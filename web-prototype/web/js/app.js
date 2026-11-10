// 無礙智瞳 網頁原型 v0.1 主程式（使用者 A：鏡頭判斷＋回報）

import { makeCalibration, imageToGround, groundToImage } from './homography.js';
import {
  buildGrid, assess, cellAt,
  FREE, BLOCKED, UNKNOWN, STATUS_TEXT, REASON_TEXT,
} from './assess.js?v=live-width-1';
import { classifyConsent } from './intent.js';
import * as api from './api.js';
import * as voice from './voice.js';
import * as detector from './detector.js';
import { renderDemoScene, DEMO_SIZE } from './demo.js';
import { initRoutePanel, initAdminPanel } from './panels.js';
import { createSidewalkScanner } from './scan.js?v=live-width-1';
import { assessLiveScan, updateLiveReport } from './live-scan.js?v=1';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const vctx = view.getContext('2d');
const bird = $('#bird');
const bctx = bird.getContext('2d');
const video = $('#video');
const scanner = createSidewalkScanner({
  status: $('#scan-status'), preview: $('#scan-preview'), button: $('#scan-again'),
  onResult: handleLiveScan,
  onFailure: (source) => { if (source.kind === 'live') resetLiveAssessment('LIVE_SCAN_FAILED'); },
});

const state = {
  config: null,
  source: null, // { kind: 'video'|'image'|'live'|'demo', el, width, height }
  calibPts: [],
  calib: null,
  mode: 'view',
  obstacles: [], // { poly: 影像座標, category, label }
  floor: [], // 已確認可用的地面（影像座標）
  occluders: [], // 影像座標多邊形
  draft: [],
  annotTime: null,
  detections: [],
  detAt: 0,
  detBusy: false,
  grid: null,
  result: null,
  history: [],
  stable: null,
  lastAlertAt: 0,
  dialog: null,
  pendingReport: null,
  lastAnalyzeAt: 0,
  dirty: true,
  liveReport: null,
  liveResetAt: 0,
};

// ───────── 小工具 ─────────
const num = (id, fallback) => {
  const v = parseFloat($(id).value);
  return Number.isFinite(v) ? v : fallback;
};
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const voiceOn = () => $('#voice-on').checked;
const markDirty = () => { state.dirty = true; };

function params() {
  const rect = { widthCm: num('#p-rect-w', 120), lengthCm: num('#p-rect-l', 200), nearCm: num('#p-near', 50) };
  const profile = state.config?.profiles.find((p) => p.id === $('#profile').value) || { widthCm: 70, sideMarginCm: 10 };
  const live = state.source?.kind === 'live';
  const widthCm = live ? 70 : num('#p-width', profile.widthCm);
  const sideCm = live ? 10 : num('#p-side', profile.sideMarginCm);
  return {
    rect,
    corridor: { leftCm: -rect.widthCm / 2 - num('#p-edge-l', 0), rightCm: rect.widthCm / 2 + num('#p-edge-r', 0) },
    range: { startCm: rect.nearCm, endCm: num('#p-range', rect.nearCm + rect.lengthCm) },
    startXCm: num('#p-start-x', 0),
    cellCm: Math.max(2, num('#p-cell', 5)),
    marginCm: Math.max(0, num('#p-margin', 5)),
    widthCm,
    sideCm,
    requiredCm: widthCm + 2 * sideCm,
    auto: $('#auto-on').checked,
  };
}

function updateThreshold() {
  const p = params();
  $('#threshold').textContent =
    `系統自動套用通行門檻：車寬 ${p.widthCm} 公分＋兩側餘裕各 ${p.sideCm} 公分＝需要 ${p.requiredCm} 公分（數值待與身障團體共同訂定）`;
}

// ───────── 畫面來源 ─────────
function setSource(src) {
  if (state.dialog) closeDialog();
  state.source = src;
  scanner.setSource(src);
  view.width = src.width;
  view.height = src.height;
  clearAnnotations(false);
  state.detections = [];
  state.history = [];
  state.stable = null;
  state.lastAlertAt = 0;
  $('#stage-hint').hidden = true;
  $('#video-controls').hidden = src.kind !== 'video';
  state.calibPts = [];
  state.calib = null;
  const live = src.kind === 'live';
  $('#live-measure').hidden = !live;
  if (live) $('#profile').value = 'manual';
  for (const id of ['#profile', '#p-width', '#p-side']) $(id).disabled = live;
  resetLiveAssessment();
  updateThreshold();
  if (src.kind !== 'demo') setMode('calib');
  markDirty();
}

