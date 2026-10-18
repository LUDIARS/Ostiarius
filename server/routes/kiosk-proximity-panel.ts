export const PROXIMITY_PANEL_HTML = `
<section aria-labelledby="proximity-title">
  <h2 id="proximity-title">Cocoiruを使わずに施設ログイン</h2>
  <p>スマホのBluetoothをオンにして、近くで指紋・顔・PINを使って確認します。登録済みのパスキーが必要です。</p>
  <button id="proximity-start" data-requires-secure-context>スマホで確認</button>
  <button id="proximity-cancel" hidden>中断</button>
  <p id="proximity-status" role="status"></p>
  <p>FeliCaは未対応です。パスキーが使えない場合は職員へご相談ください。</p>
</section>`;

/** Uses the kiosk's existing WebAuthn serialization helpers. */
export const PROXIMITY_PANEL_SCRIPT = `
const proximityStart = document.querySelector('#proximity-start');
const proximityCancel = document.querySelector('#proximity-cancel');
const proximityStatus = document.querySelector('#proximity-status');
let proximityController;
proximityCancel.onclick = () => proximityController?.abort();
window.addEventListener('pagehide', () => proximityController?.abort());
proximityStart.onclick = async () => {
  if (proximityController) return;
  const controller = new AbortController(); proximityController = controller;
  proximityStart.disabled = true; proximityCancel.hidden = false;
  let sending = false;
  const timeout = setTimeout(() => controller.abort(), 55000);
  try {
    if (!window.isSecureContext || !navigator.credentials) throw Error('unsupported');
    const capabilityResponse = await fetch('/kiosk/proximity/capabilities', {signal:controller.signal});
    if (!capabilityResponse.ok || !(await capabilityResponse.json()).passkey) throw Error('configuration');
    const created = await createSession();
    if (controller.signal.aborted) throw Error('cancelled');
    const path = '/kiosk/proximity/' + encodeURIComponent(created.sessionId);
    const begin = await fetch(path + '/begin', {method:'POST',headers:{'content-type':'application/json'},body:'{}',signal:controller.signal});
    if (!begin.ok) throw Error('unregistered');
    const options = await begin.json();
    proximityStatus.textContent = '表示された案内でスマホを選び、スマホ側で承認してください。';
    const assertion = await navigator.credentials.get({publicKey:publicKeyOptions(options),signal:controller.signal});
    if (!assertion || controller.signal.aborted) throw Error('cancelled');
    sending = true;
    proximityCancel.hidden = true;
    clearTimeout(timeout);
    const finish = await fetch(path + '/finish', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({response:assertionPayload(assertion)}),signal:AbortSignal.timeout(15000)});
    const result = await finish.json();
    if (!finish.ok || result.ok !== true) throw Error('confirmation');
    proximityStatus.textContent = '施設ログインを確認しました。';
  } catch (error) {
    proximityStatus.textContent = sending ? '結果を確認できませんでした。二重操作せず職員に確認してください。' :
      error.message === 'configuration' ? 'このKioskでは接続設定が未対応です。職員に確認してください。' :
      error.message === 'unregistered' ? '登録済みのパスキーを確認できません。職員に確認してください。' :
      '確認を完了できませんでした。Bluetoothとパスキーを確認し、もう一度お試しください。';
  } finally {
    clearTimeout(timeout); proximityController = undefined;
    proximityStart.disabled = false; proximityCancel.hidden = true;
  }
};`;
