import { assess, buildGrid, FREE, BLOCKED, UNKNOWN } from './assess.js?v=live-width-1';

const staticObstacles = new Map([
  ['bicycle', { label: '自行車', category: 'bicycle' }],
  ['motorcycle', { label: '機車', category: 'motorcycle' }],
  ['car', { label: '車輛', category: 'other' }],
  ['truck', { label: '貨車', category: 'other' }],
  ['bus', { label: '公車', category: 'other' }],
]);

export function assessLiveScan({ labels, sidewalk, painted }, calib, options) {
  if (!calib || !sidewalk || painted) {
    return {
      grid: null,
      result: { ...assess(null, options), reason: calib ? 'NO_GROUND_EVIDENCE' : 'OUTSIDE_CALIBRATION' },
      obstacle: null,
    };
  }
  const { width, height, data } = sidewalk;
  const { width: imageWidth, height: imageHeight } = calib.imageSize;
  const { widthCm, nearCm, lengthCm } = calib.rect;
  const obstacles = labels.filter(({ label, mask }) =>
    staticObstacles.has(label) && mask.width === width && mask.height === height);
  const contactDepth = Math.max(2, Math.round(height * 0.015));
  const touched = new Set();
  const grid = buildGrid({
    calib,
    corridor: { leftCm: -widthCm / 2, rightCm: widthCm / 2 },
    range: { startCm: nearCm, endCm: nearCm + lengthCm },
    cellCm: options.cellCm,
    marginCm: options.marginCm,
    sampleImage([u, v]) {
      const x = Math.floor(u / imageWidth * width);
      const y = Math.floor(v / imageHeight * height);
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