function stopLive() {
  if (video.srcObject) {
    video.srcObject.getTracks().forEach((t) => t.stop());
    video.srcObject = null;
  }
}

$('#file').addEventListener('change', (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  stopLive();
  $('#demo').value = '';
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('image/')) {
    const img = new Image();
    img.onload = () => setSource({ kind: 'image', el: img, width: img.naturalWidth, height: img.naturalHeight });
    img.src = url;
    return;
  }
  video.src = url;
  video.muted = true;
  video.onloadedmetadata = () => {
    video.pause();
    video.currentTime = 0;
    setSource({ kind: 'video', el: video, width: video.videoWidth, height: video.videoHeight });
  };
});

$('#live').addEventListener('click', async () => {
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    notice('開啟鏡頭需要 HTTPS 連線（或在電腦上用 localhost）。可以先用「選擇影片」播放錄好的片段。');
    return;
  }
  try {
    stopLive();
    $('#demo').value = '';
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.removeAttribute('src');
    video.srcObject = stream;
    await video.play();
    setSource({ kind: 'live', el: video, width: video.videoWidth, height: video.videoHeight });
  } catch (e) {
    notice(`無法開啟鏡頭：${e.message}`);
  }
});

$('#demo').addEventListener('change', (e) => {
  const key = e.target.value;
  if (!key) return;
  stopLive();
  const scene = renderDemoScene(key);
  $('#p-rect-w').value = scene.rect.widthCm;
  $('#p-rect-l').value = scene.rect.lengthCm;
  $('#p-near').value = scene.rect.nearCm;
  $('#p-edge-l').value = 0;
  $('#p-edge-r').value = 0;
  $('#p-range').value = '';
  setSource({ kind: 'demo', el: scene.canvas, width: DEMO_SIZE.width, height: DEMO_SIZE.height });
  state.calibPts = scene.calibPts;
  rebuildCalibration();
  state.floor = [scene.calibPts];
  state.obstacles = scene.obstacles;
  state.occluders = scene.occluders;
  setMode('view');
  markDirty();
});

// 影片控制
$('#play').addEventListener('click', () => (video.paused ? video.play() : video.pause()));
$('#back').addEventListener('click', () => { video.pause(); video.currentTime = Math.max(0, video.currentTime - 0.5); });
$('#fwd').addEventListener('click', () => { video.pause(); video.currentTime = Math.min(video.duration || 0, video.currentTime + 0.5); });
video.addEventListener('play', () => { $('#play').textContent = '暫停'; dropStaleAnnotations(); });
video.addEventListener('pause', () => { $('#play').textContent = '播放'; markDirty(); });
video.addEventListener('seeked', () => { dropStaleAnnotations(); markDirty(); });

/** 標註只適用於標註當下的畫面（討論04：輸出描述當前影格） */
function dropStaleAnnotations() {
  if (state.source?.kind !== 'video') return;
  if (state.annotTime !== null &&
      Math.abs(video.currentTime - state.annotTime) > 0.05) {
    clearAnnotations(false);
    notice('畫面已改變，先前的人工標註只適用於當時的影格，已清除。');
  }
}

// ───────── 校正 ─────────
function rebuildCalibration() {
  resetLiveAssessment();
  if (!state.source || state.calibPts.length !== 4) { state.calib = null; return; }
  const p = params();
  state.calib = makeCalibration(state.calibPts, p.rect, { width: state.source.width, height: state.source.height });
  if (!state.calib) notice('校正失敗：四個點不能重複或共線，請重新校正。');
  markDirty();
}

$('#reset-calib').addEventListener('click', () => {
  resetLiveAssessment();
  state.calibPts = [];
  state.calib = null;
  setMode('calib');
  markDirty();
});

for (const id of ['#p-rect-w', '#p-rect-l', '#p-near']) $(id).addEventListener('input', () => rebuildCalibration());
for (const id of ['#p-edge-l', '#p-edge-r', '#p-range', '#p-start-x', '#p-cell', '#p-margin', '#p-width', '#p-side']) {
  $(id).addEventListener('input', () => { resetLiveAssessment(); updateThreshold(); markDirty(); });
}
$('#profile').addEventListener('change', () => { updateThreshold(); markDirty(); });

