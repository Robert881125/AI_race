import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as scan from '../web/js/scan.js';

test('影片控制在主畫面上方，最近一次掃描影格預設收合', () => {
  const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');
  assert.ok(html.indexOf('id="video-controls"') < html.indexOf('id="view"'));
  const preview = html.match(/<details\b[^>]*id="scan-details"[^>]*>[\s\S]*?<\/details>/)?.[0];
  assert.ok(preview?.includes('id="scan-preview"'));
  assert.ok(!/^<details\b[^>]*\bopen\b/.test(preview));
});

test('掃描色塊只疊在相同照片或暫停於對應時間的影片', () => {
  const video = { kind: 'video', el: { paused: true, seeking: false, currentTime: 10 } };
  const mask = { frame: 10, layer: {} };
  assert.equal(scan.canDrawScanMask(mask, video), true);
  assert.equal(scan.canDrawScanMask(null, video), false);
  video.el.currentTime = 10.5;
  assert.equal(scan.canDrawScanMask(mask, video), false);
  video.el.currentTime = 10;
  video.el.paused = false;
  assert.equal(scan.canDrawScanMask(mask, video), false);
  video.el.paused = true;
  video.el.seeking = true;
  assert.equal(scan.canDrawScanMask(mask, video), false);
  assert.equal(scan.canDrawScanMask(mask, { kind: 'live' }), false);
  assert.equal(scan.canDrawScanMask(mask, { kind: 'image' }), true);
});
