/* ============================================================
 *  RV_navi  フロントエンド  app.js v1.1.3
 *  GitHub Pages + Leaflet + GAS(Code.gs)
 *  読み込み順：config.js → auth.js → app.js（API通信・会員機能は auth.js）
 *  座標：API とのやり取りは [経度, 緯度]、Leaflet は [緯度, 経度]
 * ============================================================ */
'use strict';

window.RV_FILES = window.RV_FILES || {};
window.RV_FILES.app = '1.1.3';

const CONFIG = {
  // GAS の URL は config.js に書きます
  CENTER: [36.2, 138.25],
  ZOOM: 6,
  LS: {
    vehicle: 'rvnavi_vehicle',
    favs: 'rvnavi_favs',
    dark: 'rvnavi_dark',
    lowHaz: 'rvnavi_showlow',
    poiCats: 'rvnavi_poicats',
    radius: 'rvnavi_radius',
    opts: 'rvnavi_opts',
  },
};

const POI_CATS = {
  michinoeki:  { label: '道の駅',          glyph: '駅' },
  sapa:        { label: 'SA・PA',          glyph: 'SA' },
  rvpark:      { label: 'RVパーク',        glyph: 'RV' },
  camp:        { label: 'オートキャンプ場', glyph: '営' },
  onsen:       { label: '日帰り温泉',       glyph: '♨' },
  fuel:        { label: 'ガソリンスタンド', glyph: '給' },
  supermarket: { label: 'スーパー',         glyph: '買' },
  laundry:     { label: 'コインランドリー', glyph: '洗' },
};

const SEV_ORDER = ['critical', 'high', 'medium', 'low'];
const SEV_LABEL = { critical: '通行不可の恐れ', high: '要注意', medium: '注意', low: '参考' };
const SEV_COLOR = { critical: '#c8102e', high: '#e0660f', medium: '#d6a300', low: '#7c8794' };
const SEV_Z = { critical: 400, high: 300, medium: 200, low: 100 };

const WARN_GLYPH = {
  very_narrow: '狭', narrow_road: '狭', gate: '門', sharp_turn: '曲', hairpin_series: '連',
  steep_up: '坂', steep_down: '坂', track: '林', unpaved: '砂', ford: '水',
  residential: '住', tunnel: '洞', construction: '工', height_limit: '高',
};

const RISK_LABEL = { low: '低い', medium: '中程度', high: '高い', very_high: '非常に高い' };

const state = {
  vehicle: null,
  start: null, end: null, vias: [],
  opts: { avoidTolls: false, avoidHighways: false, preference: 'recommended' },
  routes: [], sel: 0, seq: 0,
  analysisByRoute: {}, analysis: null, analyzing: -1, analysisError: null,
  poiCats: new Set(['michinoeki', 'rvpark', 'onsen', 'fuel']),
  radius: 1000,
  pois: [], poiNotes: [], poiDepart: null,
  rest: null,
  favorites: [],
  showLow: false,
};

let map, L_route, L_hazard, L_poi, L_rest, L_points, L_me;
const cumCache = new WeakMap();

/* ============================================================
 *  ユーティリティ
 * ========================================================== */
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r5 = x => Math.round(x * 1e5) / 1e5;
const isWide = () => window.matchMedia('(min-width: 900px)').matches;
const curRoute = () => state.routes[state.sel] || null;

function lsGet(k, fb = null) {
  try { const v = localStorage.getItem(k); return v == null ? fb : JSON.parse(v); } catch (e) { return fb; }
}
function lsSet(k, v) {
  try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 容量不足等は無視 */ }
}

function fmtDur(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}時間${m ? m + '分' : ''}` : `${m}分`;
}
function clockAfter(min, base) {
  const d = new Date((base || new Date()).getTime() + min * 60000);
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}
function fmtDist(m) {
  return m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`;
}
/** 標識の数字が長いときは文字を小さくするクラス */
function longCls(txt) {
  return String(txt).length >= 4 ? ' rs-long' : '';
}
function num1(x) {
  if (x == null || !isFinite(x)) return '';
  const v = Math.round(x * 100) / 100;
  return Number.isInteger(Math.round(v * 1000) / 100) ? v.toFixed(1) : v.toFixed(2);
}

function havKm(a, b) { // a,b = [lng, lat]
  const R = 6371.0088, d = Math.PI / 180;
  const dLat = (b[1] - a[1]) * d, dLng = (b[0] - a[0]) * d;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * d) * Math.cos(b[1] * d) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function routeCumKm(r) {
  if (cumCache.has(r)) return cumCache.get(r);
  const c = r.coordinates, cum = new Float64Array(c.length);
  for (let i = 1; i < c.length; i++) cum[i] = cum[i - 1] + havKm(c[i - 1], c[i]);
  cumCache.set(r, cum);
  return cum;
}
function tollKm(r) {
  const t = r.extras && r.extras.tollways;
  if (!t || !Array.isArray(t.summary)) return 0;
  const m = t.summary.filter(s => s.value === 1).reduce((a, s) => a + (s.distance || 0), 0);
  return Math.round(m / 100) / 10;
}

const empty = t => `<p class="empty">${esc(t)}</p>`;
const loadingBlock = t => `<div class="loading"><span class="spin" aria-hidden="true"></span><span>${esc(t)}</span></div>`;

/* ============================================================
 *  表示の補助
 * ========================================================== */
let toastTimer;
function toast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast toast-' + type;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, type === 'err' ? 6000 : 3200);
}

function setBusy(text) {
  $('status').hidden = !text;
  if (text) $('status-text').textContent = text;
}

function setSheet(s) { $('sheet').dataset.state = s; }

function showTab(name) {
  document.querySelectorAll('.tab').forEach(b => {
    const on = b.dataset.tab === name;
    b.classList.toggle('is-active', on);
    b.setAttribute('aria-selected', String(on));
  });
  document.querySelectorAll('.panel').forEach(p => { p.hidden = p.id !== 'panel-' + name; });
  if ($('sheet').dataset.state === 'min') setSheet('peek');
}

function updateTabBadges() {
  const set = (tab, n, cls) => {
    const b = document.querySelector(`.tab[data-tab="${tab}"] .badge`);
    if (!b) return;
    b.textContent = n;
    b.hidden = !n;
    b.className = 'badge' + (cls ? ' ' + cls : '');
  };
  const a = state.analysis;
  const c = a ? a.counts : null;
  set('hazard', c ? (c.critical || 0) + (c.high || 0) : 0, c && c.critical ? 'badge-crit' : '');
  set('poi', state.pois.length);
  set('fav', state.favorites.length);
}

/** 地図の該当地点へ移動（スマホではパネルを畳む） */
function focusOn(latlng, zoom, marker) {
  if (!isWide()) setSheet('min');
  map.flyTo(latlng, zoom || 16, { duration: 0.6 });
  if (marker) setTimeout(() => marker.openPopup(), 700);
}

function sheetPadding() {
  if (isWide()) return { tl: [450, 40], br: [40, 40] };
  const h = $('sheet').getBoundingClientRect().height;
  return { tl: [30, 80], br: [70, h + 20] };
}

