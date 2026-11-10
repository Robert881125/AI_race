// 無礙智瞳 網頁原型 v0.1 主程式（使用者 A：鏡頭判斷＋回報）

import { makeCalibration, imageToGround, groundToImage } from './homography.js?v=review-1';
import {
  buildGrid, assess, cellAt,
  FREE, BLOCKED, UNKNOWN, STATUS_TEXT, REASON_TEXT,
} from './assess.js?v=review-1';
import { classifyConsent } from './intent.js';
import * as api from './api.js?v=map-1';
import * as voice from './voice.js';
import * as detector from './detector.js';
import { renderDemoScene, DEMO_SIZE } from './demo.js';
import { initRoutePanel, initAdminPanel } from './panels.js?v=map-1';
import { createMap } from './map.js?v=map-1';
import { createSidewalkScanner } from './scan.js?v=annotate-1';
import { CALIB_NAMES, KIND_TEXT, annotateStep, annotateHint } from './annotate.js?v=annotate-1';
import { bindVideoControls } from './video-controls.js?v=video-1';
import { NEAR_LIMIT_CM, drawScanRegion, scanRegion } from './scan-region.js?v=video-1';
import { assessLiveScan, updateLiveReport } from './live-scan.js?v=annotate-1';

const $ = (s) => document.querySelector(s);
const view = $('#view');
const vctx = view.getContext('2d');
const bird = $('#bird');
const bctx = bird.getContext('2d');
const video = $('#video');
const scanner = createSidewalkScanner({
  status: $('#scan-status'), preview: $('#scan-preview'), button: $('#scan-again'),
  details: $('#scan-details'),
  getCalibration: () => state.calib,
  onResult: handleLiveScan,
  onFailure: (source) => {
    if (source.kind === 'live') resetLiveAssessment('LIVE_SCAN_FAILED');
    else { state.lastScan = null; markDirty(); }
  },
});

