import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCalibration } from '../web/js/homography.js';
import { assessLiveScan, updateLiveReport } from '../web/js/live-scan.js';

const width = 200;
const height = 80;
const calibration = makeCalibration(
  [[0, 80], [199, 80], [199, 0], [0, 0]],
  { widthCm: 200, lengthCm: 80, nearCm: 0 },
  { width, height },
);
const wheelchair = { requiredCm: 90, startXCm: 0, cellCm: 5, marginCm: 5 };

function scene(label, left, right) {
  const sidewalk = { width, height, data: new Uint8Array(width * height).fill(255) };
  const mask = { width, height, data: new Uint8Array(width * height) };
  for (let y = 30; y <= 42; y++) {
    sidewalk.data.fill(0, y * width + left, y * width + right);
    mask.data.fill(255, y * width + left, y * width + right);
  }
  return { sidewalk, labels: [{ label, mask }], painted: false };
}

test('同一輛機車位於側邊或中間會得到不同輪椅通行結果', () => {
  const side = assessLiveScan(scene('motorcycle', 0, 50), calibration, wheelchair);
  assert.equal(side.result.status, 'CANDIDATE');
  const middle = assessLiveScan(scene('motorcycle', 70, 130), calibration, wheelchair);
  assert.equal(middle.result.status, 'BLOCKED');
  assert.equal(middle.obstacle.category, 'motorcycle');
});

test('只有疑似標線、行人遮擋或未校正時不判為確定受阻', () => {
  assert.equal(assessLiveScan(scene('person', 65, 135), calibration, wheelchair).result.status, 'UNKNOWN');
  assert.equal(assessLiveScan({ ...scene('car', 60, 140), painted: true }, calibration, wheelchair).result.status, 'UNKNOWN');
  assert.equal(assessLiveScan(scene('car', 60, 140), null, wheelchair).result.status, 'UNKNOWN');
});

test('連續三次受阻才詢問，持續受阻或偶爾看不清時不重複詢問', () => {
  let state;
  const flags = ['BLOCKED', 'BLOCKED', 'UNKNOWN', 'BLOCKED', 'BLOCKED', 'BLOCKED', 'UNKNOWN',
    'BLOCKED', 'BLOCKED', 'BLOCKED', 'CANDIDATE', 'CANDIDATE', 'BLOCKED', 'BLOCKED', 'BLOCKED']
    .map((status) => (state = updateLiveReport(state, status)).shouldPrompt);
  assert.deepEqual(flags.flatMap((flag, index) => flag ? [index] : []), [5, 14]);
});
