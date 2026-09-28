/* ============================================================
 *  RV_navi  走行記録  track.js v1.3.0
 *  - 実際に走った経路をGPSで記録（ナビと連動／手動でも可）
 *  - 記録は端末内（IndexedDB）に保存。ページを閉じても途中から続けられる
 *  - GPX 1.1 形式で書き出し（1件ずつ／まとめて1ファイル）
 *  - 対応端末では共有メニューから他のアプリやドライブへ送れる
 *  読み込み順：config.js → auth.js → app.js → nav.js → track.js
 * ============================================================ */
'use strict';

window.RV_FILES = window.RV_FILES || {};
window.RV_FILES.track = '1.3.0';

const TRK = {
  DB: 'rvnavi_tracks',
  STORE: 'tracks',
  LS_AUTO: 'rvnavi_track_auto',
  MAX_ACC: 50,        // これより精度の悪い位置は記録しない（m）
  MIN_DIST: 10,       // 前の点からこれ以上動いたら記録（m）
  MIN_DT: 2,          // 記録の最短間隔（秒）
  MAX_SPEED: 70,      // これより速い移動はGPSの飛びとして無視（m/s）
  GAP_SEC: 300,       // 位置が途切れた時間がこれを超えたら区間を分ける（秒）
  MOVE_SPEED: 0.8,    // 走行中とみなす速さ（m/s）
  SAVE_MS: 20000,     // 記録中の自動保存間隔
};

const rec = {
  list: [],           // 保存済み＋記録中（新しい順）
  cur: null,          // 記録中のトラック
  watchId: null,
  lastFixAt: 0,
  weak: false,
  gpsErr: '',
  dirty: false,
  saveTimer: null,
  tickTimer: null,
  lastDraw: 0,
  wakeLock: null,
  auto: true,
  selected: new Set(),
  shownId: null,
  layer: null,
  live: null,
  canShare: false,
  dbOk: true,
};

/* ============================================================
 *  補助
 * ========================================================== */
const $t = id => document.getElementById(id);
const tEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const xEsc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

function tMsg(msg, type) { if (typeof toast === 'function') toast(msg, type); }

function distM(a, b) { // [lat,lng,...]
  const R = 6371008.8, d = Math.PI / 180;
  const dLat = (b[0] - a[0]) * d, dLng = (b[1] - a[1]) * d;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a[0] * d) * Math.cos(b[0] * d) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

