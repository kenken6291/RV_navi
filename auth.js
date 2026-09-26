/* ============================================================
 *  RV_navi  会員認証・API通信  auth.js v1.2.0
 *  - 会員登録（メールに仮パスワード送信）
 *  - ログイン／ログアウト（5回失敗で15分ロックはサーバー側）
 *  - 初回ログイン時のパスワード変更（必須）
 *  - パスワードを忘れた場合の仮パスワード再発行
 *  - パスワードの表示／非表示
 *  - ニックネーム・パスワードの変更
 * ============================================================ */
'use strict';

window.RV_FILES = window.RV_FILES || {};
window.RV_FILES.auth = '1.2.0';

const AUTH_LS = { token: 'rvnavi_token', member: 'rvnavi_member' };

const Auth = {
  token: null,
  member: null,
  forced: false,        // 仮パスワード変更中（閉じられない）
  lastPassword: '',     // 仮パスワードでログインした直後の自動入力用
  onLogin: null,        // ログイン完了時に app.js が呼ばれる
  onLogout: null,
};

/* ============================================================
 *  API 通信（全機能共通）
 * ========================================================== */
function gasUrl() {
  return (window.RV_CONFIG && window.RV_CONFIG.GAS_URL) || '';
}

function apiReady() {
  return /^https:\/\/script\.google\.com\/(macros|a\/macros\/[^/]+)\/s\/[\w-]+\/exec$/.test(gasUrl());
}

async function api(action, params = {}) {
  if (!apiReady()) throw new Error('config.js の GAS_URL にウェブアプリのURLを設定してください');
  // 危険度解析は最大5分、その他は1分で打ち切る
  const limitMs = action === 'analyzeRoute' ? 330000 : (action === 'searchAlongRoute' || action === 'restPlan') ? 300000 : 60000;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), limitMs);
  let res;
  try {
    res = await fetch(gasUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ action, token: Auth.token, params }),
      signal: ctl.signal,
    });
  } catch (e) {
    throw new Error(e.name === 'AbortError'
      ? 'サーバーの応答がありません。時間をおいてもう一度お試しください'
      : 'サーバーに接続できませんでした。電波状況を確認してください');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`サーバーエラーです（HTTP ${res.status}）`);
  const j = await res.json().catch(() => null);
  if (!j) throw new Error('サーバーの応答を読み取れませんでした');
  if (!j.ok) {
    if (j.code === 'AUTH_REQUIRED') authExpired();
    else if (j.code === 'MUST_CHANGE') openAuth('change', true);
    const err = new Error(j.error || '処理に失敗しました');
    err.code = j.code || null;
    throw err;
  }
  return j.data;
}

/* ============================================================
 *  セッション
 * ========================================================== */
function authLsGet(k) {
  try { const v = localStorage.getItem(k); return v == null ? null : JSON.parse(v); } catch (e) { return null; }
}
function authLsSet(k, v) {
  try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 無視 */ }
}

function setSession(token, member) {
  if (token !== undefined) {
    Auth.token = token;
    authLsSet(AUTH_LS.token, token);
  }
  Auth.member = member || null;
  authLsSet(AUTH_LS.member, member ? { nickname: member.nickname } : null);
  renderAccountButton();
}

function clearSession() {
  Auth.token = null;
  Auth.member = null;
  authLsSet(AUTH_LS.token, null);
  authLsSet(AUTH_LS.member, null);
  renderAccountButton();
}

function isLoggedIn() {
  return !!(Auth.token && Auth.member && !Auth.member.mustChange);
}

/** ログインが必要な操作の前に呼ぶ */
function requireLogin() {
  if (isLoggedIn()) return true;
  if (Auth.member && Auth.member.mustChange) openAuth('change', true);
  else openAuth('login');
  return false;
}

function authExpired() {
  const had = !!Auth.token;
  clearSession();
  if (had) {
    if (typeof toast === 'function') toast('ログインの有効期限が切れました。もう一度ログインしてください', 'err');
    if (typeof Auth.onLogout === 'function') Auth.onLogout({ expired: true });
  }
  openAuth('login');
}

/* ============================================================
 *  画面
 * ========================================================== */
