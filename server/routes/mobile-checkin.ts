// /mobile-checkin* — PC無し/未登録passkey来場者向けフォールバック UI + API。
//
// GET  /mobile-checkin              → 依存無しの単一 HTML ページ (Wi-Fi QR + email/password フォーム)
// GET  /mobile-checkin/wifi-qr.png  → Wi-Fi 接続用 QR (wifiSsid 未設定なら 404)
// POST /checkin/mobile-login        → { email, password } → loginAndAttest の結果を JSON で返す
//
// server/routes/checkin.ts (passkey) と同じ Hono サブルーター構成に倣う。
// ページはビルドステップ無し (このリポにフロントエンドフレームワークは無い) —
// インライン <style>/<script> のみの素の HTML。

import { Hono } from 'hono';

import { generateWifiQrPng, loginAndAttest, tokenAndAttest, type MobileCheckinDeps } from '../mobile-checkin.ts';

export interface MobileCheckinRouteDeps {
  wifiSsid: string;
  wifiPassword: string;
  /** 空ならパスワード互換フォームを表示しない。 */
  aedilisBaseUrl: string;
  /** session は低保証の互換経路なので、明示的に有効化した場合だけ mount する。 */
  sessionCheckinEnabled: boolean;
  /** password は低保証の互換経路なので、明示的に有効化した場合だけ mount する。 */
  passwordCheckinEnabled: boolean;
  loginDeps: MobileCheckinDeps;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderPage(deps: MobileCheckinRouteDeps): string {
  const hasWifi = Boolean(deps.wifiSsid);
  const hasAedilis = Boolean(deps.aedilisBaseUrl);
  const hasPasswordCheckin = hasAedilis && deps.passwordCheckinEnabled;
  const aedilisBaseUrlJson = JSON.stringify(deps.aedilisBaseUrl);

  const wifiSection = hasWifi
    ? `
    <section class="card">
      <h2>会場 Wi-Fi に接続</h2>
      <p>カメラで QR コードを読み取って会場 Wi-Fi (<strong>${escapeHtml(deps.wifiSsid)}</strong>) に接続してください。</p>
      <img class="qr" src="/mobile-checkin/wifi-qr.png" alt="Wi-Fi QR コード" width="220" height="220" />
    </section>`
    : '';

  const formSection = hasPasswordCheckin
    ? `
    <section class="card">
      <h2>チェックイン</h2>
      <p class="note">
        パスキー登録済みの PC が無い方向けの簡易チェックインです。
        Cernere アカウントのメールアドレス / パスワードでログインします
        (多要素認証 (MFA) 有効アカウントは非対応 — PC のパスキーチェックインをご利用ください)。
      </p>
      <form id="checkin-form">
        <label>メールアドレス
          <input type="email" name="email" autocomplete="username" required />
        </label>
        <label>パスワード
          <input type="password" name="password" autocomplete="current-password" required />
        </label>
        <button type="submit" id="submit-btn">チェックインする</button>
      </form>
      <div id="result" role="status"></div>
    </section>`
    : `
    <section class="card">
      <h2>チェックイン</h2>
      <p class="error">この会場ではパスワードによる簡易チェックインは利用できません。PC のパスキーチェックインをご利用ください。</p>
    </section>`;

  const script = hasPasswordCheckin
    ? `
    <script>
      const AEDILIS_BASE_URL = ${aedilisBaseUrlJson};
      const form = document.getElementById('checkin-form');
      const resultEl = document.getElementById('result');
      const submitBtn = document.getElementById('submit-btn');

      function renderProfile(profile) {
        if (!profile) return '';
        const parts = [];
        if (profile.departmentName) parts.push(profile.departmentName);
        if (profile.grade) parts.push(profile.grade + '年');
        if (profile.name) parts.push(profile.name + ' さん');
        return parts.length ? '<p class="profile">' + parts.join(' / ') + '</p>' : '';
      }

      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        submitBtn.disabled = true;
        resultEl.className = '';
        resultEl.textContent = 'ログイン中…';
        try {
          const fd = new FormData(form);
          const loginRes = await fetch('/checkin/mobile-login', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ email: fd.get('email'), password: fd.get('password') }),
          });
          const loginBody = await loginRes.json();
          if (!loginRes.ok || loginBody.error) {
            resultEl.className = 'error';
            resultEl.textContent = loginBody.error || 'ログインに失敗しました。';
            return;
          }

          resultEl.textContent = 'チェックイン中…';
          const verifyRes = await fetch(AEDILIS_BASE_URL + '/api/checkin/verify', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: 'Bearer ' + loginBody.accessToken,
            },
            body: JSON.stringify({ attestation: loginBody.attestation }),
          });
          const verifyBody = await verifyRes.json();
          if (!verifyRes.ok || verifyBody.error) {
            resultEl.className = 'error';
            resultEl.textContent = 'チェックインに失敗しました: ' + (verifyBody.error || verifyRes.status);
            return;
          }

          resultEl.className = 'success';
          resultEl.innerHTML = 'チェックインしました。' + renderProfile(loginBody.profile);
          form.reset();
        } catch (e) {
          resultEl.className = 'error';
          resultEl.textContent = '通信エラーが発生しました。しばらくしてから再度お試しください。';
        } finally {
          submitBtn.disabled = false;
        }
      });
    </script>`
    : '';

  return `<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>会場チェックイン</title>
<style>
  body { font-family: system-ui, sans-serif; margin: 0; padding: 1.5rem; background: #f5f5f7; color: #1a1a1a; }
  h1 { font-size: 1.25rem; }
  .card { background: #fff; border-radius: 12px; padding: 1.25rem; margin-bottom: 1rem; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
  .qr { display: block; margin: 0.75rem auto; }
  form { display: flex; flex-direction: column; gap: 0.75rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; font-size: 0.9rem; }
  input { padding: 0.5rem; border: 1px solid #ccc; border-radius: 8px; font-size: 1rem; }
  button { padding: 0.6rem; border: none; border-radius: 8px; background: #2563eb; color: #fff; font-size: 1rem; }
  button:disabled { opacity: 0.6; }
  .note { font-size: 0.85rem; color: #555; }
  #result.error, .error { color: #b91c1c; }
  #result.success, .success { color: #15803d; }
  .profile { font-weight: 600; }
</style>
</head>
<body>
  <h1>会場チェックイン</h1>
  ${wifiSection}
  ${formSection}
  ${script}
</body>
</html>`;
}

export function makeMobileCheckinRouter(deps: MobileCheckinRouteDeps): Hono {
  const r = new Hono();

  r.get('/mobile-checkin', (c) => c.html(renderPage(deps)));

  r.get('/mobile-checkin/wifi-qr.png', async (c) => {
    if (!deps.wifiSsid) {
      return c.json({ error: 'not_found', code: 'wifi 未構成' }, 404);
    }
    const png = await generateWifiQrPng(deps.wifiSsid, deps.wifiPassword);
    return c.body(new Uint8Array(png), 200, { 'content-type': 'image/png' });
  });

  if (deps.passwordCheckinEnabled) {
    r.post('/checkin/mobile-login', async (c) => {
      const body = (await c.req.json().catch(() => null)) as
        | { email?: unknown; password?: unknown }
        | null;
      const email = body?.email;
      const password = body?.password;
      if (typeof email !== 'string' || !email || typeof password !== 'string' || !password) {
        return c.json({ error: 'メールアドレスとパスワードを入力してください。' }, 400);
      }

      const result = await loginAndAttest(deps.loginDeps, email, password);
      if ('error' in result) {
        return c.json({ error: result.error }, 401);
      }
      return c.json(result);
    });
  }

  if (deps.sessionCheckinEnabled) {
    // 既に Cernere ログイン済み (PWA が accessToken を保持) の自動チェックイン。
    // passkey/パスワードを再入力させず、 Bearer or { accessToken } を検証して attestation を返す。
    r.post('/checkin/session', async (c) => {
      const auth = c.req.header('authorization') ?? '';
      let token = /^bearer\s+/i.test(auth) ? auth.replace(/^bearer\s+/i, '').trim() : '';
      if (!token) {
        const body = (await c.req.json().catch(() => null)) as { accessToken?: unknown } | null;
        if (typeof body?.accessToken === 'string') token = body.accessToken.trim();
      }
      if (!token) {
        return c.json({ error: 'accessToken is required' }, 400);
      }

      const result = await tokenAndAttest(deps.loginDeps, token);
      if ('error' in result) {
        return c.json({ error: result.error }, 401);
      }
      // PWA は既に token を保持している。Bearer token を反射してログやブラウザの
      // 開発者ツールに余分に残す必要はない。
      return c.json({ attestation: result.attestation, profile: result.profile });
    });
  }

  return r;
}
