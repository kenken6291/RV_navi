/* ============================================================
 *  RV_navi 設定ファイル  config.js
 *  GAS をウェブアプリとしてデプロイした URL（末尾が /exec）を貼り付けてください。
 *  app.js や auth.js を差し替えても、このファイルを残せば設定は消えません。
 * ============================================================ */
window.RV_CONFIG = {
  GAS_URL: 'https://script.google.com/macros/s/AKfycbwC0JRLwjPg5eFxn5cpkQxmOhDBa_XAF0ustWcHZEAn1shhRfG7bWLBH34zZFDx0G-QHg/exec',

  // 既定のGeminiモデル（利用者が画面で選ばなかった時に使う）
  // 空文字 '' = 自動（汎用の最新モデル）
  GEMINI_MODEL: '',

  // 画面の「AIモデル」選択肢（value がAPIのモデルID）
  // 指定モデルが使えない（廃止・未公開・名前違い・混雑）場合は
  // GAS側で汎用の最新モデルへ自動で切り替わる
  GEMINI_MODEL_OPTIONS: [
    { value: '',                  label: '自動モード（汎用の最新）' },
    { value: 'gemini-4-hydrogen', label: '4 Hydrogen（日々の暮らしをサポート）' },
    { value: 'gemini-4-neon',     label: '4 Neon（Deeper analysis）' },
    { value: 'gemini-4-carbon',   label: '4 Carbon（Code & complex work）' },
    { value: 'gemini-4-argon',    label: '4 Argon' },
    { value: 'gemini-3.8-flash',  label: '3.8 Flash' },
    { value: 'gemini-3.5-flash',  label: '3.5 Flash' },
  ],
};