const WDAY = '日月火水木金土';
const pad2 = n => String(n).padStart(2, '0');
function fmtDay(ms) {
  const d = new Date(ms);
  return `${d.getMonth() + 1}/${d.getDate()}(${WDAY[d.getDay()]})`;
}
function fmtClock(ms) {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
function fmtKm(m) { return (m / 1000).toFixed(m >= 100000 ? 0 : 1) + ' km'; }
function fmtMin(sec) {
  if (typeof fmtDur === 'function') return fmtDur(sec / 60);
  const min = Math.round(sec / 60);
  return Math.floor(min / 60) ? `${Math.floor(min / 60)}時間${min % 60}分` : `${min}分`;
}
function fileStamp(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}_${pad2(d.getHours())}${pad2(d.getMinutes())}`;
}
function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
}

function allPts(t) { return t.segs.reduce((a, s) => a.concat(s), []); }
function ptCount(t) { return t.segs.reduce((a, s) => a + s.length, 0); }
function firstPt(t) { for (const s of t.segs) if (s.length) return s[0]; return null; }
function lastPt(t) { for (let i = t.segs.length - 1; i >= 0; i--) { const s = t.segs[i]; if (s.length) return s[s.length - 1]; } return null; }
function startMs(t) { const p = firstPt(t); return p ? p[2] : Date.parse(t.createdAt); }
function endMs(t) { const p = lastPt(t); return p ? p[2] : startMs(t); }
function avgKmh(t) { return t.movingSec > 30 ? (t.dist / t.movingSec) * 3.6 : 0; }

/* ============================================================
 *  端末内の保存（IndexedDB）
 * ========================================================== */
let tdbPromise = null;
function tdbOpen() {
  if (tdbPromise) return tdbPromise;
  tdbPromise = new Promise((res, rej) => {
    if (!('indexedDB' in window)) { rej(new Error('IndexedDB非対応')); return; }
    const rq = indexedDB.open(TRK.DB, 1);
    rq.onupgradeneeded = () => {
      if (!rq.result.objectStoreNames.contains(TRK.STORE)) rq.result.createObjectStore(TRK.STORE, { keyPath: 'id' });
    };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
  return tdbPromise;
}
function tdbTx(mode, fn) {
  return tdbOpen().then(db => new Promise((res, rej) => {
    const tx = db.transaction(TRK.STORE, mode);
    const r = fn(tx.objectStore(TRK.STORE));
    let out;
    if (r) r.onsuccess = () => { out = r.result; };
    tx.oncomplete = () => res(out);
    tx.onerror = () => rej(tx.error);
    tx.onabort = () => rej(tx.error);
  }));
}
const tdbAll = () => tdbTx('readonly', st => st.getAll());
const tdbPut = t => tdbTx('readwrite', st => st.put(t));
const tdbDel = id => tdbTx('readwrite', st => st.delete(id));

async function saveTrack(t) {
  if (!rec.dbOk) return;
  t.updatedAt = new Date().toISOString();
  try {
    await tdbPut(t);
  } catch (e) {
    console.warn('走行記録の保存に失敗', e);
    tMsg('走行記録を端末に保存できませんでした（空き容量を確認してください）', 'err');
  }
}

function flushCur() {
  if (rec.cur && rec.dirty) {
    rec.dirty = false;
    saveTrack(rec.cur);
  }
}

/* ============================================================
 *  記録の開始・終了
 * ========================================================== */
function defaultTrackName(auto) {
  if (auto && typeof state === 'object' && state && state.start && state.end) {
    return `${state.start.label || '出発地'} → ${state.end.label || '目的地'}`.slice(0, 60);
  }
  return 'ドライブの記録';
}

async function recStart(opts = {}) {
  if (rec.cur) return;
  if (!navigator.geolocation) { tMsg('この端末では現在地を取得できません', 'err'); return; }
  const now = Date.now();
  const t = {
    id: 'trk_' + now.toString(36) + Math.random().toString(36).slice(2, 6),
    name: opts.name || defaultTrackName(opts.auto),
    createdAt: new Date(now).toISOString(),
    endedAt: null,
    status: 'recording',
    auto: !!opts.auto,
    segs: [[]],
    dist: 0,
    movingSec: 0,
    maxSpd: 0,
  };
  rec.cur = t;
  rec.list.unshift(t);
  rec.lastFixAt = 0;
  rec.dirty = true;
  flushCur();
  beginWatch();
  try { if (navigator.storage && navigator.storage.persist) navigator.storage.persist(); } catch (e) { /* 無視 */ }
  if (!opts.quiet) tMsg(opts.auto ? '走行の記録を始めました' : '走行の記録を始めました。画面は消さずにお使いください');
  renderTrack();
}

function recResume(t) {
  if (rec.cur) return;
  rec.cur = t;
  t.status = 'recording';
  t.segs = t.segs.filter(s => s.length);
  t.segs.push([]); // 途切れた所で区間を分ける
  rec.lastFixAt = 0;
  rec.dirty = true;
  flushCur();
  beginWatch();
  tMsg('記録の続きを始めました');
  renderTrack();
}

async function recStop(opts = {}) {
  const t = rec.cur;
  if (!t) return;
  endWatch();
  rec.cur = null;
  t.segs = t.segs.filter(s => s.length);
  if (ptCount(t) < 2 || t.dist < 50) {
    rec.list = rec.list.filter(x => x !== t);
    try { await tdbDel(t.id); } catch (e) { /* 無視 */ }
    if (!opts.quiet) tMsg('走った距離が短いため、記録は保存しませんでした');
  } else {
    t.status = 'done';
    t.endedAt = new Date().toISOString();
    rec.dirty = false;
    await saveTrack(t);
    if (!opts.quiet) tMsg(`走行記録を保存しました（${fmtKm(t.dist)}）。「記録」タブからGPXで書き出せます`);
  }
  drawLive();
  renderTrack();
}

/* 途中で止まっていた記録を終了扱いにする */
async function finishPending(t) {
  t.segs = t.segs.filter(s => s.length);
  if (ptCount(t) < 2) {
    rec.list = rec.list.filter(x => x !== t);
    try { await tdbDel(t.id); } catch (e) { /* 無視 */ }
  } else {
    t.status = 'done';
    t.endedAt = new Date(endMs(t)).toISOString();
    await saveTrack(t);
  }
  renderTrack();
}

/* ============================================================
 *  GPS
 * ========================================================== */
function beginWatch() {
  endWatch(true);
  rec.weak = false;
  rec.gpsErr = '';
  rec.watchId = navigator.geolocation.watchPosition(onTrackPos, onTrackErr, {
    enableHighAccuracy: true, maximumAge: 0, timeout: 30000,
  });
  clearInterval(rec.saveTimer);
  rec.saveTimer = setInterval(flushCur, TRK.SAVE_MS);
  clearInterval(rec.tickTimer);
  rec.tickTimer = setInterval(renderLiveStats, 5000);
  trkWakeLock();
}

function endWatch(keepTimers) {
  if (rec.watchId != null) navigator.geolocation.clearWatch(rec.watchId);
  rec.watchId = null;
  if (keepTimers) return;
  clearInterval(rec.saveTimer);
  clearInterval(rec.tickTimer);
  rec.saveTimer = rec.tickTimer = null;
  trkReleaseWake();
}

function onTrackErr(err) {
  if (err.code === 1) {
    rec.gpsErr = '位置情報の利用が許可されていません。端末の設定を確認してください';
    tMsg(rec.gpsErr, 'err');
  } else {
    rec.gpsErr = 'GPSの電波を探しています…';
  }
  renderLiveStats();
}

function onTrackPos(pos) {
  const t = rec.cur;
  if (!t) return;
  const c = pos.coords;
  const now = pos.timestamp || Date.now();
  rec.gpsErr = '';

  // 位置が長く途切れていたら区間を分ける（画面オフ・トンネル等）
  let seg = t.segs[t.segs.length - 1];
  if (rec.lastFixAt && seg.length && (now - rec.lastFixAt) / 1000 > TRK.GAP_SEC) {
    seg = [];
    t.segs.push(seg);
  }
  rec.lastFixAt = now;

  if (!(c.accuracy <= TRK.MAX_ACC)) {
    rec.weak = true;
    renderLiveStats();
    return;
  }
  rec.weak = false;

  const alt = c.altitude != null && isFinite(c.altitude) ? Math.round(c.altitude * 10) / 10 : null;
  const p = [Math.round(c.latitude * 1e6) / 1e6, Math.round(c.longitude * 1e6) / 1e6, now, alt];
  const last = seg[seg.length - 1];
  if (last) {
    const d = distM(last, p), dt = (now - last[2]) / 1000;
    if (dt < TRK.MIN_DT || d < TRK.MIN_DIST) return;
    if (d / dt > TRK.MAX_SPEED) return; // GPSの飛び
    t.dist += d;
    if (d / dt >= TRK.MOVE_SPEED) t.movingSec += dt;
  }
  if (c.speed != null && isFinite(c.speed) && c.speed < 55) t.maxSpd = Math.max(t.maxSpd || 0, c.speed);
  seg.push(p);
  rec.dirty = true;

  if (now - rec.lastDraw > 4000) { rec.lastDraw = now; drawLive(); }
  renderLiveStats();
}

/* 画面の自動消灯を防ぐ（記録はブラウザが前面にある間だけ動くため） */
async function trkWakeLock() {
  try {
    if ('wakeLock' in navigator && !rec.wakeLock) {
      rec.wakeLock = await navigator.wakeLock.request('screen');
      rec.wakeLock.addEventListener('release', () => { rec.wakeLock = null; });
    }
  } catch (e) { /* 非対応 */ }
}
function trkReleaseWake() {
  try { if (rec.wakeLock) rec.wakeLock.release(); } catch (e) { /* 無視 */ }
  rec.wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
  if (!rec.cur) return;
  if (document.visibilityState === 'hidden') {
    flushCur();
  } else {
    trkWakeLock();
    beginWatch(); // 端末によっては裏に回るとGPSが止まるため取り直す
  }
});
window.addEventListener('pagehide', flushCur);

/* ============================================================
 *  地図表示
 * ========================================================== */
function trkLayer() {
  if (!rec.layer && typeof map !== 'undefined' && map) rec.layer = L.layerGroup().addTo(map);
  return rec.layer;
}

function segsLatLngs(t) {
  return t.segs.filter(s => s.length > 1).map(s => s.map(p => [p[0], p[1]]));
}

function drawLive() {
  const lay = trkLayer();
  if (!lay) return;
  if (!rec.cur) {
    if (rec.live) { lay.removeLayer(rec.live); rec.live = null; }
    return;
  }
  const ll = segsLatLngs(rec.cur);
  if (!rec.live) {
    rec.live = L.polyline(ll, { color: '#c2185b', weight: 5, opacity: 0.85, interactive: false }).addTo(lay);
  } else {
    rec.live.setLatLngs(ll);
  }
}

function trkPin(txt, cls) {
  return L.divIcon({ className: '', html: `<div class="trk-pin ${cls}">${txt}</div>`, iconSize: [28, 28], iconAnchor: [14, 14] });
}

function showTrackOnMap(t) {
  const lay = trkLayer();
  if (!lay) return;
  hideTrackOnMap(true);
  const ll = segsLatLngs(t);
  if (!ll.length) { tMsg('地図に表示できる点がありません', 'err'); return; }
  const g = L.layerGroup();
  L.polyline(ll, { color: '#ffffff', weight: 10, opacity: 0.9, interactive: false }).addTo(g);
  L.polyline(ll, { color: '#7b2cbf', weight: 6, opacity: 1 }).bindTooltip(tEsc(t.name), { sticky: true }).addTo(g);
  const a = firstPt(t), b = lastPt(t);
  L.marker([a[0], a[1]], { icon: trkPin('始', 'trk-pin-s'), keyboard: false }).bindTooltip(`${fmtDay(a[2])} ${fmtClock(a[2])} 出発`).addTo(g);
  L.marker([b[0], b[1]], { icon: trkPin('終', 'trk-pin-e'), keyboard: false }).bindTooltip(`${fmtClock(b[2])} 到着`).addTo(g);
  g.addTo(lay);
  rec.shown = g;
  rec.shownId = t.id;

  if (typeof isWide === 'function' && !isWide() && typeof setSheet === 'function') setSheet('min');
  setTimeout(() => {
    const bounds = L.latLngBounds([].concat(...ll));
    const p = typeof sheetPadding === 'function' ? sheetPadding() : { tl: [30, 30], br: [30, 30] };
    map.fitBounds(bounds, { paddingTopLeft: p.tl, paddingBottomRight: p.br });
  }, 250);
  renderList();
}

function hideTrackOnMap(silent) {
  if (rec.shown && rec.layer) rec.layer.removeLayer(rec.shown);
  rec.shown = null;
  rec.shownId = null;
  if (!silent) renderList();
}

/* ============================================================
 *  GPX 書き出し
 * ========================================================== */
function buildGpx(tracks, title) {
  const out = [];
  out.push('<?xml version="1.0" encoding="UTF-8"?>');
  out.push('<gpx version="1.1" creator="RV_navi https://kenken6291.github.io/RV_navi/"'
    + ' xmlns="http://www.topografix.com/GPX/1/1"'
    + ' xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"'
    + ' xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">');
  out.push(`  <metadata><name>${xEsc(title)}</name><time>${new Date().toISOString()}</time></metadata>`);
  tracks.forEach(t => {
    const s = startMs(t), e = endMs(t);
    out.push('  <trk>');
    out.push(`    <name>${xEsc(t.name)}</name>`);
    out.push(`    <desc>${xEsc(`${fmtDay(s)} ${fmtClock(s)}〜${fmtClock(e)} / 距離 ${fmtKm(t.dist)} / 走行時間 ${fmtMin(t.movingSec)}`)}</desc>`);
    out.push('    <type>driving</type>');
    t.segs.filter(sg => sg.length).forEach(sg => {
      out.push('    <trkseg>');
      sg.forEach(p => {
        const ele = p[3] != null ? `<ele>${Number(p[3]).toFixed(1)}</ele>` : '';
        out.push(`      <trkpt lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}">${ele}<time>${new Date(p[2]).toISOString()}</time></trkpt>`);
      });
      out.push('    </trkseg>');
    });
    out.push('  </trk>');
  });
  out.push('</gpx>');
  return out.join('\n');
}