const AUTH_MODES = {
  login: {
    title: 'ログイン',
    lead: 'ルート探索などの機能は、無料の会員登録をしてからご利用ください。',
  },
  register: {
    title: '会員登録（無料）',
    lead: '入力したメールアドレスに仮パスワードを送ります。',
  },
  forgot: {
    title: 'パスワードの再発行',
    lead: '登録したメールアドレスに、新しい仮パスワードを送ります。',
  },
  change: {
    title: 'パスワードの変更',
    lead: '',
  },
  account: {
    title: 'アカウント',
    lead: '',
  },
};

function $a(id) { return document.getElementById(id); }

function openAuth(mode, forced) {
  const dlg = $a('dlg-auth');
  Auth.forced = mode === 'change' && !!forced;
  showAuthMode(mode);
  if (!dlg.open) dlg.showModal();
}

function closeAuth() {
  if (Auth.forced) return;
  const dlg = $a('dlg-auth');
  if (dlg.open) dlg.close();
}

function showAuthMode(mode) {
  const m = AUTH_MODES[mode];
  document.querySelectorAll('#dlg-auth .auth-form').forEach(f => { f.hidden = f.dataset.mode !== mode; });
  $a('auth-title').textContent = mode === 'change' && Auth.forced ? '新しいパスワードの設定' : m.title;

  let lead = m.lead;
  if (mode === 'change') {
    lead = Auth.forced
      ? '仮パスワードでログインしました。続けて、ご自身で決めた新しいパスワードを設定してください。'
      : '今のパスワードと、新しいパスワードを入力してください。';
    $a('chg-current-label').textContent = Auth.forced ? '仮パスワード（メールに記載）' : '今のパスワード';
    const cur = $a('chg-current');
    cur.value = Auth.forced ? Auth.lastPassword : '';
    $a('chg-new').value = '';
    $a('chg-confirm').value = '';
  }
  if (mode === 'account' && Auth.member) {
    $a('acct-email').textContent = Auth.member.email || '';
    $a('acct-nickname').value = Auth.member.nickname || '';
  }
  $a('auth-lead').textContent = lead;
  $a('auth-lead').hidden = !lead;

  $a('auth-close').hidden = Auth.forced;
  $a('auth-forced-logout').hidden = !Auth.forced;
  authMsg('');

  // パスワード欄はすべて伏せ字に戻す
  document.querySelectorAll('#dlg-auth .pw-toggle').forEach(b => setPwVisible(b, false));

  const first = document.querySelector(`#dlg-auth .auth-form[data-mode="${mode}"] input:not([type="checkbox"])`);
  if (first) setTimeout(() => {
    const target = mode === 'change' && Auth.forced && $a('chg-current').value ? $a('chg-new') : first;
    target.focus();
  }, 50);
}

function authMsg(text, type) {
  const el = $a('auth-msg');
  el.textContent = text || '';
  el.hidden = !text;
  el.className = 'auth-msg ' + (type === 'ok' ? 'is-ok' : 'is-err');
}

function setAuthBusy(form, busy) {
  form.querySelectorAll('button, input').forEach(el => { el.disabled = busy; });
  const sub = form.querySelector('[type="submit"]');
  if (sub) {
    if (busy) { sub.dataset.label = sub.textContent; sub.textContent = '通信しています…'; }
    else if (sub.dataset.label) sub.textContent = sub.dataset.label;
  }
}

function setPwVisible(btn, on) {
  const input = document.getElementById(btn.dataset.target);
  if (!input) return;
  input.type = on ? 'text' : 'password';
  btn.textContent = on ? '隠す' : '表示';
  btn.setAttribute('aria-pressed', String(on));
  btn.setAttribute('aria-label', on ? 'パスワードを隠す' : 'パスワードを表示');
}

