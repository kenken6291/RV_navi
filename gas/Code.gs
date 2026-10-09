/**
 * ============================================================
 *  RV_navi - バックエンド (Google Apps Script)  Code.gs v1.1.2
 * ------------------------------------------------------------
 *  役割: GitHub Pages(フロント) からの API 中継
 *   - ルート探索   : OpenRouteService (driving-hgv)
 *   - 道路属性検査 : Overpass API (OSM の maxheight / maxwidth 等)
 *   - AI リスク評価: Gemini API (3.8 Flash → 失敗時 3.5 Flash-Lite)
 *   - 地点検索     : 国土地理院 住所検索 + ORS ジオコーディング
 *   - データ保存   : Google Drive (JSON)
 *   - 会員認証     : スプレッドシート(members) + CacheService セッション
 *                    仮パスワードをメール送信 / 初回ログイン時に変更必須 /
 *                    パスワード忘れ時の仮パスワード再発行 / 5回失敗で15分ロック
 *
 *  リクエスト（POST / Content-Type: text/plain;charset=utf-8）:
 *    { "action": "route", "token": "セッショントークン", "params": { ... } }
 *  レスポンス:
 *    { "ok": true, "data": {...} } / { "ok": false, "error": "..." }
 *
 *  座標は全て [経度(lng), 緯度(lat)] の順（GeoJSON / ORS 準拠）
 *
 *  スクリプトプロパティ（必須）: GEMINI_API_KEY, ORS_API_KEY
 *  （AUTH_PEPPER / MEMBERS_SHEET_ID / DATA_FOLDER_ID は setup() が自動作成）
 *  初回: setup() を実行して権限承認・データフォルダ・会員シート作成
 *  ※コード変更後は「デプロイを管理」→ 編集 → 新バージョン で再デプロイ
 * ============================================================
 */

const CONFIG = {
  APP_NAME: 'RV_navi',
  SITE_URL: 'https://kenken6291.github.io/RV_navi/',
  VERSION: '1.1.2',
  TZ: 'Asia/Tokyo',

  DATA_FOLDER_NAME: 'RV_navi_Data',
  DATA_TYPES: ['profile', 'favorites', 'customPoi'],
  MAX_DATA_BYTES: 500 * 1024,

  // 2.5系は新規プロジェクトでは利用制限があるため、Google推奨の最新モデルを使用
  GEMINI_MODEL: 'gemini-3.8-flash',
  GEMINI_MODEL_FALLBACK: 'gemini-3.5-flash-lite',
  GEMINI_THINKING_LEVEL: 'low', // 3.8 Flash は low / medium / high（GASの時間制限対策で low）
  GEMINI_RATE_PER_HOUR: 30,

  // 旧 api.openrouteservice.org は廃止予定のため HeiGIT の新ホストを使用
  ORS_BASE: 'https://api.heigit.org/openrouteservice',
  // ジオコーディング(Pelias)の候補。上から試して、応答したものを6時間キャッシュ
  ORS_GEOCODE_BASES: [
    'https://api.heigit.org/pelias/v1',
    'https://api.heigit.org/openrouteservice/geocode',
    'https://api.heigit.org/geocode',
  ],
  ALT_ROUTE_MAX_KM: 95,

  GSI_ADDRESS_SEARCH: 'https://msearch.gsi.go.jp/address-search/AddressSearch',

  OVERPASS_ENDPOINTS: [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ],

  SAFETY_MARGIN_M: { height: 0.10, width: 0.10 },
  OSM_CHECK: { simplifyTolM: 8, aroundM: 18, chunkPts: 220, maxChunks: 16, matchTolM: 4 },
  POI: { maxPts: 1500, chunkPts: 300, maxResults: 400 },

  MAX_EXEC_MS: 300 * 1000, // GAS上限6分に対し5分で打ち切り
};

const T0 = Date.now();
const elapsed_ = () => Date.now() - T0;
const DEG = Math.PI / 180;

/* ------------------------------------------------------------
 *  ラベル・定数
 * ---------------------------------------------------------- */
const SEV = { critical: 4, high: 3, medium: 2, low: 1 };

const HAZARD_LABELS = {
  height_limit: '高さ制限',
  width_limit: '幅制限',
  weight_limit: '重量制限',
  length_limit: '長さ制限',
  very_narrow: '極狭路',
  narrow_road: '狭路（すれ違い困難）',
  barrier: '車止め・障害物',
  gate: 'ゲート',
  sharp_turn: '急カーブ',
  hairpin_series: '連続ヘアピン',
  steep_up: '急な上り坂',
  steep_down: '急な下り坂',
  track: '林道・作業道',
  unpaved: '未舗装路',
  ford: '渡河（洗い越し）',
  residential: '生活道路',
  tunnel: 'トンネル（高さ情報なし）',
  construction: '工事中の道路',
};

const HAZARD_GROUP = {
  height_limit: 'height', width_limit: 'width', very_narrow: 'width', narrow_road: 'width',
  weight_limit: 'weight', length_limit: 'length', barrier: 'barrier', gate: 'barrier',
  sharp_turn: 'turn', hairpin_series: 'turn', steep_up: 'steep_up', steep_down: 'steep_down',
  track: 'surface', unpaved: 'surface', ford: 'ford', residential: 'residential',
  tunnel: 'tunnel', construction: 'construction',
};

const WAYTYPE_LABELS = {
  0: '不明', 1: '幹線道路', 2: '一般道', 3: '生活道路', 4: '小径', 5: '林道・作業道',
  6: '自転車道', 7: '歩道', 8: '階段', 9: 'フェリー', 10: '工事中',
};

const STEEP_LABELS = {
  '-5': '下り16%以上', '-4': '下り11〜15%', '-3': '下り7〜10%', '-2': '下り4〜6%', '-1': '下り1〜3%',
  '0': '平坦', '1': '上り1〜3%', '2': '上り4〜6%', '3': '上り7〜10%', '4': '上り11〜15%', '5': '上り16%以上',
};
const STEEP_GRADE = { 3: '7〜10%', 4: '11〜15%', 5: '16%以上' };

const POI_CATS = {
  michinoeki:  { label: '道の駅',          values: [] },
  rvpark:      { label: 'RVパーク',        values: ['caravan_site'] },
  camp:        { label: 'オートキャンプ場', values: ['camp_site'] },
  onsen:       { label: '日帰り温泉',       values: ['public_bath', 'spa'] },
  fuel:        { label: 'ガソリンスタンド', values: ['fuel'] },
  supermarket: { label: 'スーパー',         values: ['supermarket'] },
  laundry:     { label: 'コインランドリー', values: ['laundry'] },
  sapa:        { label: 'SA・PA',          values: ['services', 'rest_area'] },
};

const POI_INFO_KEYS = [
  'opening_hours', 'phone', 'contact:phone', 'website', 'contact:website', 'fee',
  'hgv', 'caravans', 'capacity', 'capacity:caravans', 'capacity:hgv', 'toilets',
  'shower', 'drinking_water', 'power_supply', 'bath:type', 'fuel:diesel',
  'fuel:HGV_diesel', 'brand', 'operator', 'self_service', 'addr:full',
];

const DISCLAIMER = 'OpenStreetMap等の公開データとAIによる推定です。未登録・誤登録の制限や工事規制があり得るため、必ず現地の道路標識・案内を優先してください。';

/* ============================================================
 *  エントリーポイント
 * ========================================================== */
function doPost(e) {
  let req;
  try {
    req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return out_({ ok: false, error: 'リクエストのJSON形式が不正です' });
  }
  return out_(dispatch_(req.action, req.params || {}, req.token));
}

function doGet() {
  // 動作確認用（ブラウザでURLを開くと応答）
  return out_(dispatch_('ping', {}, null));
}

function dispatch_(action, params, token) {
  // --- 認証チェック ---
  let member = null;
  if (AUTH.PUBLIC_ACTIONS.indexOf(action) < 0) {
    member = sessionMember_(token);
    if (!member) return { ok: false, error: 'ログインが必要です', code: 'AUTH_REQUIRED' };
    if (member.mustChange && AUTH.CHANGE_ONLY_ACTIONS.indexOf(action) < 0) {
      return { ok: false, error: '仮パスワードを新しいパスワードに変更してください', code: 'MUST_CHANGE' };
    }
  }
  const mid = member ? member.memberId : null;

  const handlers = {
    ping: () => ({ app: CONFIG.APP_NAME, version: CONFIG.VERSION, time: new Date().toISOString() }),

    // 会員
    register: () => registerMember_(params),
    login: () => loginMember_(params),
    forgotPassword: () => forgotPassword_(params),
    me: () => ({ member: publicMember_(member) }),
    changePassword: () => changePassword_(member, params),
    updateNickname: () => updateNickname_(member, params),
    logout: () => logout_(token),

    // ナビ機能（ログイン必須）
    geocode: () => geocode_(params),
    reverse: () => reverseGeocode_(params),
    route: () => route_(params),
    analyzeRoute: () => analyzeRoute_(params, mid),
    searchAlongRoute: () => searchAlongRoute_(params),
    restPlan: () => restPlan_(params),
    loadData: () => loadData_(mid, params.type),
    saveData: () => saveData_(mid, params.type, params.data),
    loadAll: () => loadAll_(mid),
    expandMapUrl: () => expandMapUrl_(params),
  };
  const h = handlers[action];
  if (!h) return { ok: false, error: '不明なactionです: ' + action };
  try {
    return { ok: true, data: h() };
  } catch (err) {
    console.error(action, (err && err.stack) || err);
    return { ok: false, error: String((err && err.message) || err), code: (err && err.code) || null };
  }
}

/* ============================================================
 *  0. 会員認証
 * ========================================================== */
const AUTH = {
  SHEET_NAME: 'members',
  HEADERS: ['memberId', 'email', 'nickname', 'hash', 'salt', 'mustChange', 'status',
            'failCount', 'lockUntil', 'createdAt', 'lastLoginAt', 'tempIssuedAt'],
  SESSION_SEC: 21600,      // 最後の操作から6時間でログアウト
  MAX_FAIL: 5,             // 5回失敗で
  LOCK_MIN: 15,            // 15分ロック
  HASH_ROUNDS: 300,
  RESEND_WAIT_SEC: 180,    // 再発行メールの連続送信を3分制限
  PUBLIC_ACTIONS: ['ping', 'register', 'login', 'forgotPassword'],
  CHANGE_ONLY_ACTIONS: ['me', 'changePassword', 'logout'],
};
const HEX_CHARS = '0123456789abcdef';
const TOKEN_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
const TEMP_PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'; // 紛らわしい文字を除外

function registerMember_(p) {
  const email = normEmail_(p.email);
  const nickname = normNickname_(p.nickname);
  if (p.agree !== true) throw new Error('利用上の注意への同意が必要です');

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    if (findMember_(m => m.email === email)) {
      throw new Error('このメールアドレスは登録済みです。パスワードを忘れた場合は「パスワードを忘れた方」から再発行してください');
    }
    const temp = tempPassword_();
    const salt = randomString_(32, HEX_CHARS);
    const now = new Date().toISOString();
    const m = {
      memberId: 'm_' + randomString_(24, HEX_CHARS),
      email, nickname,
      hash: hashPw_(temp, salt), salt,
      mustChange: true, status: 'active',
      failCount: 0, lockUntil: 0,
      createdAt: now, lastLoginAt: '', tempIssuedAt: now,
    };
    sendTempMail_(email, nickname, temp, 'register'); // 送信に失敗したら登録しない
    membersSheet_().appendRow(AUTH.HEADERS.map(h => m[h]));
  } finally {
    lock.releaseLock();
  }
  return { message: '仮パスワードをメールで送りました。メールに書かれた仮パスワードでログインしてください。' };
}