function gpxFor(tracks) {
  const sorted = tracks.slice().sort((a, b) => startMs(a) - startMs(b));
  if (sorted.length === 1) {
    const t = sorted[0];
    const n = safeName(t.name);
    return { name: `RV_navi_${fileStamp(startMs(t))}${n ? '_' + n : ''}.gpx`, text: buildGpx(sorted, t.name) };
  }
  const title = `RV_navi 走行記録 ${sorted.length}件（${fmtDay(startMs(sorted[0]))}〜${fmtDay(endMs(sorted[sorted.length - 1]))}）`;
  return { name: `RV_navi_${fileStamp(startMs(sorted[0]))}_まとめ${sorted.length}件.gpx`, text: buildGpx(sorted, title) };
}

function downloadGpx(tracks) {
  const f = gpxFor(tracks);
  const blob = new Blob([f.text], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = f.name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 15000);
  tMsg(`GPXファイルを保存しました（${f.name}）`);
}

function shareFileOf(f) {
  for (const type of ['application/gpx+xml', 'application/octet-stream', 'text/plain']) {
    try {
      const file = new File([f.text], f.name, { type });
      if (navigator.canShare && navigator.canShare({ files: [file] })) return file;
    } catch (e) { /* 次の形式を試す */ }
  }
  return null;
}