function renderAccountButton() {
  const on = !!(Auth.token && Auth.member);
  const b = $a('btn-account');
  if (b) {
    b.classList.toggle('is-in', on);
    b.setAttribute('aria-label', on ? `アカウント（${Auth.member.nickname}さん）` : 'ログイン・会員登録');
    b.title = on ? `${Auth.member.nickname}さん` : 'ログイン';
  }
  // パネル上部のログイン状態表示
  const name = $a('acct-bar-name');
  if (name) {
    name.textContent = on ? `${Auth.member.nickname}さん` : 'ログインしていません';
    name.classList.toggle('is-in', on);
    name.setAttribute('aria-label', on ? `${Auth.member.nickname}さんのアカウント設定` : 'ログイン');
    $a('acct-bar-login').hidden = on;
    $a('acct-bar-logout').hidden = !on;
  }
}

function confirmLogout() {
  if (window.confirm('ログアウトしますか？\nこの端末に保存した車両設定とお気に入りは消えますが、ログインし直せば元に戻ります。')) {
    doLogout();
  }
}

/* ============================================================
 *  各フォームの処理
 * ========================================================== */
async function submitLogin(e) {
  e.preventDefault();
  const f = e.target;
  const email = f.elements.namedItem('email').value.trim();
  const password = f.elements.namedItem('password').value;
  if (!email || !password) { authMsg('メールアドレスとパスワードを入力してください'); return; }
  setAuthBusy(f, true);
  try {
    const d = await api('login', { email, password });
    setSession(d.token, d.member);
    f.reset();
    if (d.member.mustChange) {
      Auth.lastPassword = password;
      openAuth('change', true);
      return;
    }
    Auth.lastPassword = '';
    closeAuth();
    if (typeof toast === 'function') toast(`${d.member.nickname}さん、ようこそ`);
    if (typeof Auth.onLogin === 'function') Auth.onLogin();
  } catch (err) {
    authMsg(err.message);
  } finally {
    setAuthBusy(f, false);
  }
}

async function submitRegister(e) {
  e.preventDefault();
  const f = e.target;
  const email = f.elements.namedItem('email').value.trim();
  const nickname = f.elements.namedItem('nickname').value.trim();
  const agree = f.elements.namedItem('agree').checked;
  if (!email || !nickname) { authMsg('メールアドレスとニックネームを入力してください'); return; }
  if (!agree) { authMsg('利用上の注意を確認し、「同意します」にチェックしてください'); return; }
  setAuthBusy(f, true);
  try {
    const d = await api('register', { email, nickname, agree: true });
    f.reset();
    showAuthMode('login');
    $a('login-email').value = email;
    authMsg(d.message + '（届かない場合は迷惑メールフォルダも確認してください）', 'ok');
    setTimeout(() => $a('login-password').focus(), 60);
  } catch (err) {
    authMsg(err.message);
  } finally {
    setAuthBusy(f, false);
  }
}

async function submitForgot(e) {
  e.preventDefault();
  const f = e.target;
  const email = f.elements.namedItem('email').value.trim();
  if (!email) { authMsg('メールアドレスを入力してください'); return; }
  setAuthBusy(f, true);
  try {
    const d = await api('forgotPassword', { email });
    f.reset();
    showAuthMode('login');
    $a('login-email').value = email;
    authMsg(d.message, 'ok');
  } catch (err) {
    authMsg(err.message);
  } finally {
    setAuthBusy(f, false);
  }
}

async function submitChange(e) {
  e.preventDefault();
  const f = e.target;
  const currentPassword = $a('chg-current').value;
  const newPassword = $a('chg-new').value;
  const confirm = $a('chg-confirm').value;
  if (!currentPassword) { authMsg(Auth.forced ? '仮パスワードを入力してください' : '今のパスワードを入力してください'); return; }
  if (newPassword.length < 8 || !/[A-Za-z]/.test(newPassword) || !/\d/.test(newPassword)) {
    authMsg('新しいパスワードは8文字以上で、英字と数字を両方含めてください');
    return;
  }
  if (newPassword !== confirm) { authMsg('確認用のパスワードが一致しません'); return; }
  const wasForced = Auth.forced;
  setAuthBusy(f, true);
  try {
    const d = await api('changePassword', { currentPassword, newPassword });
    setSession(undefined, d.member);
    Auth.forced = false;
    Auth.lastPassword = '';
    f.reset();
    closeAuth();
    if (typeof toast === 'function') toast(wasForced ? `パスワードを設定しました。${d.member.nickname}さん、ようこそ` : 'パスワードを変更しました');
    if (wasForced && typeof Auth.onLogin === 'function') Auth.onLogin();
  } catch (err) {
    authMsg(err.message);
  } finally {
    setAuthBusy(f, false);
  }
}

