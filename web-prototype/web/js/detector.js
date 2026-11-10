// 自動偵測（模型推估）：在瀏覽器跑通用物件偵測模型 COCO-SSD。
// 只用來 (1) 說出「那是什麼」 (2) 以偵測框底邊近似貼地前緣、框內畫面當作遮擋。
// 精確的路面與障礙範圍，之後依討論04 換成本地標註訓練的分割模型。
// 第一次開啟需要網路下載程式庫與模型權重。

const TFJS = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.22.0/dist/tf.min.js';
const COCO = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/coco-ssd@2.2.3/dist/coco-ssd.min.js';

// [中文名稱, 回報類別, 是否當作阻隔]
const CLASS_MAP = {
  motorcycle: ['機車', 'motorcycle', true],
  bicycle: ['自行車', 'bicycle', true],
  car: ['汽車', 'other', true],
  truck: ['貨車', 'other', true],
  chair: ['椅子', 'goods', true],
  bench: ['長椅', 'goods', true],
  'potted plant': ['盆栽', 'goods', true],
  suitcase: ['行李箱', 'goods', true],
  'fire hydrant': ['消防栓', 'other', true],
  'stop sign': ['標誌', 'sign', true],
  'parking meter': ['停車收費柱', 'other', true],
  'dining table': ['桌子', 'goods', true],
  backpack: ['背包', 'goods', true],
  handbag: ['袋子', 'goods', true],
  umbrella: ['雨傘', 'goods', true],
  bottle: ['瓶子', 'goods', true],
  person: ['行人', 'other', false], // 會移動：只當遮擋，不當阻隔
  dog: ['狗', 'other', false],
};

let model = null;
let loading = null;
let tfReady = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => {
      s.remove();
      reject(new Error('無法載入 ' + src));
    };
    document.head.appendChild(s);
  });
}

function loadTensorflow() {
  tfReady ??= (async () => {
    if (!window.tf) await loadScript(TFJS);
    await window.tf.ready();
  })().catch((error) => { tfReady = null; throw error; });
  return tfReady;
}

export async function hasAcceleration() {
  await loadTensorflow();
  return ['webgl', 'webgpu'].includes(window.tf.getBackend());
}

export function load() {
  if (model) return Promise.resolve(model);
  if (!loading) {
    loading = (async () => {
      await loadTensorflow();
      if (!window.cocoSsd) await loadScript(COCO);
      model = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
      return model;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

/**
 * maxSide（可省略）：先把畫面縮到長邊 maxSide 像素再偵測，框再換算回原尺寸。
 * 模型內部本來就只用約 300 像素；沒有 GPU 加速的電腦上，大畫面會讓整個頁面卡住好幾秒。
 */
const small = typeof document !== 'undefined' ? document.createElement('canvas') : null;
export async function detect(el, minScore = 0.45, { maxSide = null } = {}) {
  const m = await load();
  const w = el.videoWidth || el.naturalWidth || el.width;
  const h = el.videoHeight || el.naturalHeight || el.height;
  let input = el;
  let k = 1;
  if (maxSide && small && Math.max(w, h) > maxSide) {
    k = maxSide / Math.max(w, h);
    small.width = Math.max(1, Math.round(w * k));
    small.height = Math.max(1, Math.round(h * k));
    small.getContext('2d').drawImage(el, 0, 0, small.width, small.height);
    input = small;
  }
  const preds = await m.detect(input, 20, minScore);
  return preds.map((p) => {
    const [label, category, isObstacle] = CLASS_MAP[p.class] || ['物品', 'other', false];
    const bbox = k === 1 ? p.bbox : p.bbox.map((v) => v / k);
    return { bbox, cls: p.class, score: p.score, label, category, isObstacle };
  });
}
