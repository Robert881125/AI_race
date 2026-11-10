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

// 使用者回報「掃描不到障礙物」：台灣騎樓、人行道常被街景模型標成 road
function roadScene(label, left, right) {
  const road = { width, height, data: new Uint8Array(width * height).fill(255) };
  const mask = { width, height, data: new Uint8Array(width * height) };
  for (let y = 30; y <= 42; y++) {
    road.data.fill(0, y * width + left, y * width + right);
    mask.data.fill(255, y * width + left, y * width + right);
  }
  return { sidewalk: null, labels: [{ label: 'road', mask: road }, { label, mask }], painted: false };
}

test('校正區內被標成 road 的地面也算地面：機車在中間判為受阻、在側邊有候選動線', () => {
  const middle = assessLiveScan(roadScene('motorcycle', 70, 130), calibration, wheelchair);
  assert.equal(middle.result.status, 'BLOCKED');
  assert.equal(middle.obstacle.category, 'motorcycle');
  assert.equal(assessLiveScan(roadScene('motorcycle', 0, 50), calibration, wheelchair).result.status, 'CANDIDATE');
});

test('完全沒有 sidewalk 也沒有 road 時仍是無法確認', () => {
  const r = assessLiveScan({ sidewalk: null, labels: [], painted: false }, calibration, wheelchair);
  assert.equal(r.result.status, 'UNKNOWN');
  assert.equal(r.result.reason, 'NO_GROUND_EVIDENCE');
});

test('使用者圈的範圍可修正 AI 結果：圈障礙物 → 受阻；把 AI 看不清的地方圈成可用地面 → 有候選動線', () => {
  // AI 看到整片地面都可用
  const clear = { sidewalk: { width, height, data: new Uint8Array(width * height).fill(255) }, labels: [], painted: false };
  assert.equal(assessLiveScan(clear, calibration, wheelchair).result.status, 'CANDIDATE');
  // 使用者在中間圈了一個貼地的箱子（地面座標，公分）
  const box = [[-35, 30], [35, 30], [35, 45], [-35, 45]];
  const withBox = assessLiveScan(clear, calibration, wheelchair, { blockedGround: [box] });
  assert.equal(withBox.result.status, 'BLOCKED');
  // AI 完全沒看到地面（全是未知），使用者把整片圈成可用地面
  const blind = { sidewalk: { width, height, data: new Uint8Array(width * height).fill(0) }, labels: [{ label: 'road', mask: { width, height, data: new Uint8Array(width * height) } }], painted: false };
  assert.notEqual(assessLiveScan(blind, calibration, wheelchair).result.status, 'CANDIDATE');
  const whole = [[0, 0], [width, 0], [width, height], [0, height]];
  assert.equal(assessLiveScan(blind, calibration, wheelchair, { freeImage: [whole] }).result.status, 'CANDIDATE');
});
