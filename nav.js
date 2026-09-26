/* ============================================================
 *  RV_navi  走行中ナビ  nav.js v1.2.1
 *  - 現在地を追いかける地図表示（進行方向の矢印）
 *  - 次の曲がり角の案内（案内標識風の表示＋音声）
 *  - 危険箇所の事前警告（高さ・幅制限、狭路、急坂など）
 *  - ルートを外れたら自動で再探索（危険度解析もやり直し）
 *  - 残り距離・残り時間・到着予定、連続運転の休憩リマインド
 *  - 画面の自動消灯を防止（対応ブラウザのみ）
 *  - テスト走行（シミュレーション）
 *  読み込み順：config.js → auth.js → app.js → nav.js
 * ============================================================ */
'use strict';

window.RV_FILES = window.RV_FILES || {};
window.RV_FILES.nav = '1.2.1';

const nav = {
  active: false,
  sim: false,
  simSpeed: 1,
  simAlong: 0,
  simTimer: null,
  watchId: null,
  route: null,
  routeKey: 0,
  coords: null,
  cumM: null,
  tArr: null,
  waycat: null,
  steps: [],
  idx: 0,
  along: 0,
  totalM: 0,
  passedVia: new Set(),
  offCount: 0,
  offSince: 0,
  lastReroute: 0,
  rerouting: false,
  announced: new Set(),
  voice: true,
  follow: true,
  marker: null,
  trail: null,
  L: null,
  wakeLock: null,
  startedAt: 0,
  lastRemind: 0,
  lastTrail: 0,
  lastPos: null,
  arrived: false,
};

/* 曲がり方（ORS の step.type） */
const MANEUVER = {
  0: { rot: -90, text: '左方向' },
  1: { rot: 90, text: '右方向' },
  2: { rot: -135, text: '左に大きく曲がる' },
  3: { rot: 135, text: '右に大きく曲がる' },
  4: { rot: -45, text: '斜め左' },
  5: { rot: 45, text: '斜め右' },
  6: { rot: 0, text: '直進' },
  7: { glyph: '↻', text: 'ロータリー' },
  8: { glyph: '↻', text: 'ロータリーを出る' },
  9: { glyph: '⤺', text: 'Uターン' },
  10: { glyph: '着', text: '目的地' },
  11: { rot: 0, text: '出発' },
  12: { rot: -25, text: '左側を進む' },
  13: { rot: 25, text: '右側を進む' },
};

const ARROW_SVG = '<svg viewBox="0 0 48 48" width="100%" height="100%" aria-hidden="true"><path d="M24 3 L40 21 H29.5 V45 H18.5 V21 H8 Z" fill="currentColor"/></svg>';

/* ============================================================
 *  補助
 * ========================================================== */
const $n = id => document.getElementById(id);
const NAV_DEG = Math.PI / 180;

function navBearing(a, b) { // [lng,lat]
  const y = Math.sin((b[0] - a[0]) * NAV_DEG) * Math.cos(b[1] * NAV_DEG);
  const x = Math.cos(a[1] * NAV_DEG) * Math.sin(b[1] * NAV_DEG) -
    Math.sin(a[1] * NAV_DEG) * Math.cos(b[1] * NAV_DEG) * Math.cos((b[0] - a[0]) * NAV_DEG);
  return (Math.atan2(y, x) / NAV_DEG + 360) % 360;
}

function speakDist(m) {
  if (m >= 950) {
    const km = Math.round(m / 500) / 2;
    return `${km % 1 ? km.toFixed(1) : km}キロ`;
  }
  const r = m >= 200 ? Math.round(m / 100) * 100 : Math.max(10, Math.round(m / 10) * 10);
  return `${r}メートル`;
}

function showDist(m) {
  if (m >= 1000) return (m / 1000).toFixed(m >= 10000 ? 0 : 1) + 'km';
  return (m >= 200 ? Math.round(m / 50) * 50 : Math.max(0, Math.round(m / 10) * 10)) + 'm';
}

