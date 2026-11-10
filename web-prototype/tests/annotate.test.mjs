// 合併後的「標註」流程：校正四角 → 圈範圍 → 選種類
import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateStep, annotateHint, CALIB_NAMES, KIND_TEXT } from '../web/js/annotate.js';

const calib = { ok: true };
const four = [[0, 0], [1, 0], [1, 1], [0, 1]];

test('還沒校正（或校正失敗）→ 第 1 步點四角', () => {
  assert.equal(annotateStep({ calibPts: [], calib: null }), 'calib');
  assert.equal(annotateStep({ calibPts: four.slice(0, 3), calib: null }), 'calib');
  assert.equal(annotateStep({ calibPts: four, calib: null }), 'calib', '四點交叉等校正失敗時要重點');
});

test('校正完成 → 第 2 步圈範圍；圈好 → 第 3 步選種類', () => {
  assert.equal(annotateStep({ calibPts: four, calib }), 'draw');
  assert.equal(annotateStep({ calibPts: four, calib, pending: [[0, 0], [1, 0], [1, 1]] }), 'choose');
});

test('提示會說下一個要點哪個角、已點幾個', () => {
  const h = annotateHint('calib', { calibCount: 2 });
  assert.match(h, new RegExp(CALIB_NAMES[2]));
  assert.match(h, /2／4/);
  assert.match(annotateHint('draw', { draftCount: 0 }), /AI 掃描/, '不圈也可以，系統會用 AI 掃描判斷');
  assert.match(annotateHint('draw', { draftCount: 4 }), /已點 4 點/);
  assert.match(annotateHint('draw', { live: true }), /即時鏡頭/);
  assert.match(annotateHint('choose'), /是什麼/);
});

test('三種範圍都有名稱', () => {
  assert.deepEqual(Object.keys(KIND_TEXT).sort(), ['floor', 'obstacle', 'occluder']);
});