function loginMember_(p) {
  const email = normEmail_(p.email);
  const pw = String(p.password || '');
  if (!pw) throw new Error('パスワードを入力してください');
  const generic = 'メールアドレスまたはパスワードが違います';

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const m = findMember_(x => x.email === email);
    if (!m) throw new Error(generic);
    if (m.status !== 'active') throw new Error('このアカウントは利用停止中です');
    const now = Date.now();
    if (m.lockUntil > now) {
      throw new Error('ログインに続けて失敗したため一時的にロックしています。' + Math.ceil((m.lockUntil - now) / 60000) + '分後にお試しください');
    }
    if (hashPw_(pw, m.salt) !== m.hash) {
      m.failCount += 1;
      let msg;
      if (m.failCount >= AUTH.MAX_FAIL) {
        m.lockUntil = now + AUTH.LOCK_MIN * 60000;
        m.failCount = 0;
        msg = 'ログインに' + AUTH.MAX_FAIL + '回失敗したため、' + AUTH.LOCK_MIN + '分間ロックしました';
      } else {
        msg = generic + '（あと' + (AUTH.MAX_FAIL - m.failCount) + '回失敗すると' + AUTH.LOCK_MIN + '分間ロックされます）';
      }
      saveMember_(m);
      throw new Error(msg);
    }
    m.failCount = 0;
    m.lockUntil = 0;
    m.lastLoginAt = new Date().toISOString();
    saveMember_(m);
    return { token: createSession_(m.memberId), member: publicMember_(m) };
  } finally {
    lock.releaseLock();
  }
}

function forgotPassword_(p) {
  const email = normEmail_(p.email);
  const msg = '登録済みのメールアドレスであれば、新しい仮パスワードを送りました。メールを確認してください。';
  const cache = CacheService.getScriptCache();
  const rk = 'fg:' + sha_(email);
  if (cache.get(rk)) throw new Error('再発行は3分ほど時間をおいてからお試しください');
  cache.put(rk, '1', AUTH.RESEND_WAIT_SEC);

  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const m = findMember_(x => x.email === email);
    if (!m || m.status !== 'active') return { message: msg }; // 登録の有無は答えない
    const temp = tempPassword_();
    m.salt = randomString_(32, HEX_CHARS);
    m.hash = hashPw_(temp, m.salt);
    m.mustChange = true;
    m.failCount = 0;
    m.lockUntil = 0;
    m.tempIssuedAt = new Date().toISOString();
    sendTempMail_(m.email, m.nickname, temp, 'reset');
    saveMember_(m);
  } finally {
    lock.releaseLock();
  }
  return { message: msg };
}

function changePassword_(member, p) {
  const cur = String(p.currentPassword || '');
  const nw = String(p.newPassword || '');
  if (hashPw_(cur, member.salt) !== member.hash) throw new Error('現在のパスワード（仮パスワード）が違います');
  validateNewPassword_(nw);
  if (nw === cur) throw new Error('新しいパスワードは、今のパスワードと別のものにしてください');
  const m = memberById_(member.memberId, true);
  m.salt = randomString_(32, HEX_CHARS);
  m.hash = hashPw_(nw, m.salt);
  m.mustChange = false;
  saveMember_(m);
  return { member: publicMember_(m), message: 'パスワードを変更しました' };
}

function updateNickname_(member, p) {
  const nickname = normNickname_(p.nickname);
  const m = memberById_(member.memberId, true);
  m.nickname = nickname;
  saveMember_(m);
  return { member: publicMember_(m), message: 'ニックネームを変更しました' };
}

function logout_(token) {
  if (token) CacheService.getScriptCache().remove('sess:' + token);
  return { message: 'ログアウトしました' };
}

function publicMember_(m) {
  return { nickname: m.nickname, email: m.email, mustChange: !!m.mustChange };
}

/* --- 入力チェック --- */
function normEmail_(v) {
  const e = String(v || '').trim().toLowerCase();
  if (!e) throw new Error('メールアドレスを入力してください');
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) throw new Error('メールアドレスの形式が正しくありません');
  return e;
}

function normNickname_(v) {
  const n = String(v || '').trim().replace(/\s+/g, ' ');
  if (!n) throw new Error('ニックネームを入力してください');
  if (n.length > 20) throw new Error('ニックネームは20文字以内にしてください');
  if (/^[=+\-@]/.test(n)) throw new Error('ニックネームの先頭に = + - @ は使えません');
  return n;
}

function validateNewPassword_(pw) {
  if (pw.length < 8 || pw.length > 64) throw new Error('パスワードは8〜64文字にしてください');
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) throw new Error('パスワードには英字と数字を両方含めてください');
}

/* --- パスワード・セッション --- */
function pepper_() {
  const props = PropertiesService.getScriptProperties();
  let p = props.getProperty('AUTH_PEPPER');
  if (!p) {
    p = randomString_(48, TOKEN_CHARS);
    props.setProperty('AUTH_PEPPER', p);
  }
  return p;
}

function hashPw_(pw, salt) {
  const pep = pepper_();
  let h = salt + ':' + pw + ':' + pep;
  for (let i = 0; i < AUTH.HASH_ROUNDS; i++) {
    h = toHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, h + salt, Utilities.Charset.UTF_8));
  }
  return h;
}

function toHex_(bytes) {
  return bytes.map(b => ((b + 256) % 256).toString(16).padStart(2, '0')).join('');
}

function randomString_(len, chars) {
  let out = '';
  const limit = 256 - (256 % chars.length);
  while (out.length < len) {
    const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256,
      Utilities.getUuid() + Date.now() + Math.random(), Utilities.Charset.UTF_8);
    for (let i = 0; i < bytes.length && out.length < len; i++) {
      const v = (bytes[i] + 256) % 256;
      if (v < limit) out += chars[v % chars.length];
    }
  }
  return out;
}

function tempPassword_() {
  let p;
  do { p = randomString_(10, TEMP_PW_CHARS); } while (!/[A-Za-z]/.test(p) || !/\d/.test(p));
  return p;
}

function createSession_(memberId) {
  const token = randomString_(40, TOKEN_CHARS);
  CacheService.getScriptCache().put('sess:' + token, memberId, AUTH.SESSION_SEC);
  return token;
}

function sessionMember_(token) {
  if (!/^[A-Za-z0-9]{40}$/.test(String(token || ''))) return null;
  const cache = CacheService.getScriptCache();
  const id = cache.get('sess:' + token);
  if (!id) return null;
  cache.put('sess:' + token, id, AUTH.SESSION_SEC); // 操作のたびに有効期限を延長
  const m = memberById_(id);
  if (!m || m.status !== 'active') return null;
  return m;
}

/* --- 会員シート --- */
function membersSheet_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('MEMBERS_SHEET_ID');
  let ss = null;
  if (id) {
    try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; }
  }
  if (!ss) {
    ss = SpreadsheetApp.create('RV_navi_Members');
    try { DriveApp.getFileById(ss.getId()).moveTo(dataFolder_()); } catch (e) { /* 移動失敗は無視 */ }
    props.setProperty('MEMBERS_SHEET_ID', ss.getId());
  }
  let sh = ss.getSheetByName(AUTH.SHEET_NAME);
  if (!sh) {
    sh = ss.getSheets()[0];
    sh.setName(AUTH.SHEET_NAME);
  }
  if (sh.getLastRow() === 0) {
    sh.appendRow(AUTH.HEADERS);
    sh.setFrozenRows(1);
    sh.getRange('A:L').setNumberFormat('@'); // すべて文字列として保存
  }
  return sh;
}

function rowToMember_(r) {
  const o = {};
  AUTH.HEADERS.forEach((h, i) => { o[h] = r[i] instanceof Date ? r[i].toISOString() : r[i]; });
  o.memberId = String(o.memberId);
  o.email = String(o.email).toLowerCase();
  o.nickname = String(o.nickname);
  o.hash = String(o.hash);
  o.salt = String(o.salt);
  o.mustChange = o.mustChange === true || String(o.mustChange).toUpperCase() === 'TRUE';
  o.status = String(o.status || 'active');
  o.failCount = Number(o.failCount) || 0;
  o.lockUntil = Number(o.lockUntil) || 0;
  return o;
}

function findMember_(pred) {
  const sh = membersSheet_();
  const last = sh.getLastRow();
  if (last < 2) return null;
  const vals = sh.getRange(2, 1, last - 1, AUTH.HEADERS.length).getValues();
  for (let i = 0; i < vals.length; i++) {
    if (!vals[i][0]) continue;
    const m = rowToMember_(vals[i]);
    if (pred(m)) return m;
  }
  return null;
}

function memberById_(id, fresh) {
  const cache = CacheService.getScriptCache();
  const k = 'mem:' + id;
  if (!fresh) {
    const hit = cache.get(k);
    if (hit) return JSON.parse(hit);
  }
  const m = findMember_(x => x.memberId === id);
  if (m) cache.put(k, JSON.stringify(m), 600);
  return m;
}

function saveMember_(m) {
  const sh = membersSheet_();
  const cell = sh.getRange('A:A').createTextFinder(m.memberId).matchEntireCell(true).findNext();
  if (!cell) throw new Error('会員情報が見つかりません');
  const row = AUTH.HEADERS.map(h => {
    const v = m[h];
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    return v == null ? '' : String(v);
  });
  sh.getRange(cell.getRow(), 1, 1, row.length).setValues([row]);
  CacheService.getScriptCache().remove('mem:' + m.memberId);
}

/* --- メール送信 --- */
function sendTempMail_(email, nickname, temp, kind) {
  const isReg = kind === 'register';
  const body = [
    nickname + ' 様',
    '',
    isReg ? 'RV_navi（キャンピングカー専用ナビ）にご登録いただき、ありがとうございます。'
          : 'パスワード再発行のご依頼を受け付けました。',
    '',
    '仮パスワード： ' + temp,
    '',
    '下記のページで、メールアドレスと仮パスワードを入れてログインしてください。',
    'ログイン後、新しいパスワードの設定画面が表示されます。',
    CONFIG.SITE_URL,
    '',
    'このメールに心当たりがない場合は、何もせずに破棄してください。',
    '',
    '――――――――――',
    'RV_navi（キャンピングカー専用ナビ）',
    '※このメールは送信専用です。',
  ].join('\n');
  try {
    MailApp.sendEmail({
      to: email,
      subject: isReg ? '【RV_navi】仮パスワードのお知らせ' : '【RV_navi】仮パスワード再発行のお知らせ',
      body,
      name: 'RV_navi',
    });
  } catch (e) {
    console.error('メール送信失敗', e);
    throw new Error('メールを送信できませんでした。時間をおいてもう一度お試しください');
  }
}

/* ============================================================
 *  地図の共有リンク（短縮URL）の展開
 *   maps.app.goo.gl などをたどって、座標の入った本来のURLを返す
 * ========================================================== */