function speak(text, urgent) {
  if (!nav.voice || !('speechSynthesis' in window) || !text) return;
  try {
    if (urgent) window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'ja-JP';
    u.rate = 1.05;
    const v = window.speechSynthesis.getVoices().find(x => /^ja/i.test(x.lang));
    if (v) u.voice = v;
    window.speechSynthesis.speak(u);
  } catch (e) { /* 音声非対応 */ }
}

function navStatus(text) {
  const el = $n('nav-status');
  el.hidden = !text;
  if (text) el.textContent = text;
}

/** 案内ステップの所要時間から各座標の到達時刻(秒)を算出 */
function navTimeArr(r, cumM) {
  const n = cumM.length, arr = new Float64Array(n), total = cumM[n - 1] || 1;
  const dur = Number(r.summary && r.summary.duration) || 0;
  for (let i = 0; i < n; i++) arr[i] = dur * cumM[i] / total;
  let t0 = 0;
  (r.steps || []).forEach(s => {
    if (!Array.isArray(s.wp)) return;
    const a = Math.max(0, Math.min(n - 1, s.wp[0] | 0)), b = Math.max(0, Math.min(n - 1, s.wp[1] | 0));
    const d = cumM[b] - cumM[a], du = Number(s.duration) || 0;
    for (let i = a; i <= b; i++) arr[i] = t0 + (d > 0 ? du * (cumM[i] - cumM[a]) / d : 0);
    t0 += du;
  });
  return arr;
}

function idxAtAlong(m) {
  const c = nav.cumM;
  let lo = 0, hi = c.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid] < m) lo = mid + 1; else hi = mid;
  }
  return Math.max(0, lo - 1);
}

function timeAtAlong(m) {
  const i = idxAtAlong(m), c = nav.cumM, t = nav.tArr;
  if (i >= c.length - 1) return t[t.length - 1];
  const seg = c[i + 1] - c[i];
  const f = seg > 0 ? (m - c[i]) / seg : 0;
  return t[i] + (t[i + 1] - t[i]) * f;
}

function pointAtAlong(m) {
  const i = idxAtAlong(m), c = nav.coords, cm = nav.cumM;
  if (i >= c.length - 1) return { lat: c[c.length - 1][1], lng: c[c.length - 1][0], i: c.length - 1 };
  const seg = cm[i + 1] - cm[i];
  const f = seg > 0 ? Math.max(0, Math.min(1, (m - cm[i]) / seg)) : 0;
  return {
    lng: c[i][0] + (c[i + 1][0] - c[i][0]) * f,
    lat: c[i][1] + (c[i + 1][1] - c[i][1]) * f,
    i,
  };
}

/* ============================================================
 *  ルートの読み込み・現在地のルート上への当てはめ
 * ========================================================== */
function loadRouteIntoNav(r) {
  nav.route = r;
  nav.routeKey++;
  nav.coords = r.coordinates;
  nav.cumM = Float64Array.from(routeCumKm(r), v => v * 1000);
  nav.totalM = nav.cumM[nav.cumM.length - 1];
  nav.tArr = navTimeArr(r, nav.cumM);
  nav.steps = (r.steps || []).filter(s => Array.isArray(s.wp));
  const n = nav.coords.length;
  nav.waycat = new Int16Array(n);
  const wc = r.extras && r.extras.waycategory;
  if (wc && Array.isArray(wc.values)) {
    wc.values.forEach(v => { for (let i = Math.max(0, v[0]); i <= Math.min(n - 1, v[1]); i++) nav.waycat[i] = v[2]; });
  }
  nav.idx = 0;
  nav.along = 0;
  nav.simAlong = 0;
  nav.offCount = 0;
  nav.passedVia = new Set();
  nav.arrived = false;
  if (nav.trail) nav.trail.setLatLngs([]);
}

