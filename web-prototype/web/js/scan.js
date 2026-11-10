import { drawScanRegion, scanRegion } from './scan-region.js?v=video-1';

const obstacleNames = new Map([
  ['person', '行人'], ['rider', '騎乘者'], ['bicycle', '自行車'], ['motorcycle', '機車'],
  ['car', '汽車'], ['truck', '貨車'], ['bus', '公車'],
]);

function findPaintedLane(pixels, road) {
  if (!pixels || !road || road.width !== pixels.width || road.height !== pixels.height) return null;
  const { width, height, data } = pixels;
  const candidate = new Uint8Array(width * height);
  for (let i = Math.floor(height * 0.33) * width; i < candidate.length; i++) {
    if (!road.data[i]) continue;
    const [r, g, b] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    if (g > r + 14 && b > r + 12 && Math.abs(g - b) < (g + b) * 0.18) candidate[i] = 1;
  }
  const queue = new Int32Array(candidate.length);
  let largest = Math.max(4, width * height * 0.015);
  let result = null;
  // 只採用連到畫面近端、由下往前延伸的連續塗色區。
  for (let y = Math.floor(height * 0.85); y < height; y++) {
    for (let x = Math.floor(width * 0.25); x < width * 0.75; x++) {
      const seed = y * width + x;
      if (!candidate[seed]) continue;
      let end = 1;
      let minRow = y;
      queue[0] = seed;
      candidate[seed] = 0;
      for (let start = 0; start < end; start++) {
        const i = queue[start];
        const col = i % width;
        minRow = Math.min(minRow, Math.floor(i / width));
        const neighbors = [i - width, i + width];
        if (col > 0) neighbors.push(i - 1);
        if (col < width - 1) neighbors.push(i + 1);
        for (const j of neighbors) {
          if (!candidate[j]) continue;
          candidate[j] = 0;
          queue[end++] = j;
        }
      }
      if (minRow >= height * 0.72 || end < largest) continue;
      largest = end;
      result = new Uint8Array(candidate.length);
      for (let j = 0; j < end; j++) result[queue[j]] = 255;
    }
  }
  return result ? { width, height, data: result } : null;
}

export function summarizeScan(segments, pixels, nearOnly = false) {
  let sidewalk = segments.find(({ label }) => label === 'sidewalk')?.mask;
  const area = sidewalk?.data.reduce((count, pixel) => count + (pixel > 0), 0) ?? 0;
  const painted = !sidewalk || area < Math.max(4, sidewalk.width * sidewalk.height * 0.0025);
  if (painted) sidewalk = findPaintedLane(pixels, segments.find(({ label }) => label === 'road')?.mask);
  if (!sidewalk) return { sidewalk: null, possibleObstacles: [], painted: false };
  const { width, height, data } = sidewalk;

  const possibleObstacles = segments.filter(({ label, mask }) => {
    if (!obstacleNames.has(label) || mask.width !== width || mask.height !== height) return false;
    const firstRow = nearOnly ? 0 : Math.floor(height * 0.45);
    const contactDepth = Math.max(1, Math.round(height * 0.025));
    let adjoiningColumns = 0;
    for (let x = 0; x < width; x++) {
      let y = height - 1;
      while (y >= firstRow && mask.data[y * width + x] === 0) y--;
      let contact = false;
      if (y >= firstRow) {
        for (let row = y + 1; row <= Math.min(y + contactDepth, height - 1); row++) {
          if (data[row * width + x] > 0) { contact = true; break; }
        }
      }
      adjoiningColumns = contact ? adjoiningColumns + 1 : 0;
      if (adjoiningColumns >= Math.max(3, Math.ceil(width * 0.012))) return true;
    }
    return false;
  }).map(({ label }) => obstacleNames.get(label));
  return { sidewalk, possibleObstacles, painted };
}

export function canDrawScanMask(scan, source) {
  if (!scan?.layer) return false;
  if (source.kind === 'image') return true;
  return source.kind === 'video' && source.el.paused && !source.el.seeking &&
    Math.abs(source.el.currentTime - scan.frame) < 0.05;
}

