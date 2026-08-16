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
  <button disabled>顔認証（P2で提供予定）</button>
  <p id="status"></p>
  <div id="qr"></div>
</main>
<script>
const status = document.querySelector('#status');
const qr = document.querySelector('#qr');
let sessionId;
let pollTimer;

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

document.querySelector('#passkey').onclick = showPasskey;
document.querySelector('#register').onclick = showRegister;
</script>`, 200, {
      ...PROTECTED_HEADERS,
      'content-security-policy': "default-src 'self'; img-src 'self'; script-src 'unsafe-inline'; style-src 'self' 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
    });
  });
  return router;
}
