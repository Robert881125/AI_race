const runtimeUrl = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/transformers.min.js';
const modelId = 'Xenova/segformer-b0-finetuned-cityscapes-512-1024';
const modelRevision = '18b12204d4c787afb8df24e49efc36a20d9f16d0';
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

export function summarizeScan(segments, pixels) {
  let sidewalk = segments.find(({ label }) => label === 'sidewalk')?.mask;
  const area = sidewalk?.data.reduce((count, pixel) => count + (pixel > 0), 0) ?? 0;
  const painted = !sidewalk || area < Math.max(4, sidewalk.width * sidewalk.height * 0.0025);
  if (painted) sidewalk = findPaintedLane(pixels, segments.find(({ label }) => label === 'road')?.mask);
  if (!sidewalk) return { sidewalk: null, possibleObstacles: [], painted: false };
  const { width, height, data } = sidewalk;

  const possibleObstacles = segments.filter(({ label, mask }) => {
    if (!obstacleNames.has(label) || mask.width !== width || mask.height !== height) return false;
    const firstRow = Math.floor(height * 0.45);
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

let loading;
let modelReady = false;

function loadModel() {
  if (!loading) {
    loading = (async () => {
      const { env, pipeline, RawImage } = await import(runtimeUrl);
      env.allowLocalModels = false;
      env.backends.onnx.wasm.numThreads = 1;
      const segment = await pipeline('image-segmentation', modelId, {
        revision: modelRevision, device: 'wasm', dtype: 'q8',
      });
      modelReady = true;
      return { segment, RawImage };
    })().catch((error) => { loading = null; throw error; });
  }
  return loading;
}

export function createSidewalkScanner({ status, preview, button, onResult, onFailure }) {
  let source = null;
  let busy = false;
  let failed = false;
  let nextScanAt = 0;
  let lastFrame = null;
  const snapshot = document.createElement('canvas');
  const ctx = snapshot.getContext('2d', { willReadFrequently: true });

  function setSource(next) {
    source = next?.kind === 'demo' ? null : next;
    failed = false;
    nextScanAt = 0;
    lastFrame = null;
    preview.hidden = true;
    button.disabled = !source;
    status.textContent = source
      ? '準備自動掃描人行道，首次使用需要下載模型。'
      : next ? '目前為內建示範，通行結果使用預設標註。' : '選擇照片、影片或開啟鏡頭後會自動掃描。';
  }

  async function tick(now) {
    const current = source;
    if (!current || busy || failed || now < nextScanAt) return;
    const video = current.kind !== 'image';
    if (video && current.el.readyState < 2) return;
    const frame = video ? current.el.currentTime : 0;
    if (frame === lastFrame) return;
    busy = true;
    lastFrame = frame;
    const capturedAt = performance.now();
    try {
      const scale = Math.min(1, 512 / Math.max(current.width, current.height));
      snapshot.width = Math.max(1, Math.round(current.width * scale));
      snapshot.height = Math.max(1, Math.round(current.height * scale));
      ctx.drawImage(current.el, 0, 0, snapshot.width, snapshot.height);
      const pixels = ctx.getImageData(0, 0, snapshot.width, snapshot.height);
      status.textContent = modelReady ? '正在掃描人行道…' : '正在下載及載入人行道模型…';
      const { segment, RawImage } = await loadModel();
      if (source !== current) return;
      status.textContent = '正在掃描人行道…';
      const labels = await segment(new RawImage(pixels.data, pixels.width, pixels.height, 4));
      if (source !== current) return;
      const { sidewalk, possibleObstacles, painted } = summarizeScan(labels, pixels);
      preview.width = snapshot.width;
      preview.height = snapshot.height;
      const output = preview.getContext('2d');
      output.drawImage(snapshot, 0, 0);
      if (sidewalk) {
        const layer = document.createElement('canvas');
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
      preview.hidden = false;
      const scene = painted ? '已標示疑似藍綠色人行標線區（黃色），路面用途待確認。'
        : sidewalk ? '已標示可見的人行道（綠色）。' : '此影格沒有足夠的人行道辨識證據。';
      const obstacles = possibleObstacles.length ? `疑似靠近人行道的物體：${possibleObstacles.join('、')}。` : '';
      const time = current.kind === 'video' ? `影片 ${frame.toFixed(1)} 秒。\n` : '';
      const widthHint = current.kind === 'live' ? '' : ' 通行淨寬待確認。';
      status.textContent = `掃描完成。${time}${scene}${obstacles}${widthHint}`;
      onResult?.({ labels, sidewalk, painted, capturedAt, snapshot, source: current });
    } catch (error) {
      if (source !== current) return;
      failed = true;
      preview.hidden = true;
      status.textContent = '人行道掃描失敗。請檢查網路及瀏覽器，再按「重新掃描」。';
      console.warn('Sidewalk scan failed', error);
      onFailure?.(current);
    } finally {
      busy = false;
      if (source === current) nextScanAt = performance.now() + 1500;
    }
  }

  button.addEventListener('click', () => {
    failed = false;
    nextScanAt = 0;
    lastFrame = null;
    void tick(performance.now());
  });
  return { setSource, tick };
}
