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

test('漏辨識時標出連到近端的藍綠鋪面，忽略孤立色塊', () => {
  const road = segment('road', rect(0, 20, 7, 20));
  const pixels = { width: 20, height: 20, data: new Uint8ClampedArray(20 * 20 * 4) };
  const paint = (points) => points.forEach(([x, y]) => pixels.data.set([48, 122, 132, 255], (y * 20 + x) * 4));
  paint(rect(2, 6, 8, 13));
  assert.equal(summarizeScan([road], pixels).sidewalk, null);
  paint(rect(8, 14, 10, 20));
  const result = summarizeScan([road], pixels);
  assert.equal(result.painted, true);
  assert.equal(result.sidewalk.data[19 * 20 + 10], 255);
  assert.equal(result.sidewalk.data[10 * 20 + 3], 0);
});