export function createSidewalkScanner({ status, preview, button, details, getCalibration, captureEvidence, onResult, onFailure }) {
  let worker = null;
  let modelReady = false;
  function segment(pixels) {
    if (!worker) worker = new Worker(new URL('./scan-worker.js?v=video-1', import.meta.url), { type: 'module' });
    return new Promise((resolve, reject) => {
      worker.onmessage = ({ data }) => {
        if (data.error) reject(new Error(data.error));
        else resolve(data.labels);
      };
      worker.onerror = (event) => {
        worker.terminate();
        worker = null;
        modelReady = false;
        reject(new Error(event.message || '無法啟動背景掃描'));
      };
      worker.postMessage(pixels);
    });
  }
  let source = null;
  let busy = false;
  let failed = false;
  let nextScanAt = 0;
  let lastFrame = null;
  let generation = 0;
  let lastCalibration = null;
  let activeRegion = null;
  let recent = null;
  const snapshot = document.createElement('canvas');
  const ctx = snapshot.getContext('2d', { willReadFrequently: true });

  function setSource(next) {
    source = next?.kind === 'demo' ? null : next;
    lastCalibration = null;
    activeRegion = source ? scanRegion(source, null) : null;
    details.hidden = true;
    details.open = false;
    reset();
    button.disabled = !source;
    if (!source) status.textContent = next
      ? '目前為內建示範，通行結果使用預設標註。' : '選擇照片、影片或開啟鏡頭後會自動掃描。';
  }

  function reset() {
    generation++;
    failed = false;
    nextScanAt = 0;
    lastFrame = null;
    recent = null;
    preview.hidden = true;
    if (source) status.textContent = '準備掃描人行道，首次使用需要下載模型。';
  }

  function drawOverlay(context, scale) {
    if (!source) return;
    if (canDrawScanMask(recent, source)) {
      const { x, y, width, height } = recent.region;
      context.drawImage(recent.layer, x, y, width, height);
    }
    if (source.kind === 'image' || !activeRegion) return;
    const { x, y, width, height } = activeRegion;
    context.save();
    context.strokeStyle = '#10202b';
    context.lineWidth = 7 * scale;
    context.strokeRect(x, y, width, height);
    context.strokeStyle = '#40e0ff';
    context.lineWidth = 4 * scale;
    context.strokeRect(x, y, width, height);
    context.restore();
  }

  async function tick(now) {
    const current = source;
    if (!current) return;
    const isVideo = current.kind !== 'image';
    const calibration = isVideo ? getCalibration?.() ?? null : null;
    if (calibration !== lastCalibration) {
      lastCalibration = calibration;
      activeRegion = scanRegion(current, calibration);
      reset();
    }
    if (busy || failed || now < nextScanAt) return;
    if (isVideo && (current.el.readyState < 2 || current.el.seeking)) return;
    const frame = isVideo ? current.el.currentTime : 0;
    if (frame === lastFrame) return;
    lastFrame = frame;
    const region = activeRegion;
    if (!region) {
      status.textContent = '校正範圍沒有落在前方 4 公尺內的可見路面，請重做地面校正。';
      return;
    }
    busy = true;
    const capturedAt = performance.now();
    const request = generation;
    try {
      drawScanRegion(snapshot, ctx, current.el, region);
      const pixels = ctx.getImageData(0, 0, snapshot.width, snapshot.height);
      const evidence = captureEvidence?.(current);
      if (preview.hidden) status.textContent = modelReady ? '正在掃描人行道…' : '正在載入模型並掃描人行道…';
      const labels = await segment(pixels);
      modelReady = true;
      if (request !== generation || (isVideo && current.el.seeking)) return;
      const { sidewalk, possibleObstacles, painted } = summarizeScan(labels, pixels, isVideo);
      preview.width = snapshot.width;
      preview.height = snapshot.height;
      const output = preview.getContext('2d');
      output.drawImage(snapshot, 0, 0);
      let layer = null;
      if (sidewalk) {
        layer = document.createElement('canvas');
        layer.width = sidewalk.width;
        layer.height = sidewalk.height;
        const layerContext = layer.getContext('2d');
        const image = layerContext.createImageData(layer.width, layer.height);
        const color = painted ? [255, 203, 38, 140] : [0, 230, 145, 125];
        for (let i = 0; i < sidewalk.data.length; i++) {
          if (sidewalk.data[i] > 0) image.data.set(color, i * 4);
        }
        layerContext.putImageData(image, 0, 0);
        output.drawImage(layer, 0, 0, preview.width, preview.height);
      }
      recent = { frame, layer, region };
      preview.hidden = false;
      details.hidden = false;
      const scene = painted ? '已標示疑似藍綠色人行標線區（黃色），路面用途待確認。'
        : sidewalk ? '已標示可見的人行道（綠色）。' : '這一格未辨識到足夠的人行道特徵，通行狀態待確認。';
      const obstacles = possibleObstacles.length ? `疑似靠近人行道的物體：${possibleObstacles.join('、')}。` : '';
      const time = current.kind === 'video' ? `影片 ${frame.toFixed(1)} 秒。\n` : '';
      const widthHint = current.kind === 'live' || !sidewalk ? '' : ' 通行淨寬待確認。';
      const scope = !isVideo ? '' : region.endCm === null
        ? '範圍：畫面近端（尚未校正距離）。'
        : '範圍：校正區內，最遠前方 ' + (region.endCm / 100).toFixed(1) + ' 公尺。';
      status.textContent = `掃描完成。${time}${scope}${scene}${obstacles}${widthHint}`;
      onResult?.({ labels, sidewalk, painted, capturedAt, region, snapshot: evidence ?? snapshot, source: current });
    } catch (error) {
      if (request !== generation) return;
      failed = true;
      recent = null;
      preview.hidden = true;
      status.textContent = '人行道掃描失敗。請檢查網路及瀏覽器，再按「重新掃描」。';
      console.warn('Sidewalk scan failed', error);
      onFailure?.(current);
    } finally {
      busy = false;
      if (request === generation) nextScanAt = performance.now() + 1500;
    }
  }

  button.addEventListener('click', () => {
    reset();
    void tick(performance.now());
  });
  return { setSource, reset, tick, drawOverlay };
}
