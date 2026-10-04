// secure context が要る手段の一覧 (サーバの /api/health とブラウザ側の表示判定で共有する)。
//
// パスキー (WebAuthn) とカメラ (getUserMedia) は secure context (HTTPS か localhost) でしか
// 動かない。HTTP の LAN で開いた画面ではこれらを出さず、使える手段を案内する。

export const SECURE_CONTEXT_METHODS = ['passkey', 'camera'] as const;

/** secure context でない画面で案内する手段 (表示文言)。 */
export const INSECURE_CONTEXT_GUIDANCE = 'この画面ではパスキーとカメラを使えません。会場 kiosk での顔認証、Cocoiru、または GLAB 経由のチェックインをご利用ください。';

/**
 * secure context でない画面に要る手段を隠し、案内を出すブラウザ側スクリプト。
 * `data-requires-secure-context` を付けた要素を隠し、`data-insecure-context-guidance` に案内を入れる。
 */
export function secureContextScript(): string {
  return `(() => {
  if (window.isSecureContext) return;
  document.querySelectorAll('[data-requires-secure-context]').forEach((element) => { element.hidden = true; });
  document.querySelectorAll('[data-insecure-context-guidance]').forEach((element) => {
    element.hidden = false;
    element.textContent = ${JSON.stringify(INSECURE_CONTEXT_GUIDANCE)};
  });
})();`;
}
