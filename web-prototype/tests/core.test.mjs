// 執行：node --test web-prototype/tests
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildGrid, assess } from '../web/js/assess.js';
import { makeCalibration, imageToGround, groundToImage } from '../web/js/homography.js';
import { classifyConsent } from '../web/js/intent.js';
import { createDemoStore, eventState } from '../web/js/api.js';

const rect = (x0, x1, y0, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
const base = { corridor: { leftCm: -100, rightCm: 100 }, range: { startCm: 0, endCm: 200 }, cellCm: 5 };
const wheelchair = { requiredCm: 90, startXCm: 0 };

// ── 討論04 驗收案例（手工格網） ──
test('淨空走廊 → 有候選動線', () => {
  const r = assess(buildGrid({ ...base }), wheelchair);
  assert.equal(r.status, 'CANDIDATE');
  assert.ok(r.path.length > 0);
});

test('紙箱靠一側、另一側全程夠寬 → 有候選動線', () => {
  const g = buildGrid({ ...base, blockedGround: [rect(40, 100, 80, 120)] });
  const r = assess(g, wheelchair);
  assert.equal(r.status, 'CANDIDATE');
  assert.ok(r.path.every((p) => p.x < 40), '動線要繞過紙箱');
});

test('紙箱放中間、左右各自不足 → 通行空間不足', () => {
  const g = buildGrid({ ...base, blockedGround: [rect(-30, 30, 80, 120)] });
  const r = assess(g, wheelchair);
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.reason, 'NARROW_CROSS_SECTION');
  assert.ok(r.bottleneck.yCm >= 80 && r.bottleneck.yCm <= 120);
});

test('兩處空隙各自夠寬但接不起來 → 無法確認', () => {
  const g = buildGrid({
    ...base,
    marginCm: 0,
    blockedGround: [rect(-100, 0, 60, 80), rect(0, 100, 100, 120)],
  });
  const r = assess(g, wheelchair);
  assert.equal(r.status, 'UNKNOWN');
});

test('窄縫剛好在門檻附近（誤差跨過門檻）→ 無法確認', () => {
  const g = buildGrid({ ...base, marginCm: 5, blockedGround: [rect(-100, -45, 80, 120), rect(45, 100, 80, 120)] });
  const r = assess(g, wheelchair);
  assert.equal(r.status, 'UNKNOWN');
});

test('唯一可能的動線經過未知區 → 無法確認（遮擋）', () => {
  const g = buildGrid({
    ...base,
    blockedGround: [rect(-100, -10, 80, 120)],
    unknownGround: [rect(-10, 100, 80, 160)],
  });
  const r = assess(g, wheelchair);
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'OCCLUDED');
});

test('沒有校正 → 無法確認', () => {
  const r = assess(null, wheelchair);
  assert.equal(r.status, 'UNKNOWN');
  assert.equal(r.reason, 'OUTSIDE_CALIBRATION');
});

// ── 校正：影像 ↔ 地面 ──
test('橫跨通道的薄障礙落在採樣列之間也不會產生候選動線', () => {
  const grid = buildGrid({ ...base, blockedGround: [rect(-100, 100, 49, 51)] });
  assert.notEqual(assess(grid, wheelchair).status, 'CANDIDATE');
});

test('四點交叉或尺寸無效時拒絕校正', () => {
  const size = { width: 1280, height: 720 };
  const measure = { widthCm: 120, lengthCm: 200, nearCm: 50 };
  assert.equal(makeCalibration([[300, 680], [980, 680], [480, 300], [800, 300]], measure, size), null);
  assert.equal(makeCalibration([[100, 600], [1100, 600], [100, 200], [1100, 200]], measure, size), null);
  assert.equal(makeCalibration([[300, 680], [980, 680], [800, 300], [480, 300]], { ...measure, lengthCm: 0 }, size), null);
});

test('四點校正可來回換算', () => {
  const img = [[300, 900], [980, 900], [800, 500], [480, 500]];
  const calib = makeCalibration(img, { widthCm: 120, lengthCm: 200, nearCm: 50 }, { width: 1280, height: 960 });
  assert.ok(calib);
  const g = imageToGround(calib, [300, 900]);
  assert.ok(Math.abs(g[0] + 60) < 1e-6 && Math.abs(g[1] - 50) < 1e-6);
  const back = groundToImage(calib, [0, 150]);
  const again = imageToGround(calib, back);
  assert.ok(Math.abs(again[0]) < 1e-6 && Math.abs(again[1] - 150) < 1e-6);
  // 地平線以上的點（天空）應該拿不到地面座標
  assert.equal(imageToGround(calib, [640, 10]), null);
});

test('校正後：鏡頭看不到的地方是未知', () => {
  const img = [[300, 900], [980, 900], [800, 500], [480, 500]];
  const calib = makeCalibration(img, { widthCm: 120, lengthCm: 200, nearCm: 50 }, { width: 1280, height: 960 });
  const unmarked = buildGrid({ calib, corridor: { leftCm: -60, rightCm: 60 }, range: { startCm: 50, endCm: 250 }, cellCm: 5 });
  assert.equal(assess(unmarked, wheelchair).status, 'UNKNOWN', '入鏡不代表是可通行地面');
  assert.equal(assess(unmarked, { requiredCm: 130 }).status, 'UNKNOWN', '缺乏證據時也不能判定通道太窄');
  const g = buildGrid({ calib, freeImage: [img], corridor: { leftCm: -60, rightCm: 60 }, range: { startCm: 50, endCm: 250 }, cellCm: 5 });
  const r = assess(g, { requiredCm: 90, startXCm: 0 });
  assert.equal(r.status, 'CANDIDATE');
});

// ── 語音同意判斷 ──
test('語音同意：明確同意', () => {
  for (const t of ['好', '好的', '要', '可以', '回報', '麻煩你', '同意回報', 'OK']) assert.equal(classifyConsent(t), 'yes', t);
});
test('語音同意：明確拒絕', () => {
  for (const t of ['不要', '不用', '算了', '不用了謝謝', '先不要', '等一下']) assert.equal(classifyConsent(t), 'no', t);
});
test('語音同意：不清楚就不送出', () => {
  for (const t of ['', '要不要', '好不好', '什麼', '不要好了要', '嗯不', '好嗎', '好？', '是什麼', '要回報什麼', '今天好熱', '嗯', '不好意思，可以再說一次嗎']) assert.equal(classifyConsent(t), 'unclear', t);
});

test('公開展示事件可重送、依序查證與排除，且每次展示獨立', () => {
  const config = { segments: [{ id: 'S1' }], categories: [{ id: 'goods', expireHours: 1 }] };
  const now = Date.parse('2026-11-10T01:00:00Z');
  const store = createDemoStore(config, () => now);
  const report = { id: 'test_0001', segmentId: 'S1', category: 'goods' };
  assert.equal(store.create(report).status, '待確認');
  assert.equal(store.create(report).duplicate, true);
  assert.equal(store.list().length, 1);
  assert.equal(eventState(store.list()[0], now + 3600000), 'expired');
  assert.throws(() => store.setStatus(report.id, '已排除'), /狀態變更順序/);
  store.setStatus(report.id, '現地確認');
  store.setStatus(report.id, '現地確認');
  assert.equal(store.setStatus(report.id, '已排除').history.length, 3);
  assert.equal(eventState(store.list()[0], now), 'cleared');
  assert.throws(() => store.setStatus(report.id, '待確認'), /狀態變更順序/);
  assert.deepEqual(createDemoStore(config, () => now).list(), []);
});
