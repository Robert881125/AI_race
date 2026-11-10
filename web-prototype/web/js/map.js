// 地圖（討論08）：OpenStreetMap 底圖＋試跑路段＋回報點。
// 地圖只是輔助；所有資訊在文字區仍完整呈現（螢幕報讀使用者不需要看地圖）。
// 路段線形取自 OpenStreetMap（© OpenStreetMap contributors，ODbL），存在 config.json 的 segments[].path。
// 圖磚用 tile.openstreetmap.org：只適合展示用原型的少量使用，正式上線要換自架或其他圖磚服務。

const LEAFLET_JS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
const LEAFLET_CSS = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

const ROUTE_COLORS = ['#2563eb', '#16a34a', '#9333ea', '#ea580c'];
const STATE_STYLE = {
  待確認: { color: '#d97706', label: '待確認' },
  現地確認: { color: '#dc2626', label: '現地確認' },
  expired: { color: '#6b7280', label: '資訊已過期，路況待確認' },
};

// ───────── 純函式（可在 Node 測試） ─────────

const toRad = (d) => (d * Math.PI) / 180;
/** 兩點距離（公尺），台灣範圍用平面近似即可 */
export function metersBetween([lat1, lon1], [lat2, lon2]) {
  const x = (lon2 - lon1) * 111320 * Math.cos(toRad((lat1 + lat2) / 2));
  const y = (lat2 - lat1) * 111320;
  return Math.hypot(x, y);
}

/** 沿著折線走到全長的 fraction（0–1）處的座標 */
export function pointAlong(path, fraction) {
  if (!path?.length) return null;
  if (path.length === 1) return [...path[0]];
  const lengths = path.slice(1).map((p, i) => metersBetween(path[i], p));
  const total = lengths.reduce((a, b) => a + b, 0);
  let target = Math.min(1, Math.max(0, fraction)) * total;
  for (let i = 0; i < lengths.length; i++) {
    if (target <= lengths[i] || i === lengths.length - 1) {
      const t = lengths[i] ? Math.min(1, target / lengths[i]) : 0;
      return [path[i][0] + (path[i + 1][0] - path[i][0]) * t, path[i][1] + (path[i + 1][1] - path[i][1]) * t];
    }
    target -= lengths[i];
  }
  return [...path[path.length - 1]];
}

/** 所有路段的範圍 [[南, 西], [北, 東]]；沒有線形時回傳 null */
export function segmentsBounds(segments) {
  const pts = segments.flatMap((s) => s.path || []);
  if (!pts.length) return null;
  const lats = pts.map((p) => p[0]);
  const lons = pts.map((p) => p[1]);
  return [[Math.min(...lats), Math.min(...lons)], [Math.max(...lats), Math.max(...lons)]];
}

/**
 * 回報 → 地圖點位。同一路段有多筆時沿路段平均分開，不疊在一起。
 * 已排除的不畫；過期的畫灰色。includeCleared 給治理端用。
 */
export function eventMarkers(events, segments, now = Date.now(), { includeCleared = false } = {}) {
  const paths = Object.fromEntries(segments.filter((s) => s.path?.length).map((s) => [s.id, s.path]));
  const bySeg = new Map();
  for (const e of events) {
    if (!paths[e.segmentId]) continue;
    const cleared = e.status === '已排除';
    if (cleared && !includeCleared) continue;
    if (!bySeg.has(e.segmentId)) bySeg.set(e.segmentId, []);
    bySeg.get(e.segmentId).push(e);
  }
  const out = [];
  for (const [segId, list] of bySeg) {
    list.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    list.forEach((e, k) => {
      const expired = e.status !== '已排除' && Date.parse(e.expiresAt) <= now;
      const state = e.status === '已排除' ? '已排除' : expired ? 'expired' : e.status;
      const style = STATE_STYLE[state] || { color: '#16a34a', label: '已排除' };
      out.push({ id: e.id, segmentId: segId, state, color: style.color, label: style.label, latlng: pointAlong(paths[segId], (k + 1) / (list.length + 1)), event: e });
    });
  }
  return out;
}

// ───────── 瀏覽器 ─────────