/* ============================================================
 *  地図
 * ========================================================== */
function initMap() {
  map = L.map('map', { zoomControl: false, attributionControl: false }).setView(CONFIG.CENTER, CONFIG.ZOOM);
  L.control.zoom({ position: 'topright', zoomInTitle: '拡大', zoomOutTitle: '縮小' }).addTo(map);
  L.control.attribution({ position: 'topleft', prefix: false }).addTo(map);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors',
  }).addTo(map);

  map.createPane('segPane');
  map.getPane('segPane').style.zIndex = 420;

  L_route = L.layerGroup().addTo(map);
  L_hazard = L.layerGroup().addTo(map);
  L_poi = L.layerGroup().addTo(map);
  L_rest = L.layerGroup().addTo(map);
  L_points = L.layerGroup().addTo(map);
  L_me = L.layerGroup().addTo(map);

  map.on('click', onMapClick);
}

function onMapClick(e) {
  const lat = r5(e.latlng.lat), lng = r5(e.latlng.lng);
  const html = `<div class="pop">
    <p class="pop-title" data-label>${lat.toFixed(5)}, ${lng.toFixed(5)}</p>
    <div class="pop-actions">
      <button class="btn-sm primary" type="button" data-act="start">ここを出発地にする</button>
      <button class="btn-sm" type="button" data-act="via">経由地に追加</button>
      <button class="btn-sm primary" type="button" data-act="end">ここを目的地にする</button>
    </div></div>`;
  const pop = L.popup({ maxWidth: 260 }).setLatLng(e.latlng).setContent(html).openOn(map);
  const el = pop.getElement();
  if (!el) return;
  const labelEl = el.querySelector('[data-label]');
  el.querySelectorAll('[data-act]').forEach(b => {
    b.onclick = () => {
      setPoint(b.dataset.act, { lat, lng, label: labelEl.textContent });
      map.closePopup();
    };
  });
  if (isLoggedIn()) {
    api('reverse', { lat, lng }).then(d => { if (labelEl) labelEl.textContent = d.label; }).catch(() => {});
  }
}

/* ============================================================
 *  地点（出発・経由・目的）
 * ========================================================== */
function pointIcon(kind, n) {
  const txt = kind === 'start' ? '出' : kind === 'end' ? '着' : String(n);
  return L.divIcon({
    className: '',
    html: `<div class="pin pin-${kind}"><span>${txt}</span></div>`,
    iconSize: [34, 34],
    iconAnchor: [17, 41],
  });
}

function setPoint(kind, pt, o = {}) {
  if (kind === 'start') {
    state.start = pt;
    $('in-start').value = pt.label;
    $('res-start').hidden = true;
  } else if (kind === 'end') {
    state.end = pt;
    $('in-end').value = pt.label;
    $('res-end').hidden = true;
  } else {
    if (state.vias.length >= 20) { toast('経由地は20か所までです', 'err'); return; }
    const at = o.insertAt == null ? state.vias.length : Math.max(0, Math.min(o.insertAt, state.vias.length));
    state.vias.splice(at, 0, pt);
    $('in-via').value = '';
    $('res-via').hidden = true;
  }
  if (o.refine) refineLabel(pt);
  afterPointsChanged(!!o.reroute);
}

function refineLabel(pt) {
  if (!isLoggedIn()) return;
  api('reverse', { lat: pt.lat, lng: pt.lng }).then(d => {
    pt.label = d.label;
    if (pt === state.start) $('in-start').value = d.label;
    if (pt === state.end) $('in-end').value = d.label;
    renderPoints();
  }).catch(() => {});
}

function afterPointsChanged(reroute) {
  renderPoints();
  clearRoute();
  if (reroute && state.start && state.end) searchRoute();
}

function renderPoints() {
  L_points.clearLayers();
  const add = (p, kind, n, onMove) => {
    const m = L.marker([p.lat, p.lng], {
      icon: pointIcon(kind, n), draggable: true, title: p.label, zIndexOffset: 1000,
    }).addTo(L_points);
    m.on('dragend', () => {
      const ll = m.getLatLng();
      onMove({ lat: r5(ll.lat), lng: r5(ll.lng), label: `${ll.lat.toFixed(5)}, ${ll.lng.toFixed(5)}` });
    });
  };
  if (state.start) add(state.start, 'start', 0, pt => setPoint('start', pt, { refine: true }));
  state.vias.forEach((v, i) => add(v, 'via', i + 1, pt => {
    state.vias[i] = pt;
    refineLabel(pt);
    afterPointsChanged(false);
  }));
  if (state.end) add(state.end, 'end', 0, pt => setPoint('end', pt, { refine: true }));

  $('via-list').innerHTML = state.vias.map((v, i) => `
    <li class="via-item">
      <span class="pt-dot pt-via" aria-hidden="true">${i + 1}</span>
      <span class="via-name" title="${esc(v.label)}">${esc(v.label)}</span>
      <button class="btn-icon" type="button" data-up="${i}" aria-label="経由地${i + 1}を前へ" ${i === 0 ? 'disabled' : ''}>↑</button>
      <button class="btn-icon" type="button" data-del="${i}" aria-label="経由地${i + 1}を削除">✕</button>
    </li>`).join('');
}

async function doGeocode(which) {
  const input = $('in-' + which), box = $('res-' + which);
  const q = input.value.trim();
  if (!q) { toast('地名・住所・施設名を入力してください'); return; }
  if (!requireLogin()) return;
  box.hidden = false;
  box.innerHTML = '<div class="gc-item muted">検索しています…</div>';
  try {
    const c = map.getCenter();
    const d = await api('geocode', { q, lat: c.lat, lng: c.lng });
    if (!d.results.length) {
      box.innerHTML = '<div class="gc-item muted">見つかりません。市町村名を付けて検索してください</div>';
      return;
    }
    box.innerHTML = d.results.map((r, i) =>
      `<button class="gc-item" type="button" data-i="${i}">${esc(r.label)}</button>`).join('');
    box.querySelectorAll('button').forEach(b => {
      b.onclick = () => {
        const r = d.results[+b.dataset.i];
        setPoint(which, { lat: r.lat, lng: r.lng, label: r.label });
        if (!curRoute()) map.setView([r.lat, r.lng], 13);
      };
    });
  } catch (e) {
    box.innerHTML = `<div class="gc-item err">${esc(e.message)}</div>`;
  }
}

function locate(setStart) {
  if (!navigator.geolocation) { toast('この端末では現在地を取得できません', 'err'); return; }
  setBusy('現在地を取得しています…');
  navigator.geolocation.getCurrentPosition(pos => {
    setBusy(null);
    const { latitude: lat, longitude: lng, accuracy } = pos.coords;
    L_me.clearLayers();
    L.circle([lat, lng], { radius: accuracy, color: '#2a7de1', weight: 1, fillOpacity: 0.08, interactive: false }).addTo(L_me);
    L.marker([lat, lng], {
      icon: L.divIcon({ className: '', html: '<div class="me-dot"></div>', iconSize: [22, 22], iconAnchor: [11, 11] }),
      interactive: false, keyboard: false,
    }).addTo(L_me);
    if (setStart) setPoint('start', { lat: r5(lat), lng: r5(lng), label: '現在地' });
    map.setView([lat, lng], Math.max(map.getZoom(), 14));
  }, err => {
    setBusy(null);
    toast(err.code === 1 ? '位置情報の利用が許可されていません。端末の設定を確認してください' : '現在地を取得できませんでした', 'err');
  }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 30000 });
}