// ───────── 模式與標註 ─────────
const CALIB_NAMES = ['近左', '近右', '遠右', '遠左'];
function setMode(mode) {
  state.mode = mode;
  state.draft = [];
  document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  const hint = {
    view: '檢視模式：畫面上的綠線是候選動線、紅線是瓶頸截面。',
    calib: `地面校正：請依序點膠帶矩形的【近左、近右、遠右、遠左】四角。下一點：${CALIB_NAMES[state.calibPts.length % 4]}`,
    floor: '標可用地面：只圈已確認可用、看得清楚的地面。未標記處保留未知。',
    obstacle: '標障礙：沿著障礙物「貼地的範圍」逐點點出輪廓（不是物體頂部），完成後按「完成這個範圍」。',
    occluder: '標遮擋：圈出看不到地面的區域（被擋住、太暗、模糊），程式會當作未知。',
  }[mode];
  $('#mode-hint').textContent = hint;
  const annot = ['floor', 'obstacle', 'occluder'].includes(mode);
  $('#annot-cat').hidden = mode !== 'obstacle';
  $('#close-poly').hidden = !annot;
  $('#undo').hidden = mode === 'view';
  markDirty();
}
document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => {
  if (b.dataset.mode === 'calib') state.calibPts = [];
  setMode(b.dataset.mode);
  if (b.dataset.mode === 'calib') { state.calib = null; resetLiveAssessment(); markDirty(); }
}));

function clearAnnotations(withDirty = true) {
  state.obstacles = [];
  state.occluders = [];
  state.floor = [];
  state.draft = [];
  state.annotTime = null;
  if (withDirty) markDirty();
}
$('#clear-annot').addEventListener('click', () => clearAnnotations());

$('#undo').addEventListener('click', () => {
  if (state.mode === 'calib') { state.calibPts.pop(); state.calib = null; setMode('calib'); }
  else state.draft.pop();
  markDirty();
});

$('#close-poly').addEventListener('click', closeDraft);
function closeDraft() {
  if (state.draft.length < 3) { notice('至少要點 3 個點才能圍出範圍。'); return; }
  const poly = state.draft.map((p) => [...p]);
  if (state.mode === 'obstacle') {
    const cat = $('#annot-cat').value;
    const name = state.config.categories.find((c) => c.id === cat)?.name || '物品';
    state.obstacles.push({ poly, category: cat, label: name });
  } else if (state.mode === 'occluder') {
    state.occluders.push(poly);
  } else if (state.mode === 'floor') {
    state.floor.push(poly);
  }
  state.annotTime = state.source?.kind === 'video' ? video.currentTime : null;
  state.draft = [];
  markDirty();
}

view.addEventListener('pointerdown', (e) => {
  if (!state.source || state.mode === 'view') return;
  const r = view.getBoundingClientRect();
  const pt = [((e.clientX - r.left) / r.width) * view.width, ((e.clientY - r.top) / r.height) * view.height];
  if (state.mode === 'calib') {
    if (state.calibPts.length >= 4) state.calibPts = [];
    state.calibPts.push(pt);
    if (state.calibPts.length === 4) {
      rebuildCalibration();
      if (state.calib) setMode('view');
    } else {
      setMode('calib');
    }
  } else {
    if (state.source.kind === 'live') { notice('即時鏡頭持續變動。請用照片或暫停影片做人工標註。'); return; }
    if (state.source.kind === 'video' && !video.paused) video.pause();
    // 點回第一個點附近 → 自動完成
    if (state.draft.length >= 3) {
      const [fx, fy] = state.draft[0];
      if (Math.hypot(fx - pt[0], fy - pt[1]) < view.width * 0.02) { closeDraft(); return; }
    }
    state.draft.push(pt);
  }
  markDirty();
});

// ───────── 判斷 ─────────
function showLiveResult(grid, result) {
  state.grid = grid;
  state.result = result;
  showResult(result, '鏡頭掃描＋地面校正');
  $('#live-status').textContent = `輪椅判斷：${STATUS_TEXT[result.status]}。 ${$('#reason').textContent}`;
  drawBird();
}

