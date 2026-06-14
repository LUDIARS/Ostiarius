// gateway 公開鍵の Aedilis 自己登録 (#167)。
//
// CONTRACTS.md §4: `POST {AEDILIS_BASE_URL}/api/admin/gateways`
//   (requireAdmin Bearer) body `{ lanId, publicKeyPem, facilityId, label? }`
//   → Aedilis の gateway_registry に upsert。
//
// 運用化: AEDILIS_BASE_URL と AEDILIS_ADMIN_TOKEN が両方そろっていれば起動後に
// 自己登録する。 失敗は warn でリトライ (数回)。 未設定なら従来通り手動 (起動ログの
// PEM を運用者が登録) にフォールバックする。
//
// SRP: HTTP 登録だけに責務を絞る。 「やるか否か」 の判断 (env 揃い) は呼び出し側。

export interface AedilisRegisterOptions {
  baseUrl: string; // 末尾スラッシュ無し (config 側で正規化済み)
  adminToken: string; // admin Cernere Bearer
  lanId: string;
  facilityId: string;
  publicKeyPem: string;
  label: string;
  /** リトライ回数 (初回含む)。 default 4 */
  maxAttempts?: number;
  /** リトライ間隔 ms。 default 5000 */
  retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Aedilis に公開鍵を登録する。 成功で true、 全リトライ失敗で false。
 * 例外は内部で握りつぶし warn — 起動シーケンスをブロックしない。
 */
export async function registerGatewayKey(opts: AedilisRegisterOptions): Promise<boolean> {
  const url = `${opts.baseUrl}/api/admin/gateways`;
  const maxAttempts = opts.maxAttempts ?? 4;
  const retryDelayMs = opts.retryDelayMs ?? 5000;

  const payload = {
    lanId: opts.lanId,
    publicKeyPem: opts.publicKeyPem,
    facilityId: opts.facilityId,
    label: opts.label,
  };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${opts.adminToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
      if (res.ok) {
        console.log(
          `[ostiarius] 公開鍵を Aedilis に自己登録: ${url} lanId=${opts.lanId} (HTTP ${res.status})`,
        );
        return true;
      }
      // 4xx は設定/権限ミスの可能性が高くリトライしても直らない → 即諦める
      if (res.status >= 400 && res.status < 500) {
        const text = await res.text().catch(() => '');
        console.warn(
          `[ostiarius] 自己登録が拒否されました (HTTP ${res.status}) — 手動 provision に切替: ${text.slice(0, 200)}`,
        );
        return false;
      }
      throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const last = attempt >= maxAttempts;
      console.warn(
        `[ostiarius] 自己登録 失敗 (${attempt}/${maxAttempts}): ${msg}` +
          (last ? ' — 手動 provision にフォールバック' : ` — ${retryDelayMs}ms 後に再試行`),
      );
      if (last) return false;
      await sleep(retryDelayMs);
    }
  }
  return false;
}