/* ============================================================
 *  ルート探索
 * ========================================================== */
function clearRoute() {
  state.seq++;
  state.routes = [];
  state.sel = 0;
  state.analysisByRoute = {};
  state.analysis = null;
  state.analyzing = -1;
  state.analysisError = null;
  state.pois = [];
  state.poiNotes = [];
  state.rest = null;
  L_route.clearLayers();
  L_hazard.clearLayers();
  L_poi.clearLayers();
  L_rest.clearLayers();
  renderRouteCards();
  renderAi();
  renderHazards();
  renderPois();
  renderRest();
}

async function searchRoute() {
  if (!requireLogin()) return;
  if (!state.vehicle) {
    openVehicle();
    toast('先に車両の寸法を登録してください');
    return;
  }
  if (!state.start || !state.end) {
    toast('出発地と目的地を設定してください', 'err');
    return;
  }
  clearRoute();
  const seq = state.seq;
  const btn = $('btn-route');
  btn.disabled = true;
  setBusy('ルートを探しています…');
  try {
    const d = await api('route', {
      waypoints: [state.start, ...state.vias, state.end].map(p => [p.lng, p.lat]),
      vehicle: state.vehicle,
      avoidTolls: state.opts.avoidTolls,
      avoidHighways: state.opts.avoidHighways,
      preference: state.opts.preference,
    });
    if (seq !== state.seq) return;
    state.routes = d.routes;
    state.sel = 0;
    drawRoutes();
    renderRouteCards();
    fitRoute();
    runAnalysis();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    setBusy(null);
  }
}

function drawRoutes() {
  L_route.clearLayers();
  state.routes.forEach((r, i) => {
    if (i === state.sel) return;
    const ll = r.coordinates.map(c => [c[1], c[0]]);
    L.polyline(ll, { color: '#7d8793', weight: 7, opacity: 0.8, dashArray: '1 12', lineCap: 'round' })
      .bindTooltip(`別ルート${i}：${fmtDur(r.summary.duration / 60)}（選ぶにはタップ）`, { sticky: true })
      .on('click', ev => { L.DomEvent.stopPropagation(ev); selectRoute(i); })
      .addTo(L_route);
  });
  const r = curRoute();
  if (!r) return;
  const ll = r.coordinates.map(c => [c[1], c[0]]);
  L.polyline(ll, { color: '#ffffff', weight: 13, opacity: 0.95, interactive: false }).addTo(L_route);
  L.polyline(ll, { color: '#1d4f9c', weight: 7, opacity: 1, interactive: false }).addTo(L_route);
}

function fitRoute() {
  const r = curRoute();
  if (!r) return;
  const b = L.latLngBounds(r.coordinates.map(c => [c[1], c[0]]));
  const p = sheetPadding();
  map.fitBounds(b, { paddingTopLeft: p.tl, paddingBottomRight: p.br });
}

function selectRoute(i) {
  if (i === state.sel || !state.routes[i]) return;
  state.sel = i;
  state.analysis = state.analysisByRoute[i] || null;
  state.analysisError = null;
  state.pois = [];
  state.rest = null;
  L_poi.clearLayers();
  L_rest.clearLayers();
  drawRoutes();
  renderRouteCards();
  renderHazards();
  renderAi();
  renderPois();
  renderRest();
  if (!state.analysis) runAnalysis();
}

function renderRouteCards() {
  const box = $('route-cards');
  if (!state.routes.length) { box.innerHTML = ''; return; }
  box.innerHTML = state.routes.map((r, i) => {
    const a = state.analysisByRoute[i];
    const min = r.summary.duration / 60;
    const toll = tollKm(r);
    let risk;
    if (a) {
      const parts = SEV_ORDER.filter(s => s !== 'low' && a.counts[s])
        .map(s => `<span class="pill sev-${s}">${SEV_LABEL[s]} ${a.counts[s]}</span>`);
      risk = parts.length ? parts.join('') : '<span>大きな危険箇所は見つかりませんでした</span>';
    } else if (state.analyzing === i) {
      risk = '<span>危険箇所を調べています…</span>';
    } else {
      risk = i === state.sel ? '' : '<span>タップすると危険箇所を調べます</span>';
    }
    return `<button class="rc ${i === state.sel ? 'is-sel' : ''}" type="button" data-i="${i}" aria-pressed="${i === state.sel}">
      <span class="rc-name">${i === 0 ? 'おすすめルート' : '別ルート' + i}</span>
      <span class="rc-main"><b>${fmtDur(min)}</b><span>${(r.summary.distance / 1000).toFixed(1)} km</span></span>
      <span class="rc-sub">到着 ${clockAfter(min)}${toll ? `<span class="sep">有料区間 ${toll} km</span>` : ''}</span>
      <span class="rc-risk">${risk}</span>
    </button>`;
  }).join('');
  box.querySelectorAll('.rc').forEach(b => { b.onclick = () => selectRoute(+b.dataset.i); });
}

/* ============================================================
 *  危険度解析
 * ========================================================== */
async function runAnalysis() {
  const r = curRoute();
  if (!r) return;
  const seq = state.seq, sel = state.sel;
  state.analyzing = sel;
  state.analysisError = null;
  renderHazards();
  renderAi();
  renderRouteCards();
  try {
    const d = await api('analyzeRoute', { route: r, vehicle: state.vehicle });
    if (seq !== state.seq) return;
    state.analysisByRoute[sel] = d;
    if (sel === state.sel) {
      state.analysis = d;
      if (d.counts.critical) {
        toast(`通行できない恐れのある箇所が${d.counts.critical}か所あります。「危険箇所」を確認してください`, 'err');
      }
    }
  } catch (e) {
    if (seq === state.seq && sel === state.sel) state.analysisError = e.message;
  } finally {
    if (seq === state.seq) {
      if (state.analyzing === sel) state.analyzing = -1;
      renderHazards();
      renderAi();
      renderRouteCards();
    }
  }
}

function signHtml(h) {
  const d = h.detail || {};
  switch (h.type) {
    case 'height_limit':
      return d.limitM != null ? `<span class="rs rs-h rs-sm${longCls(num1(d.limitM))}"><b>${num1(d.limitM)}</b><i>m</i></span>` : warnSign(h, '高');
    case 'width_limit':
      return `<span class="rs rs-w rs-sm${longCls(num1(d.limitM))}"><b>${num1(d.limitM)}</b><i>m</i></span>`;
    case 'weight_limit':
      return `<span class="rs rs-sm${longCls(num1(d.limitT))}"><b>${num1(d.limitT)}</b><i>t</i></span>`;
    case 'length_limit':
      return `<span class="rs rs-sm${longCls(num1(d.limitM))}"><b>${num1(d.limitM)}</b><i>m</i></span>`;
    case 'barrier':
      return '<span class="rs-noentry" aria-hidden="true"></span>';
    default:
      return warnSign(h, WARN_GLYPH[h.type] || '!');
  }
}
function warnSign(h, g) {
  return `<span class="ws ws-${h.severity}" aria-hidden="true"><span>${esc(g)}</span></span>`;
}