async function submitNickname(e) {
  e.preventDefault();
  const f = e.target;
  const nickname = $a('acct-nickname').value.trim();
  if (!nickname) { authMsg('ニックネームを入力してください'); return; }
  setAuthBusy(f, true);
  try {
    const d = await api('updateNickname', { nickname });
    setSession(undefined, d.member);
    authMsg(d.message, 'ok');
  } catch (err) {
    authMsg(err.message);
  } finally {
    setAuthBusy(f, false);
  }
}

async function doLogout() {
  try { if (Auth.token) await api('logout'); } catch (e) { /* 期限切れでもログアウト扱い */ }
  clearSession();
  Auth.forced = false;
  Auth.lastPassword = '';
  const dlg = $a('dlg-auth');
  if (dlg.open) dlg.close();
  if (typeof toast === 'function') toast('ログアウトしました');
  if (typeof Auth.onLogout === 'function') Auth.onLogout({ expired: false });
}

/* ============================================================
 *  初期化（app.js から呼ぶ）
 * ========================================================== */
let authBound = false;
function bindAuthUI() {
  if (authBound) return;
  authBound = true;
  $a('form-login').addEventListener('submit', submitLogin);
  $a('form-register').addEventListener('submit', submitRegister);
  $a('form-forgot').addEventListener('submit', submitForgot);
  $a('form-change').addEventListener('submit', submitChange);
  $a('form-account').addEventListener('submit', submitNickname);

  document.querySelectorAll('#dlg-auth [data-goto]').forEach(b => {
    b.onclick = () => showAuthMode(b.dataset.goto);
  });
  document.querySelectorAll('#dlg-auth .pw-toggle').forEach(b => {
    b.onclick = () => setPwVisible(b, b.getAttribute('aria-pressed') !== 'true');
  });

  $a('auth-close').onclick = closeAuth;
  $a('auth-forced-logout').onclick = doLogout;
  $a('acct-logout').onclick = confirmLogout;
  $a('acct-bar-logout').onclick = confirmLogout;
  $a('acct-bar-login').onclick = () => openAuth('login');
  $a('acct-change-pw').onclick = () => { Auth.forced = false; showAuthMode('change'); };

  // Esc キーで閉じるのを、仮パスワード変更中だけ止める
  $a('dlg-auth').addEventListener('cancel', e => { if (Auth.forced) e.preventDefault(); });

  const openAccount = () => {
    if (Auth.token && Auth.member) {
      if (Auth.member.mustChange) openAuth('change', true);
      else openAuth('account');
    } else {
      openAuth('login');
    }
  };
  $a('btn-account').onclick = openAccount;
  $a('acct-bar-name').onclick = openAccount;
}

/** 起動時：保存済みトークンでログイン状態を確認 */
async function initAuth(handlers) {
  Auth.onLogin = handlers.onLogin;
  Auth.onLogout = handlers.onLogout;
  bindAuthUI();

  Auth.token = authLsGet(AUTH_LS.token);
  const cached = authLsGet(AUTH_LS.member);
  if (Auth.token && cached) Auth.member = { nickname: cached.nickname, mustChange: false };
  renderAccountButton();

  if (!apiReady()) return;
  if (!Auth.token) { openAuth('login'); return; }

  try {
    const d = await api('me');
    setSession(undefined, d.member);
    if (d.member.mustChange) { openAuth('change', true); return; }
    if (typeof Auth.onLogin === 'function') Auth.onLogin();
  } catch (e) {
    // AUTH_REQUIRED のときは api() 内でログイン画面を開く
    if (e.code !== 'AUTH_REQUIRED' && e.code !== 'MUST_CHANGE' && typeof toast === 'function') toast(e.message, 'err');
  }
}

// app.js の読み込みに失敗しても、ログイン画面だけは開けるようにする
document.addEventListener('DOMContentLoaded', () => {
  try { bindAuthUI(); renderAccountButton(); } catch (e) { console.error(e); }
});