async function shareGpx(tracks) {
  const f = gpxFor(tracks);
  const file = shareFileOf(f);
  if (!file) { downloadGpx(tracks); return; }
  try {
    await navigator.share({ files: [file], title: f.name });
  } catch (e) {
    if (e && e.name !== 'AbortError') {
      tMsg('共有できなかったため、ファイルとして保存します', 'err');
      downloadGpx(tracks);
    }
  }
}

function checkShare() {
  try {
    rec.canShare = !!(navigator.share && shareFileOf({ text: '<gpx/>', name: 'test.gpx' }));
  } catch (e) { rec.canShare = false; }
}

/* ============================================================
 *  画面
 * ========================================================== */
function renderTrack() {
  renderLive();
  renderList();
  renderIndicators();
}

function renderIndicators() {
  const on = !!rec.cur;
  const badge = document.querySelector('.tab[data-tab="track"] .badge');
  if (badge) {
    badge.hidden = !on;
    badge.textContent = '●';
    badge.className = 'badge badge-crit';
  }
  const pill = $t('rec-pill');
  if (pill) {
    pill.hidden = !on;
    if (on) pill.innerHTML = `<span class="trk-dot" aria-hidden="true"></span>記録中 ${fmtKm(rec.cur.dist)}`;
  }
  const nb = $t('nav-rec');
  if (nb) {
    nb.setAttribute('aria-pressed', String(on));
    nb.classList.toggle('is-rec', on);
    nb.textContent = on ? '● 記録中' : '記録 オフ';
  }
}