function resetLiveAssessment(reason = 'LIVE_CALIBRATION_REQUIRED') {
  state.liveResetAt = performance.now();
  state.liveReport = null;
  if (reason === 'LIVE_CALIBRATION_REQUIRED') $('#live-confirm').checked = false;
  if (state.source?.kind !== 'live') return;
  if (state.dialog) closeDialog();
  showLiveResult(null, { status: 'UNKNOWN', reason });
}

$('#live-calibrate').addEventListener('click', () => {
  const settings = $('#calibration-settings');
  settings.open = true;
  $('#p-rect-w').focus();
});

$('#live-confirm').addEventListener('change', () => {
  if ($('#live-confirm').checked && !state.calib) {
    resetLiveAssessment();
    notice('請先完成四點地面校正。');
    return;
  }
  resetLiveAssessment($('#live-confirm').checked ? 'LIVE_SCANNING' : 'LIVE_CALIBRATION_REQUIRED');
});

function handleLiveScan(scan) {
  if (scan.source.kind !== 'live' || scan.source !== state.source ||
      scan.capturedAt < state.liveResetAt || !state.calib || !$('#live-confirm').checked) return;
  const { grid, result, obstacle } = assessLiveScan(scan, state.calib, params());
  state.liveReport = updateLiveReport(state.liveReport, result.status);
  if (result.status === 'BLOCKED' && state.liveReport.blocked < 3) {
    showLiveResult(grid, { status: 'UNKNOWN', reason: 'LIVE_CONFIRMING_BLOCK' });
    return;
  }
  showLiveResult(grid, result);
  if (state.liveReport.clear >= 2 && state.dialog) closeDialog();
  if (state.liveReport.shouldPrompt) {
    const lab = { label: obstacle?.label, category: obstacle?.category ?? 'other', origin: 'model' };
    void askReport(lab);
  }
}

function analyze() {
  if (state.source?.kind === 'live') return;
  const p = params();
  const calib = state.calib;
  let r;
  let origin = '人工標註';
  let labels = [];
  if (!calib) {
    state.grid = null;
    r = assess(null, p);
  } else {
    const blockedGround = [];
    const unknownImage = [...state.occluders];
    for (const o of state.obstacles) {
      const g = o.poly.map((pt) => imageToGround(calib, pt));
      if (g.some((x) => !x)) { unknownImage.push(o.poly); continue; } // 地平線以上：無法定位 → 未知
      blockedGround.push(g);
      labels.push({ ground: g, label: o.label, category: o.category, origin: 'manual' });
    }
    const detFresh = p.auto && performance.now() - state.detAt < 1500;
    if (detFresh) {
      for (const d of state.detections) {
        const [x, y, w, h] = d.bbox;
        unknownImage.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
      }
    }
    if (state.source.kind === 'demo') origin = '示範預設標註';
    else if (!state.floor.length && !labels.length && !state.occluders.length) origin = '尚無已確認的地面或阻隔';
    if (detFresh && state.detections.length) origin += '＋模型標出的未知區';
    state.grid = buildGrid({
      calib, corridor: p.corridor, range: p.range, cellCm: p.cellCm,
      freeImage: state.floor, blockedGround, unknownImage, marginCm: p.marginCm,
    });
    r = assess(state.grid, { requiredCm: p.requiredCm, startXCm: p.startXCm });
  }
  state.result = r;
  state.labels = labels;
  state.origin = origin;
  showResult(r, origin);
  stabilizeAndAlert(r, labels);
}

function showResult(r, origin) {
  $('#result').dataset.status = r.status;
  $('#status').textContent = STATUS_TEXT[r.status];
  let reason = REASON_TEXT[r.reason] || r.reason;
  if (r.bottleneck) reason += `（最寬缺口約 ${r.bottleneck.maxGapCm} 公分，需要 ${params().requiredCm} 公分）`;
  $('#reason').textContent = reason;
  $('#evidence').textContent = `判斷依據：${origin}。結果只描述畫面中已校正的這一小段。`;
}

function isDynamic() {
  return state.source?.kind === 'live' || (state.source?.kind === 'video' && !video.paused);
}