function snapToRoute(lat, lng) {
  const c = nav.coords, n = c.length;
  const kx = 111320 * Math.cos(lat * NAV_DEG), ky = 110540;
  const search = (from, to) => {
    let best = { d: Infinity, i: 0, t: 0 };
    for (let i = from; i < to; i++) {
      const a = c[i], b = c[i + 1];
      const ax = (a[0] - lng) * kx, ay = (a[1] - lat) * ky;
      const dx = (b[0] - a[0]) * kx, dy = (b[1] - a[1]) * ky;
      const L2 = dx * dx + dy * dy;
      let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const d = Math.hypot(ax + t * dx, ay + t * dy);
      if (d < best.d) best = { d, i, t };
    }
    return best;
  };
  let b = search(Math.max(0, nav.idx - 40), Math.min(n - 1, nav.idx + 800));
  if (b.d > 80) {
    const g = search(0, n - 1);
    if (g.d < b.d) b = g;
  }
  b.along = nav.cumM[b.i] + (nav.cumM[b.i + 1] - nav.cumM[b.i]) * b.t;
  return b;
}

/* ============================================================
 *  開始・終了
 * ========================================================== */
async function startNav(simulate) {
  const r = curRoute();
  if (!r) { toast('先にルートを探してください', 'err'); return; }
  const a = state.analysis;
  if (a && a.counts && a.counts.critical) {
    if (!window.confirm(`このルートには、車両が通行できない恐れのある箇所が${a.counts.critical}か所あります。\nこのまま案内を開始しますか？`)) return;
  }
  if (!simulate && !navigator.geolocation) { toast('この端末では現在地を取得できません', 'err'); return; }

  nav.active = true;
  nav.sim = !!simulate;
  nav.simSpeed = 1;
  nav.follow = true;
  nav.startedAt = Date.now();
  nav.lastRemind = Date.now();
  nav.announced = new Set();
  loadRouteIntoNav(r);

  if (!nav.L) {
    nav.L = L.layerGroup().addTo(map);
    nav.trail = L.polyline([], { color: '#8a939e', weight: 8, opacity: 0.9, interactive: false }).addTo(nav.L);
    nav.marker = L.marker([r.coordinates[0][1], r.coordinates[0][0]], {
      icon: L.divIcon({ className: '', html: '<div class="nav-car"><div class="nav-car-arrow">' + ARROW_SVG + '</div></div>', iconSize: [44, 44], iconAnchor: [22, 22] }),
      interactive: false, keyboard: false, zIndexOffset: 3000,
    }).addTo(nav.L);
  } else {
    nav.L.addTo(map);
  }

  document.body.classList.add('nav-mode');
  $n('nav-ui').hidden = false;
  $n('nav-sim-speed').hidden = !nav.sim;
  $n('nav-sim-speed').textContent = '速さ ×1';
  $n('nav-voice').setAttribute('aria-pressed', String(nav.voice));
  $n('nav-voice').textContent = nav.voice ? '音声 オン' : '音声 オフ';
  $n('nav-recenter').hidden = true;
  navStatus(nav.sim ? 'テスト走行中です（実際の位置は使いません）' : '現在地を取得しています…');
  if (nav.sim) setTimeout(() => { if (nav.active && nav.sim) navStatus(null); }, 4000);

  requestWakeLock();
  const minTotal = Math.round((r.summary.duration || 0) / 60);
  speak(`案内を開始します。目的地まで${(nav.totalM / 1000).toFixed(0)}キロ、およそ${fmtDur(minTotal)}です。運転中は画面を操作しないでください。`, true);

  if (nav.sim) {
    nav.simTimer = setInterval(simTick, 1000);
    simTick();
  } else {
    nav.watchId = navigator.geolocation.watchPosition(onNavPosition, onNavError, {
      enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
    });
  }
}

