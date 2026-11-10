// 地圖輔助函式與路段設定（討論08）
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { metersBetween, pointAlong, segmentsBounds, eventMarkers } from '../web/js/map.js';

const config = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

test('設定檔的每個路段都有 OSM 線形，A、B 動線起點與終點相同', () => {
  const seg = Object.fromEntries(config.segments.map((s) => [s.id, s]));
  for (const s of config.segments) assert.ok(s.path.length >= 2, `${s.id} 要有線形`);
  const ends = (route) => {
    const paths = route.segments.map((id) => seg[id].path);
    return [paths[0][0], paths.at(-1).at(-1)];
  };
  const [aStart, aEnd] = ends(config.routes.find((r) => r.id === 'A'));
  const [bStart, bEnd] = ends(config.routes.find((r) => r.id === 'B'));
  assert.ok(metersBetween(aStart, bStart) < 5, '兩條路線同一個起點');
  assert.ok(metersBetween(aEnd, bEnd) < 5, '兩條路線同一個終點');
});

test('路段長度和路線名稱寫的一致（A 約 320 公尺、B 約 450 公尺）', () => {
  const len = (p) => p.slice(1).reduce((sum, q, i) => sum + metersBetween(p[i], q), 0);
  const seg = Object.fromEntries(config.segments.map((s) => [s.id, s]));
  const routeLen = (id) => config.routes.find((r) => r.id === id).segments.reduce((sum, s) => sum + len(seg[s].path), 0);
  assert.ok(Math.abs(routeLen('A') - 320) < 20);
  assert.ok(Math.abs(routeLen('B') - 450) < 20);
});

test('沿線取點：起點、終點、中點', () => {
  const path = [[23.5, 119.5], [23.5, 119.501], [23.501, 119.501]];
  assert.deepEqual(pointAlong(path, 0), [23.5, 119.5]);
  const end = pointAlong(path, 1);
  assert.ok(metersBetween(end, [23.501, 119.501]) < 0.01);
  // 第一段約 102 公尺、第二段約 111 公尺 → 全長一半落在第二段上
  const leg1 = metersBetween(path[0], path[1]);
  const total = leg1 + metersBetween(path[1], path[2]);
  const mid = pointAlong(path, 0.5);
  assert.ok(Math.abs(leg1 + metersBetween(path[1], mid) - total / 2) < 1, '沿線走到一半');
});

test('地圖範圍涵蓋所有路段；沒有線形時不畫地圖', () => {
  const [[s, w], [n, e]] = segmentsBounds(config.segments);
  for (const p of config.segments.flatMap((x) => x.path)) assert.ok(p[0] >= s && p[0] <= n && p[1] >= w && p[1] <= e);
  assert.equal(segmentsBounds([{ id: 'X', name: '無線形' }]), null);
});

test('回報點：已排除不畫、過期畫灰色、同路段多筆沿線分開', () => {
  const now = Date.parse('2026-11-10T12:00:00+08:00');
  const ev = (id, status, minsAgo, expiresInMins, segmentId = 'S1') => ({
    id, segmentId, status, summary: id,
    createdAt: new Date(now - minsAgo * 60000).toISOString(),
    expiresAt: new Date(now + expiresInMins * 60000).toISOString(),
  });
  const markers = eventMarkers([
    ev('a', '待確認', 10, 60),
    ev('b', '現地確認', 5, 60),
    ev('c', '已排除', 3, 60),
    ev('d', '待確認', 120, -1),
    ev('e', '待確認', 1, 60, 'NOPE'), // 不存在的路段
  ], config.segments, now);
  assert.deepEqual(markers.map((m) => m.id).sort(), ['a', 'b', 'd']);
  const byId = Object.fromEntries(markers.map((m) => [m.id, m]));
  assert.equal(byId.d.state, 'expired');
  assert.equal(byId.d.label, '資訊已過期，路況待確認');
  assert.equal(byId.b.state, '現地確認');
  const pts = markers.map((m) => m.latlng.join());
  assert.equal(new Set(pts).size, pts.length, '同一路段的點不重疊');
  assert.equal(eventMarkers([ev('c', '已排除', 3, 60)], config.segments, now, { includeCleared: true }).length, 1);
});