function renderLive() {
  const box = $t('trk-live');
  if (!box) return;
  if (!rec.dbOk) {
    box.innerHTML = '<p class="empty">この端末（ブラウザ）では記録を保存できません。プライベートブラウズを解除してお試しください。</p>';
    return;
  }
  if (rec.cur) {
    box.innerHTML = `<div class="trk-card is-rec">
        <p class="trk-head"><span class="trk-dot" aria-hidden="true"></span>記録中：${tEsc(rec.cur.name)}</p>
        <div class="trk-stats" id="trk-stats"></div>
        <p id="trk-gps" class="trk-gps"></p>
        <button id="trk-stop" class="btn-primary btn-stop" type="button">■ 記録を止めて保存</button>
      </div>`;
    $t('trk-stop').onclick = () => recStop();
    renderLiveStats();
    return;
  }
  const pend = rec.list.find(t => t.status === 'recording');
  if (pend) {
    box.innerHTML = `<div class="trk-card is-pend">
        <p class="trk-head">途中で止まった記録があります</p>
        <p class="trk-sub">${tEsc(pend.name)}　${fmtDay(startMs(pend))} ${fmtClock(startMs(pend))}〜　${fmtKm(pend.dist)}</p>
        <div class="trk-actions">
          <button id="trk-resume" class="btn-sm primary" type="button">続きを記録する</button>
          <button id="trk-finish" class="btn-sm" type="button">ここで終えて保存</button>
        </div>
      </div>`;
    $t('trk-resume').onclick = () => recResume(pend);
    $t('trk-finish').onclick = () => finishPending(pend);
    return;
  }
  box.innerHTML = `<button id="trk-start" class="btn-primary btn-rec" type="button"><span class="trk-dot is-still" aria-hidden="true"></span>走行の記録を開始</button>`;
  $t('trk-start').onclick = () => recStart();
}