function hazardDetail(h) {
  const d = h.detail || {};
  switch (h.type) {
    case 'height_limit': return d.limitM != null ? `高さ制限 ${d.limitM}m（車高 ${d.vehicleM}m）` : (d.note || '');
    case 'width_limit': return `幅制限 ${d.limitM}m（車幅 ${d.vehicleM}m）`;
    case 'weight_limit': return `重量制限 ${d.limitT}t（総重量 ${d.vehicleT}t）`;
    case 'length_limit': return `長さ制限 ${d.limitM}m（全長 ${d.vehicleM}m）`;
    case 'very_narrow':
    case 'narrow_road': return d.roadWidthM ? `道路の幅 約${d.roadWidthM}m` : (d.note || '');
    case 'steep_up':
    case 'steep_down': return `勾配 ${d.grade}、約${d.lengthM}m続きます`;
    case 'hairpin_series': return `約${d.lengthM}mの間に急カーブが${d.count}か所`;
    case 'sharp_turn': return `向きが約${d.turnDeg}°変わるカーブ`;
    case 'barrier':
    case 'gate': return d.note || '';
    default: return d.lengthM ? `約${d.lengthM}m` : (d.note || '');
  }
}

function hazardPopup(h) {
  const osm = h.osmId ? `<p><a href="https://www.openstreetmap.org/${esc(h.osmId)}" target="_blank" rel="noopener">地図データを確認</a></p>` : '';
  return `<div class="pop">
    <div class="pop-head">${signHtml(h)}<strong>${esc(h.title || h.label)}</strong></div>
    <p class="pop-meta">${SEV_LABEL[h.severity]}<span class="sep">出発から ${h.distFromStartKm.toFixed(1)} km</span>${h.roadName ? `<span class="sep">${esc(h.roadName)}</span>` : ''}</p>
    <p>${esc(hazardDetail(h))}</p>
    ${h.advice ? `<p>${esc(h.advice)}</p>` : ''}
    ${osm}
  </div>`;
}

function renderHazards() {
  L_hazard.clearLayers();
  updateTabBadges();
  const box = $('hz-list'), cnt = $('hz-counts');
  const r = curRoute();

  if (!r) {
    cnt.innerHTML = '';
    box.innerHTML = empty('ルートを探すと、高さ制限・狭い道・急な坂などをここに一覧表示します。');
    return;
  }
  if (state.analyzing === state.sel) {
    cnt.innerHTML = '';
    box.innerHTML = loadingBlock('道路の制限情報とAIで危険箇所を調べています。長いルートでは1〜2分かかります');
    return;
  }
  const a = state.analysis;
  if (!a) {
    cnt.innerHTML = '';
    box.innerHTML = state.analysisError
      ? `<p class="err">${esc(state.analysisError)}</p><button class="btn-primary" type="button" id="btn-reanalyze">もう一度調べる</button>`
      : empty('');
    const rb = $('btn-reanalyze');
    if (rb) rb.onclick = runAnalysis;
    return;
  }

  cnt.innerHTML = SEV_ORDER.map(s =>
    `<span class="cnt sev-${s}"><b>${a.counts[s] || 0}</b>${SEV_LABEL[s]}</span>`).join('');

  const list = a.hazards.filter(h => state.showLow || h.severity !== 'low');
  if (!list.length) {
    box.innerHTML = empty(a.hazards.length
      ? '軽微な注意だけです。「軽微な注意も表示する」をオンにすると確認できます。'
      : '危険箇所は見つかりませんでした。現地の標識には引き続き注意してください。');
    return;
  }

  const coords = r.coordinates;
  const markers = {};
  list.forEach(h => {
    if (h.idxEnd > h.idx) {
      const seg = coords.slice(h.idx, h.idxEnd + 1).map(c => [c[1], c[0]]);
      L.polyline(seg, { pane: 'segPane', color: SEV_COLOR[h.severity], weight: 9, opacity: 0.85, lineCap: 'round', interactive: false })
        .addTo(L_hazard);
    }
    markers[h.id] = L.marker([h.lat, h.lng], {
      icon: L.divIcon({ className: 'map-ico', html: signHtml(h), iconSize: [38, 38], iconAnchor: [19, 19], popupAnchor: [0, -18] }),
      zIndexOffset: SEV_Z[h.severity],
      title: h.title || h.label,
    }).bindPopup(hazardPopup(h), { maxWidth: 280 }).addTo(L_hazard);
  });

  box.innerHTML = list.map(h => `
    <button class="hz-item sev-${h.severity}" type="button" data-id="${h.id}">
      ${signHtml(h)}
      <span class="hz-body">
        <span class="hz-title">${esc(h.title || h.label)}</span>
        <span class="hz-meta">${SEV_LABEL[h.severity]}<span class="sep">出発から ${h.distFromStartKm.toFixed(1)} km</span>${h.roadName ? `<span class="sep">${esc(h.roadName)}</span>` : ''}</span>
        <span class="hz-detail">${esc(hazardDetail(h))}</span>
        ${h.advice ? `<span class="hz-advice">${esc(h.advice)}</span>` : ''}
      </span>
    </button>`).join('');
  box.querySelectorAll('.hz-item').forEach(b => {
    b.onclick = () => {
      const h = list.find(x => x.id === b.dataset.id);
      if (h) focusOn([h.lat, h.lng], 17, markers[h.id]);
    };
  });
}