function expandMapUrl_(p) {
  const allowed = u => /^https:\/\/([a-z0-9-]+\.)*(goo\.gl|g\.co|google\.[a-z]{2,3}(\.[a-z]{2})?)(\/|\?|$)/i.test(u);
  let url = String(p.url || '').trim();
  if (!allowed(url)) throw new Error('Googleマップの共有リンクのみ読み取れます');
  const cache = CacheService.getScriptCache();
  const ck = 'mapurl:' + sha_(url);
  const hit = cacheGet_(ck);
  if (hit) return hit;

  let lat = null, lng = null;
  for (let i = 0; i < 6; i++) {
    const res = UrlFetchApp.fetch(url, {
      followRedirects: false,
      muteHttpExceptions: true,
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Mobile Safari/537.36', 'Accept-Language': 'ja' },
    });
    const code = res.getResponseCode();
    const h = res.getAllHeaders();
    let loc = h.Location || h.location;
    if (Array.isArray(loc)) loc = loc[0];
    if (code >= 300 && code < 400 && loc) {
      if (/^\//.test(loc)) loc = url.match(/^https?:\/\/[^/]+/)[0] + loc;
      // 同意画面を経由する場合は、本来の行き先を取り出す
      const cont = loc.match(/consent\.google\.[^?]+\?.*?continue=([^&]+)/);
      if (cont) loc = decodeURIComponent(cont[1]);
      url = loc;
      if (!allowed(url)) break;
      continue;
    }
    if (code === 200) {
      const html = res.getContentText().slice(0, 300000);
      const m = html.match(/!3d(-?\d{1,3}\.\d+)!4d(-?\d{1,3}\.\d+)/)
        || html.match(/center=(-?\d{1,3}\.\d+)%2C(-?\d{1,3}\.\d+)/)
        || html.match(/\[null,null,(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+)\]/)
        || html.match(/@(-?\d{1,3}\.\d+),(-?\d{1,3}\.\d+),\d/);
      if (m) { lat = Number(m[1]); lng = Number(m[2]); }
    }
    break;
  }
  const out = { url, lat, lng };
  cachePut_(ck, out, 21600);
  return out;
}

/* ============================================================
 *  1. 地点検索
 * ========================================================== */
function geocode_(p) {
  const q = String(p.q || '').trim();
  if (!q) throw new Error('検索語を入力してください');
  if (q.length > 100) throw new Error('検索語が長すぎます');

  const focusLat = Number(p.lat), focusLng = Number(p.lng);
  const hasFocus = isFinite(focusLat) && isFinite(focusLng) && p.lat !== undefined && p.lng !== undefined;
  const ck = 'geo:' + sha_(q + '|' + (hasFocus ? focusLat.toFixed(2) + ',' + focusLng.toFixed(2) : ''));
  const hit = cacheGet_(ck);
  if (hit) return hit;

  const results = [];

  // 1) 国土地理院（住所に強い）
  try {
    const r = fetchJson_(CONFIG.GSI_ADDRESS_SEARCH + '?q=' + encodeURIComponent(q));
    if (r.code === 200 && Array.isArray(r.body)) {
      r.body.slice(0, 6).forEach(f => {
        if (!f || !f.geometry) return;
        results.push({
          label: (f.properties && f.properties.title) || q,
          lng: r5_(f.geometry.coordinates[0]), lat: r5_(f.geometry.coordinates[1]),
          source: 'gsi',
        });
      });
    }
  } catch (e) { console.warn('GSI geocode', e); }

  // 2) ORS（施設名に強い）
  const key = prop_('ORS_API_KEY', false);
  if (key) {
    let qs = '?text=' + encodeURIComponent(q) + '&boundary.country=JP&size=6&lang=ja';
    if (hasFocus) qs += '&focus.point.lat=' + focusLat + '&focus.point.lon=' + focusLng;
    try {
      const r = orsGeocodeFetch_('search', qs, key);
      if (r && r.code === 200 && r.body && Array.isArray(r.body.features)) {
        r.body.features.forEach(f => results.push({
          label: f.properties.label || f.properties.name,
          lng: r5_(f.geometry.coordinates[0]), lat: r5_(f.geometry.coordinates[1]),
          source: 'ors',
        }));
      }
    } catch (e) { console.warn('ORS geocode', e); }
  }

  const seen = {};
  const uniq = results.filter(x => {
    const k = x.lat.toFixed(4) + ',' + x.lng.toFixed(4);
    if (seen[k]) return false;
    seen[k] = 1;
    return true;
  }).slice(0, 10);

  const res = { query: q, results: uniq };
  if (uniq.length) cachePut_(ck, res, 21600);
  return res;
}

function reverseGeocode_(p) {
  const lat = Number(p.lat), lng = Number(p.lng);
  if (!isFinite(lat) || !isFinite(lng)) throw new Error('座標が不正です');
  const fallback = { label: lat.toFixed(5) + ', ' + lng.toFixed(5), lat, lng, source: 'coords' };
  const key = prop_('ORS_API_KEY', false);
  if (!key) return fallback;
  const r = orsGeocodeFetch_('reverse', '?point.lat=' + lat + '&point.lon=' + lng + '&size=1&lang=ja', key);
  if (r && r.code === 200 && r.body && r.body.features && r.body.features.length) {
    const f = r.body.features[0];
    return { label: f.properties.label || f.properties.name, lat, lng, source: 'ors' };
  }
  return fallback;
}

/* ============================================================
 *  2. ルート探索（ORS driving-hgv）
 * ========================================================== */
function route_(p) {
  const wps = (p.waypoints || []).map(normLngLat_);
  if (wps.length < 2) throw new Error('出発地と目的地を指定してください');
  if (wps.length > 25) throw new Error('経由地は最大23か所までです');

  const v = normVehicle_(p.vehicle);
  const key = prop_('ORS_API_KEY', true);

  const avoid = [];
  if (p.avoidTolls) avoid.push('tollways');
  if (p.avoidHighways) avoid.push('highways');
  if (!p.allowFerries) avoid.push('ferries');

  const pref = ['fastest', 'shortest', 'recommended'].indexOf(p.preference) >= 0 ? p.preference : 'recommended';

  const body = {
    coordinates: wps,
    instructions: true,
    language: 'ja',
    units: 'm',
    elevation: true,
    geometry_simplify: false,
    extra_info: ['steepness', 'waytype', 'waycategory', 'surface', 'tollways'],
    radiuses: wps.map(() => 1000),
    preference: pref,
    options: {
      vehicle_type: 'hgv',
      profile_params: {
        restrictions: {
          height: v.effHeight,
          width: v.effWidth,
          length: v.totalLength,
          weight: v.totalWeight,
        },
      },
    },
  };
  if (avoid.length) body.options.avoid_features = avoid;

  const directKm = hav_(wps[0][1], wps[0][0], wps[wps.length - 1][1], wps[wps.length - 1][0]) / 1000;
  if (p.alternatives !== false && wps.length === 2 && directKm <= CONFIG.ALT_ROUTE_MAX_KM) {
    body.alternative_routes = { target_count: 2, weight_factor: 1.4, share_factor: 0.6 };
  }

  const call = () => fetchJson_(CONFIG.ORS_BASE + '/v2/directions/driving-hgv/geojson', {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: key, Accept: 'application/geo+json, application/json' },
    payload: JSON.stringify(body),
  });

  let r = call();
  if (r.code !== 200 && body.alternative_routes) {
    delete body.alternative_routes; // 代替ルート指定が原因の失敗に備えて再試行
    r = call();
  }
  if (r.code !== 200) throw new Error('ルート探索に失敗しました: ' + orsErr_(r));
  if (!r.body || !Array.isArray(r.body.features) || !r.body.features.length) {
    throw new Error('ルートが見つかりませんでした（車両寸法で通行できる道路がない可能性があります）');
  }

  return {
    vehicle: v,
    routes: r.body.features.map((f, i) => compactRoute_(f, i)),
    note: 'ORSの大型車プロファイルで探索しています。所要時間はトラック基準のため長めに表示されます。',
  };
}

function compactRoute_(f, i) {
  const pr = f.properties || {};
  const coords = f.geometry.coordinates.map(c => [r5_(c[0]), r5_(c[1]), c.length > 2 ? Math.round(c[2]) : null]);
  const steps = [];
  (pr.segments || []).forEach((seg, si) => (seg.steps || []).forEach(s => steps.push({
    seg: si,
    instruction: s.instruction,
    name: s.name && s.name !== '-' ? s.name : '',
    distance: Math.round(s.distance || 0),
    duration: Math.round(s.duration || 0),
    type: s.type,
    wp: s.way_points,
  })));
  const ex = pr.extras || {};
  const extras = {};
  ['steepness', 'waytype', 'waycategory', 'surface', 'tollways'].forEach(k => {
    if (ex[k]) extras[k] = { values: ex[k].values || [], summary: ex[k].summary || [] };
  });
  const sm = pr.summary || {};
  return {
    id: i,
    summary: { distance: Math.round(sm.distance || 0), duration: Math.round(sm.duration || 0) },
    ascent: Math.round(pr.ascent || 0),
    descent: Math.round(pr.descent || 0),
    bbox: f.bbox || null,
    wayPoints: pr.way_points || [0, coords.length - 1],
    coordinates: coords,
    steps,
    extras,
  };
}

/**
 * ORS ジオコーディング呼び出し（新ホストの正しいパスを自動判別）
 * 成功したベースURLは CacheService に6時間保存
 */
function orsGeocodeFetch_(kind, qs, key) {
  const cache = CacheService.getScriptCache();
  const known = cache.get('ors_geo_base');
  const bases = known ? [known] : CONFIG.ORS_GEOCODE_BASES;
  for (let i = 0; i < bases.length; i++) {
    const r = fetchJson_(bases[i] + '/' + kind + qs, { headers: { Authorization: key } });
    if (r.code === 200 && r.body && Array.isArray(r.body.features)) {
      if (!known) cache.put('ors_geo_base', bases[i], 21600);
      return r;
    }
    if (r.code === 401 || r.code === 403 || r.code === 429) return r; // キー・上限の問題は他を試しても同じ
  }
  if (known) cache.remove('ors_geo_base');
  return null;
}

function orsErr_(r) {
  const b = r.body;
  let msg = '';
  if (b && b.error) msg = typeof b.error === 'string' ? b.error : (b.error.message || JSON.stringify(b.error));
  if (!msg) msg = 'HTTP ' + r.code + ' ' + String(r.text || '').slice(0, 200);
  if (/routable point/i.test(msg)) msg = '指定地点の近くに通行可能な道路が見つかりません（' + msg + '）';
  if (r.code === 429) msg = 'ORSの利用上限に達しました。しばらく待って再試行してください';
  return msg;
}

/* ============================================================
 *  3. ルート危険度解析
 * ========================================================== */