const state = {
  config: null,
  source: null, // { kind: 'video'|'image'|'live'|'demo', el, width, height }
  calibPts: [],
  calib: null,
  lastScan: null,
  judgedScan: null,
  userCalibInputs: null,
  pendingPoly: null,
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
  sendingReport: false,
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
  const limit = live || state.source?.kind === 'video' ? NEAR_LIMIT_CM : Infinity;
  const widthCm = live ? 70 : num('#p-width', profile.widthCm);
  const sideCm = live ? 10 : num('#p-side', profile.sideMarginCm);
  return {
    rect,
    corridor: { leftCm: -rect.widthCm / 2 - num('#p-edge-l', 0), rightCm: rect.widthCm / 2 + num('#p-edge-r', 0) },
    range: { startCm: rect.nearCm, endCm: Math.min(limit, num('#p-range', rect.nearCm + rect.lengthCm)) },
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
const CALIB_INPUTS = ['#p-rect-w', '#p-rect-l', '#p-near', '#p-edge-l', '#p-edge-r', '#p-range'];

function setSource(src) {
  if (src.kind !== 'demo' && state.userCalibInputs) {
    for (const [id, value] of state.userCalibInputs) $(id).value = value;
    state.userCalibInputs = null;
  }
  if (state.dialog) closeDialog();
  state.source = src;
  state.lastScan = null;
  state.judgedScan = null;
  scanner.setSource(src);
  const scale = src.kind === 'video' || src.kind === 'live'
    ? Math.min(1, 960 / Math.max(src.width, src.height)) : 1;
  view.width = Math.max(1, Math.round(src.width * scale));
  view.height = Math.max(1, Math.round(src.height * scale));
  vctx.setTransform(view.width / src.width, 0, 0, view.height / src.height, 0, 0);
  clearAnnotations(false);
  state.detections = [];
  state.history = [];
  state.stable = null;
  state.lastAlertAt = 0;
  $('#stage-hint').hidden = true;
  $('#video-controls').hidden = src.kind !== 'video';
  if (src.kind === 'video') videoControls.reset();
  state.calibPts = [];
  state.calib = null;
  const live = src.kind === 'live';
  $('#live-measure').hidden = !live;
  if (live) $('#profile').value = 'manual';
  for (const id of ['#profile', '#p-width', '#p-side']) $(id).disabled = live;
  resetLiveAssessment();
  updateThreshold();
  if (src.kind !== 'demo') setMode('annotate');
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
  state.userCalibInputs ??= CALIB_INPUTS.map((id) => [id, $(id).value]);
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
const videoControls = bindVideoControls(video, $('#video-controls'), () => {
  scanner.reset();
  state.lastScan = null;
  state.judgedScan = null;
  state.detections = [];
  state.history = [];
  state.stable = null;
  if (state.dialog) closeDialog();
  markDirty();
});
video.addEventListener('play', dropStaleAnnotations);
video.addEventListener('pause', markDirty);
video.addEventListener('seeked', () => { dropStaleAnnotations(); markDirty(); });

/** 標註只適用於標註當下的畫面（討論04：輸出描述當前影格） */
function dropStaleAnnotations() {
  if (state.source?.kind !== 'video') return;
  if (state.annotTime !== null &&
      Math.abs(video.currentTime - state.annotTime) > 0.05) {
    clearAnnotations();
    refreshAnnotateUi();
    notice('畫面已改變，先前的人工標註只適用於當時的影格，已清除。');
  }
}

// ───────── 校正 ─────────
function rebuildCalibration() {
  resetLiveAssessment();
  if (!state.source || state.calibPts.length !== 4) { state.calib = null; return; }
  const p = params();
  state.calib = makeCalibration(state.calibPts, p.rect, { width: state.source.width, height: state.source.height });
  if (!state.calib) notice('校正失敗：請確認實際尺寸，並依近左、近右、遠右、遠左重點四角。');
  refreshAnnotateUi();
  markDirty();
}

$('#reset-calib').addEventListener('click', () => {
  resetLiveAssessment();
  state.calibPts = [];
  state.calib = null;
  state.pendingPoly = null;
  setMode('annotate');
  markDirty();
});
$('#recalib').addEventListener('click', () => $('#reset-calib').click());

for (const id of ['#p-rect-w', '#p-rect-l', '#p-near']) $(id).addEventListener('input', () => rebuildCalibration());
for (const id of ['#p-edge-l', '#p-edge-r', '#p-range', '#p-start-x', '#p-cell', '#p-margin', '#p-width', '#p-side']) {
  $(id).addEventListener('input', () => { resetLiveAssessment(); updateThreshold(); markDirty(); });
}
$('#profile').addEventListener('change', () => { updateThreshold(); markDirty(); });

// ───────── 模式與標註 ─────────
const currentStep = () => annotateStep({ calibPts: state.calibPts, calib: state.calib, pending: state.pendingPoly });

/** 模式只有兩個：'view' 檢視／'annotate' 標註（校正四角 → 圈範圍 → 選種類，依進度自動切換） */
function setMode(mode) {
  state.mode = mode === 'view' ? 'view' : 'annotate';
  document.querySelectorAll('.modes button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === state.mode)));
  refreshAnnotateUi();
  markDirty();
}

function refreshAnnotateUi() {
  const annotating = state.mode === 'annotate';
  const s = currentStep();
  $('#mode-hint').textContent = annotating
    ? annotateHint(s, { calibCount: state.calibPts.length, draftCount: state.draft.length, live: state.source?.kind === 'live' })
    : '檢視模式：畫面上的綠線是候選動線、紅線是瓶頸截面。要校正或圈範圍請按「標註」。';
  $('#annot-choice').hidden = !(annotating && s === 'choose');
  $('#close-poly').hidden = !(annotating && s === 'draw' && state.draft.length >= 3);
  $('#undo').hidden = !annotating || (s === 'calib' && !state.calibPts.length) || (s === 'draw' && !state.draft.length);
  $('#recalib').hidden = !state.calibPts.length;
}

document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

$('#annot-choice').addEventListener('click', (e) => {
  const b = e.target.closest('button[data-kind]');
  if (!b || !state.pendingPoly) return;
  const poly = state.pendingPoly;
  if (b.dataset.kind === 'obstacle') {
    const cat = $('#annot-cat').value;
    const name = state.config.categories.find((c) => c.id === cat)?.name || '物品';
    state.obstacles.push({ poly, category: cat, label: name });
  } else if (b.dataset.kind === 'occluder') {
    state.occluders.push(poly);
  } else {
    state.floor.push(poly);
  }
  state.pendingPoly = null;
  state.annotTime = state.source?.kind === 'video' ? video.currentTime : null;
  notice(`已標為「${KIND_TEXT[b.dataset.kind]}」。可以繼續圈下一個範圍，或按「檢視」看結果。`);
  refreshAnnotateUi();
  markDirty();
});

function clearAnnotations(withDirty = true) {
  state.obstacles = [];
  state.occluders = [];
  state.floor = [];
  state.draft = [];
  state.pendingPoly = null;
  state.annotTime = null;
  if (withDirty) markDirty();
}
$('#clear-annot').addEventListener('click', () => { clearAnnotations(); refreshAnnotateUi(); });

$('#undo').addEventListener('click', () => {
  const s = currentStep();
  if (s === 'calib') { state.calibPts.pop(); state.calib = null; resetLiveAssessment(); }
  else if (s === 'choose') { state.draft = state.pendingPoly; state.pendingPoly = null; } // 回到圈範圍
  else state.draft.pop();
  refreshAnnotateUi();
  markDirty();
});

$('#close-poly').addEventListener('click', closeDraft);
/** 圈好一個範圍 → 等使用者選它是什麼（可用地面／障礙物／看不清楚） */
function closeDraft() {
  if (state.draft.length < 3) { notice('至少要點 3 個點才能圍出範圍。'); return; }
  state.pendingPoly = state.draft.map((p) => [...p]);
  state.draft = [];
  refreshAnnotateUi();
  $('#annot-choice button')?.focus();
  markDirty();
}

view.addEventListener('pointerdown', (e) => {
  if (!state.source || state.mode === 'view') return;
  const r = view.getBoundingClientRect();
  const pt = [((e.clientX - r.left) / r.width) * state.source.width,
    ((e.clientY - r.top) / r.height) * state.source.height];
  const s = currentStep();
  if (state.source.kind === 'video' && !video.paused) video.pause();
  if (s === 'calib') {
    if (state.calibPts.length >= 4) state.calibPts = [];
    state.calibPts.push(pt);
    if (state.calibPts.length === 4) {
      rebuildCalibration();
      if (!state.calib) state.calibPts = []; // 校正失敗（點交叉等）→ 重點四角
      else notice('地面校正完成。可以直接按「檢視」看 AI 掃描的判斷，或繼續圈範圍。');
    }
    refreshAnnotateUi();
  } else if (s === 'choose') {
    notice('請先選剛圈好的範圍是什麼，或按「復原一點」修改。');
    return;
  } else {
    if (state.source.kind === 'live') { notice('即時鏡頭持續變動。請用照片或暫停影片做人工標註。'); return; }
    if (state.source.kind === 'video') state.annotTime = video.currentTime;
    // 點回第一個點附近 → 自動完成
    if (state.draft.length >= 3) {
      const [fx, fy] = state.draft[0];
      if (Math.hypot(fx - pt[0], fy - pt[1]) < state.source.width * 0.02) { closeDraft(); return; }
    }
    state.draft.push(pt);
    refreshAnnotateUi();
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
  if (scan.source !== state.source) return;
  if (scan.source.kind !== 'live') {
    state.lastScan = scan;
    markDirty();
    return;
  }
  if (scan.capturedAt < state.liveResetAt || !state.calib || !$('#live-confirm').checked) return;
  const { grid, result, obstacle } = assessLiveScan(scan, state.calib, params());
  state.liveReport = updateLiveReport(state.liveReport, result.status);
  if (result.status === 'BLOCKED' && state.liveReport.blocked < 3) {
    showLiveResult(grid, { status: 'UNKNOWN', reason: 'LIVE_CONFIRMING_BLOCK' });
    return;
  }
  showLiveResult(grid, result);
  if (state.liveReport.clear >= 2 && state.dialog) closeDialog();
  if (state.liveReport.shouldPrompt) {
    if (state.pendingReport) {
      state.liveReport.prompted = false;
      return;
    }
    const lab = { label: obstacle?.label, category: obstacle?.category ?? 'other', origin: 'model' };
    void askReport(lab);
  }
}

const VIDEO_SCAN_MAX_LAG = 4;

function scanForCurrentFrame() {
  const scan = state.lastScan;
  if (!scan || scan.source.kind !== 'video') return scan;
  const limit = video.paused ? 0.05 : VIDEO_SCAN_MAX_LAG;
  return !video.seeking && scan.calibration === state.calib &&
    Math.abs(video.currentTime - scan.frame) < limit ? scan : null;
}

function analyze() {
  const source = state.source;
  if (!source || source.kind === 'live') return;
  const p = params();
  const calib = state.calib;
  const scan = scanForCurrentFrame();
  const labels = [];
  const manual = state.floor.length || state.obstacles.length || state.occluders.length;
  let origin = scan ? 'AI 已掃描，請完成地面校正' : '人工標註';
  let result;
  state.grid = null;
  if (calib) {
    const blockedGround = [];
    const unknownImage = [...state.occluders];
    for (const obstacle of state.obstacles) {
      const ground = obstacle.poly.map((point) => imageToGround(calib, point));
      if (ground.some((point) => !point)) { unknownImage.push(obstacle.poly); continue; }
      blockedGround.push(ground);
      labels.push({ ground, label: obstacle.label, category: obstacle.category, origin: 'manual' });
    }
    const automatic = scan && assessLiveScan(scan, calib, p, { freeImage: state.floor, unknownImage, blockedGround });
    if (automatic && (automatic.grid || !manual)) {
      state.grid = automatic.grid;
      result = automatic.result;
      origin = manual ? 'AI 掃描＋人工圈選修正＋地面校正' : 'AI 掃描＋地面校正';
      if (source.kind === 'video') origin += '（影片 ' + scan.frame.toFixed(1) + ' 秒）';
      if (automatic.obstacle) labels.push({ ...automatic.obstacle, origin: 'model' });
    } else {
      const detFresh = p.auto && performance.now() - state.detAt < 1500;
      if (detFresh) {
        for (const { bbox: [x, y, w, h] } of state.detections) {
          unknownImage.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h]]);
        }
      }
      origin = source.kind === 'demo' ? '示範預設標註' : manual ? '人工標註' : '等待已校正影格的掃描';
      if (detFresh && state.detections.length) origin += '＋模型標出的未知區';
      state.grid = buildGrid({
        calib, corridor: p.corridor, range: p.range, cellCm: p.cellCm,
        freeImage: state.floor, blockedGround, unknownImage, marginCm: p.marginCm,
      });
    }
  }
  result ??= assess(state.grid, p);
  state.result = result;
  state.labels = labels;
  state.origin = origin;
  showResult(result, origin);
  if (!isDynamic() || (scan && scan !== state.judgedScan)) {
    state.judgedScan = scan;
    stabilizeAndAlert(result, labels);
  } else if (!scan) {
    state.history = [];
    state.stable = null;
    if (state.dialog) closeDialog();
  }
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
    if (!l.ground) continue;
    const ys = l.ground.map((p) => p[1]);
    const d = y < Math.min(...ys) ? Math.min(...ys) - y : y > Math.max(...ys) ? y - Math.max(...ys) : 0;
    if (d < bestD) { bestD = d; best = l; }
  }
  return best;
}

// ───────── 詢問回報（語音只在提問後聆聽一次） ─────────
async function askReport(lab) {
  if (state.dialog || state.pendingReport) return;
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
  if (state.pendingReport) { notice('請先完成或結束上一筆回報。'); return; }
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
  if (state.pendingReport) { notice('請先完成或結束上一筆回報。'); return; }
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
  if (!ev || state.sendingReport) return;
  state.sendingReport = true;
  $('#retry').hidden = true;
  $('#discard-report').hidden = true;
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
    $('#discard-report').hidden = false;
    if (voiceOn()) voice.say('回報沒有送出，請按重新送出。');
  } finally {
    state.sendingReport = false;
  }
}
$('#retry').addEventListener('click', sendPending);
$('#discard-report').addEventListener('click', () => {
  if (state.sendingReport || !state.pendingReport) return;
  state.pendingReport = null;
  $('#retry').hidden = true;
  $('#discard-report').hidden = true;
  notice('已結束這筆待送回報。');
});

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

const detectorCanvas = document.createElement('canvas');
const detectorContext = detectorCanvas.getContext('2d');

async function runDetection() {
  if (state.detBusy || !state.source || !$('#auto-on').checked) return;
  const source = state.source;
  const moving = source.kind === 'video' || source.kind === 'live';
  const calibration = state.calib;
  const videoTime = video.currentTime;
  const region = moving ? scanRegion(source, calibration) : null;
  if (moving && (!region || video.seeking || video.readyState < 2)) return;
  state.detBusy = true;
  try {
    if (region) drawScanRegion(detectorCanvas, detectorContext, source.el, region);
    const detections = await detector.detect(region ? detectorCanvas : source.el);
    if (source === state.source && calibration === state.calib && $('#auto-on').checked &&
        (source.kind !== 'video' || (!video.seeking && Math.abs(video.currentTime - videoTime) < 0.5))) {
      state.detections = region ? detections.map((detection) => {
        const [x, y, width, height] = detection.bbox;
        const scaleX = region.width / detectorCanvas.width;
        const scaleY = region.height / detectorCanvas.height;
        return {
          ...detection,
          bbox: [region.x + x * scaleX, region.y + y * scaleY, width * scaleX, height * scaleY],
        };
      }) : detections;
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
  const k = s.width / 960; // 線寬隨解析度縮放
  try { vctx.drawImage(s.el, 0, 0, s.width, s.height); } catch { return; }
  scanner.drawOverlay(vctx, k);
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
  if (state.pendingPoly) drawPoly(vctx, state.pendingPoly, { fill: 'rgba(255,225,77,0.35)', stroke: '#ffe14d', width: 3 * k });
  // 草稿
  if (state.draft.length) {
    drawLine(vctx, state.draft, '#ffe14d', 3 * k);
    state.draft.forEach((pt) => { vctx.fillStyle = '#ffe14d'; vctx.beginPath(); vctx.arc(pt[0], pt[1], 6 * k, 0, Math.PI * 2); vctx.fill(); });
  }
  // 結果：候選動線、瓶頸
  const r = state.source.kind === 'video' && (!video.paused || video.seeking) ? null : state.result;
  if (c && r?.path) drawLine(vctx, r.path.map((q) => groundToImage(c, [q.x, q.y])), '#22c55e', 8 * k);
  if (c && r?.bottleneck) {
    const { leftCm, rightCm } = state.grid?.corridor ?? p.corridor;
    drawLine(vctx, [groundToImage(c, [leftCm, r.bottleneck.yCm]), groundToImage(c, [rightCm, r.bottleneck.yCm])], '#ff3b30', 6 * k);
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
      if (video.currentTime !== lastVideoTime) {
        lastVideoTime = video.currentTime;
        dropStaleAnnotations();
        if (state.lastScan && video.currentTime - state.lastScan.frame > VIDEO_SCAN_MAX_LAG) {
          state.lastScan = null;
          markDirty();
        }
      }
    }
    const detectionInterval = s.kind === 'video' || s.kind === 'live' ? 1200 : 400;
    if ($('#auto-on').checked && now - lastDetRun > detectionInterval && (dyn || state.dirty)) {
      lastDetRun = now;
      runDetection();
    }
    if (s.kind !== 'live' && state.dirty) {
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
  // 地圖（討論08）：只是輔助，文字區仍是完整資訊；地圖載入失敗不影響其他功能
  const routeMap = createMap($('#route-map'), cfg, { note: $('#route-map-note') });
  const adminMap = createMap($('#admin-map'), cfg, { note: $('#admin-map-note'), includeCleared: false });
  adminMap.onMarkerClick((id) => {
    const card = document.querySelector(`#admin-list [data-event-id="${CSS.escape(id)}"]`);
    if (card) { card.scrollIntoView({ behavior: 'smooth', block: 'center' }); card.focus({ preventScroll: true }); }
  });
  initRoutePanel(cfg, voiceOn, undefined, { onRoute: (id) => routeMap.setRoute(id), onEvents: (events) => routeMap.setEvents(events) });
  admin = initAdminPanel(cfg, { onEvents: (events) => adminMap.setEvents(events) });
  drawBird();
  requestAnimationFrame(loop);
}
init();

// 供測試與除錯使用
window.__wuai = { state, params, analyze };