/** 動態畫面：最近 4 次至少 3 次相同才算穩定；靜態畫面直接採用 */
function stabilizeAndAlert(r, labels) {
  state.history.push(r.status);
  if (state.history.length > 4) state.history.shift();
  let stable = r.status;
  if (isDynamic()) {
    const n = state.history.filter((s) => s === r.status).length;
    if (n < 3) stable = state.stable;
  }
  const prev = state.stable;
  state.stable = stable;
  if (r.status !== 'BLOCKED' && state.dialog) closeDialog();
  if (stable === 'BLOCKED' && prev !== 'BLOCKED' && Date.now() - state.lastAlertAt > 15000) {
    state.lastAlertAt = Date.now();
    const lab = nearestLabel(labels, r.bottleneck?.yCm);
    askReport(lab);
  }
}

function nearestLabel(labels, y) {
  if (!labels.length) return { label: '物品', category: 'other', origin: 'manual' };
  if (y == null) return labels[0];
  let best = labels[0];
  let bestD = Infinity;
  for (const l of labels) {
    const ys = l.ground.map((p) => p[1]);
    const d = y < Math.min(...ys) ? Math.min(...ys) - y : y > Math.max(...ys) ? y - Math.max(...ys) : 0;
    if (d < bestD) { bestD = d; best = l; }
  }
  return best;
}

// ───────── 詢問回報（語音只在提問後聆聽一次） ─────────
async function askReport(lab) {
  if (state.dialog) return;
  const q = (lab.label ? `前方有${lab.label}，通行空間不足。` : '前方輪椅通行空間不足。') + '要回報這個路段嗎？';
  const dialog = { lab };
  state.dialog = dialog;
  $('#consent').hidden = false;
  $('#consent-q').textContent = q;
  $('#consent-hint').textContent = voice.canListen() && voiceOn() ? '' : '請按「回報」或「不用」。';
  if (!voiceOn()) return;
  await voice.say(q);
  await listenConsent(dialog, 2);
}

async function listenConsent(dialog, tries) {
  if (state.dialog !== dialog) return;
  if (!voice.canListen()) {
    $('#consent-hint').textContent = '這個瀏覽器或連線（需 HTTPS）不支援語音聆聽，請按按鈕。';
    return;
  }
  $('#consent-hint').textContent = '聆聽中…請說「好」或「不用」';
  const heard = await voice.listenOnce(6000);
  if (state.dialog !== dialog) return;
  const intent = classifyConsent(heard);
  $('#consent-hint').textContent = heard ? `聽到：「${heard}」` : '沒有聽到回答';
  if (intent === 'yes') return confirmReport('語音同意');
  if (intent === 'no') return declineReport();
  if (tries > 1) {
    await voice.say('抱歉，沒有聽清楚。要回報嗎？請說好，或是不用。');
    return listenConsent(dialog, tries - 1);
  }
  $('#consent-hint').textContent += '。沒有聽清楚，請按按鈕。';
  voice.say('請按畫面上的按鈕。');
}

function closeDialog() {
  voice.stopAll();
  state.dialog = null;
  $('#consent').hidden = true;
}

function confirmReport(how) {
  const lab = state.dialog?.lab;
  closeDialog();
  if (!lab) return;
  const source = lab.origin === 'model' ? 'auto' : 'trigger';
  submitReport({
    category: lab.category,
    source,
    summary: `${lab.label ? lab.label + '縮窄通道，' : ''}輪椅通行空間不足（${how}；${source === 'auto' ? '鏡頭與地面校正推估' : '人工標註'}）`,
  });
}

function declineReport() {
  closeDialog();
  $('#report-msg').textContent = '好的，不回報。';
  if (voiceOn()) voice.say('好的，不回報。');
}

$('#yes').addEventListener('click', () => confirmReport('按鈕同意'));
$('#no').addEventListener('click', declineReport);
$('#segment').addEventListener('change', () => { if (state.dialog) closeDialog(); });

// ───────── 手動回報（系統沒提醒，但使用者覺得不好走） ─────────
const CAT_WORDS = [
  ['motorcycle', /機車|摩托/],
  ['bicycle', /腳踏車|自行車|單車|腳車/],
  ['goods', /雜物|箱|東西|貨|垃圾|桶/],
  ['sign', /招牌|立牌|看板|牌子/],
  ['fence', /圍籬|施工|工程/],
  ['step', /落差|台階|階梯|坑|洞|不平/],
  ['other', /其他|別的/],
];

