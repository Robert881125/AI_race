import { groundToImage } from './homography.js?v=review-1';

export const NEAR_LIMIT_CM = 400;

export function nearScanRange(calibration) {
  const { nearCm, lengthCm } = calibration.rect;
  const endCm = Math.min(NEAR_LIMIT_CM, nearCm + lengthCm);
  return endCm > nearCm ? { startCm: nearCm, endCm } : null;
}

export function scanRegion({ kind, width, height }, calibration) {
  if (kind !== 'video' && kind !== 'live') return { x: 0, y: 0, width, height, endCm: null };
  if (!calibration) {
    const x = Math.floor(width * 0.08);
    const y = Math.floor(height * 0.45);
    return { x, y, width: width - 2 * x, height: height - y, endCm: null };
  }

  const range = nearScanRange(calibration);
  if (!range) return null;
  const half = calibration.rect.widthCm / 2;
  const corners = [range.startCm, range.endCm].flatMap((distance) =>
    [-half, half].map((x) => groundToImage(calibration, [x, distance])));
  if (corners.some((point) => !point || !point.every(Number.isFinite))) return null;
  const xs = corners.map(([x]) => x);
  const ys = corners.map(([, y]) => y);
  const x = Math.max(0, Math.floor(Math.min(...xs)));
  const y = Math.max(0, Math.floor(Math.min(...ys)));
  const right = Math.min(width, Math.ceil(Math.max(...xs)));
  const bottom = Math.min(height, Math.ceil(Math.max(...ys)));
  if (right <= x || bottom <= y) return null;
  return { x, y, width: right - x, height: bottom - y, endCm: range.endCm };
}

export function drawScanRegion(canvas, context, frame, { x, y, width, height }) {
  const scale = Math.min(1, 512 / Math.max(width, height));
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  context.drawImage(frame, x, y, width, height, 0, 0, canvas.width, canvas.height);
}
