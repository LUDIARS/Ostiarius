import { Hono } from 'hono';
import { toString as qrToString } from 'qrcode';

import type { IdentitySessionStore } from '../identity-session-store.ts';
import type { KioskAuthorization } from '../kiosk-authorization.ts';

const PROTECTED_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
};

export function makeKioskRouter(args: {
  authorization: KioskAuthorization;
  pwaOrigin: string;
  sessions: IdentitySessionStore;
}): Hono {
  const router = new Hono();
  router.get('/kiosk/passkey-qr/:sessionId', async (c) => {
    if (!args.authorization.isAuthorized(c)) return c.json({ error: 'kiosk_unauthorized' }, 401);
    const sessionId = c.req.param('sessionId');
    if (!args.sessions.get(sessionId)) return c.json({ error: 'session_expired' }, 410);
    const url = `${args.pwaOrigin}/checkin?nonce=${encodeURIComponent(sessionId)}`;
    return c.body(await qrToString(url, { type: 'svg' }), 200, {
      ...PROTECTED_HEADERS,
      'content-type': 'image/svg+xml',
    });
  });
  router.get('/kiosk', (c) => {
    const hasBootstrapToken = Boolean(c.req.header('x-ostiarius-kiosk'));
    if (hasBootstrapToken) {
      if (!args.authorization.establishBrowserSession(c)) {
        return c.json({ error: 'kiosk_unauthorized' }, 401, PROTECTED_HEADERS);
      }
    } else if (!args.authorization.isAuthorized(c)) {
      return c.json({ error: 'kiosk_unauthorized' }, 401, PROTECTED_HEADERS);
    }

    return c.html(`<!doctype html>
<meta charset="utf-8">
<title>本人確認 kiosk</title>
<main>
  <h1>本人確認</h1>
  <button id="passkey">パスキーで出席</button>
  <button id="register">端末を登録</button>
  <button id="face">顔認証</button>
  <button id="enroll">顔を登録（職員）</button>
  <p id="status"></p>
<div id="qr"></div>
  <video id="camera" autoplay muted playsinline hidden></video>
  <section id="enroll-panel" hidden>
    <h2>顔テンプレート登録</h2>
    <p id="enroll-status"></p>
    <label>生徒認証コード <input id="student-code" autocomplete="one-time-code"></label>
    <button id="staff-auth">職員パスキーで認証</button>
    <button id="start-enroll" disabled>同意内容を確認</button>
    <div id="consent" hidden>
      <p id="consent-text"></p>
      <label><input id="consent-accepted" type="checkbox"> 内容を理解し、同意します</label>
      <button id="accept-consent" disabled>撮影を開始</button>
    </div>
    <p id="shot-progress"></p>
    <button id="capture-shot" disabled>このポーズを撮影</button>
    <button id="cancel-enroll" disabled>中断</button>
  </section>
</main>
<script>
const status = document.querySelector('#status');
const qr = document.querySelector('#qr');
const enrollPanel = document.querySelector('#enroll-panel');
const enrollStatus = document.querySelector('#enroll-status');
const studentCode = document.querySelector('#student-code');
const staffAuth = document.querySelector('#staff-auth');
const startEnroll = document.querySelector('#start-enroll');
const consent = document.querySelector('#consent');
const consentText = document.querySelector('#consent-text');
const consentAccepted = document.querySelector('#consent-accepted');
const acceptConsent = document.querySelector('#accept-consent');
const shotProgress = document.querySelector('#shot-progress');
const captureShot = document.querySelector('#capture-shot');
const cancelEnroll = document.querySelector('#cancel-enroll');
const video = document.querySelector('#camera');
let sessionId;
let pollTimer;
let staffSession;
let enrollId;
let enrollmentStream;
let shotsRequired = 6;
const enrollmentPoses = ['front', 'left', 'right', 'up', 'glasses', 'noglasses'];

function stopPolling() {
  if (pollTimer) clearTimeout(pollTimer);
  pollTimer = undefined;
}

async function createSession() {
  const response = await fetch('/identity/session', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ purpose: 'verify' }),
  });
  if (!response.ok) throw new Error('session_create_failed');
  return response.json();
}

async function pollSession() {
  try {
    const response = await fetch('/identity/session/' + encodeURIComponent(sessionId));
    if (!response.ok) {
      status.textContent = 'セッションが終了しました。';
      stopPolling();
      return;
    }
    if ((await response.json()).state === 'issued') {
      status.textContent = '出席を確認しました。';
      stopPolling();
      return;
    }
    pollTimer = setTimeout(pollSession, 1000);
  } catch {
    status.textContent = '確認状態を取得できません。再試行しています。';
    pollTimer = setTimeout(pollSession, 1000);
  }
}

async function showPasskey() {
  stopPolling();
  try {
    const session = await createSession();
    sessionId = session.sessionId;
    if (!sessionId) throw new Error('session_id_missing');
    const image = document.createElement('img');
    image.alt = '出席用QR';
    image.src = '/kiosk/passkey-qr/' + encodeURIComponent(sessionId);
    qr.replaceChildren(image);
    status.textContent = '生徒端末でQRを読み取ってください。';
    pollTimer = setTimeout(pollSession, 1000);
  } catch {
    status.textContent = 'セッションを開始できません。';
  }
}

async function showRegister() {
  stopPolling();
  try {
    const response = await fetch('/identity/passkey/register-hint');
    if (!response.ok) throw new Error('register_hint_failed');
    const hint = await response.json();
    qr.innerHTML = hint.qrSvg;
    status.textContent = '生徒端末でパスキーを登録してください。';
  } catch {
    status.textContent = '登録用QRを取得できません。';
  }
}

async function showFace() {
  stopPolling();
  try {
    const session = await createSession(); sessionId = session.sessionId;
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
    video.srcObject = stream; video.hidden = false;
    const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
    status.textContent = 'カメラに顔を向けてください。';
    const sendFrame = async () => {
      if (!sessionId || !video.srcObject) return;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const frame = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .8));
      if (!frame) return;
      const form = new FormData(); form.set('sessionId', sessionId); form.set('frame', frame, 'frame.jpg');
      const response = await fetch('/identity/face/frame', { method: 'POST', body: form });
      const result = await response.json();
      if (result.state === 'issued') { status.textContent = '出席を確認しました。'; stream.getTracks().forEach((track) => track.stop()); return; }
      if (result.state === 'fallback') { status.textContent = 'パスキーまたは職員にお知らせください。'; stream.getTracks().forEach((track) => track.stop()); return; }
      if (result.challenge) status.textContent = { blink: '一度まばたきをしてください。', turn_left: '左を向いて戻してください。', turn_right: '右を向いて戻してください。', nod: 'うなずいてください。' }[result.challenge.kind];
      else if (result.hint) status.textContent = 'もう一度、明るい場所で正面を向いてください。';
      setTimeout(sendFrame, result.state === 'idle' ? 1000 : 200);
    };
    await sendFrame();
  } catch { status.textContent = 'カメラを利用できません。パスキーをご利用ください。'; }
}

function base64UrlToBytes(value) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}

function bytesToBase64Url(value) {
  return btoa(String.fromCharCode(...new Uint8Array(value))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function publicKeyOptions(options) {
  return {
    ...options,
    challenge: base64UrlToBytes(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((credential) => ({ ...credential, id: base64UrlToBytes(credential.id) })),
  };
}

function assertionPayload(credential) {
  const response = credential.response;
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      signature: bytesToBase64Url(response.signature),
      userHandle: response.userHandle ? bytesToBase64Url(response.userHandle) : undefined,
    },
    clientExtensionResults: credential.getClientExtensionResults(),
  };
}

async function authenticateStaff() {
  enrollStatus.textContent = '職員パスキーを確認しています。';
  const begin = await fetch('/identity/staff/begin', { method: 'POST' });
  if (!begin.ok) throw new Error('staff_begin_failed');
  const credential = await navigator.credentials.get({ publicKey: publicKeyOptions(await begin.json()) });
  if (!credential) throw new Error('staff_credential_missing');
  const finish = await fetch('/identity/staff/finish', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ response: assertionPayload(credential) }),
  });
  if (!finish.ok) throw new Error('staff_finish_failed');
  staffSession = (await finish.json()).staffSession;
  if (!staffSession) throw new Error('staff_session_missing');
  staffAuth.disabled = true;
  startEnroll.disabled = false;
  enrollStatus.textContent = '職員を確認しました。生徒認証コードを入力してください。';
}

async function startEnrollment() {
  if (!staffSession || !studentCode.value.trim()) throw new Error('student_code_missing');
  const response = await fetch('/identity/enroll/start', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ostiarius-staff': staffSession },
    body: JSON.stringify({ studentAuthCode: studentCode.value.trim() }),
  });
  if (!response.ok) throw new Error('enroll_start_failed');
  const result = await response.json();
  enrollId = result.enrollId; shotsRequired = result.shots.required;
  consentText.textContent = result.consent.text;
  consent.hidden = false; startEnroll.disabled = true;
  enrollStatus.textContent = '生徒本人に同意内容を確認してもらってください。';
}

async function beginCapture() {
  if (!enrollId || !consentAccepted.checked) throw new Error('consent_required');
  const response = await fetch('/identity/enroll/consent', {
    method: 'POST', headers: { 'content-type': 'application/json', 'x-ostiarius-staff': staffSession }, body: JSON.stringify({ enrollId, accepted: true }),
  });
  if (!response.ok) throw new Error('consent_failed');
  enrollmentStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: false });
  video.srcObject = enrollmentStream; video.hidden = false;
  captureShot.disabled = false; cancelEnroll.disabled = false; acceptConsent.disabled = true;
  shotProgress.textContent = '正面を向いて、撮影してください（0/' + shotsRequired + '）。';
}

async function captureEnrollmentShot() {
  if (!enrollId || !staffSession || !video.videoWidth) return;
  captureShot.disabled = true;
  const canvas = document.createElement('canvas'); canvas.width = 640; canvas.height = 480;
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  const frame = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', .8));
  if (!frame) throw new Error('frame_failed');
  const form = new FormData(); form.set('enrollId', enrollId); form.set('frame', frame, 'frame.jpg');
  form.set('pose', enrollmentPoses[Math.min(Number(shotProgress.dataset.done || 0), enrollmentPoses.length - 1)]);
  const response = await fetch('/identity/enroll/frame', { method: 'POST', headers: { 'x-ostiarius-staff': staffSession }, body: form });
  if (!response.ok) throw new Error('enroll_frame_failed');
  const result = await response.json(); shotProgress.dataset.done = String(result.shotsDone);
  if (!result.accepted) { shotProgress.textContent = '品質を確認できません。明るい場所で静止して、もう一度撮影してください。'; captureShot.disabled = false; return; }
  if (result.shotsDone < result.shotsRequired) {
    shotProgress.textContent = enrollmentPoses[result.shotsDone] + ' のポーズを撮影してください（' + result.shotsDone + '/' + result.shotsRequired + '）。';
    captureShot.disabled = false; return;
  }
  const commit = await fetch('/identity/enroll/commit', { method: 'POST', headers: { 'content-type': 'application/json', 'x-ostiarius-staff': staffSession }, body: JSON.stringify({ enrollId }) });
  if (!commit.ok) throw new Error('enroll_commit_failed');
  enrollmentStream.getTracks().forEach((track) => track.stop()); enrollmentStream = undefined;
  captureShot.disabled = true; cancelEnroll.disabled = true; enrollId = undefined;
  shotProgress.textContent = '登録を完了しました。';
}

async function cancelEnrollment() {
  if (enrollId) await fetch('/identity/enroll/' + encodeURIComponent(enrollId), { method: 'DELETE', headers: { 'x-ostiarius-staff': staffSession } });
  if (enrollmentStream) enrollmentStream.getTracks().forEach((track) => track.stop());
  enrollmentStream = undefined; enrollId = undefined; captureShot.disabled = true; cancelEnroll.disabled = true;
  shotProgress.textContent = '登録を中断しました。';
}

document.querySelector('#passkey').onclick = showPasskey;
document.querySelector('#register').onclick = showRegister;
document.querySelector('#face').onclick = showFace;
document.querySelector('#enroll').onclick = () => { enrollPanel.hidden = false; qr.replaceChildren(); stopPolling(); };
staffAuth.onclick = () => authenticateStaff().catch(() => { enrollStatus.textContent = '職員認証に失敗しました。'; });
startEnroll.onclick = () => startEnrollment().catch(() => { enrollStatus.textContent = '生徒認証コードを確認できません。'; });
consentAccepted.onchange = () => { acceptConsent.disabled = !consentAccepted.checked; };
acceptConsent.onclick = () => beginCapture().catch(() => { enrollStatus.textContent = '同意またはカメラを確認できません。'; });
captureShot.onclick = () => captureEnrollmentShot().catch(() => { captureShot.disabled = false; shotProgress.textContent = '撮影に失敗しました。もう一度お試しください。'; });
cancelEnroll.onclick = () => { void cancelEnrollment(); };
</script>`, 200, {
      ...PROTECTED_HEADERS,
      'content-security-policy': "default-src 'self'; img-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    });
  });
  return router;
}