function analyzeRoute_(p, memberId) {
  const v = normVehicle_(p.vehicle);
  const rt = checkRoute_(p.route);
  const coords = rt.coordinates;
  const n = coords.length;
  const cum = cumDist_(coords);
  const info = buildIndexInfo_(rt, n);

  let hazards = [];
  hazards = hazards.concat(detectHairpins_(coords, cum, v, info, rt.wayPoints));
  hazards = hazards.concat(detectExtrasHazards_(cum, info, v, n));

  const osm = detectOsmRestrictions_(coords, cum, v);
  hazards = hazards.concat(osm.hazards);

  hazards = finalizeHazards_(hazards, coords, cum, info, rt.steps);
  const stats = routeStats_(rt, coords, cum);

  let ai = null, aiError = null;
  if (p.useAI !== false && hazards.length + stats.mainRoads.length > 0) {
    try {
      ai = geminiAssess_(v, stats, hazards, memberId);
    } catch (e) {
      aiError = e.message;
      console.warn('Gemini', e);
    }
  }

  const counts = { critical: 0, high: 0, medium: 0, low: 0 };
  const merged = mergeAi_(hazards, ai);
  merged.forEach(h => { counts[h.severity] = (counts[h.severity] || 0) + 1; });

  return {
    vehicle: v,
    stats,
    counts,
    hazards: merged,
    ai: ai ? {
      overallRisk: ai.overallRisk,
      riskScore: ai.riskScore,
      summary: ai.summary,
      additionalConcerns: ai.additionalConcerns || [],
      recommendations: ai.recommendations || [],
      nightDrivingNote: ai.nightDrivingNote || '',
    } : null,
    aiError,
    osmCoverage: { checkedKm: osm.checkedKm, totalKm: osm.totalKm, notes: osm.errors },
    disclaimer: DISCLAIMER,
  };
}

/** 各座標インデックスごとの道路種別・カテゴリ・勾配・案内ステップ */
function buildIndexInfo_(rt, n) {
  const waytype = new Int16Array(n).fill(-1);
  const waycat = new Int16Array(n);
  const steep = new Int8Array(n);
  const stepIdx = new Int32Array(n).fill(-1);
  const fill = (ex, arr) => {
    if (!ex || !Array.isArray(ex.values)) return;
    ex.values.forEach(val => {
      const a = clamp_(val[0] | 0, 0, n - 1), b = clamp_(val[1] | 0, 0, n - 1);
      for (let i = a; i <= b; i++) arr[i] = val[2];
    });
  };
  fill(rt.extras.waytype, waytype);
  fill(rt.extras.waycategory, waycat);
  fill(rt.extras.steepness, steep);
  rt.steps.forEach((s, si) => {
    if (!Array.isArray(s.wp)) return;
    const a = clamp_(s.wp[0] | 0, 0, n - 1), b = clamp_(s.wp[1] | 0, 0, n - 1);
    for (let i = a; i <= b; i++) stepIdx[i] = si;
  });
  return { waytype, waycat, steep, stepIdx };
}

/** ① 幾何解析: 急カーブ・連続ヘアピン */
function detectHairpins_(coords, cum, v, info, wayPointIdx) {
  const n = coords.length;
  const L = 25; // 前後25mの方位差で判定
  const TH = v.totalLength >= 7 ? 105 : 125;
  const wps = (wayPointIdx || []).map(w => clamp_(w | 0, 0, n - 1));
  const hits = [];
  let j = 0, k = 1;

  for (let i = 1; i < n - 1; i++) {
    while (j + 1 < i && cum[i] - cum[j + 1] >= L) j++;
    if (cum[i] - cum[j] < L) continue;
    if (k <= i) k = i + 1;
    while (k < n - 1 && cum[k] - cum[i] < L) k++;
    if (cum[k] - cum[i] < L) break;
    if (info.waycat[i] & 1) continue; // 高速道路は除外
    const b1 = bearing_(coords[j][1], coords[j][0], coords[i][1], coords[i][0]);
    const b2 = bearing_(coords[i][1], coords[i][0], coords[k][1], coords[k][0]);
    let t = Math.abs(b2 - b1);
    if (t > 180) t = 360 - t;
    if (t >= TH) hits.push({ i, t });
  }

  // 60m以内の連続ヒットを1つのカーブにまとめる
  const turns = [];
  hits.forEach(h => {
    if (wps.some(w => Math.abs(cum[w] - cum[h.i]) < 40)) return; // 経由地での折り返しは除外
    const last = turns[turns.length - 1];
    if (last && cum[h.i] - cum[last.e] < 60) {
      last.e = h.i;
      if (h.t > last.t) { last.t = h.t; last.i = h.i; }
    } else {
      turns.push({ s: h.i, e: h.i, i: h.i, t: h.t });
    }
  });

  // 400m以内に3つ以上続けば「連続ヘアピン区間」
  const out = [];
  let grp = [];
  const flush = () => {
    if (!grp.length) return;
    if (grp.length >= 3) {
      const first = grp[0], last = grp[grp.length - 1];
      out.push(hz_('hairpin_series', 'high', first.i, {
        idxEnd: last.i,
        detail: {
          count: grp.length,
          maxTurnDeg: Math.round(Math.max.apply(null, grp.map(g => g.t))),
          lengthM: Math.round(cum[last.i] - cum[first.i]),
        },
        source: 'geometry',
      }));
    } else {
      grp.forEach(g => {
        let sev = 'low';
        if (g.t >= 150) sev = v.totalLength >= 7 ? 'high' : 'medium';
        out.push(hz_('sharp_turn', sev, g.i, { detail: { turnDeg: Math.round(g.t) }, source: 'geometry' }));
      });
    }
    grp = [];
  };
  turns.forEach(tn => {
    if (grp.length && cum[tn.i] - cum[grp[grp.length - 1].i] > 400) flush();
    grp.push(tn);
  });
  flush();
  return out;
}

/** ② ORS付加情報: 勾配・道路種別・路面 */
function detectExtrasHazards_(cum, info, v, n) {
  const out = [];
  const total = cum[n - 1];
  const lenOf = r => cum[r[1]] - cum[r[0]];
  const edge = Math.min(1000, total * 0.1);
  const inCore = r => cum[r[0]] > edge && cum[r[1]] < total - edge;

  // 急勾配
  [1, -1].forEach(sign => {
    mergeRuns_(runs_(n, i => sign * info.steep[i] >= 3), cum, 50).forEach(r => {
      let maxC = 0;
      for (let i = r[0]; i <= r[1]; i++) maxC = Math.max(maxC, sign * info.steep[i]);
      const len = lenOf(r);
      let sev = null;
      if (maxC >= 5 && len >= 50) sev = 'high';
      else if (maxC >= 4 && len >= 100) sev = len >= 300 ? 'high' : 'medium';
      else if (maxC >= 3 && len >= 400) sev = 'medium';
      if (!sev) return;
      if (sev === 'medium' && (v.trailer || v.totalWeight >= 5)) sev = 'high';
      out.push(hz_(sign > 0 ? 'steep_up' : 'steep_down', sev, r[0], {
        idxEnd: r[1], detail: { grade: STEEP_GRADE[maxC], lengthM: Math.round(len) }, source: 'ors',
      }));
    });
  });

  // 林道・小径
  mergeRuns_(runs_(n, i => info.waytype[i] === 4 || info.waytype[i] === 5), cum, 30).forEach(r => {
    if (lenOf(r) < 30) return;
    out.push(hz_('track', 'high', r[0], { idxEnd: r[1], detail: { lengthM: Math.round(lenOf(r)) }, source: 'ors' }));
  });

  // 生活道路（出発・到着付近は除外）
  mergeRuns_(runs_(n, i => info.waytype[i] === 3), cum, 30).forEach(r => {
    if (lenOf(r) < 300 || !inCore(r)) return;
    out.push(hz_('residential', 'low', r[0], { idxEnd: r[1], detail: { lengthM: Math.round(lenOf(r)) }, source: 'ors' }));
  });

  // 工事中
  mergeRuns_(runs_(n, i => info.waytype[i] === 10), cum, 30).forEach(r => {
    out.push(hz_('construction', 'medium', r[0], { idxEnd: r[1], detail: { lengthM: Math.round(lenOf(r)) }, source: 'ors' }));
  });

  // 未舗装（bit 8）
  mergeRuns_(runs_(n, i => (info.waycat[i] & 8) && info.waytype[i] !== 4 && info.waytype[i] !== 5), cum, 30).forEach(r => {
    if (lenOf(r) < 50) return;
    const sev = v.drive === '2WD' && (v.trailer || v.totalWeight >= 3.5) ? 'high' : 'medium';
    out.push(hz_('unpaved', sev, r[0], { idxEnd: r[1], detail: { lengthM: Math.round(lenOf(r)) }, source: 'ors' }));
  });

  // 渡河（bit 128）
  mergeRuns_(runs_(n, i => info.waycat[i] & 128), cum, 30).forEach(r => {
    out.push(hz_('ford', 'high', r[0], { idxEnd: r[1], detail: {}, source: 'ors' }));
  });

  // 一般道のトンネル（bit 32、高速を除く）
  mergeRuns_(runs_(n, i => (info.waycat[i] & 32) && !(info.waycat[i] & 1) && info.waytype[i] >= 2), cum, 20).forEach(r => {
    out.push(hz_('tunnel', 'low', r[0], { idxEnd: r[1], detail: { lengthM: Math.round(lenOf(r)) }, source: 'ors' }));
  });

  return out;
}

/** ③ OSM実タグ（Overpass）: ルート上の制限値を車両と比較 */
function detectOsmRestrictions_(coords, cum, v) {
  const C = CONFIG.OSM_CHECK;
  const idx = simplifyIdx_(coords, C.simplifyTolM);
  const chunks = chunkIdx_(idx, C.chunkPts);
  const grid = buildGrid_(coords);
  const res = { hazards: [], checkedKm: 0, totalKm: round_(cum[cum.length - 1] / 1000, 1), errors: [] };
  const seen = {};
  const limit = Math.min(chunks.length, C.maxChunks);

  for (let ci = 0; ci < limit; ci++) {
    if (elapsed_() > CONFIG.MAX_EXEC_MS * 0.5) {
      res.errors.push('処理時間の上限により一部区間は未確認です');
      break;
    }
    const ch = chunks[ci];
    const poly = polyStr_(coords, ch);
    const q = '[out:json][timeout:60];' +
      'way[highway](around:' + C.aroundM + ',' + poly + ')->.w;' +
      '(way.w[maxheight];way.w["maxheight:physical"];way.w[maxwidth];way.w[maxweight];' +
      'way.w[maxlength];way.w[width];way.w[narrow=yes];);' +
      'out tags geom;' +
      'node(around:' + C.aroundM + ',' + poly + ')[~"^(maxheight|barrier)$"~"."];' +
      'out;';

    let data;
    try {
      data = overpass_(q);
    } catch (e) {
      res.errors.push('区間' + (ci + 1) + 'の確認に失敗: ' + e.message);
      continue;
    }

    (data.elements || []).forEach(el => {
      const key = el.type + '/' + el.id;
      if (seen[key]) return;
      seen[key] = 1;
      let at = -1, atEnd = -1;
      if (el.type === 'way') {
        // ルート座標と2点以上一致＝ルート上を走る道路（交差・立体交差の別道路を除外）
        let cnt = 0, minI = Infinity, maxI = -1;
        (el.geometry || []).forEach(pt => {
          if (!pt) return;
          const i = gridNearest_(grid, coords, pt.lat, pt.lon, C.matchTolM);
          if (i >= 0) { cnt++; minI = Math.min(minI, i); maxI = Math.max(maxI, i); }
        });
        if (cnt < 2) return;
        at = minI; atEnd = maxI;
      } else if (el.type === 'node') {
        at = gridNearest_(grid, coords, el.lat, el.lon, C.matchTolM);
        if (at < 0) return;
        atEnd = at;
      } else {
        return;
      }
      evalRestrictionTags_(el.tags || {}, v, at, atEnd, key).forEach(h => res.hazards.push(h));
    });
    res.checkedKm = round_(cum[ch[ch.length - 1]] / 1000, 1);
  }
  if (chunks.length > limit) {
    res.errors.push('長距離のため、OSM属性は出発から約' + res.checkedKm + 'kmまでを確認しました');
  }
  return res;
}

