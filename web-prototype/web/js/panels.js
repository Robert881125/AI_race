// 使用者 B 的路線提醒、治理端事件列表。

import * as api from './api.js?v=map-1';
import * as voice from './voice.js';

const $ = (s) => document.querySelector(s);
const SOURCE_TEXT = { auto: '模型推估', trigger: '人工觸發／人工標註', manual: '使用者手動回報' };

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString('zh-TW', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ───────── 使用者 B：路線提醒 ─────────
/** hooks（可省略）：onRoute(routeId) 選定路線改變時、onEvents(events) 取得路況後；給地圖用 */
export function initRoutePanel(config, isVoiceOn, loadEvents = api.listEvents, hooks = {}) {
  const segName = Object.fromEntries(config.segments.map((s) => [s.id, s.name]));
  const routes = Object.fromEntries(config.routes.map((r) => [r.id, r]));
  const sel = $('#route');
  sel.innerHTML = config.routes.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');

  const msg = $('#route-msg');
  const altMsg = $('#route-alt-msg');
  const actions = $('#route-actions');
  let seen = new Set(); // 已提醒過的事件
  let timer = null;
  let checkSequence = 0;
  let alternativeSequence = 0;

  function onRoute(events, route) {
    const now = Date.now();
    const mine = events.filter((e) => route.segments.includes(e.segmentId));
    return {
      active: mine.filter((e) => api.eventState(e, now) === 'active'),
      expired: mine.filter((e) => api.eventState(e, now) === 'expired'),
    };
  }

  async function check({ fromWatch = false } = {}) {
    const route = routes[sel.value];
    const sequence = ++checkSequence;
    let events;
    try {
      events = await loadEvents();
    } catch (e) {
      if (sequence !== checkSequence) return;
      msg.className = 'route-msg alert';
      msg.textContent = `無法取得路況：${e.message}。目前無法確認。`;
      actions.hidden = true;
      return;
    }
    if (sequence !== checkSequence) return;
    hooks.onEvents?.(events);
    const { active, expired } = onRoute(events, route);
    const fresh = active.filter((e) => !seen.has(e.id));
    if (active.length) {
      active.forEach((e) => seen.add(e.id));
      const latest = [...active].sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
      msg.className = 'route-msg alert';
      msg.innerHTML =
        `<strong>目前路線有 ${active.length} 筆有效的路障回報。</strong><br>` +
        `最新一筆：${esc(segName[latest.segmentId])}，${esc(latest.summary || '')}` +
        `（${api.timeAgo(latest.createdAt)}回報，狀態：${esc(latest.status)}，來源：${esc(SOURCE_TEXT[latest.source] || latest.source)}）`;
      if (!fromWatch || fresh.length) {
        actions.hidden = false;
        if (isVoiceOn()) voice.say('目前路線有路障回報，要看替代路線嗎？');
      }
    } else {
      msg.className = 'route-msg ok';
      msg.innerHTML =
        '目前路線沒有有效的路障回報。<span class="muted small">（沒有回報不代表一定暢通。）</span>' +
        (expired.length ? `<br><span class="muted small">另有 ${expired.length} 筆資訊已過期，路況待確認。</span>` : '');
      actions.hidden = true;
    }
  }

  async function showAlternative() {
    const route = routes[sel.value];
    const altId = config.alternatives?.[route.id];
    const alt = altId && routes[altId];
    if (!alt) {
      altMsg.className = 'route-msg alert';
      altMsg.textContent = '目前沒有事先走查過的替代路線，無法確認。';
      if (isVoiceOn()) voice.say('目前沒有走查過的替代路線，無法確認。');
      return;
    }
    const sequence = ++alternativeSequence;
    let events;
    try {
      events = await loadEvents();
    } catch (e) {
      if (sequence !== alternativeSequence) return;
      altMsg.className = 'route-msg alert';
      altMsg.textContent = `無法取得替代路況：${e.message}。仍維持目前路線。`;
      return;
    }
    if (sequence !== alternativeSequence) return;
    const { active, expired } = onRoute(events, alt);
    if (active.length || expired.length) {
      altMsg.className = 'route-msg alert';
      altMsg.textContent = '替代路線仍有有效或過期的路障回報，路況待確認。仍維持目前路線。';
      if (isVoiceOn()) voice.say(altMsg.textContent);
      return;
    }
    sel.value = alt.id;
    hooks.onRoute?.(alt.id);
    seen.clear();
    actions.hidden = true;
    altMsg.className = 'route-msg ok';
    altMsg.innerHTML =
      `<strong>已切換到：${esc(alt.name)}</strong><br>` +
      `經過：${alt.segments.map((s) => esc(segName[s])).join('、')}<br>` +
      `最近走查：${fmtTime(alt.checkedAt)}（${api.timeAgo(alt.checkedAt)}）`;
    if (isVoiceOn()) voice.say(`已切換到${alt.name}，最近走查時間${api.timeAgo(alt.checkedAt)}。`);
    await check({ fromWatch: true });
  }

  $('#route-check').addEventListener('click', () => { altMsg.textContent = ''; seen.clear(); check(); });
  $('#route-alt').addEventListener('click', showAlternative);
  $('#route-keep').addEventListener('click', () => {
    alternativeSequence++;
    actions.hidden = true;
    altMsg.className = 'route-msg';
    altMsg.textContent = '維持原路線。接近回報路段時請留意。';
  });
  sel.addEventListener('change', () => {
    hooks.onRoute?.(sel.value);
    checkSequence++;
    alternativeSequence++;
    seen.clear();
    msg.textContent = '';
    altMsg.textContent = '';
    actions.hidden = true;
  });
  hooks.onRoute?.(sel.value);
  $('#route-watch').addEventListener('change', (e) => {
    clearInterval(timer);
    if (e.target.checked) {
      check();
      timer = setInterval(() => check({ fromWatch: true }), 5000);
    }
  });
}

// ───────── 治理端 ─────────
export function initAdminPanel(config, hooks = {}) {
  const segName = Object.fromEntries(config.segments.map((s) => [s.id, s.name]));
  const catName = Object.fromEntries(config.categories.map((c) => [c.id, c.name]));
  const list = $('#admin-list');

  async function refresh() {
    let events;
    try {
      events = await api.listEvents();
    } catch (e) {
      hooks.onEvents?.([]);
      list.innerHTML = `<p class="card">無法取得事件：${esc(e.message)}</p>`;
      return;
    }
    hooks.onEvents?.(events);
    if (!events.length) {
      list.innerHTML = '<p class="card muted">目前沒有事件。到「鏡頭判斷」回報一筆試試看。</p>';
      return;
    }
    const now = Date.now();
    events.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    list.innerHTML = events.map((e) => {
      const st = api.eventState(e, now);
      const chip = st === 'expired'
        ? '<span class="chip expired">資訊已過期，路況待確認</span>'
        : `<span class="chip s-${esc(e.status)}">${esc(e.status)}</span>`;
      return `<article class="card" data-event-id="${esc(e.id)}" tabindex="-1">
        <h3>${esc(segName[e.segmentId] || e.segmentId)}　${chip}</h3>
        <p>${esc(catName[e.category] || e.category)}：${esc(e.summary || '')}</p>
        <p class="muted small">來源：${esc(SOURCE_TEXT[e.source] || e.source)}　觀測：${fmtTime(e.observedAt)}　有效至：${fmtTime(e.expiresAt)}</p>
        <p class="muted small">歷程：${(e.history || []).map((h) => `${esc(h.status)} ${fmtTime(h.at)}`).join(' → ')}</p>
        <div class="row">
          <button type="button" data-id="${esc(e.id)}" data-status="現地確認" ${api.nextEventStatus(e.status) === '現地確認' ? '' : 'disabled'}>現地確認</button>
          <button type="button" data-id="${esc(e.id)}" data-status="已排除" ${api.nextEventStatus(e.status) === '已排除' ? '' : 'disabled'}>已排除</button>
        </div>
      </article>`;
    }).join('');
  }

  list.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-id]');
    if (!b) return;
    b.disabled = true;
    try { await api.setStatus(b.dataset.id, b.dataset.status); } catch (e) { alert(`更新失敗：${e.message}`); }
    refresh();
  });

  refresh();
  setInterval(() => { if (!$('#tab-admin').hidden) refresh(); }, 5000);
  return { refresh };
}