$('#manual').addEventListener('click', async () => {
  $('#manual-panel').hidden = false;
  $('#manual-hint').textContent = '';
  if (voiceOn()) {
    await voice.say('要回報什麼？例如機車、雜物、招牌，或是落差。');
    if (voice.canListen() && !$('#manual-panel').hidden) {
      $('#manual-hint').textContent = '聆聽中…';
      const heard = await voice.listenOnce(6000);
      if ($('#manual-panel').hidden) return;
      const hit = CAT_WORDS.find(([, re]) => re.test(heard));
      if (hit) {
        const category = state.config.categories.find((c) => c.id === hit[0]);
        $('#manual-hint').textContent = `聽到「${heard}」。若要回報${category.name}，請按下對應按鈕。`;
        return;
      }
      $('#manual-hint').textContent = heard ? `聽到：「${heard}」，請按下方按鈕選擇。` : '沒有聽到，請按下方按鈕選擇。';
    }
  }
});
$('#manual-cancel').addEventListener('click', () => { voice.stopAll(); $('#manual-panel').hidden = true; });

function manualReport(cat, how) {
  voice.stopAll();
  $('#manual-panel').hidden = true;
  const name = state.config.categories.find((c) => c.id === cat)?.name || '其他';
  submitReport({ category: cat, source: 'manual', summary: `使用者手動回報：${name}（${how}）` });
}

// ───────── 送出回報（同一筆重送只建立一筆） ─────────
async function submitReport({ category, source, summary }) {
  const ev = {
    id: api.newId(),
    segmentId: $('#segment').value,
    category,
    source,
    summary,
    observedAt: new Date().toISOString(),
  };
  state.pendingReport = ev;
  await sendPending();
}

async function sendPending() {
  const ev = state.pendingReport;
  if (!ev) return;
  $('#retry').hidden = true;
  $('#report-msg').textContent = '送出中…';
  try {
    const saved = await api.createEvent(ev);
    state.pendingReport = null;
    const seg = state.config.segments.find((s) => s.id === saved.segmentId)?.name || '';
    $('#report-msg').textContent = `已回報：${seg}，狀態「${saved.status}」。`;
    if (voiceOn()) voice.say(`已回報，目前狀態是${saved.status}。`);
  } catch (e) {
    $('#report-msg').textContent = `送出失敗：${e.message}。可以按「重新送出」（不會重複建立）。`;
    $('#retry').hidden = false;
    if (voiceOn()) voice.say('回報沒有送出，請按重新送出。');
  }
}
$('#retry').addEventListener('click', sendPending);

// ───────── 自動偵測 ─────────
$('#auto-on').addEventListener('change', async (e) => {
  if (!e.target.checked) { state.detections = []; $('#auto-status').textContent = ''; markDirty(); return; }
  $('#auto-status').textContent = '載入模型中（第一次需要網路，約數秒）…';
  try {
    await detector.load();
    $('#auto-status').textContent = '自動偵測已開啟：偵測框內保留未知。';
  } catch (err) {
    $('#auto-status').textContent = `模型載入失敗：${err.message}`;
    e.target.checked = false;
  }
  markDirty();
});

async function runDetection() {
  if (state.detBusy || !state.source || !$('#auto-on').checked) return;
  const source = state.source;
  const videoTime = video.currentTime;
  state.detBusy = true;
  try {
    const detections = await detector.detect(source.el);
    if (source === state.source && $('#auto-on').checked &&
        (source.kind !== 'video' || Math.abs(video.currentTime - videoTime) < 0.5)) {
      state.detections = detections;
      state.detAt = performance.now();
      markDirty();
    }
  } catch { /* 下一輪再試 */ }
  finally { state.detBusy = false; }
}

// ───────── 繪圖 ─────────
function drawPoly(ctx, pts, { fill, stroke, width = 2, dash } = {}) {
  if (!pts.length) return;
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.closePath();
  if (fill) { ctx.fillStyle = fill; ctx.fill(); }
  if (stroke) { ctx.setLineDash(dash || []); ctx.lineWidth = width; ctx.strokeStyle = stroke; ctx.stroke(); ctx.setLineDash([]); }
}

function drawLine(ctx, pts, color, width) {
  const ok = pts.filter(Boolean);
  if (ok.length < 2) return;
  ctx.beginPath();
  ok.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
  ctx.lineWidth = width;
  ctx.strokeStyle = color;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
}