function evalRestrictionTags_(t, v, idx, idxEnd, osmId) {
  const out = [];
  const name = t.name || t.ref || '';
  const base = () => ({ idxEnd, source: 'osm', osmId });
  const add = (type, sev, detail) => out.push(hz_(type, sev, idx, Object.assign(base(), { detail: Object.assign({ name }, detail) })));

  if (['yes', 'designated'].indexOf(t.motor_vehicle) >= 0 && t.barrier) return out;

  // 高さ
  const rawH = t['maxheight:physical'] || t.maxheight;
  const mh = parseLen_(rawH);
  if (mh != null) {
    if (mh < v.height) add('height_limit', 'critical', { limitM: mh, vehicleM: v.height });
    else if (mh < v.height + 0.3) add('height_limit', 'high', { limitM: mh, vehicleM: v.height, note: '余裕30cm未満' });
  } else if (rawH === 'below_default') {
    add('height_limit', 'high', { limitM: null, note: '低い構造物あり（数値不明）' });
  }

  // 幅
  const mw = parseLen_(t.maxwidth);
  if (mw != null) {
    if (mw < v.width) add('width_limit', 'critical', { limitM: mw, vehicleM: v.width });
    else if (mw < v.width + 0.3) add('width_limit', 'high', { limitM: mw, vehicleM: v.width, note: '余裕30cm未満' });
  }

  // 重量
  const mwt = parseWeight_(t.maxweight);
  if (mwt != null && mwt < v.totalWeight) add('weight_limit', 'critical', { limitT: mwt, vehicleT: v.totalWeight });

  // 長さ
  const ml = parseLen_(t.maxlength);
  if (ml != null && ml < v.totalLength) add('length_limit', 'critical', { limitM: ml, vehicleM: v.totalLength });

  // 道路の実幅
  const w = parseLen_(t.width);
  const major = /^(motorway|trunk)/.test(t.highway || '');
  if (w != null && !major) {
    if (w < v.width + 0.6) add('very_narrow', 'high', { roadWidthM: w, vehicleM: v.width });
    else if (w < v.width * 2 + 0.8) add('narrow_road', 'medium', { roadWidthM: w, note: '対向車とのすれ違い困難' });
  } else if (t.narrow === 'yes' && !major) {
    add('narrow_road', 'medium', { note: '狭い道路として登録' });
  }

  // 障害物
  if (t.barrier) {
    if (t.barrier === 'height_restrictor' && mh == null) add('height_limit', 'high', { limitM: null, note: '高さ制限バー（数値不明）' });
    else if (['bollard', 'block', 'jersey_barrier'].indexOf(t.barrier) >= 0) add('barrier', 'critical', { kind: t.barrier, note: '車止めで通行不可の可能性' });
    else if (['gate', 'lift_gate', 'swing_gate'].indexOf(t.barrier) >= 0) add('gate', 'medium', { kind: t.barrier, note: '時間帯により閉鎖の可能性' });
  }
  return out;
}

/** 重複統合・ID付与・道路名付与 */
function finalizeHazards_(list, coords, cum, info, steps) {
  list.sort((a, b) => a.idx - b.idx);
  const merged = [];
  list.forEach(h => {
    const dup = merged.find(m => HAZARD_GROUP[m.type] === HAZARD_GROUP[h.type] && Math.abs(cum[m.idx] - cum[h.idx]) < 150);
    if (dup) {
      if (SEV[h.severity] > SEV[dup.severity]) Object.assign(dup, h);
      return;
    }
    merged.push(h);
  });

  const heights = merged.filter(h => h.type === 'height_limit');
  let final = merged.filter(h => !(h.type === 'tunnel' && heights.some(x => Math.abs(cum[x.idx] - cum[h.idx]) < 300)));

  if (final.length > 80) {
    final = final.slice()
      .sort((a, b) => SEV[b.severity] - SEV[a.severity] || a.idx - b.idx)
      .slice(0, 80)
      .sort((a, b) => a.idx - b.idx);
  }

  return final.map((h, k) => {
    const c = coords[h.idx];
    const si = info.stepIdx[h.idx];
    const st = si >= 0 ? steps[si] : null;
    const d = h.detail || {};
    return {
      id: 'H' + (k + 1),
      type: h.type,
      label: HAZARD_LABELS[h.type] || h.type,
      severity: h.severity,
      lat: c[1],
      lng: c[0],
      idx: h.idx,
      idxEnd: h.idxEnd != null ? h.idxEnd : h.idx,
      distFromStartKm: round_(cum[h.idx] / 1000, 2),
      roadName: (st && st.name) || d.name || '',
      detail: d,
      source: h.source,
      osmId: h.osmId || null,
    };
  });
}

function routeStats_(rt, coords, cum) {
  const n = coords.length;
  const shareOf = (ex, labels) => {
    const o = {};
    if (!ex || !Array.isArray(ex.summary)) return o;
    ex.summary.forEach(s => {
      const k = labels[String(s.value)] || String(s.value);
      o[k] = round_((o[k] || 0) + (s.amount || 0), 1);
    });
    return o;
  };
  const roadDist = {};
  rt.steps.forEach(s => { if (s.name) roadDist[s.name] = (roadDist[s.name] || 0) + (Number(s.distance) || 0); });
  const mainRoads = Object.keys(roadDist)
    .sort((a, b) => roadDist[b] - roadDist[a])
    .slice(0, 12)
    .map(k => ({ name: k, km: round_(roadDist[k] / 1000, 1) }));

  let maxE = -Infinity, minE = Infinity;
  coords.forEach(c => {
    if (c[2] != null && isFinite(c[2])) { maxE = Math.max(maxE, c[2]); minE = Math.min(minE, c[2]); }
  });
  const tw = rt.extras.tollways;
  const tollM = tw && Array.isArray(tw.summary)
    ? tw.summary.filter(s => s.value === 1).reduce((a, s) => a + (s.distance || 0), 0) : 0;

  return {
    distanceKm: round_(cum[n - 1] / 1000, 1),
    durationMin: Math.round((Number(rt.summary.duration) || 0) / 60),
    ascentM: rt.ascent,
    descentM: rt.descent,
    maxElevationM: isFinite(maxE) ? Math.round(maxE) : null,
    minElevationM: isFinite(minE) ? Math.round(minE) : null,
    tollKm: round_(tollM / 1000, 1),
    roadTypeShare: shareOf(rt.extras.waytype, WAYTYPE_LABELS),
    steepShare: shareOf(rt.extras.steepness, STEEP_LABELS),
    mainRoads,
  };
}

/* ------------------------------------------------------------
 *  ④ Gemini によるリスク評価
 * ---------------------------------------------------------- */
function geminiAssess_(v, stats, hazards, memberId) {
  const payload = {
    vehicle: {
      widthM: v.width, heightM: v.height, lengthM: v.totalLength, weightT: v.totalWeight,
      drive: v.drive, trailer: v.trailer,
    },
    route: stats,
    hazards: hazards.slice(0, 60).map(h => ({
      id: h.id, type: h.type, label: h.label, severity: h.severity,
      km: round_(h.distFromStartKm, 1), road: h.roadName, detail: h.detail,
    })),
  };

  const ck = 'gem:' + sha_(JSON.stringify(payload));
  const hit = cacheGet_(ck);
  if (hit) return hit;

  rateLimit_(memberId);

  const prompt = [
    'あなたは日本の道路事情に精通した、キャンピングカー・大型車の運行安全アドバイザーです。',
    '以下のJSONは、車両の寸法(vehicle)、ルート概要(route)、プログラムが機械的に検出した危険候補(hazards)です。',
    '',
    '# ルール',
    '1. hazards の各 id について、車両寸法を踏まえて重大度(severity)を再評価し、20文字以内の title と、運転者向けの具体的な advice（60〜120文字）を返してください。',
    '   - 重大度は critical / high / medium / low のいずれか。',
    '   - 入力で critical のもの（OSMの制限値が車両寸法を下回る等）は critical のままにしてください。',
    '   - low の生活道路・トンネル等で問題が小さいものは low のままで構いません。',
    '2. 座標や距離を新たに創作しないでください。',
    '3. additionalConcerns には、route.mainRoads に含まれる道路名について、あなたの知識で広く知られている狭隘区間（いわゆる酷道・険道、離合困難な峠道、低いガード下、大型車通行止め区間など）がある場合のみ記載してください。確信がない場合は空配列にしてください。approxKm は分からなければ省略してください。',
    '4. recommendations には、休憩・給油・出発時刻・迂回検討など実用的な助言を3〜6件。',
    '5. nightDrivingNote には、夜間走行時の注意点を1〜2文で。',
    '6. riskScore は 0（安全）〜100（非常に危険）の整数。overallRisk は low / medium / high / very_high。',
    '7. 日本語の「です・ます」調で、最終判断は現地標識を優先する前提で書いてください。',
    '',
    '# 入力',
    JSON.stringify(payload),
  ].join('\n');

  const sevEnum = ['critical', 'high', 'medium', 'low'];
  const schema = {
    type: 'OBJECT',
    properties: {
      overallRisk: { type: 'STRING', enum: ['low', 'medium', 'high', 'very_high'] },
      riskScore: { type: 'INTEGER' },
      summary: { type: 'STRING' },
      hazards: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            id: { type: 'STRING' },
            severity: { type: 'STRING', enum: sevEnum },
            title: { type: 'STRING' },
            advice: { type: 'STRING' },
          },
          required: ['id', 'severity', 'title', 'advice'],
        },
      },
      additionalConcerns: {
        type: 'ARRAY',
        items: {
          type: 'OBJECT',
          properties: {
            title: { type: 'STRING' },
            detail: { type: 'STRING' },
            roadName: { type: 'STRING' },
            approxKm: { type: 'NUMBER' },
          },
          required: ['title', 'detail'],
        },
      },
      recommendations: { type: 'ARRAY', items: { type: 'STRING' } },
      nightDrivingNote: { type: 'STRING' },
    },
    required: ['overallRisk', 'riskScore', 'summary', 'hazards', 'recommendations'],
  };

  let res;
  try {
    res = callGemini_(CONFIG.GEMINI_MODEL, prompt, schema, CONFIG.GEMINI_THINKING_LEVEL);
  } catch (e) {
    console.warn('Gemini主モデル失敗→フォールバック', e);
    res = callGemini_(CONFIG.GEMINI_MODEL_FALLBACK, prompt, schema, null);
  }

  // 出力の正規化
  res.overallRisk = ['low', 'medium', 'high', 'very_high'].indexOf(res.overallRisk) >= 0 ? res.overallRisk : 'medium';
  res.riskScore = clamp_(Math.round(Number(res.riskScore) || 0), 0, 100);
  res.summary = String(res.summary || '').slice(0, 600);
  res.hazards = Array.isArray(res.hazards) ? res.hazards : [];
  res.additionalConcerns = (Array.isArray(res.additionalConcerns) ? res.additionalConcerns : []).slice(0, 8);
  res.recommendations = (Array.isArray(res.recommendations) ? res.recommendations : []).slice(0, 8).map(s => String(s).slice(0, 200));
  res.nightDrivingNote = String(res.nightDrivingNote || '').slice(0, 300);

  cachePut_(ck, res, 21600);
  return res;
}