let leafletLoading = null;
function loadLeaflet() {
  if (window.L) return Promise.resolve(window.L);
  if (!leafletLoading) {
    leafletLoading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CSS;
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = LEAFLET_JS;
      s.onload = () => (window.L ? resolve(window.L) : reject(new Error('地圖程式庫載入不完整')));
      s.onerror = () => reject(new Error('無法載入地圖程式庫（需要網路）'));
      document.head.appendChild(s);
    }).catch((e) => { leafletLoading = null; throw e; });
  }
  return leafletLoading;
}

const escapeHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * 建立地圖。container 為空的 div；note 為說明文字元素（可省略）。
 * 回傳 { setRoute(routeId), setEvents(events), onMarkerClick(fn) }；載入失敗時這些方法都是空操作。
 */
export function createMap(container, config, { note = null, includeCleared = false } = {}) {
  const segments = config.segments || [];
  const bounds = segmentsBounds(segments);
  let map = null;
  let routeLayer = null;
  let markerLayer = null;
  let pendingRoute = null;
  let pendingEvents = null;
  let markerClick = null;

  const api = {
    setRoute(routeId) { pendingRoute = routeId; if (map) drawRoutes(); },
    setEvents(events) { pendingEvents = events; if (map) drawEvents(); },
    onMarkerClick(fn) { markerClick = fn; },
  };

  if (!bounds) {
    container.hidden = true;
    if (note) note.textContent = '設定檔沒有路段線形，不顯示地圖。';
    return api;
  }

  function drawRoutes() {
    const L = window.L;
    routeLayer.clearLayers();
    const segById = Object.fromEntries(segments.map((s) => [s.id, s]));
    (config.routes || []).forEach((r, i) => {
      const selected = !pendingRoute || r.id === pendingRoute;
      for (const segId of r.segments) {
        const s = segById[segId];
        if (!s?.path?.length) continue;
        L.polyline(s.path, {
          color: ROUTE_COLORS[i % ROUTE_COLORS.length],
          weight: selected ? 8 : 5,
          opacity: selected ? 0.85 : 0.7,
          dashArray: selected ? null : '8 8',
        }).bindTooltip(`${escapeHtml(r.name)}｜${escapeHtml(s.name)}`).addTo(routeLayer);
      }
    });
  }

  function drawEvents() {
    const L = window.L;
    markerLayer.clearLayers();
    const segName = Object.fromEntries(segments.map((s) => [s.id, s.name]));
    for (const m of eventMarkers(pendingEvents || [], segments, Date.now(), { includeCleared })) {
      L.circleMarker(m.latlng, { radius: 10, color: '#fff', weight: 2, fillColor: m.color, fillOpacity: 0.95 })
        .bindPopup(`<strong>${escapeHtml(m.label)}</strong><br>${escapeHtml(segName[m.segmentId])}<br>${escapeHtml(m.event.summary || '')}`)
        .on('click', () => markerClick?.(m.id))
        .addTo(markerLayer);
    }
  }

  if (note) note.textContent = '地圖載入中…';
  loadLeaflet().then((L) => {
    map = L.map(container, { scrollWheelZoom: false });
    // 地圖所在分頁一開始是隱藏的（大小為 0），這時算出的縮放會錯；等第一次真的看得到時再對準全部路段
    let fitted = false;
    const fit = () => {
      map.invalidateSize();
      if (!fitted && container.clientWidth > 0 && container.clientHeight > 0) {
        map.fitBounds(bounds, { padding: [24, 24] });
        L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
        fitted = true;
      }
    };
    map.setView(bounds[0], 17);
    routeLayer = L.layerGroup().addTo(map);
    markerLayer = L.layerGroup().addTo(map);
    drawRoutes();
    drawEvents();
    fit();
    if ('ResizeObserver' in window) new ResizeObserver(fit).observe(container);
    if (note) note.textContent = '地圖僅供參考。回報圖點依所選路段示意，請看文字區的完整路況。路段線形：OpenStreetMap（ODbL）。';
  }).catch((e) => {
    container.hidden = true;
    if (note) note.textContent = `${e.message}；路況請看下方文字。`;
  });

  return api;
}
