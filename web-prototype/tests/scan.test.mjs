import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeScan } from '../web/js/scan.js';

function segment(label, points) {
  const width = 20;
  const height = 20;
  const data = new Uint8Array(width * height);
  for (const [x, y] of points) data[y * width + x] = 255;
  return { label, mask: { width, height, data } };
}

const rect = (left, right, top, bottom) =>
  Array.from({ length: (right - left) * (bottom - top) }, (_, i) => [
    left + i % (right - left), top + Math.floor(i / (right - left)),
  ]);

test('只有車道或零星像素時，不宣稱掃描到人行道', () => {
  assert.equal(summarizeScan([segment('road', rect(0, 20, 10, 20))]).sidewalk, null);
  assert.equal(summarizeScan([segment('sidewalk', [[12, 16]])]).sidewalk, null);
});

test('辨識前方人行道，車道上的車不算疑似占用', () => {
  const sidewalk = segment('sidewalk', rect(4, 12, 13, 20));
  const car = segment('car', rect(13, 19, 8, 16));
  assert.equal(summarizeScan([sidewalk, car]).sidewalk, sidewalk.mask);
  assert.deepEqual(summarizeScan([sidewalk, car]).possibleObstacles, []);
});

test('物體貼地位置鄰接人行道時，標示疑似占用', () => {
  const sidewalk = segment('sidewalk', rect(4, 12, 13, 20));
  const bicycle = segment('bicycle', rect(6, 10, 9, 13));
  assert.deepEqual(summarizeScan([sidewalk, bicycle]).possibleObstacles, ['自行車']);
});