function callGemini_(model, prompt, schema, thinkingLevel) {
  const key = prop_('GEMINI_API_KEY', true);
  // Gemini 3 系は温度を既定値のまま使うことが推奨されているため指定しない
  const generationConfig = {
    maxOutputTokens: 8192,
    responseMimeType: 'application/json',
    responseSchema: schema,
  };
  if (thinkingLevel) generationConfig.thinkingConfig = { thinkingLevel };
  const body = {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig,
  };
  const r = fetchJson_('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent', {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-goog-api-key': key },
    payload: JSON.stringify(body),
  });
  if (r.code !== 200) {
    const msg = r.body && r.body.error ? r.body.error.message : String(r.text || '').slice(0, 200);
    throw new Error('Gemini(' + model + ') HTTP ' + r.code + ': ' + msg);
  }
  const cand = r.body && r.body.candidates && r.body.candidates[0];
  const text = cand && cand.content && cand.content.parts
    ? cand.content.parts.map(pt => pt.text || '').join('') : '';
  if (!text) throw new Error('Gemini応答が空です（' + ((cand && cand.finishReason) || 'unknown') + '）');
  return JSON.parse(text.replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim());
}

function mergeAi_(hazards, ai) {
  const map = {};
  if (ai && Array.isArray(ai.hazards)) ai.hazards.forEach(a => { if (a && a.id) map[a.id] = a; });
  return hazards.map(h => {
    const a = map[h.id];
    if (!a) return h;
    let sev = SEV[a.severity] ? a.severity : h.severity;
    if (h.severity === 'critical') sev = 'critical';
    return Object.assign({}, h, {
      severity: sev,
      originalSeverity: h.severity,
      title: String(a.title || '').slice(0, 30),
      advice: String(a.advice || '').slice(0, 300),
    });
  });
}

function rateLimit_(memberId) {
  const id = /^[A-Za-z0-9_-]{16,64}$/.test(String(memberId || '')) ? memberId : 'anon';
  const k = 'rl:' + id + ':' + Utilities.formatDate(new Date(), CONFIG.TZ, 'yyyyMMddHH');
  const c = CacheService.getScriptCache();
  const cnt = Number(c.get(k) || 0);
  if (cnt >= CONFIG.GEMINI_RATE_PER_HOUR) {
    throw new Error('AI解析の利用回数が上限に達しました（1時間あたり' + CONFIG.GEMINI_RATE_PER_HOUR + '回）');
  }
  c.put(k, String(cnt + 1), 3700);
}

/* ============================================================
 *  4. ルート沿い施設検索
 * ========================================================== */
function searchAlongRoute_(p) {
  const rt = checkRoute_(p.route);
  const coords = rt.coordinates;
  const cum = cumDist_(coords);
  const radius = clamp_(Number(p.radius) || 1000, 300, 2000);
  const cats = (Array.isArray(p.categories) && p.categories.length ? p.categories : Object.keys(POI_CATS))
    .filter(c => POI_CATS[c]);
  if (!cats.length) throw new Error('検索カテゴリを指定してください');

  const mid = coords[Math.floor(coords.length / 2)];
  const ck = 'poi:' + sha_(JSON.stringify([radius, cats.slice().sort(), coords.length, coords[0], mid, coords[coords.length - 1]]));
  const hit = cacheGet_(ck);
  if (hit) return hit;

  const tArr = buildTimeArr_(rt, cum);
  const found = findPoisAlong_(coords, cum, radius, cats);
  const pois = found.pois.map(pi => Object.assign(pi, { etaMin: Math.round(tArr[pi.idx] / 60) }));

  const result = { radius, categories: cats, count: pois.length, pois, notes: found.errors };
  cachePut_(ck, result, 3600);
  return result;
}

function findPoisAlong_(coords, cum, radius, cats) {
  const P = CONFIG.POI;
  const clauses = poiClauses_(cats);
  if (!clauses.length) return { pois: [], errors: [] };

  const simp = simplifyToMax_(coords, P.maxPts, Math.min(radius / 4, 120));
  const chunks = chunkIdx_(simp.idx, P.chunkPts);
  const around = Math.round(radius + simp.tol);
  const raw = {};
  const errors = [];

  for (let ci = 0; ci < chunks.length; ci++) {
    if (elapsed_() > CONFIG.MAX_EXEC_MS * 0.8) {
      errors.push('処理時間の上限により後半区間の検索を省略しました');
      break;
    }
    const poly = polyStr_(coords, chunks[ci]);
    const q = '[out:json][timeout:90];(' +
      clauses.map(c => 'nwr(around:' + around + ',' + poly + ')' + c + ';').join('') +
      ');out tags center;';
    try {
      const data = overpass_(q);
      (data.elements || []).forEach(el => { raw[el.type + '/' + el.id] = el; });
    } catch (e) {
      errors.push('区間' + (ci + 1) + 'の施設検索に失敗: ' + e.message);
    }
  }

  const items = [];
  Object.keys(raw).forEach(k => {
    const el = raw[k];
    const t = el.tags || {};
    const cat = classifyPoi_(t);
    if (!cat || cats.indexOf(cat) < 0) return;
    const lat = el.lat != null ? el.lat : (el.center && el.center.lat);
    const lng = el.lon != null ? el.lon : (el.center && el.center.lon);
    if (lat == null || lng == null) return;
    const near = nearestOnRoute_(coords, simp.idx, lat, lng);
    if (near.d > radius) return;
    items.push({
      id: k,
      category: cat,
      label: POI_CATS[cat].label,
      name: t.name || POI_CATS[cat].label,
      lat: r5_(lat),
      lng: r5_(lng),
      idx: near.i,
      distToRouteM: Math.round(near.d),
      alongKm: round_(cum[near.i] / 1000, 1),
      info: pickPoiInfo_(t),
      _rank: poiRank_(el, t),
    });
  });

  const pois = dedupPois_(items)
    .sort((a, b) => a.alongKm - b.alongKm)
    .slice(0, P.maxResults)
    .map(pi => { delete pi._rank; return pi; });
  return { pois, errors };
}

function poiClauses_(cats) {
  const vals = [];
  cats.forEach(c => (POI_CATS[c] || { values: [] }).values.forEach(v => { if (vals.indexOf(v) < 0) vals.push(v); }));
  const out = [];
  if (vals.length) out.push('[~"^(tourism|amenity|shop|highway|leisure)$"~"^(' + vals.join('|') + ')$"]');
  if (cats.indexOf('michinoeki') >= 0) out.push('["name"~"^道の駅"]');
  return out;
}

function classifyPoi_(t) {
  const name = t.name || '';
  const transit = t.highway === 'bus_stop' || t.public_transport || t.railway || t.amenity === 'toilets';
  if (/^道の駅/.test(name) && !transit) return 'michinoeki';
  if (t.tourism === 'caravan_site' || /RVパーク/i.test(name)) return 'rvpark';
  if (t.tourism === 'camp_site') return 'camp';
  if (t.amenity === 'public_bath' || t.leisure === 'spa') return 'onsen';
  if (t.amenity === 'fuel') return 'fuel';
  if (t.shop === 'supermarket') return 'supermarket';
  if (t.shop === 'laundry' || t.amenity === 'laundry') return 'laundry';
  if (t.highway === 'services' || t.highway === 'rest_area') return 'sapa';
  return null;
}

function poiRank_(el, t) {
  let r = 0;
  if (t.highway === 'services' || t.highway === 'rest_area') r += 3;
  if (el.type !== 'node') r += 2;
  if (t.website || t['contact:website']) r += 1;
  if (t.opening_hours) r += 1;
  return r;
}

function dedupPois_(items) {
  const out = [];
  items.sort((a, b) => b._rank - a._rank).forEach(pi => {
    const lim = pi.category === 'michinoeki' ? 400 : 300;
    const dup = out.find(o => o.category === pi.category &&
      (pi.category === 'michinoeki' || o.name === pi.name) &&
      hav_(o.lat, o.lng, pi.lat, pi.lng) < lim);
    if (!dup) out.push(pi);
  });
  return out;
}

function pickPoiInfo_(t) {
  const o = {};
  POI_INFO_KEYS.forEach(k => { if (t[k] != null) o[k] = t[k]; });
  return o;
}

/* ============================================================
 *  5. 休憩計画（連続運転2時間ごと）
 * ========================================================== */
function restPlan_(p) {
  const rt = checkRoute_(p.route);
  const coords = rt.coordinates, n = coords.length;
  const cum = cumDist_(coords);
  const tArr = buildTimeArr_(rt, cum);
  const total = tArr[n - 1];
  const intervalMin = clamp_(Number(p.intervalMin) || 120, 60, 240);
  const interval = intervalMin * 60;

  let depart = null;
  if (p.departAt) {
    depart = new Date(p.departAt);
    if (isNaN(depart.getTime())) throw new Error('出発時刻の形式が不正です');
  }
  const arrival = {
    totalMin: Math.round(total / 60),
    clock: clock_(depart, total),
    night: isNight_(depart, total),
  };

  if (total < interval + 15 * 60) {
    return { intervalMin, arrival, stops: [], message: '運転時間が休憩間隔以内のため、途中休憩の提案はありません' };
  }

  const info = buildIndexInfo_(rt, n);
  const found = findPoisAlong_(coords, cum, 1000, ['michinoeki', 'sapa', 'rvpark']);
  const cands = found.pois
    .map(pi => Object.assign({}, pi, { etaSec: tArr[pi.idx], onHighway: !!(info.waycat[pi.idx] & 1) }))
    .filter(pi => pi.category === 'sapa' ? (pi.onHighway && pi.distToRouteM < 300) : !pi.onHighway);

  const PRIO = { sapa: 1.0, michinoeki: 1.0, rvpark: 0.7 };
  const WINDOW = 45 * 60;
  const stops = [];
  let last = 0, guard = 0;

  while (total - last > interval + 15 * 60 && guard++ < 30) {
    const target = last + interval;
    const win = cands.filter(c => c.etaSec > last + 20 * 60 && c.etaSec <= target && c.etaSec >= target - WINDOW);
    win.forEach(c => {
      c._score = (1 - (target - c.etaSec) / WINDOW) * 0.6 + PRIO[c.category] * 0.4 - (c.distToRouteM / 1000) * 0.1;
    });
    win.sort((a, b) => b._score - a._score);

    if (win.length) {
      const best = win[0];
      stops.push({
        targetMin: Math.round(target / 60),
        etaMin: Math.round(best.etaSec / 60),
        clock: clock_(depart, best.etaSec),
        night: isNight_(depart, best.etaSec),
        poi: stripPoi_(best),
        alternatives: win.slice(1, 3).map(stripPoi_),
        note: best.category === 'sapa' ? 'SA・PAは上下線どちら側か現地でご確認ください' : '',
      });
      last = best.etaSec;
    } else {
      const ti = indexAtTime_(tArr, target);
      stops.push({
        targetMin: Math.round(target / 60),
        etaMin: Math.round(target / 60),
        clock: clock_(depart, target),
        night: isNight_(depart, target),
        poi: null,
        lat: coords[ti][1],
        lng: coords[ti][0],
        alongKm: round_(cum[ti] / 1000, 1),
        alternatives: [],
        note: 'この付近に道の駅・SA/PA・RVパークが見つかりません。手前の大型駐車場やコンビニで休憩してください',
      });
      last = target;
    }
  }

  return { intervalMin, arrival, stops, notes: found.errors };
}