function stopNav(message) {
  if (!nav.active) return;
  nav.active = false;
  if (nav.watchId != null) navigator.geolocation.clearWatch(nav.watchId);
  nav.watchId = null;
  clearInterval(nav.simTimer);
  nav.simTimer = null;
  releaseWakeLock();
  try { window.speechSynthesis.cancel(); } catch (e) { /* 無視 */ }
  if (message) speak(message, true);
  if (nav.L) map.removeLayer(nav.L);
  document.body.classList.remove('nav-mode');
  $n('nav-ui').hidden = true;
  $n('nav-alert').hidden = true;
  navStatus(null);
  fitRoute();
}

function onNavError(err) {
  navStatus(err.code === 1
    ? '位置情報の利用が許可されていません。端末の設定を確認してください'
    : '現在地を取得できません。空の見える場所で少しお待ちください');
}

/* ============================================================
 *  テスト走行
 * ========================================================== */
function simTick() {
  if (!nav.active || !nav.sim || nav.rerouting) return;
  const i = idxAtAlong(nav.simAlong);
  // その区間の予定速度で走る（ORSの所要時間から算出）
  let v = 13;
  if (i < nav.coords.length - 1) {
    const dt = nav.tArr[i + 1] - nav.tArr[i], dd = nav.cumM[i + 1] - nav.cumM[i];
    if (dt > 0 && dd > 0) v = Math.min(33, Math.max(5, dd / dt));
  }
  nav.simAlong = Math.min(nav.totalM, nav.simAlong + v * nav.simSpeed);
  const p = pointAtAlong(nav.simAlong);
  const nx = pointAtAlong(Math.min(nav.totalM, nav.simAlong + 15));
  onNavPosition({
    coords: {
      latitude: p.lat, longitude: p.lng, accuracy: 5, speed: v,
      heading: navBearing([p.lng, p.lat], [nx.lng, nx.lat]),
    },
    timestamp: Date.now(),
  });
}

/* ============================================================
 *  位置の更新ごとの処理
 * ========================================================== */
function onNavPosition(pos) {
  if (!nav.active) return;
  const { latitude: lat, longitude: lng, accuracy, speed, heading } = pos.coords;
  const v = speed != null && isFinite(speed) ? Math.max(0, speed) : 0;
  if (!nav.sim && $n('nav-status').textContent.indexOf('現在地を取得') === 0) navStatus(null);

  const sn = snapToRoute(lat, lng);
  const offLimit = Math.max(50, Math.min(120, (accuracy || 20) * 1.5));
  const onRoute = sn.d <= offLimit;

  // ---- ルート外れの判定 → 再探索 ----
  if (!onRoute && (accuracy || 0) < 100) {
    nav.offCount++;
    if (!nav.offSince) nav.offSince = Date.now();
    if (nav.offCount >= 3 && Date.now() - nav.offSince > 6000) navReroute({ lat, lng });
  } else {
    nav.offCount = 0;
    nav.offSince = 0;
  }

  if (onRoute) {
    nav.idx = sn.i;
    nav.along = Math.max(sn.along, nav.along - 30); // GPSの揺れで少し戻るのは許容
  }

  // ---- 車両マーカー ----
  let hd = null;
  if (heading != null && isFinite(heading) && v > 1.5) hd = heading;
  else if (nav.idx < nav.coords.length - 1) hd = navBearing(nav.coords[nav.idx], nav.coords[nav.idx + 1]);
  const shown = onRoute && !nav.sim ? pointAtAlong(nav.along) : { lat, lng };
  nav.marker.setLatLng([shown.lat, shown.lng]);
  const el = nav.marker.getElement();
  if (el && hd != null) {
    const arrow = el.querySelector('.nav-car-arrow');
    if (arrow) arrow.style.transform = `rotate(${hd}deg)`;
  }
  if (nav.follow) {
    const z = v > 22 ? 15 : v > 11 ? 16 : 17;
    map.setView([shown.lat, shown.lng], Math.max(z, 14), { animate: true, duration: 0.5 });
  }

  // ---- 通過済みの軌跡 ----
  if (Date.now() - nav.lastTrail > 4000) {
    nav.lastTrail = Date.now();
    const pts = nav.coords.slice(0, nav.idx + 1).map(c => [c[1], c[0]]);
    pts.push([shown.lat, shown.lng]);
    nav.trail.setLatLngs(pts);
  }

  markPassedVias();
  updateManeuver(v);
  updateHazards();
  updateStats(v);
  updateRestInfo();
  checkArrival(lat, lng);
  nav.lastPos = { lat, lng };
}