function renderAi() {
  const box = $('ai-box');
  const r = curRoute();
  if (!r) { box.innerHTML = ''; return; }
  if (state.analyzing === state.sel) {
    box.innerHTML = loadingBlock('危険箇所を調べています。先に地図でルートを確認できます');
    return;
  }
  const a = state.analysis;
  if (!a) {
    box.innerHTML = state.analysisError ? `<p class="note">危険箇所の確認に失敗しました：${esc(state.analysisError)}</p>` : '';
    return;
  }

  let html = '';
  if (a.ai) {
    const ai = a.ai;
    html += `<section class="ai risk-${esc(ai.overallRisk)}" aria-label="AIによるルートの所見">
      <header class="ai-head">
        <span class="ai-score" aria-label="危険度スコア">${ai.riskScore}</span>
        <span class="ai-level">このルートの危険度は${RISK_LABEL[ai.overallRisk] || '不明'}です</span>
      </header>
      <p>${esc(ai.summary)}</p>`;
    if (ai.additionalConcerns && ai.additionalConcerns.length) {
      html += `<h3>道路についての注意</h3><ul>${ai.additionalConcerns.map(c =>
        `<li><b>${esc(c.title)}</b>${c.roadName ? `（${esc(c.roadName)}）` : ''}：${esc(c.detail)}</li>`).join('')}</ul>`;
    }
    if (ai.recommendations && ai.recommendations.length) {
      html += `<h3>走行のアドバイス</h3><ul>${ai.recommendations.map(x => `<li>${esc(x)}</li>`).join('')}</ul>`;
    }
    if (ai.nightDrivingNote) html += `<h3>夜間に走る場合</h3><p>${esc(ai.nightDrivingNote)}</p>`;
    html += '</section>';
  } else if (a.aiError) {
    html += `<p class="note">AIの所見は取得できませんでした（${esc(a.aiError)}）。地図データから検出した危険箇所は「危険箇所」タブで確認できます。</p>`;
  }

  const s = a.stats || {};
  html += `<p class="stats">
    <span>上り合計 <b>${s.ascentM ?? '-'}m</b></span>
    <span>最高地点 <b>${s.maxElevationM ?? '-'}m</b></span>
    ${s.tollKm ? `<span>有料区間 <b>${s.tollKm}km</b></span>` : ''}
  </p>`;
  const cov = a.osmCoverage || {};
  if (cov.notes && cov.notes.length) html += `<p class="note">${cov.notes.map(esc).join('<br>')}</p>`;
  box.innerHTML = html;
}

/* ============================================================
 *  ルート沿いの施設
 * ========================================================== */
function renderPoiCats() {
  $('poi-cats').innerHTML = Object.entries(POI_CATS).map(([k, c]) => {
    const on = state.poiCats.has(k);
    return `<button class="chip ${on ? 'is-on' : ''}" type="button" data-cat="${k}" aria-pressed="${on}">
      <span class="pi pi-${k}" aria-hidden="true">${c.glyph}</span>${c.label}</button>`;
  }).join('');
  $('poi-cats').querySelectorAll('.chip').forEach(b => {
    b.onclick = () => {
      const k = b.dataset.cat;
      if (state.poiCats.has(k)) state.poiCats.delete(k); else state.poiCats.add(k);
      lsSet(CONFIG.LS.poiCats, [...state.poiCats]);
      renderPoiCats();
    };
  });
}

function renderRadius() {
  $('poi-radius').querySelectorAll('button').forEach(b => {
    const on = +b.dataset.r === state.radius;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-checked', String(on));
    b.setAttribute('role', 'radio');
  });
}

async function searchPois() {
  if (!requireLogin()) return;
  const r = curRoute();
  if (!r) { toast('先にルートを探してください', 'err'); return; }
  if (!state.poiCats.size) { toast('探す施設を1つ以上選んでください', 'err'); return; }
  const seq = state.seq, sel = state.sel;
  const btn = $('btn-poi');
  btn.disabled = true;
  setBusy('ルート沿いの施設を探しています…');
  try {
    const d = await api('searchAlongRoute', { route: r, radius: state.radius, categories: [...state.poiCats] });
    if (seq !== state.seq || sel !== state.sel) return;
    state.pois = d.pois;
    state.poiNotes = d.notes || [];
    state.poiDepart = new Date();
    renderPois();
    if (!d.pois.length) toast('条件に合う施設は見つかりませんでした。距離を広げてみてください');
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    setBusy(null);
  }
}

function poiIcon(cat) {
  return L.divIcon({
    className: '',
    html: `<span class="pi pi-${cat} pi-map">${POI_CATS[cat] ? POI_CATS[cat].glyph : '★'}</span>`,
    iconSize: [34, 34], iconAnchor: [17, 17], popupAnchor: [0, -16],
  });
}

