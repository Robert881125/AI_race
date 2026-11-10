import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCalibration } from '../web/js/homography.js';
import { scanRegion, nearScanRange } from '../web/js/scan-region.js';
import { parseVideoTime, formatVideoTime } from '../web/js/video-controls.js';
import { assessLiveScan } from '../web/js/live-scan.js';

test('影片時間接受秒數與分秒，並拒絕格式錯誤', () => {
  assert.equal(parseVideoTime('1:25.5'), 85.5);
  assert.equal(parseVideoTime('2:04:09'), 7449);
  assert.equal(parseVideoTime('18.5'), 18.5);
  for (const value of ['', '-1', '2:65', '1:7', 'Infinity', 'abc']) assert.equal(parseVideoTime(value), null);
  assert.equal(formatVideoTime(59.99), '01:00.0');
  assert.equal(formatVideoTime(3661), '1:01:01.0');
});

const frame = { kind: 'video', width: 1000, height: 600 };
const calibration = makeCalibration([[150, 580], [850, 580], [700, 180], [300, 180]],
  { widthCm: 160, nearCm: 50, lengthCm: 500 }, frame);

test('影片先用畫面近端，校正後只掃到前方 4 公尺，照片維持全圖', () => {
  assert.deepEqual(scanRegion(frame, null), { x: 80, y: 270, width: 840, height: 330, endCm: null });
  assert.deepEqual(nearScanRange(calibration), { startCm: 50, endCm: 400 });
  const near = scanRegion(frame, calibration);
  assert.equal(near.endCm, 400);
  assert.ok(near.y > 180 && near.y < 580, '裁掉校正區內 4 公尺以外的地面');
  assert.ok(near.width < frame.width && near.height < frame.height);
  assert.equal(scanRegion(frame, { ...calibration, rect: { ...calibration.rect, nearCm: 410 } }), null);
  assert.deepEqual(scanRegion({ ...frame, kind: 'image' }, calibration),
    { x: 0, y: 0, width: 1000, height: 600, endCm: null });
});

test('輪椅網格依裁切偏移取樣，且不評估 4 公尺之外', () => {
  const region = scanRegion({ ...frame, kind: 'live' }, calibration);
  const sidewalk = { width: 80, height: 80, data: new Uint8Array(80 * 80).fill(255) };
  const options = { requiredCm: 90, startXCm: 0, cellCm: 5, marginCm: 0 };
  const good = assessLiveScan({ region, labels: [], sidewalk, painted: false }, calibration, options);
  assert.equal(good.grid.range.endCm, 400);
  assert.equal(good.result.status, 'CANDIDATE');
  const shifted = assessLiveScan({ region: { ...region, x: region.x + 1000 }, labels: [], sidewalk, painted: false }, calibration, options);
  assert.equal(shifted.result.status, 'UNKNOWN');
});