function markPassedVias() {
  const wps = (nav.route.wayPoints || []).slice(1, -1);
  wps.forEach((w, k) => {
    if (!nav.passedVia.has(k) && nav.along >= nav.cumM[Math.min(w, nav.cumM.length - 1)] - 40) {
      nav.passedVia.add(k);
      const via = state.vias[k];
      if (via) speak(`経由地、${via.label}を通過しました`);
    }
  });
}

/* ---- 次の曲がり角 ---- */
function stepText(s) {
  const m = MANEUVER[s.type] || {};
  if (s.instruction) return s.instruction;
  return (m.text || '') + (s.name ? `、${s.name}` : '');
}

function updateManeuver(v) {
  const steps = nav.steps;
  let si = -1;
  for (let k = 0; k < steps.length; k++) {
    const s = steps[k];
    if (s.type === 11) continue;
    if (nav.cumM[s.wp[0]] > nav.along + 5) { si = k; break; }
  }
  const box = $n('nav-top');
  if (si < 0) {
    $n('nav-dist').textContent = showDist(Math.max(0, nav.totalM - nav.along));
    $n('nav-instr').textContent = '目的地に向かっています';
    $n('nav-arrow').innerHTML = '<span class="nav-glyph">着</span>';
    $n('nav-then').hidden = true;
    return;
  }
  const s = steps[si];
  const dist = nav.cumM[s.wp[0]] - nav.along;
  const m = MANEUVER[s.type] || MANEUVER[6];
  $n('nav-dist').textContent = showDist(dist);
  $n('nav-instr').textContent = stepText(s);
  $n('nav-arrow').innerHTML = m.glyph
    ? `<span class="nav-glyph">${m.glyph}</span>`
    : `<span class="nav-rot" style="transform:rotate(${m.rot}deg)">${ARROW_SVG}</span>`;
  box.classList.toggle('is-hw', !!(nav.waycat[nav.idx] & 1));

  // その先の案内（300m以内に続く場合）
  const nx = steps[si + 1];
  const then = $n('nav-then');
  if (nx && nav.cumM[nx.wp[0]] - nav.cumM[s.wp[0]] < 300) {
    then.hidden = false;
    then.textContent = 'その先 ' + ((MANEUVER[nx.type] || {}).text || '') + (nx.name ? ` ${nx.name}` : '');
  } else {
    then.hidden = true;
  }

  // 音声（速さに応じて案内のタイミングを調整）
  const stages = [];
  if (v > 16 || dist > 1500) stages.push({ k: 'far', d: Math.max(1000, v * 45) });
  stages.push({ k: 'mid', d: Math.max(300, v * 15) });
  stages.push({ k: 'near', d: Math.max(50, v * 5) });
  let target = null;
  stages.forEach(st => { if (dist <= st.d) target = st; });
  if (!target) return;
  const key = `${nav.routeKey}:m${si}:${target.k}`;
  if (nav.announced.has(key)) return;
  stages.forEach(st => { if (st.d >= target.d) nav.announced.add(`${nav.routeKey}:m${si}:${st.k}`); });
  if (s.type === 10) {
    speak(target.k === 'near' ? 'まもなく目的地です' : `${speakDist(dist)}先、目的地です`);
    return;
  }
  const txt = stepText(s);
  const thenTxt = !then.hidden ? `。${then.textContent}` : '';
  speak(target.k === 'near' ? `まもなく、${txt}${thenTxt}` : `${speakDist(dist)}先、${txt}`);
}