function stripPoi_(pi) {
  return {
    id: pi.id, category: pi.category, label: pi.label, name: pi.name,
    lat: pi.lat, lng: pi.lng, alongKm: pi.alongKm, distToRouteM: pi.distToRouteM,
    etaMin: Math.round(pi.etaSec / 60), info: pi.info,
  };
}

function clock_(depart, sec) {
  if (!depart) return null;
  return Utilities.formatDate(new Date(depart.getTime() + sec * 1000), CONFIG.TZ, 'HH:mm');
}

function isNight_(depart, sec) {
  if (!depart) return null;
  const h = Number(Utilities.formatDate(new Date(depart.getTime() + sec * 1000), CONFIG.TZ, 'H'));
  return h >= 22 || h < 5;
}

/* ============================================================
 *  6. データ保存（Google Drive / JSON）
 * ========================================================== */
function loadData_(memberId, type) {
  checkMemberId_(memberId);
  checkType_(type);
  const f = findDataFile_(fileName_(type, memberId));
  if (!f) return { type, data: null, updatedAt: null };
  const obj = JSON.parse(f.getBlob().getDataAsString('UTF-8'));
  return { type, data: obj.data, updatedAt: obj.updatedAt };
}

function loadAll_(memberId) {
  checkMemberId_(memberId);
  const o = {};
  CONFIG.DATA_TYPES.forEach(t => { o[t] = loadData_(memberId, t); });
  return o;
}

function saveData_(memberId, type, data) {
  checkMemberId_(memberId);
  checkType_(type);
  const clean = validateData_(type, data);
  const updatedAt = new Date().toISOString();
  const json = JSON.stringify({ type, memberId, updatedAt, data: clean });
  if (Utilities.newBlob(json).getBytes().length > CONFIG.MAX_DATA_BYTES) {
    throw new Error('保存データが大きすぎます（上限' + Math.round(CONFIG.MAX_DATA_BYTES / 1024) + 'KB）');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const name = fileName_(type, memberId);
    const f = findDataFile_(name);
    if (f) {
      f.setContent(json);
    } else {
      const nf = dataFolder_().createFile(name, json, 'application/json');
      CacheService.getScriptCache().put('fid:' + name, nf.getId(), 21600);
    }
  } finally {
    lock.releaseLock();
  }
  return { type, updatedAt };
}

function validateData_(type, data) {
  if (type === 'profile') {
    if (!data || typeof data !== 'object') throw new Error('車両プロファイルが不正です');
    normVehicle_(data); // 値の範囲チェック
    return {
      name: String(data.name || '').slice(0, 40),
      width: Number(data.width), height: Number(data.height),
      length: Number(data.length), weight: Number(data.weight),
      drive: data.drive === '4WD' ? '4WD' : '2WD',
      trailer: !!data.trailer,
      trailerLength: Number(data.trailerLength) || 0,
      trailerWeight: Number(data.trailerWeight) || 0,
    };
  }
  if (!Array.isArray(data)) throw new Error(type + ' は配列で送信してください');
  if (data.length > 1000) throw new Error('登録件数が多すぎます（最大1000件）');
  return data.filter(x => x && isFinite(Number(x.lat)) && isFinite(Number(x.lng)));
}

function checkMemberId_(id) {
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(String(id || ''))) throw new Error('会員IDが不正です');
}

function checkType_(type) {
  if (CONFIG.DATA_TYPES.indexOf(type) < 0) throw new Error('不明なデータ種別です: ' + type);
}

function fileName_(type, memberId) {
  return type + '_' + memberId + '.json';
}

function dataFolder_() {
  const props = PropertiesService.getScriptProperties();
  const id = props.getProperty('DATA_FOLDER_ID');
  if (id) {
    try { return DriveApp.getFolderById(id); } catch (e) { /* 再作成へ */ }
  }
  const it = DriveApp.getFoldersByName(CONFIG.DATA_FOLDER_NAME);
  const folder = it.hasNext() ? it.next() : DriveApp.createFolder(CONFIG.DATA_FOLDER_NAME);
  props.setProperty('DATA_FOLDER_ID', folder.getId());
  return folder;
}

function findDataFile_(name) {
  const cache = CacheService.getScriptCache();
  const fid = cache.get('fid:' + name);
  if (fid) {
    try {
      const f = DriveApp.getFileById(fid);
      if (!f.isTrashed()) return f;
    } catch (e) { /* キャッシュ無効 */ }
  }
  const it = dataFolder_().getFilesByName(name);
  if (!it.hasNext()) return null;
  const f = it.next();
  cache.put('fid:' + name, f.getId(), 21600);
  return f;
}

/* ============================================================
 *  共通: 車両・ルート検証
 * ========================================================== */
function normVehicle_(v) {
  v = v || {};
  const num = (x, min, max, label) => {
    const n = Number(x);
    if (!isFinite(n) || n < min || n > max) throw new Error('車両の' + label + 'が不正です（' + min + '〜' + max + '）');
    return n;
  };
  const width = num(v.width, 1.4, 2.6, '車幅(m)');
  const height = num(v.height, 1.5, 4.0, '全高(m)');
  const length = num(v.length, 3.0, 12.0, '全長(m)');
  const weight = num(v.weight, 0.5, 25, '総重量(t)');
  const trailer = !!v.trailer;
  const trailerLength = trailer ? num(v.trailerLength || 0, 0, 10, 'トレーラー長(m)') : 0;
  const trailerWeight = trailer ? num(v.trailerWeight || 0, 0, 10, 'トレーラー重量(t)') : 0;
  return {
    width, height, length, weight,
    drive: v.drive === '4WD' ? '4WD' : '2WD',
    trailer, trailerLength, trailerWeight,
    effWidth: round_(width + CONFIG.SAFETY_MARGIN_M.width, 2),
    effHeight: round_(height + CONFIG.SAFETY_MARGIN_M.height, 2),
    totalLength: round_(length + trailerLength, 2),
    totalWeight: round_(weight + trailerWeight, 2),
  };
}

function checkRoute_(rt) {
  if (!rt || !Array.isArray(rt.coordinates) || rt.coordinates.length < 2) throw new Error('ルート座標がありません');
  if (rt.coordinates.length > 80000) throw new Error('ルートが長すぎます');
  const coords = rt.coordinates.map(c => {
    const pt = normLngLat_(c);
    pt.push(c.length > 2 && c[2] != null ? Number(c[2]) : null);
    return pt;
  });
  return {
    coordinates: coords,
    steps: Array.isArray(rt.steps) ? rt.steps : [],
    extras: rt.extras || {},
    summary: rt.summary || {},
    ascent: Number(rt.ascent) || 0,
    descent: Number(rt.descent) || 0,
    wayPoints: Array.isArray(rt.wayPoints) ? rt.wayPoints : [0, coords.length - 1],
  };
}

function normLngLat_(c) {
  if (!Array.isArray(c) || c.length < 2) throw new Error('座標の形式が不正です');
  const lng = Number(c[0]), lat = Number(c[1]);
  if (!isFinite(lng) || !isFinite(lat) || lng < -180 || lng > 180 || lat < -90 || lat > 90) {
    throw new Error('座標の値が不正です');
  }
  return [r5_(lng), r5_(lat)];
}

/** 案内ステップの所要時間から各座標の到達時刻(秒)を算出 */
function buildTimeArr_(rt, cum) {
  const n = cum.length;
  const arr = new Float64Array(n);
  const total = cum[n - 1] || 1;
  const dur = Number(rt.summary.duration) || 0;
  for (let i = 0; i < n; i++) arr[i] = dur * cum[i] / total;
  if (!rt.steps.length) return arr;
  let t0 = 0;
  rt.steps.forEach(s => {
    if (!Array.isArray(s.wp)) return;
    const a = clamp_(s.wp[0] | 0, 0, n - 1), b = clamp_(s.wp[1] | 0, 0, n - 1);
    const d = cum[b] - cum[a], du = Number(s.duration) || 0;
    for (let i = a; i <= b; i++) arr[i] = t0 + (d > 0 ? du * (cum[i] - cum[a]) / d : 0);
    t0 += du;
  });
  return arr;
}

function indexAtTime_(tArr, sec) {
  let lo = 0, hi = tArr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (tArr[mid] < sec) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/* ============================================================
 *  共通: 幾何ユーティリティ
 * ========================================================== */
function hav_(lat1, lng1, lat2, lng2) {
  const dLat = (lat2 - lat1) * DEG, dLng = (lng2 - lng1) * DEG;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.min(1, Math.sqrt(a)));
}

function bearing_(lat1, lng1, lat2, lng2) {
  const y = Math.sin((lng2 - lng1) * DEG) * Math.cos(lat2 * DEG);
  const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) -
    Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lng2 - lng1) * DEG);
  return (Math.atan2(y, x) / DEG + 360) % 360;
}

function cumDist_(coords) {
  const n = coords.length, cum = new Float64Array(n);
  for (let i = 1; i < n; i++) cum[i] = cum[i - 1] + hav_(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
  return cum;
}

function runs_(n, pred) {
  const out = [];
  let s = -1;
  for (let i = 0; i < n; i++) {
    if (pred(i)) { if (s < 0) s = i; }
    else if (s >= 0) { out.push([s, i - 1]); s = -1; }
  }
  if (s >= 0) out.push([s, n - 1]);
  return out;
}

function mergeRuns_(runs, cum, gapM) {
  const out = [];
  runs.forEach(r => {
    const l = out[out.length - 1];
    if (l && cum[r[0]] - cum[l[1]] <= gapM) l[1] = r[1];
    else out.push([r[0], r[1]]);
  });
  return out;
}

/** Douglas-Peucker（元インデックスを返す） */
function simplifyIdx_(coords, tolM) {
  const n = coords.length;
  if (n <= 2) return n === 2 ? [0, 1] : [0];
  const X = new Float64Array(n), Y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    X[i] = coords[i][0] * 111320 * Math.cos(coords[i][1] * DEG);
    Y[i] = coords[i][1] * 110540;
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const seg = stack.pop(), a = seg[0], b = seg[1];
    const ax = X[a], ay = Y[a], dx = X[b] - ax, dy = Y[b] - ay, len2 = dx * dx + dy * dy;
    let maxD = 0, idx = -1;
    for (let i = a + 1; i < b; i++) {
      let t = len2 > 0 ? ((X[i] - ax) * dx + (Y[i] - ay) * dy) / len2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      const d = Math.hypot(X[i] - (ax + t * dx), Y[i] - (ay + t * dy));
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tolM && idx > 0) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i);
  return out;
}

function simplifyToMax_(coords, maxPts, tol0) {
  let tol = Math.max(5, tol0);
  let idx = simplifyIdx_(coords, tol);
  while (idx.length > maxPts && tol < 3000) {
    tol *= 1.6;
    idx = simplifyIdx_(coords, tol);
  }
  return { idx, tol };
}

