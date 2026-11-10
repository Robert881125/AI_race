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

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector(`script[src="${src}"]`)) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.crossOrigin = 'anonymous';
    s.onload = resolve;
    s.onerror = () => reject(new Error('無法載入 ' + src));
    document.head.appendChild(s);
  });
}

export function load() {
  if (model) return Promise.resolve(model);
  if (!loading) {
    loading = (async () => {
      await loadScript(TFJS);
      await loadScript(COCO);
      model = await window.cocoSsd.load({ base: 'lite_mobilenet_v2' });
      return model;
    })().catch((e) => { loading = null; throw e; });
  }
  return loading;
}

export async function detect(el) {
  const m = await load();
  const preds = await m.detect(el, 20, 0.45);
  return preds.map((p) => {
    const [label, category, isObstacle] = CLASS_MAP[p.class] || ['物品', 'other', false];
    return { bbox: p.bbox, cls: p.class, score: p.score, label, category, isObstacle };
  });
}