function drawView() {
  const s = state.source;
  if (!s) return;
  const k = view.width / 960; // 線寬隨解析度縮放
  try { vctx.drawImage(s.el, 0, 0, view.width, view.height); } catch { return; }
  const p = params();
  const c = state.calib;

  if (c) {
    // 通道邊界與分析範圍
    const corners = [
      [p.corridor.leftCm, p.range.startCm], [p.corridor.rightCm, p.range.startCm],
      [p.corridor.rightCm, p.range.endCm], [p.corridor.leftCm, p.range.endCm],
    ].map((g) => groundToImage(c, g));
    if (corners.every(Boolean)) drawPoly(vctx, corners, { stroke: 'rgba(80,160,255,0.9)', width: 3 * k, dash: [10 * k, 8 * k] });
  }
  // 校正點
  state.calibPts.forEach((pt, i) => {
    vctx.fillStyle = '#f2c200';
    vctx.beginPath(); vctx.arc(pt[0], pt[1], 9 * k, 0, Math.PI * 2); vctx.fill();
    vctx.fillStyle = '#000';
    vctx.font = `${16 * k}px sans-serif`;
    vctx.fillText(CALIB_NAMES[i], pt[0] + 12 * k, pt[1] - 10 * k);
  });
  for (const poly of state.floor) drawPoly(vctx, poly, { fill: 'rgba(34,197,94,0.16)', stroke: '#22c55e', width: 2 * k });
  // 遮擋與障礙
  for (const o of state.occluders) drawPoly(vctx, o, { fill: 'rgba(120,120,120,0.45)', stroke: 'rgba(255,255,255,0.8)', width: 2 * k, dash: [6 * k, 6 * k] });
  for (const o of state.obstacles) {
    drawPoly(vctx, o.poly, { fill: 'rgba(220,40,30,0.35)', stroke: '#ff5a4f', width: 3 * k });
    vctx.fillStyle = '#fff';
    vctx.font = `bold ${18 * k}px sans-serif`;
    vctx.fillText(o.label, o.poly[0][0], o.poly[0][1] - 6 * k);
  }
  if (p.auto) {
    for (const d of state.detections) {
      const [x, y, w, h] = d.bbox;
      vctx.lineWidth = 3 * k;
      vctx.strokeStyle = d.isObstacle ? '#ff9f1a' : '#9ad';
      vctx.strokeRect(x, y, w, h);
      vctx.fillStyle = vctx.strokeStyle;
      vctx.font = `bold ${16 * k}px sans-serif`;
      vctx.fillText(`${d.label} ${(d.score * 100).toFixed(0)}%（模型推估）`, x + 4 * k, y + 18 * k);
    }
  }
  // 草稿
  if (state.draft.length) {
    drawLine(vctx, state.draft, '#ffe14d', 3 * k);
    state.draft.forEach((pt) => { vctx.fillStyle = '#ffe14d'; vctx.beginPath(); vctx.arc(pt[0], pt[1], 6 * k, 0, Math.PI * 2); vctx.fill(); });
  }
  // 結果：候選動線、瓶頸
  const r = state.result;
  if (c && r?.path) drawLine(vctx, r.path.map((q) => groundToImage(c, [q.x, q.y])), '#22c55e', 8 * k);
  if (c && r?.bottleneck) {
    drawLine(vctx, [groundToImage(c, [p.corridor.leftCm, r.bottleneck.yCm]), groundToImage(c, [p.corridor.rightCm, r.bottleneck.yCm])], '#ff3b30', 6 * k);
  }
}

