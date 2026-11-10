import test from 'node:test';
import assert from 'node:assert/strict';

globalThis.window = {};
const { initRoutePanel } = await import('../web/js/panels.js');

const config = {
  segments: [{ id: 'S1', name: '騎樓' }, { id: 'S2', name: '人行道' }],
  routes: [
    { id: 'A', name: '原路線', segments: ['S1'] },
    { id: 'B', name: '替代路線', segments: ['S2'], checkedAt: '2026-11-10T09:00:00+08:00' },
  ],
  alternatives: { A: 'B' },
};

function setup(loadEvents) {
  const elements = new Map();
  const get = (selector) => {
    if (!elements.has(selector)) {
      elements.set(selector, {
        value: '',
        addEventListener(event, callback) { this[event] = callback; },
      });
    }
    return elements.get(selector);
  };
  globalThis.document = { querySelector: get };
  get('#route').value = 'A';
  initRoutePanel(config, () => false, loadEvents);
  return get;
}

test('確認替代路況後，選單與後續查詢一起切換到 B', async () => {
  const get = setup(async () => [{ id: 'report', segmentId: 'S1', status: '待確認', expiresAt: '2099-01-01' }]);
  await get('#route-alt').click();
  assert.equal(get('#route').value, 'B');
  assert.match(get('#route-alt-msg').innerHTML, /已切換到/);
  assert.match(get('#route-msg').innerHTML, /沒有有效的路障回報/);
});

test('替代路況讀取失敗或有回報時，保持原路線', async () => {
  let error = true;
  const get = setup(async () => {
    if (error) throw new Error('離線');
    return [{ id: 'report', segmentId: 'S2', status: '待確認', expiresAt: '2099-01-01' }];
  });
  await get('#route-alt').click();
  assert.equal(get('#route').value, 'A');
  assert.match(get('#route-alt-msg').textContent, /無法取得/);
  error = false;
  await get('#route-alt').click();
  assert.equal(get('#route').value, 'A');
  assert.match(get('#route-alt-msg').textContent, /路況待確認/);
});