function renderLiveStats() {
  renderIndicators();
  const t = rec.cur, box = $t('trk-stats');
  if (!t || !box) return;
  const elapsed = (Date.now() - Date.parse(t.createdAt)) / 1000;
  const avg = avgKmh(t);
  box.innerHTML = `
    <div><b>${fmtKm(t.dist)}</b><span>走った距離</span></div>
    <div><b>${fmtMin(elapsed)}</b><span>経過時間</span></div>
    <div><b>${avg ? Math.round(avg) + ' km/h' : '--'}</b><span>平均の速さ</span></div>
    <div><b>${ptCount(t).toLocaleString()}</b><span>記録した点</span></div>`;
  const g = $t('trk-gps');
  if (g) {
    const msg = rec.gpsErr || (rec.weak ? 'GPSの精度が低いため、良くなるまで記録を控えています' : (rec.lastFixAt ? 'GPS：良好' : 'GPSの電波を探しています…'));
    g.textContent = msg;
    g.classList.toggle('is-weak', !!(rec.gpsErr || rec.weak));
  }
}

function renderList() {
  const box = $t('trk-list');
  if (!box) return;
  const done = rec.list.filter(t => t.status === 'done');
  [...rec.selected].forEach(id => { if (!done.some(t => t.id === id)) rec.selected.delete(id); });

  const bulk = $t('trk-bulk');
  if (bulk) {
    bulk.hidden = done.length < 2;
    const n = rec.selected.size;
    $t('trk-bulk-dl').disabled = !n;
    $t('trk-bulk-dl').textContent = n ? `選んだ${n}件をまとめてGPX保存` : 'チェックした記録をまとめてGPX保存';
    $t('trk-bulk-share').hidden = !rec.canShare;
    $t('trk-bulk-share').disabled = !n;
    $t('trk-bulk-all').textContent = n === done.length ? '選択を外す' : 'すべて選ぶ';
  }

  if (!done.length) {
    box.innerHTML = '<p class="empty">まだ記録はありません。「走行の記録を開始」を押すか、ナビを開始すると記録されます。</p>';
    return;
  }
  box.innerHTML = done.map(t => {
    const s = startMs(t), e = endMs(t);
    const avg = avgKmh(t);
    const shown = rec.shownId === t.id;
    return `<article class="trk-item${shown ? ' is-shown' : ''}">
      <div class="trk-row">
        <input class="trk-check" type="checkbox" data-tsel="${t.id}" ${rec.selected.has(t.id) ? 'checked' : ''} aria-label="${tEsc(t.name)}を選ぶ">
        <div class="trk-body">
          <p class="tl-name">${tEsc(t.name)}</p>
          <p class="tl-meta"><span>${fmtDay(s)} ${fmtClock(s)}〜${fmtDay(e) !== fmtDay(s) ? fmtDay(e) + ' ' : ''}${fmtClock(e)}</span></p>
          <p class="tl-meta"><span>${fmtKm(t.dist)}</span><span>走行 ${fmtMin(t.movingSec)}</span>${avg ? `<span>平均 ${Math.round(avg)} km/h</span>` : ''}</p>
        </div>
      </div>
      <div class="trk-actions">
        <button class="btn-sm" type="button" data-tmap="${t.id}">${shown ? '地図から消す' : '地図で見る'}</button>
        <button class="btn-sm primary" type="button" data-tdl="${t.id}">GPXで保存</button>
        ${rec.canShare ? `<button class="btn-sm" type="button" data-tshare="${t.id}">送る</button>` : ''}
        <button class="btn-sm" type="button" data-tren="${t.id}">名前</button>
        <button class="btn-icon" type="button" data-tdel="${t.id}" aria-label="${tEsc(t.name)}を削除">✕</button>
      </div>
    </article>`;
  }).join('');
}

function trackById(id) { return rec.list.find(t => t.id === id); }