function drawBird() {
  const g = state.grid;
  const W = bird.width;
  const H = bird.height;
  bctx.fillStyle = css('--surface');
  bctx.fillRect(0, 0, W, H);
  if (!g) {
    bctx.fillStyle = css('--muted');
    bctx.font = '15px sans-serif';
    bctx.fillText('尚未校正，沒有地面格網', 16, H / 2);
    return;
  }
  const cs = Math.max(1, Math.min((W - 20) / g.cols, (H - 40) / g.rows));
  const ox = (W - cs * g.cols) / 2;
  const oy = 10;
  const colors = { [FREE]: css('--cell-free'), [BLOCKED]: css('--cell-blocked'), [UNKNOWN]: css('--cell-unknown') };
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      bctx.fillStyle = colors[cellAt(g, r, c)];
      // 第 0 列（最近）畫在最下面
      bctx.fillRect(ox + c * cs, oy + (g.rows - 1 - r) * cs, Math.ceil(cs), Math.ceil(cs));
    }
  }
  const toXY = (x, y) => [ox + ((x - g.corridor.leftCm) / g.cellCm) * cs, oy + (g.rows - (y - g.range.startCm) / g.cellCm) * cs];
  const res = state.result;
  if (res?.path) drawLine(bctx, res.path.map((q) => toXY(q.x, q.y)), css('--path'), Math.max(3, cs * 0.6));
  if (res?.bottleneck) drawLine(bctx, [toXY(g.corridor.leftCm, res.bottleneck.yCm), toXY(g.corridor.rightCm, res.bottleneck.yCm)], css('--bottleneck'), 4);
  // 輪椅位置與需求寬度
  const p = params();
  const [bx0, by] = toXY(p.startXCm - p.requiredCm / 2, g.range.startCm);
  const [bx1] = toXY(p.startXCm + p.requiredCm / 2, g.range.startCm);
  bctx.fillStyle = css('--accent');
  bctx.fillRect(bx0, by + 4, bx1 - bx0, 6);
  bctx.font = '12px sans-serif';
  bctx.fillStyle = css('--muted');
  bctx.fillText(`輪椅需求 ${p.requiredCm} cm`, ox, by + 24);
  bctx.fillText(`前方 ${Math.round(g.range.endCm)} cm`, ox, oy + 12);
}

// ───────── 主迴圈 ─────────
let lastVideoTime = -1;
let lastDetRun = 0;
function loop(now) {
  const s = state.source;
  if (s) {
    if (!document.hidden) void scanner.tick(now);
    const dyn = isDynamic();
    if (s.kind === 'video') {
      $('#time').textContent = `${video.currentTime.toFixed(1)} / ${(video.duration || 0).toFixed(1)} 秒`;
      if (video.currentTime !== lastVideoTime) { lastVideoTime = video.currentTime; dropStaleAnnotations(); markDirty(); }
    }
    if ($('#auto-on').checked && now - lastDetRun > 400 && (dyn || state.dirty)) {
      lastDetRun = now;
      runDetection();
    }
    if (s.kind !== 'live' && (dyn ? now - state.lastAnalyzeAt > 200 : state.dirty)) {
      state.lastAnalyzeAt = now;
      state.dirty = false;
      analyze();
      drawBird();
    }
    drawView();
  }
  requestAnimationFrame(loop);
}

// ───────── 分頁 ─────────
document.querySelectorAll('[role="tab"]').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('[role="tab"]').forEach((t) => {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      $('#' + t.getAttribute('aria-controls')).hidden = !on;
    });
    if (tab.id === 'tab-btn-admin') admin?.refresh();
  });
});

let noticeTimer = null;
function notice(text) {
  const el = $('#report-msg');
  el.textContent = text;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 8000);
}

// ───────── 啟動 ─────────
let admin = null;
async function init() {
  try {
    state.config = await api.getConfig();
  } catch (e) {
    $('#stage-hint').textContent = `無法載入設定（${e.message}）。請確認 Pages 已部署，或在本機用 python server.py 啟動。`;
    return;
  }
  const cfg = state.config;
  $('#demo-mode').hidden = !api.isDemoMode();
  $('#segment').innerHTML = cfg.segments.map((s) => `<option value="${s.id}">${s.name}</option>`).join('');
  $('#profile').innerHTML = cfg.profiles.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
  $('#annot-cat').innerHTML = cfg.categories.map((c) => `<option value="${c.id}"${c.id === 'goods' ? ' selected' : ''}>${c.name}</option>`).join('');
  $('#manual-cats').innerHTML = cfg.categories.map((c) => `<button type="button" data-cat="${c.id}">${c.name}</button>`).join('');
  $('#manual-cats').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-cat]');
    if (b) manualReport(b.dataset.cat, '按鈕');
  });
  updateThreshold();
  setMode('view');
  initRoutePanel(cfg, voiceOn);
  admin = initAdminPanel(cfg);
  drawBird();
  requestAnimationFrame(loop);
}
init();

// 供測試與除錯使用
window.__wuai = { state, params, analyze };