function tagsHtml(info) {
  info = info || {};
  const t = [];
  const oh = info.opening_hours;
  if (oh === '24/7') t.push('24時間');
  else if (oh) t.push('営業 ' + String(oh).slice(0, 40));
  if (info.hgv === 'yes' || info.hgv === 'designated') t.push('大型車可');
  if (info['fuel:HGV_diesel'] === 'yes') t.push('大型車用給油');
  if (info['fuel:diesel'] === 'yes') t.push('軽油');
  if (info['capacity:caravans']) t.push('キャンピングカー枠 ' + info['capacity:caravans'] + '台');
  else if (info.caravans === 'yes') t.push('キャンピングカー可');
  if (info.power_supply && info.power_supply !== 'no') t.push('電源あり');
  if (info.shower === 'yes' || info.shower === 'hot') t.push('シャワー');
  if (info.toilets === 'yes') t.push('トイレ');
  if (info.drinking_water === 'yes') t.push('給水');
  if (info.fee === 'no') t.push('無料');
  else if (info.fee === 'yes') t.push('有料');
  if (info['bath:type'] === 'onsen') t.push('温泉');

  let h = t.length ? `<ul class="tags">${t.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : '';
  const phone = info.phone || info['contact:phone'];
  const web = info.website || info['contact:website'];
  const links = [];
  if (phone) links.push(`<a href="tel:${esc(String(phone).split(/[;,]/)[0].replace(/[^\d+]/g, ''))}">電話する</a>`);
  if (web && /^https?:\/\//.test(web)) links.push(`<a href="${esc(web)}" target="_blank" rel="noopener noreferrer">公式サイト</a>`);
  if (links.length) h += `<p class="links">${links.join('')}</p>`;
  return h;
}

/** 経由地として正しい順番に差し込む位置 */
function viaInsertIndex(alongKm) {
  const r = curRoute();
  if (!r || alongKm == null) return state.vias.length;
  const cum = routeCumKm(r);
  const inner = (r.wayPoints || []).slice(1, -1);
  return Math.min(state.vias.length, inner.filter(w => cum[w] < alongKm).length);
}

function addAsVia(p) {
  setPoint('via', { lat: p.lat, lng: p.lng, label: p.name }, { insertAt: viaInsertIndex(p.alongKm), reroute: true });
  showTab('route');
  toast(`「${p.name}」を経由地に追加しました`);
}

function poiActionsHtml(key, p) {
  const fav = isFav(p);
  return `<div class="tl-actions">
    <button class="btn-sm primary" type="button" data-via="${key}">経由地に追加</button>
    <button class="btn-star ${fav ? 'is-on' : ''}" type="button" data-fav="${key}" data-favid="${esc(favKey(p))}"
      aria-pressed="${fav}" aria-label="お気に入り">★</button>
  </div>`;
}

function poiPopup(p, key) {
  return `<div class="pop">
    <div class="pop-head"><span class="pi pi-${p.category}">${POI_CATS[p.category].glyph}</span><strong>${esc(p.name)}</strong></div>
    <p class="pop-meta">${POI_CATS[p.category].label}<span class="sep">出発から ${p.alongKm.toFixed(1)} km</span><span class="sep">ルートから ${fmtDist(p.distToRouteM)}</span></p>
    ${tagsHtml(p.info)}
    ${poiActionsHtml(key, p)}
  </div>`;
}

function bindPoiActions(root, getPoi) {
  root.querySelectorAll('[data-via]').forEach(b => {
    b.onclick = ev => { ev.stopPropagation(); const p = getPoi(b.dataset.via); if (p) { map.closePopup(); addAsVia(p); } };
  });
  root.querySelectorAll('[data-fav]').forEach(b => {
    b.onclick = ev => { ev.stopPropagation(); const p = getPoi(b.dataset.fav); if (p) toggleFav(p); };
  });
}

function renderPois() {
  L_poi.clearLayers();
  updateTabBadges();
  const box = $('poi-list');
  if (!curRoute()) {
    box.innerHTML = empty('ルートを探したあと、道の駅や温泉をルート沿いから探せます。');
    return;
  }
  if (!state.pois.length) {
    box.innerHTML = empty('施設の種類と距離を選んで「ルート沿いを探す」を押してください。');
    return;
  }
  const getPoi = k => state.pois[+k];
  const markers = [];
  state.pois.forEach((p, i) => {
    const m = L.marker([p.lat, p.lng], { icon: poiIcon(p.category), title: p.name })
      .bindPopup(poiPopup(p, i), { maxWidth: 280 })
      .addTo(L_poi);
    m.on('popupopen', e => bindPoiActions(e.popup.getElement(), getPoi));
    markers[i] = m;
  });

  box.innerHTML = state.pois.map((p, i) => {
    const eta = p.etaMin != null ? clockAfter(p.etaMin, state.poiDepart) : '';
    return `<article class="tl-item">
      <div class="tl-km"><b>${p.alongKm.toFixed(1)}</b><span>km</span>${eta ? `<em>${eta}頃</em>` : ''}</div>
      <div class="tl-body">
        <button class="tl-head" type="button" data-focus="${i}">
          <span class="pi pi-${p.category}" aria-hidden="true">${POI_CATS[p.category].glyph}</span>
          <span class="tl-name">${esc(p.name)}</span>
        </button>
        <p class="tl-meta"><span>${POI_CATS[p.category].label}</span><span>ルートから ${fmtDist(p.distToRouteM)}</span></p>
        ${tagsHtml(p.info)}
        ${poiActionsHtml(i, p)}
      </div>
    </article>`;
  }).join('') + (state.poiNotes.length ? `<p class="note">${state.poiNotes.map(esc).join('<br>')}</p>` : '');

  box.querySelectorAll('[data-focus]').forEach(b => {
    b.onclick = () => { const i = +b.dataset.focus; const p = state.pois[i]; focusOn([p.lat, p.lng], 16, markers[i]); };
  });
  bindPoiActions(box, getPoi);
}

/* ============================================================
 *  休憩計画
 * ========================================================== */
function initRestDepart() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  $('rest-depart').value = d.toISOString().slice(0, 16);
}

async function planRest() {
  if (!requireLogin()) return;
  const r = curRoute();
  if (!r) { toast('先にルートを探してください', 'err'); return; }
  const v = $('rest-depart').value;
  const depart = v ? new Date(v) : new Date();
  if (isNaN(depart.getTime())) { toast('出発時刻を正しく入力してください', 'err'); return; }
  const seq = state.seq, sel = state.sel;
  const btn = $('btn-rest');
  btn.disabled = true;
  setBusy('休憩場所を探しています…');
  try {
    const d = await api('restPlan', { route: r, intervalMin: +$('rest-interval').value, departAt: depart.toISOString() });
    if (seq !== state.seq || sel !== state.sel) return;
    state.rest = d;
    renderRest();
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.disabled = false;
    setBusy(null);
  }
}

function restPoiHtml(p, key) {
  const fav = isFav(p);
  return `<div class="rest-poi">
    <button class="tl-head" type="button" data-rfocus="${key}">
      <span class="pi pi-${p.category}" aria-hidden="true">${POI_CATS[p.category] ? POI_CATS[p.category].glyph : '★'}</span>
      <span class="tl-name">${esc(p.name)}</span>
    </button>
    <p class="tl-meta"><span>${esc(p.label)}</span><span>出発から ${p.alongKm.toFixed(1)} km</span><span>到着まで ${fmtDur(p.etaMin)}</span></p>
    ${tagsHtml(p.info)}
    <div class="tl-actions">
      <button class="btn-sm primary" type="button" data-via="${key}">経由地に追加</button>
      <button class="btn-star ${fav ? 'is-on' : ''}" type="button" data-fav="${key}" data-favid="${esc(favKey(p))}" aria-pressed="${fav}" aria-label="お気に入り">★</button>
    </div>
  </div>`;
}

function renderRest() {
  L_rest.clearLayers();
  const box = $('rest-list');
  if (!curRoute()) {
    box.innerHTML = empty('ルートを探したあと、休憩場所を運転時間に合わせて提案します。');
    return;
  }
  const d = state.rest;
  if (!d) {
    box.innerHTML = empty('出発時刻を確認して「休憩場所を提案」を押してください。');
    return;
  }

  const getPoi = key => {
    const [i, j] = String(key).split(':').map(Number);
    const s = d.stops[i];
    if (!s) return null;
    return j < 0 ? s.poi : (s.alternatives || [])[j];
  };

  let html = `<div class="arrive ${d.arrival.night ? 'is-night' : ''}">
    <span>到着予定</span><b>${d.arrival.clock || '--:--'}</b><span>運転 ${fmtDur(d.arrival.totalMin)}</span>
    ${d.arrival.night ? '<p>夜間の到着です。目的地の進入路と停める場所を、明るいうちに確認しておくと安心です。</p>' : ''}
  </div>`;

  if (!d.stops.length) html += empty(d.message || '途中休憩は必要ない距離です。');

  html += d.stops.map((s, i) => `
    <article class="rest-item ${s.night ? 'is-night' : ''}">
      <header><span class="rest-no">休憩${i + 1}</span><b>${s.clock || ''}</b><span>出発から ${fmtDur(s.etaMin)}</span></header>
      ${s.poi ? restPoiHtml(s.poi, `${i}:-1`) : `<p class="note">${esc(s.note)}</p><button class="btn-sm" type="button" data-rpt="${i}">地図で位置を見る</button>`}
      ${s.poi && s.note ? `<p class="note">${esc(s.note)}</p>` : ''}
      ${s.alternatives && s.alternatives.length ? `<details><summary>ほかの候補（${s.alternatives.length}件）</summary>
        ${s.alternatives.map((a, j) => restPoiHtml(a, `${i}:${j}`)).join('')}</details>` : ''}
    </article>`).join('');

  if (d.notes && d.notes.length) html += `<p class="note">${d.notes.map(esc).join('<br>')}</p>`;
  box.innerHTML = html;

  const markers = {};
  d.stops.forEach((s, i) => {
    if (!s.poi) return;
    markers[`${i}:-1`] = L.marker([s.poi.lat, s.poi.lng], { icon: poiIcon(s.poi.category), title: s.poi.name, zIndexOffset: 500 })
      .bindPopup(`<div class="pop"><div class="pop-head"><strong>休憩${i + 1}：${esc(s.poi.name)}</strong></div><p class="pop-meta">${s.clock || ''}頃</p></div>`)
      .addTo(L_rest);
  });

  box.querySelectorAll('[data-rfocus]').forEach(b => {
    b.onclick = () => { const p = getPoi(b.dataset.rfocus); if (p) focusOn([p.lat, p.lng], 16, markers[b.dataset.rfocus]); };
  });
  box.querySelectorAll('[data-rpt]').forEach(b => {
    b.onclick = () => { const s = d.stops[+b.dataset.rpt]; focusOn([s.lat, s.lng], 13); };
  });
  bindPoiActions(box, getPoi);
}

/* ============================================================
 *  お気に入り
 * ========================================================== */
function favKey(p) {
  return p.id || `${Number(p.lat).toFixed(5)},${Number(p.lng).toFixed(5)}`;
}
function isFav(p) {
  const k = favKey(p);
  return state.favorites.some(f => f.id === k);
}

let favSaveTimer;
function saveFavs() {
  lsSet(CONFIG.LS.favs, state.favorites);
  clearTimeout(favSaveTimer);
  if (!isLoggedIn()) return;
  favSaveTimer = setTimeout(() => {
    api('saveData', { type: 'favorites', data: state.favorites }).catch(e => console.warn('お気に入りのバックアップ失敗', e));
  }, 1500);
}

function toggleFav(p) {
  const id = favKey(p);
  const i = state.favorites.findIndex(f => f.id === id);
  if (i >= 0) {
    state.favorites.splice(i, 1);
    toast('お気に入りから外しました');
  } else {
    state.favorites.unshift({
      id, name: p.name || p.label, lat: p.lat, lng: p.lng,
      category: p.category || null, addedAt: new Date().toISOString(),
    });
    toast('お気に入りに追加しました');
  }
  saveFavs();
  refreshFavButtons(id);
  renderFavs();
}

function refreshFavButtons(id) {
  const on = state.favorites.some(f => f.id === id);
  document.querySelectorAll('[data-favid]').forEach(b => {
    if (b.dataset.favid !== id) return;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-pressed', String(on));
  });
}

function renderFavs() {
  updateTabBadges();
  const box = $('fav-list');
  if (!state.favorites.length) {
    box.innerHTML = empty('ルート沿いの施設や休憩場所の★を押すと、ここに保存されます。');
    return;
  }
  box.innerHTML = state.favorites.map((f, i) => {
    const cat = POI_CATS[f.category];
    return `<article class="fav-item">
      <button class="tl-head" type="button" data-ffocus="${i}">
        <span class="pi ${cat ? 'pi-' + f.category : 'pi-fav'}" aria-hidden="true">${cat ? cat.glyph : '★'}</span>
        <span class="tl-name">${esc(f.name)}</span>
      </button>
      <p class="tl-meta">${cat ? `<span>${cat.label}</span>` : ''}</p>
      <div class="tl-actions">
        <button class="btn-sm primary" type="button" data-fend="${i}">目的地にする</button>
        <button class="btn-sm" type="button" data-fvia="${i}">経由地に追加</button>
        <button class="btn-icon" type="button" data-fdel="${i}" aria-label="${esc(f.name)}を削除">✕</button>
      </div>
    </article>`;
  }).join('');

  box.querySelectorAll('[data-ffocus]').forEach(b => {
    b.onclick = () => { const f = state.favorites[+b.dataset.ffocus]; focusOn([f.lat, f.lng], 15); };
  });
  box.querySelectorAll('[data-fend]').forEach(b => {
    b.onclick = () => {
      const f = state.favorites[+b.dataset.fend];
      setPoint('end', { lat: f.lat, lng: f.lng, label: f.name });
      showTab('route');
      toast(`「${f.name}」を目的地にしました`);
    };
  });
  box.querySelectorAll('[data-fvia]').forEach(b => {
    b.onclick = () => {
      const f = state.favorites[+b.dataset.fvia];
      setPoint('via', { lat: f.lat, lng: f.lng, label: f.name }, { reroute: !!(state.start && state.end) });
      showTab('route');
      toast(`「${f.name}」を経由地に追加しました`);
    };
  });
  box.querySelectorAll('[data-fdel]').forEach(b => {
    b.onclick = () => {
      const f = state.favorites[+b.dataset.fdel];
      state.favorites.splice(+b.dataset.fdel, 1);
      saveFavs();
      refreshFavButtons(f.id);
      renderFavs();
    };
  });
}

/* ============================================================
 *  車両プロファイル
 * ========================================================== */
function totalWeight(v) {
  return Math.round(((+v.weight || 0) + (v.trailer ? (+v.trailerWeight || 0) : 0)) * 100) / 100;
}

function renderVehicle() {
  const v = state.vehicle, b = $('btn-vehicle');
  if (!v) {
    b.innerHTML = '<span class="veh-empty">車両を登録</span>';
    b.setAttribute('aria-label', '車両の寸法を登録');
    return;
  }
  const h = num1(v.height), w = num1(v.width), t = num1(totalWeight(v));
  b.innerHTML = `
    <span class="rs rs-h${longCls(h)}"><b>${h}</b><i>m</i></span>
    <span class="rs rs-w${longCls(w)}"><b>${w}</b><i>m</i></span>
    <span class="rs${longCls(t)}"><b>${t}</b><i>t</i></span>`;
  b.setAttribute('aria-label', `車両の寸法：高さ${v.height}m、幅${v.width}m、重量${totalWeight(v)}t、全長${v.length}m。変更する`);
}

function fillVehicleForm() {
  const f = $('form-vehicle'), v = state.vehicle || {};
  const el = n => f.elements.namedItem(n); // 'length' は elements.length と衝突するため namedItem を使う
  el('name').value = v.name || '';
  ['height', 'width', 'length', 'weight', 'trailerLength', 'trailerWeight'].forEach(k => {
    el(k).value = v[k] != null && v[k] !== 0 ? v[k] : '';
  });
  f.elements.drive.value = v.drive === '4WD' ? '4WD' : '2WD';
  f.elements.trailer.checked = !!v.trailer;
  $('trailer-fields').hidden = !v.trailer;
  $('veh-err').hidden = true;
}

function openVehicle() {
  fillVehicleForm();
  const dlg = $('dlg-vehicle');
  if (!dlg.open) dlg.showModal();
}

function readVehicleForm() {
  const f = $('form-vehicle');
  const g = n => f.elements.namedItem(n).value.trim();
  const num = (n, min, max, label) => {
    const x = Number(g(n));
    if (g(n) === '' || !isFinite(x) || x < min || x > max) {
      throw new Error(`${label}は ${min}〜${max} の範囲で入力してください`);
    }
    return Math.round(x * 100) / 100;
  };
  const trailer = f.elements.trailer.checked;
  return {
    name: g('name').slice(0, 40),
    height: num('height', 1.5, 4, '全高'),
    width: num('width', 1.4, 2.6, '車幅'),
    length: num('length', 3, 12, '全長'),
    weight: num('weight', 0.5, 25, '車両総重量'),
    drive: f.elements.drive.value === '4WD' ? '4WD' : '2WD',
    trailer,
    trailerLength: trailer ? num('trailerLength', 0, 10, 'トレーラー長') : 0,
    trailerWeight: trailer ? num('trailerWeight', 0, 10, 'トレーラー重量') : 0,
  };
}

function saveVehicle(ev) {
  ev.preventDefault();
  let v;
  try {
    v = readVehicleForm();
  } catch (e) {
    $('veh-err').textContent = e.message;
    $('veh-err').hidden = false;
    return;
  }
  const changed = JSON.stringify(v) !== JSON.stringify(state.vehicle);
  state.vehicle = v;
  lsSet(CONFIG.LS.vehicle, v);
  renderVehicle();
  $('dlg-vehicle').close();
  toast('車両の寸法を保存しました');
  if (isLoggedIn()) api('saveData', { type: 'profile', data: v }).catch(e => console.warn('車両のバックアップ失敗', e));
  if (changed && state.start && state.end && state.routes.length) {
    toast('車両の寸法が変わったため、ルートを探し直します');
    searchRoute();
  }
}

/** ログイン後：サーバー（Drive）の車両設定・お気に入りと同期 */
async function syncFromServer() {
  try {
    const d = await api('loadAll');
    const prof = d.profile && d.profile.data;
    if (prof) {
      state.vehicle = prof;
      lsSet(CONFIG.LS.vehicle, prof);
      renderVehicle();
    } else if (state.vehicle) {
      api('saveData', { type: 'profile', data: state.vehicle }).catch(() => {});
    }

    const server = (d.favorites && d.favorites.data) || [];
    const ids = new Set(server.map(f => f.id));
    const localOnly = state.favorites.filter(f => f && f.id && !ids.has(f.id));
    state.favorites = server.concat(localOnly);
    lsSet(CONFIG.LS.favs, state.favorites);
    renderFavs();
    if (localOnly.length) saveFavs();
  } catch (e) {
    console.warn('サーバーとの同期に失敗', e);
  }
}

async function onLoggedIn() {
  await syncFromServer();
  if (!state.vehicle) openVehicle();
}

/** ログアウト時：共用端末でも前の人のデータが残らないよう消去 */
function onLoggedOut(info) {
  if (info && info.expired) return; // 期限切れ時は同じ人が再ログインする想定で残す
  state.vehicle = null;
  state.favorites = [];
  lsSet(CONFIG.LS.vehicle, null);
  lsSet(CONFIG.LS.favs, []);
  clearRoute();
  renderVehicle();
  renderFavs();
}

/* ============================================================
 *  夜間モード
 * ========================================================== */
function applyDark(on) {
  document.documentElement.classList.toggle('dark', on);
  document.querySelector('meta[name="theme-color"]').content = on ? '#1b1e22' : '#1d4f9c';
  $('btn-dark').setAttribute('aria-pressed', String(on));
  lsSet(CONFIG.LS.dark, on);
}

/* ============================================================
 *  イベント登録
 * ========================================================== */
function bindUI() {
  document.querySelectorAll('.tab').forEach(b => { b.onclick = () => showTab(b.dataset.tab); });

  $('sheet-handle').onclick = () => {
    const s = $('sheet').dataset.state;
    setSheet(s === 'full' ? 'peek' : 'full');
  };

  document.querySelectorAll('[data-geo]').forEach(b => { b.onclick = () => doGeocode(b.dataset.geo); });
  ['start', 'via', 'end'].forEach(w => {
    const input = $('in-' + w);
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); doGeocode(w); }
    });
    input.addEventListener('input', () => { $('res-' + w).hidden = true; });
  });
  $('btn-here').onclick = () => locate(true);

  $('via-list').onclick = e => {
    const up = e.target.closest('[data-up]'), del = e.target.closest('[data-del]');
    if (up) {
      const i = +up.dataset.up;
      if (i > 0) { [state.vias[i - 1], state.vias[i]] = [state.vias[i], state.vias[i - 1]]; afterPointsChanged(false); }
    } else if (del) {
      state.vias.splice(+del.dataset.del, 1);
      afterPointsChanged(false);
    }
  };

  $('opt-tolls').checked = state.opts.avoidTolls;
  $('opt-highways').checked = state.opts.avoidHighways;
  $('opt-pref').value = state.opts.preference;
  const saveOpts = () => {
    state.opts = {
      avoidTolls: $('opt-tolls').checked,
      avoidHighways: $('opt-highways').checked,
      preference: $('opt-pref').value,
    };
    lsSet(CONFIG.LS.opts, state.opts);
  };
  ['opt-tolls', 'opt-highways', 'opt-pref'].forEach(id => $(id).addEventListener('change', saveOpts));

  $('btn-route').onclick = searchRoute;

  $('opt-lowhaz').checked = state.showLow;
  $('opt-lowhaz').onchange = e => {
    state.showLow = e.target.checked;
    lsSet(CONFIG.LS.lowHaz, state.showLow);
    renderHazards();
  };

  $('poi-radius').querySelectorAll('button').forEach(b => {
    b.onclick = () => { state.radius = +b.dataset.r; lsSet(CONFIG.LS.radius, state.radius); renderRadius(); };
  });
  $('btn-poi').onclick = searchPois;
  $('btn-rest').onclick = planRest;

  $('btn-vehicle').onclick = openVehicle;
  $('form-vehicle').addEventListener('submit', saveVehicle);
  $('veh-cancel').onclick = () => $('dlg-vehicle').close();
  $('veh-trailer').onchange = e => { $('trailer-fields').hidden = !e.target.checked; };

  $('btn-locate').onclick = () => locate(false);
  $('btn-dark').onclick = () => applyDark(!document.documentElement.classList.contains('dark'));
}

/* ============================================================
 *  起動
 * ========================================================== */
function init() {
  state.vehicle = lsGet(CONFIG.LS.vehicle);
  state.favorites = lsGet(CONFIG.LS.favs, []) || [];
  state.showLow = !!lsGet(CONFIG.LS.lowHaz, false);
  const cats = lsGet(CONFIG.LS.poiCats);
  if (Array.isArray(cats)) state.poiCats = new Set(cats.filter(c => POI_CATS[c]));
  const rad = lsGet(CONFIG.LS.radius);
  if ([500, 1000, 2000].includes(rad)) state.radius = rad;
  const opts = lsGet(CONFIG.LS.opts);
  if (opts && typeof opts === 'object') Object.assign(state.opts, opts);

  const dk = lsGet(CONFIG.LS.dark);
  applyDark(dk == null ? window.matchMedia('(prefers-color-scheme: dark)').matches : !!dk);

  initMap();
  bindUI();
  renderVehicle();
  renderPoiCats();
  renderRadius();
  initRestDepart();
  renderPoints();
  renderRouteCards();
  renderAi();
  renderHazards();
  renderPois();
  renderRest();
  renderFavs();

  if (!apiReady()) {
    toast('config.js の GAS_URL を設定すると、ルート探索が使えるようになります', 'err');
    return;
  }
  initAuth({ onLogin: onLoggedIn, onLogout: onLoggedOut });
}

document.addEventListener('DOMContentLoaded', init);
