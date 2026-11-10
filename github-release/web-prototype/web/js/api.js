// 與 server.py 溝通。

async function request(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch { /* 非 JSON */ }
  if (!res.ok || data === null) throw new Error(data?.error || `伺服器回應 ${res.status}`);
  return data;
}

let demoStore = null;

export async function getConfig() {
  // Pages 的發布產物將 config.json 放在 index.html 旁。Python 模式走原本的 API。
  const response = await fetch(new URL('../config.json', import.meta.url));
  if (response.status === 404) return request('GET', '/api/config');
  if (!response.ok) throw new Error(`展示設定載入失敗（${response.status}）`);
  const config = await response.json();
  demoStore = createDemoStore(config);
  return config;
}

export const isDemoMode = () => demoStore !== null;
export const listEvents = async () => demoStore ? demoStore.list() : request('GET', '/api/events');
export const createEvent = async (ev) => demoStore ? demoStore.create(ev) : request('POST', '/api/events', ev);
export const setStatus = async (id, status) => demoStore
  ? demoStore.setStatus(id, status)
  : request('POST', `/api/events/${encodeURIComponent(id)}/status`, { status });

export function nextEventStatus(status) {
  return { 待確認: '現地確認', 現地確認: '已排除' }[status];
}

export function createDemoStore(config, now = Date.now) {
  const events = new Map();
  return {
    list: () => [...events.values()],
    create(ev) {
      const existing = events.get(ev.id);
      if (existing) return { ...existing, duplicate: true };
      const category = config.categories.find((c) => c.id === ev.category);
      if (!category || !config.segments.some((s) => s.id === ev.segmentId)) throw new Error('未知的路段或障礙類別');
      const time = now();
      const createdAt = new Date(time).toISOString();
      const saved = {
        ...ev,
        createdAt,
        expiresAt: new Date(time + category.expireHours * 3600000).toISOString(),
        status: '待確認',
        history: [{ status: '待確認', at: createdAt }],
      };
      events.set(saved.id, saved);
      return saved;
    },
    setStatus(id, status) {
      const event = events.get(id);
      if (!event) throw new Error('找不到事件');
      if (event.status === status) return event;
      if (nextEventStatus(event.status) !== status) throw new Error('狀態變更順序錯誤');
      const updated = { ...event, status, history: [...event.history, { status, at: new Date(now()).toISOString() }] };
      events.set(id, updated);
      return updated;
    },
  };
}

/** 不依賴 crypto.randomUUID（非 HTTPS 下不能用） */
export function newId() {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return 'ev_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** 事件目前是否仍有效（未排除、未過期） */
export function eventState(ev, now = Date.now()) {
  if (ev.status === '已排除') return 'cleared';
  if (Date.parse(ev.expiresAt) <= now) return 'expired';
  return 'active';
}

export function timeAgo(iso, now = Date.now()) {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s} 秒前`;
  if (s < 3600) return `${Math.round(s / 60)} 分鐘前`;
  if (s < 86400) return `${Math.round(s / 3600)} 小時前`;
  return `${Math.round(s / 86400)} 天前`;
}
