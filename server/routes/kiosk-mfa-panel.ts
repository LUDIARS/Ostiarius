// kiosk 画面の「現地確認 (MFA) の確認待ち」パネル。
//
// 利用者端末が施設 LAN 経由で nonce を届けると (POST /api/mfa/onsite/sessions)、kiosk は
// GET /kiosk/mfa/current で確認待ちを見つけてこのパネルを出す。本人の確定は既存の
// 顔 1:N + 生体性、またはパスキー。結果 (送信済み / Cernere の拒否コード) をここに表示する。
//
// kiosk.ts のスクリプト内の video / base64UrlToBytes / publicKeyOptions / assertionPayload を使う。
// テンプレート文字列へ差し込むので、スクリプト中でバッククォートと「${」を使わない。

export const MFA_PANEL_HTML = `
  <section id="mfa-panel" hidden>
    <h2>現地確認（多要素認証）の確認待ち</h2>
    <p>ログイン中の端末から確認の依頼が届いています。依頼した本人が確認してください。</p>
    <p id="mfa-expires"></p>
    <button id="mfa-face">顔で確認</button>
    <button id="mfa-passkey">パスキーで確認</button>
    <p id="mfa-status" role="status"></p>
  </section>`;

export const MFA_PANEL_SCRIPT = `
const mfaPanel = document.querySelector('#mfa-panel');
const mfaStatus = document.querySelector('#mfa-status');
const mfaExpires = document.querySelector('#mfa-expires');
const mfaFace = document.querySelector('#mfa-face');
const mfaPasskey = document.querySelector('#mfa-passkey');
let mfaSessionId;
let mfaStream;
const MFA_ERROR_TEXT = {
  invalid_format: '確認結果の形式が受け付けられませんでした。',
  unknown_kiosk: 'この端末はログインサーバーに登録されていません。職員に連絡してください。',
  revoked_kiosk: 'この端末の登録は失効しています。職員に連絡してください。',
  invalid_signature: '確認結果の署名を検証できませんでした。職員に連絡してください。',
  purpose_mismatch: '確認結果の用途が一致しませんでした。',
  nonce_unknown: '確認の依頼が見つかりません。ログイン画面からやり直してください。',
  nonce_used: 'この確認の依頼は使用済みです。ログイン画面からやり直してください。',
  subject_mismatch: 'ログインしている本人と、ここで確認した人が一致しません。',
  stale: '確認に時間がかかりすぎました。もう一度お試しください。',
  assurance_insufficient: 'この方法ではこのサービスの確認に足りません。顔で確認してください。',
  place_not_allowed: 'このサービスはこの施設での確認を受け付けていません。',
  mfa_revision_changed: '多要素認証の設定が変わりました。ログイン画面からやり直してください。',
  service_token_unavailable: 'ログインサーバーへ送信できません。職員に連絡してください。',
  cernere_unreachable: 'ログインサーバーに接続できません。しばらくしてからお試しください。',
  submit_unauthorized: 'この端末には送信の権限がありません。職員に連絡してください。',
  submit_failed: '確認結果を送信できませんでした。',
};

function stopMfaCamera() {
  if (mfaStream) mfaStream.getTracks().forEach((track) => track.stop());
  mfaStream = undefined;
}

function showMfaResult(mfa) {
  if (!mfa) return;
  stopMfaCamera();
  mfaFace.disabled = true; mfaPasskey.disabled = true;
  if (mfa.state === 'submitted') mfaStatus.textContent = '確認しました。ログイン中の端末で続けてください。';
  else if (mfa.state === 'expired') mfaStatus.textContent = '確認の期限が切れました。ログイン画面からやり直してください。';
  else if (mfa.state === 'rejected') mfaStatus.textContent = MFA_ERROR_TEXT[mfa.error] || '確認を受け付けられませんでした。';
}

async function pollMfa() {
  try {
    const response = await fetch('/kiosk/mfa/current');
    const current = response.ok ? (await response.json()).session : null;
    if (current && current.sessionId !== mfaSessionId) {
      mfaSessionId = current.sessionId;
      mfaFace.disabled = false; mfaPasskey.disabled = false;
      mfaStatus.textContent = '';
      mfaExpires.textContent = new Date(current.expiresAt).toLocaleTimeString() + ' まで有効です。';
      mfaPanel.hidden = false;
    } else if (!current && mfaSessionId && !mfaStream && mfaFace.disabled === false) {
      mfaPanel.hidden = true; mfaSessionId = undefined;
    }
  } catch { /* 次回のポーリングで再試行する */ }
  setTimeout(pollMfa, 2000);
}

async function confirmMfaByFace() {
  if (!mfaSessionId) return;
  const target = mfaSessionId;
  mfaFace.disabled = true; mfaPasskey.disabled = true;
  const created = await fetch('/identity/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ purpose: 'verify' }) });
  if (!created.ok) throw new Error('session_create_failed');
  const identitySessionId = (await created.json()).sessionId;
  mfaStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  video.srcObject = mfaStream; video.hidden = false;
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
  mfaStatus.textContent = 'カメラに顔を向けてください。';
  const sendFrame = async () => {
    if (!mfaStream || target !== mfaSessionId) return;
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    const frame = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .8));
    if (!frame) return;
    const form = new FormData(); form.set('identitySessionId', identitySessionId); form.set('frame', frame, 'frame.jpg');
    const response = await fetch('/kiosk/mfa/' + encodeURIComponent(target) + '/face/frame', { method: 'POST', body: form });
    const result = await response.json();
    if (result.mfa) { showMfaResult(result.mfa); return; }
    if (!response.ok || result.state === 'fallback') { stopMfaCamera(); mfaStatus.textContent = '顔で確認できませんでした。パスキーをお試しください。'; mfaPasskey.disabled = false; mfaFace.disabled = false; return; }
    if (result.challenge) mfaStatus.textContent = { blink: '一度まばたきをしてください。', turn_left: '左を向いて戻してください。', turn_right: '右を向いて戻してください。', nod: 'うなずいてください。' }[result.challenge.kind];
    else if (result.hint) mfaStatus.textContent = 'もう一度、明るい場所で正面を向いてください。';
    setTimeout(sendFrame, 200);
  };
  await sendFrame();
}

async function confirmMfaByPasskey() {
  if (!mfaSessionId) return;
  const target = mfaSessionId;
  mfaFace.disabled = true; mfaPasskey.disabled = true;
  mfaStatus.textContent = 'パスキーを確認しています。';
  const begin = await fetch('/kiosk/mfa/' + encodeURIComponent(target) + '/passkey/begin', { method: 'POST' });
  if (!begin.ok) { const failed = await begin.json().catch(() => ({})); if (failed.mfa) { showMfaResult(failed.mfa); return; } throw new Error('passkey_begin_failed'); }
  const credential = await navigator.credentials.get({ publicKey: publicKeyOptions(await begin.json()) });
  if (!credential) throw new Error('passkey_credential_missing');
  const finish = await fetch('/kiosk/mfa/' + encodeURIComponent(target) + '/passkey/finish', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response: assertionPayload(credential) }),
  });
  const result = await finish.json().catch(() => ({}));
  if (result.mfa) { showMfaResult(result.mfa); return; }
  throw new Error('passkey_finish_failed');
}

mfaFace.onclick = () => confirmMfaByFace().catch(() => { stopMfaCamera(); mfaStatus.textContent = 'カメラを利用できません。パスキーをお試しください。'; mfaFace.disabled = false; mfaPasskey.disabled = false; });
mfaPasskey.onclick = () => confirmMfaByPasskey().catch(() => { mfaStatus.textContent = 'パスキーで確認できませんでした。'; mfaFace.disabled = false; mfaPasskey.disabled = false; });
void pollMfa();
`;
