import { assess, buildGrid, pointInPolygon, FREE, BLOCKED, UNKNOWN } from './assess.js?v=review-1';

import { nearScanRange } from './scan-region.js?v=video-1';

const staticObstacles = new Map([
  ['bicycle', { label: '自行車', category: 'bicycle' }],
  ['motorcycle', { label: '機車', category: 'motorcycle' }],
  ['car', { label: '車輛', category: 'other' }],
  ['truck', { label: '貨車', category: 'other' }],
  ['bus', { label: '公車', category: 'other' }],
]);

/**
 * 地面＝模型標成 sidewalk 或 road 的像素。
 * 街景模型（歐洲街道訓練）常把台灣的騎樓、人行道水泥面標成 road（討論：使用者回報掃描不到障礙物，
 * 實測照片的近端地面 38% 被標成 road、只有 5.5% 是 sidewalk）。校正矩形已由使用者確認是要走的路面，
 * 所以在校正範圍內兩者都當作地面；障礙物仍只認機車、汽車等類別。
 */
function groundMask(labels, sidewalk) {
  const road = labels.find(({ label }) => label === 'road')?.mask;
  const base = sidewalk ?? road;
  if (!base) return null;
  const { width, height } = base;
  if (!sidewalk || !road || road.width !== width || road.height !== height) return base;
  const data = new Uint8Array(width * height);
  for (let i = 0; i < data.length; i++) {
    data[i] = sidewalk.data[i] || road.data[i] ? 255 : 0;
  }
  return { width, height, data };
}

/**
 * overrides（可省略）：使用者在照片／暫停影片上圈的範圍，用來修正 AI 掃描結果
 *  - freeImage：圈成「可用地面」（影像座標）→ 可用
 *  - unknownImage：圈成「看不清楚」→ 未知
 *  - blockedGround：圈成「障礙物」（地面座標）→ 阻隔
 */
export function assessLiveScan({ labels, sidewalk, painted, region }, calib, options, overrides = {}) {
  const { freeImage = [], unknownImage = [], blockedGround = [] } = overrides;
  const range = calib && nearScanRange(calib);
  const ground = range && !painted && groundMask(labels, sidewalk);
  if (!ground) {
    return {
      grid: null,
      result: { ...assess(null, options), reason: range ? 'NO_GROUND_EVIDENCE' : 'OUTSIDE_CALIBRATION' },
      obstacle: null,
    };
  }
  const { width, height, data } = ground;
  const { width: imageWidth, height: imageHeight } = calib.imageSize;
  const { widthCm } = calib.rect;
  const crop = region ?? { x: 0, y: 0, width: imageWidth, height: imageHeight };
  const obstacles = labels.filter(({ label, mask }) =>
    staticObstacles.has(label) && mask.width === width && mask.height === height);
  const contactDepth = Math.max(2, Math.round(height * 0.015));
  const touched = new Set();
  const grid = buildGrid({
    calib,
    corridor: { leftCm: -widthCm / 2, rightCm: widthCm / 2 },
    range,
    cellCm: options.cellCm,
    marginCm: options.marginCm,
    blockedGround,
    sampleImage([u, v]) {
      if (unknownImage.some((poly) => pointInPolygon([u, v], poly))) return UNKNOWN;
      if (freeImage.some((poly) => pointInPolygon([u, v], poly))) return FREE;
      const x = Math.floor((u - crop.x) / crop.width * width);
      const y = Math.floor((v - crop.y) / crop.height * height);
      if (x < 0 || y < 0 || x >= width || y >= height) return UNKNOWN;
      const index = y * width + x;
      if (data[index]) return FREE;
      if (x < 1 || x >= width - 1) return UNKNOWN;
      const obstacle = obstacles.find(({ mask }) =>
        mask.data[index - 1] && mask.data[index] && mask.data[index + 1]);
      if (!obstacle) return UNKNOWN;
      for (let row = y + 1; row < height && row <= y + contactDepth; row++) {
        if (!data[row * width + x]) continue;
        touched.add(obstacle.label);
        return BLOCKED;
      }
      return UNKNOWN;
    },
  });
  if (grid) grid.widthErrorCm = 2 * options.marginCm;
  const result = assess(grid, options);
  const obstacle = touched.size === 1 ? staticObstacles.get([...touched][0]) : null;
  return { grid, result, obstacle };
}

export function updateLiveReport(previous, status) {
  const blocked = status === 'BLOCKED' ? (previous?.blocked ?? 0) + 1 : 0;
  const clear = status === 'CANDIDATE' ? (previous?.clear ?? 0) + 1 : 0;
  const wasPrompted = !!previous?.prompted && clear < 2;
  const shouldPrompt = blocked >= 3 && !wasPrompted;
  return { blocked, clear, prompted: wasPrompted || shouldPrompt, shouldPrompt };
}