function bindTrackUI() {
  const list = $t('trk-list');
  if (!list) return;

  list.addEventListener('change', e => {
    const c = e.target.closest('[data-tsel]');
    if (!c) return;
    if (c.checked) rec.selected.add(c.dataset.tsel); else rec.selected.delete(c.dataset.tsel);
    renderList();
  });

  list.addEventListener('click', async e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tmap) {
      if (rec.shownId === b.dataset.tmap) hideTrackOnMap();
      else { const t = trackById(b.dataset.tmap); if (t) showTrackOnMap(t); }
    } else if (b.dataset.tdl) {
      const t = trackById(b.dataset.tdl); if (t) downloadGpx([t]);
    } else if (b.dataset.tshare) {
      const t = trackById(b.dataset.tshare); if (t) shareGpx([t]);
    } else if (b.dataset.tren) {
      const t = trackById(b.dataset.tren);
      if (!t) return;
      const name = window.prompt('記録の名前', t.name);
      if (name == null) return;
      t.name = name.trim().slice(0, 60) || t.name;
      await saveTrack(t);
      renderList();
    } else if (b.dataset.tdel) {
      const t = trackById(b.dataset.tdel);
      if (!t) return;
      if (!window.confirm(`「${t.name}」を削除しますか？\n削除した記録は元に戻せません。必要ならGPXで保存してから削除してください。`)) return;
      if (rec.shownId === t.id) hideTrackOnMap(true);
      rec.list = rec.list.filter(x => x !== t);
      rec.selected.delete(t.id);
      try { await tdbDel(t.id); } catch (err) { console.warn(err); }
      renderList();
      tMsg('記録を削除しました');
    }
  });

  const pickSel = () => rec.list.filter(t => t.status === 'done' && rec.selected.has(t.id));
  $t('trk-bulk-dl').onclick = () => { const s = pickSel(); if (s.length) downloadGpx(s); };
  $t('trk-bulk-share').onclick = () => { const s = pickSel(); if (s.length) shareGpx(s); };
  $t('trk-bulk-all').onclick = () => {
    const done = rec.list.filter(t => t.status === 'done');
    if (rec.selected.size === done.length) rec.selected.clear();
    else done.forEach(t => rec.selected.add(t.id));
    renderList();
  };

  const auto = $t('trk-auto');
  auto.checked = rec.auto;
  auto.onchange = () => {
    rec.auto = auto.checked;
    try { localStorage.setItem(TRK.LS_AUTO, JSON.stringify(rec.auto)); } catch (e) { /* 無視 */ }
  };

  const pill = $t('rec-pill');
  if (pill) pill.onclick = () => {
    if (typeof showTab === 'function') showTab('track');
    if (typeof setSheet === 'function' && $t('sheet').dataset.state === 'min') setSheet('peek');
  };

  const nb = $t('nav-rec');
  if (nb) nb.onclick = () => {
    if (rec.cur) {
      if (window.confirm('走行の記録を止めて保存しますか？')) recStop();
    } else {
      recStart({ auto: true });
    }
  };
}

/* ============================================================
 *  ナビとの連動（nav.js の開始・終了に処理を足す）
 * ========================================================== */
function hookNav() {
  if (typeof window.startNav !== 'function' || typeof window.stopNav !== 'function') return;
  const origStart = window.startNav, origStop = window.stopNav;

  window.startNav = async function (simulate) {
    const r = await origStart.apply(this, arguments);
    try {
      if (typeof nav === 'object' && nav.active && !nav.sim && rec.auto && !rec.cur && rec.dbOk) {
        await recStart({ auto: true, quiet: true });
      }
    } catch (e) { console.warn(e); }
    renderIndicators();
    return r;
  };

  window.stopNav = function () {
    const wasActive = typeof nav === 'object' && nav.active;
    const r = origStop.apply(this, arguments);
    try {
      if (wasActive && rec.cur && rec.cur.auto) {
        setTimeout(() => recStop(), 1200); // 到着の案内のあとで保存を知らせる
      }
    } catch (e) { console.warn(e); }
    return r;
  };
}

/* ============================================================
 *  起動
 * ========================================================== */
async function initTrack() {
  try {
    const a = JSON.parse(localStorage.getItem(TRK.LS_AUTO));
    rec.auto = a == null ? true : !!a;
  } catch (e) { rec.auto = true; }

  checkShare();
  bindTrackUI();
  hookNav();

  try {
    const all = await tdbAll();
    rec.list = (all || []).sort((a, b) => startMs(b) - startMs(a));
    // 記録中のまま残ったものが複数あれば、最新以外は終了扱い
    const pend = rec.list.filter(t => t.status === 'recording');
    for (const t of pend.slice(1)) await finishPending(t);
  } catch (e) {
    console.warn('走行記録を読み込めません', e);
    rec.dbOk = false;
  }
  renderTrack();
}

document.addEventListener('DOMContentLoaded', () => {
  // app.js・nav.js の初期化が終わってから動かす
  setTimeout(() => { initTrack().catch(e => console.error(e)); }, 0);
});