/* ---- 危険箇所の警告 ---- */
function updateHazards() {
  const a = state.analysis;
  const alert = $n('nav-alert');
  if (!a || !Array.isArray(a.hazards) || curRoute() !== nav.route) { alert.hidden = true; return; }
  let nearest = null, nearestD = Infinity;
  a.hazards.forEach(h => {
    if (h.severity === 'low') return;
    const hd = nav.cumM[Math.min(h.idx, nav.cumM.length - 1)] - nav.along;
    const endD = nav.cumM[Math.min(h.idxEnd, nav.cumM.length - 1)] - nav.along;
    if (endD < -10) return;
    const d = Math.max(0, hd);
    if (d < 1500 && d < nearestD) { nearest = h; nearestD = d; }
    const stages = h.severity === 'medium' ? [300] : [1000, 300];
    stages.forEach(st => {
      const key = `${nav.routeKey}:h${h.id}:${st}`;
      if (d <= st && !nav.announced.has(key)) {
        stages.forEach(x => { if (x >= st) nav.announced.add(`${nav.routeKey}:h${h.id}:${x}`); });
        const where = d < 30 ? 'この先すぐ' : `この先${speakDist(d)}`;
        const extra = h.severity === 'critical' ? '車両が通行できない恐れがあります。' : '注意してください。';
        speak(`${where}、${h.title || h.label}。${hazardDetail(h)}。${extra}`, h.severity === 'critical');
      }
    });
  });
  if (!nearest) { alert.hidden = true; return; }
  alert.hidden = false;
  alert.className = 'nav-alert sev-' + nearest.severity;
  alert.innerHTML = `${signHtml(nearest)}<span><b>${nearestD < 30 ? 'この先すぐ' : showDist(nearestD) + '先'}</b>${esc(nearest.title || nearest.label)}<small>${esc(hazardDetail(nearest))}</small></span>`;
}

/* ---- 残り距離・時間 ---- */
function updateStats(v) {
  const remainM = Math.max(0, nav.totalM - nav.along);
  const remainSec = Math.max(0, nav.tArr[nav.tArr.length - 1] - timeAtAlong(nav.along));
  $n('nav-remain-d').textContent = showDist(remainM);
  $n('nav-remain-t').textContent = fmtDur(remainSec / 60);
  $n('nav-eta').textContent = clockAfter(remainSec / 60);
  $n('nav-speed').textContent = Math.round(v * 3.6);

  // 連続運転のリマインド（休憩タブの間隔設定を使用）
  const interval = (+($('rest-interval') && $('rest-interval').value) || 120) * 60000;
  if (Date.now() - nav.lastRemind > interval) {
    nav.lastRemind = Date.now();
    speak(`運転を始めてから${fmtDur(interval / 60000)}たちました。そろそろ休憩しましょう`);
  }
}

function updateRestInfo() {
  const el = $n('nav-rest');
  const d = state.rest;
  if (!d || !Array.isArray(d.stops) || curRoute() !== nav.route) { el.hidden = true; return; }
  const next = d.stops.find(s => s.poi && s.poi.alongKm * 1000 > nav.along + 50);
  if (!next) { el.hidden = true; return; }
  el.hidden = false;
  el.textContent = `次の休憩：${next.poi.name}（あと${showDist(next.poi.alongKm * 1000 - nav.along)}）`;
}

function checkArrival(lat, lng) {
  if (nav.arrived) return;
  const end = nav.coords[nav.coords.length - 1];
  const dEnd = Math.hypot((end[0] - lng) * 111320 * Math.cos(lat * NAV_DEG), (end[1] - lat) * 110540);
  if (nav.totalM - nav.along < 30 || dEnd < 25) {
    nav.arrived = true;
    speak('目的地に到着しました。おつかれさまでした', true);
    toast('目的地に到着しました');
    setTimeout(() => stopNav(), 3500);
  }
}

/* ============================================================
 *  再探索
 * ========================================================== */