function chunkIdx_(idx, size) {
  const out = [];
  for (let s = 0; s < idx.length - 1; s += size - 1) out.push(idx.slice(s, Math.min(idx.length, s + size)));
  return out;
}

function polyStr_(coords, ids) {
  return ids.map(i => coords[i][1].toFixed(5) + ',' + coords[i][0].toFixed(5)).join(',');
}

/** 空間グリッド（1/2000度 ≒ 55m） */
const GRID_RES = 2000;
function buildGrid_(coords) {
  const g = {};
  for (let i = 0; i < coords.length; i++) {
    const k = Math.floor(coords[i][1] * GRID_RES) + ':' + Math.floor(coords[i][0] * GRID_RES);
    (g[k] || (g[k] = [])).push(i);
  }
  return g;
}

function gridNearest_(grid, coords, lat, lng, tolM) {
  const gy = Math.floor(lat * GRID_RES), gx = Math.floor(lng * GRID_RES);
  let best = -1, bestD = tolM;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const arr = grid[(gy + dy) + ':' + (gx + dx)];
      if (!arr) continue;
      for (let q = 0; q < arr.length; q++) {
        const i = arr[q];
        const d = hav_(lat, lng, coords[i][1], coords[i][0]);
        if (d <= bestD) { bestD = d; best = i; }
      }
    }
  }
  return best;
}

/** 簡略線で最寄り区間を探し、元ジオメトリで精査 */
function nearestOnRoute_(coords, sidx, lat, lng) {
  const kx = 111320 * Math.cos(lat * DEG), ky = 110540;
  let bestSeg = 0, bestD = Infinity;
  for (let s = 0; s < sidx.length - 1; s++) {
    const a = coords[sidx[s]], b = coords[sidx[s + 1]];
    const ax = (a[0] - lng) * kx, ay = (a[1] - lat) * ky;
    const bx = (b[0] - lng) * kx, by = (b[1] - lat) * ky;
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < bestD) { bestD = d; bestSeg = s; }
  }
  const from = sidx[Math.max(0, bestSeg - 1)];
  const to = sidx[Math.min(sidx.length - 1, bestSeg + 2)];
  let bi = from, bd = Infinity;
  for (let i = from; i <= to; i++) {
    const d = hav_(lat, lng, coords[i][1], coords[i][0]);
    if (d < bd) { bd = d; bi = i; }
  }
  return { i: bi, d: Math.min(bd, bestD) };
}

/** OSM の長さ表記をメートルに変換 */
function parseLen_(s) {
  if (s == null) return null;
  s = String(s).trim().toLowerCase().replace(',', '.');
  if (!s || /^(none|default|no|unsigned|below_default)$/.test(s)) return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(m|meters?|metres?)?$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*cm$/);
  if (m) return round_(Number(m[1]) / 100, 2);
  m = s.match(/^(\d+)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?$/);
  if (m) return round_(Number(m[1]) * 0.3048 + Number(m[2] || 0) * 0.0254, 2);
  m = s.match(/^(\d+(?:\.\d+)?)\s*(ft|feet)$/);
  if (m) return round_(Number(m[1]) * 0.3048, 2);
  return null;
}

/** OSM の重量表記をトンに変換 */
function parseWeight_(s) {
  if (s == null) return null;
  s = String(s).trim().toLowerCase().replace(',', '.');
  if (!s || /^(none|default|no|unsigned)$/.test(s)) return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s*(t|tons?|tonnes?)?$/);
  if (m) return Number(m[1]);
  m = s.match(/^(\d+(?:\.\d+)?)\s*kg$/);
  if (m) return round_(Number(m[1]) / 1000, 2);
  m = s.match(/^(\d+(?:\.\d+)?)\s*(st)$/);
  if (m) return round_(Number(m[1]) * 0.907, 2);
  m = s.match(/^(\d+(?:\.\d+)?)\s*(lbs?)$/);
  if (m) return round_(Number(m[1]) * 0.000453592, 2);
  return null;
}

function hz_(type, severity, idx, extra) {
  return Object.assign({ type, severity, idx, idxEnd: idx }, extra || {});
}

/* ============================================================
 *  共通: HTTP・キャッシュ・その他
 * ========================================================== */
function overpass_(query) {
  let lastErr = 'Overpass接続エラー';
  for (let e = 0; e < CONFIG.OVERPASS_ENDPOINTS.length; e++) {
    const ep = CONFIG.OVERPASS_ENDPOINTS[e];
    for (let t = 0; t < 2; t++) {
      if (elapsed_() > CONFIG.MAX_EXEC_MS * 0.9) throw new Error('処理時間の上限に達しました');
      let res;
      try {
        res = UrlFetchApp.fetch(ep, { method: 'post', payload: { data: query }, muteHttpExceptions: true });
      } catch (err) {
        lastErr = String(err.message || err);
        break;
      }
      const code = res.getResponseCode();
      if (code === 200) {
        try {
          const json = JSON.parse(res.getContentText());
          if (json.remark && /runtime error|timed out|out of memory/i.test(json.remark)) {
            lastErr = 'Overpass処理エラー: ' + json.remark;
            break;
          }
          return json;
        } catch (err) {
          lastErr = 'Overpass応答の解析に失敗';
          break;
        }
      }
      lastErr = 'Overpass HTTP ' + code;
      if (code === 429 || code === 504) { Utilities.sleep(1500 * (t + 1)); continue; }
      break;
    }
  }
  throw new Error(lastErr);
}

function fetchJson_(url, opt) {
  const o = Object.assign({ muteHttpExceptions: true }, opt || {});
  const res = UrlFetchApp.fetch(url, o);
  const text = res.getContentText();
  let body = null;
  try { body = JSON.parse(text); } catch (e) { /* JSONでない */ }
  return { code: res.getResponseCode(), body, text };
}

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function prop_(key, required) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v && required) throw new Error('スクリプトプロパティ ' + key + ' が未設定です');
  return v;
}

function cacheGet_(k) {
  try {
    const v = CacheService.getScriptCache().get(k);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

function cachePut_(k, obj, sec) {
  try {
    const s = JSON.stringify(obj);
    if (s.length < 95000) CacheService.getScriptCache().put(k, s, sec);
  } catch (e) { /* キャッシュ失敗は無視 */ }
}

function sha_(s) {
  const bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, s, Utilities.Charset.UTF_8);
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/, '').slice(0, 32);
}

function clamp_(x, a, b) { return Math.min(b, Math.max(a, x)); }
function r5_(x) { return Math.round(Number(x) * 1e5) / 1e5; }
function round_(x, d) { const k = Math.pow(10, d || 0); return Math.round(x * k) / k; }

/* ============================================================
 *  初期設定・動作確認（エディタから手動実行）
 * ========================================================== */
function setup() {
  const f = dataFolder_();
  Logger.log('データフォルダ: ' + f.getName() + ' → ' + f.getUrl());
  const sh = membersSheet_();
  Logger.log('会員シート: ' + sh.getParent().getUrl());
  pepper_();
  Logger.log('メール送信の残り回数（本日）: ' + MailApp.getRemainingDailyQuota());
  ['GEMINI_API_KEY', 'ORS_API_KEY'].forEach(k => {
    Logger.log(k + ': ' + (prop_(k, false) ? '設定済み' : '★未設定'));
  });
  UrlFetchApp.fetch(CONFIG.GSI_ADDRESS_SEARCH + '?q=' + encodeURIComponent('東京駅'), { muteHttpExceptions: true });
  Logger.log('権限承認OK');
}

/** 共有リンク展開の確認：下のURLを自分のリンクに置き換えて実行 */
function test_expand() {
  Logger.log(JSON.stringify(expandMapUrl_({ url: 'https://maps.app.goo.gl/xxxxxxxx' })));
}

/** Gemini の接続確認（主モデルと予備モデル） */
function test_gemini() {
  const schema = { type: 'OBJECT', properties: { reply: { type: 'STRING' } }, required: ['reply'] };
  [[CONFIG.GEMINI_MODEL, CONFIG.GEMINI_THINKING_LEVEL], [CONFIG.GEMINI_MODEL_FALLBACK, null]].forEach(([m, lv]) => {
    try {
      const r = callGemini_(m, '「接続OK」と日本語で返してください。', schema, lv);
      Logger.log(m + ' : ' + JSON.stringify(r));
    } catch (e) {
      Logger.log(m + ' : 失敗 ' + e.message);
    }
  });
}

/** ORS 新ホストへの接続確認（キー登録後に実行） */
function test_ors() {
  const key = prop_('ORS_API_KEY', true);
  const d = fetchJson_(CONFIG.ORS_BASE + '/v2/directions/driving-hgv/geojson', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: key },
    payload: JSON.stringify({ coordinates: [[139.7671, 35.6812], [139.7454, 35.6586]] }),
  });
  Logger.log('ルート探索: HTTP ' + d.code + (d.code === 200 ? ' OK' : ' ' + String(d.text).slice(0, 200)));
  CacheService.getScriptCache().remove('ors_geo_base');
  CONFIG.ORS_GEOCODE_BASES.forEach(b => {
    const r = fetchJson_(b + '/search?text=' + encodeURIComponent('東京駅') + '&size=1', { headers: { Authorization: key } });
    Logger.log('ジオコーディング ' + b + ' : HTTP ' + r.code);
  });
}

const TEST_VEHICLE = { width: 2.0, height: 2.9, length: 5.4, weight: 3.5, drive: '2WD', trailer: false };

function test_geocode() {
  Logger.log(JSON.stringify(dispatch_('geocode', { q: '道の駅 富士吉田' }), null, 2));
}

function test_all() {
  const MID = 'test-member-000000000001';
  // 東京駅 → 河口湖付近
  const r = route_({ waypoints: [[139.7671, 35.6812], [138.7550, 35.4970]], vehicle: TEST_VEHICLE });
  const rt = r.routes[0];
  Logger.log('route: ' + (rt.summary.distance / 1000).toFixed(1) + 'km / ' + Math.round(rt.summary.duration / 60) + '分 / 候補' + r.routes.length + '本');

  const a = analyzeRoute_({ route: rt, vehicle: TEST_VEHICLE }, MID);
  Logger.log('analyze: ' + JSON.stringify({ counts: a.counts, ai: a.ai && a.ai.summary, osm: a.osmCoverage }));
  a.hazards.slice(0, 8).forEach(h => Logger.log(' ' + h.id + ' [' + h.severity + '] ' + h.label + ' ' + h.distFromStartKm + 'km ' + (h.title || '')));

  const s = searchAlongRoute_({ route: rt, radius: 1000, categories: ['michinoeki', 'onsen', 'fuel'] });
  Logger.log('poi: ' + s.count + '件');

  const rp = restPlan_({ route: rt, intervalMin: 60, departAt: new Date().toISOString() });
  Logger.log('rest: ' + JSON.stringify(rp.stops.map(x => x.poi ? x.poi.name : '候補なし')));

  Logger.log('save: ' + JSON.stringify(saveData_(MID, 'profile', TEST_VEHICLE)));
}

/** 会員機能の確認（仮パスワードは自分宛てメールで届きます） */
function test_register() {
  const me = Session.getActiveUser().getEmail();
  Logger.log(JSON.stringify(registerMember_({ email: me, nickname: 'テスト', agree: true })));
}