async function navReroute(pos) {
  if (nav.rerouting || Date.now() - nav.lastReroute < 30000 || !state.end) return;
  nav.rerouting = true;
  nav.lastReroute = Date.now();
  navStatus('ルートを外れました。新しいルートを探しています…');
  speak('ルートを外れました。新しいルートを探します', true);
  const remVias = state.vias.filter((v, k) => !nav.passedVia.has(k));
  try {
    const d = await api('route', {
      waypoints: [[pos.lng, pos.lat], ...remVias.map(p => [p.lng, p.lat]), [state.end.lng, state.end.lat]],
      vehicle: state.vehicle,
      avoidTolls: state.opts.avoidTolls,
      avoidHighways: state.opts.avoidHighways,
      preference: state.opts.preference,
      alternatives: false,
    });
    if (!nav.active) return;
    state.seq++;
    state.start = { lat: r5(pos.lat), lng: r5(pos.lng), label: '現在地' };
    state.vias = remVias;
    state.routes = d.routes;
    state.sel = 0;
    state.analysisByRoute = {};
    state.analysis = null;
    state.analysisError = null;
    state.pois = [];
    state.rest = null;
    L_poi.clearLayers();
    L_rest.clearLayers();
    $('in-start').value = '現在地';
    drawRoutes();
    renderPoints();
    renderRouteCards();
    renderPois();
    renderRest();
    loadRouteIntoNav(curRoute());
    if (nav.sim) nav.simAlong = 0;
    navStatus(null);
    speak('新しいルートで案内します。危険箇所を確認しています');
    runAnalysis({ useAI: false }); // 走行中はAI所見を省略して素早く確認
  } catch (e) {
    navStatus('再探索できませんでした。30秒後にもう一度試します');
    setTimeout(() => { if (nav.active) navStatus(null); }, 6000);
  } finally {
    nav.rerouting = false;
  }
}

/* ============================================================
 *  画面の自動消灯防止
 * ========================================================== */
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      nav.wakeLock = await navigator.wakeLock.request('screen');
      nav.wakeLock.addEventListener('release', () => { nav.wakeLock = null; });
    }
  } catch (e) { /* 非対応・省電力モード */ }
}
function releaseWakeLock() {
  try { if (nav.wakeLock) nav.wakeLock.release(); } catch (e) { /* 無視 */ }
  nav.wakeLock = null;
}
document.addEventListener('visibilitychange', () => {
  if (nav.active && document.visibilityState === 'visible' && !nav.wakeLock) requestWakeLock();
});

/* ============================================================
 *  ボタン
 * ========================================================== */
function bindNavUI() {
  $n('nav-end').onclick = () => stopNav('案内を終了します');
  $n('nav-voice').onclick = () => {
    nav.voice = !nav.voice;
    if (!nav.voice) { try { window.speechSynthesis.cancel(); } catch (e) { /* 無視 */ } }
    $n('nav-voice').setAttribute('aria-pressed', String(nav.voice));
    $n('nav-voice').textContent = nav.voice ? '音声 オン' : '音声 オフ';
    if (nav.voice) speak('音声案内をオンにしました');
  };
  $n('nav-sim-speed').onclick = () => {
    nav.simSpeed = nav.simSpeed === 1 ? 4 : nav.simSpeed === 4 ? 10 : 1;
    $n('nav-sim-speed').textContent = '速さ ×' + nav.simSpeed;
  };
  $n('nav-recenter').onclick = () => {
    nav.follow = true;
    $n('nav-recenter').hidden = true;
    if (nav.lastPos) map.setView([nav.lastPos.lat, nav.lastPos.lng], 16);
  };
  map.on('dragstart', () => {
    if (!nav.active) return;
    nav.follow = false;
    $n('nav-recenter').hidden = false;
  });
}

document.addEventListener('DOMContentLoaded', () => {
  // app.js の地図作成後に登録する
  setTimeout(() => { try { bindNavUI(); } catch (e) { console.error(e); } }, 0);
});
