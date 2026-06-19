# interface: Cernere passkey export (連携先 — 取得)

Ostiarius が Cernere から passkey 公開鍵を取り込むための外部接点。Ostiarius は
**クライアント側**。実装: `server/cernere-sync.ts`。

## エンドポイント

- `GET {CERNERE_BASE_URL}/api/auth/passkey/export`
- 認証: `Authorization: Bearer {CERNERE_SERVICE_TOKEN}` (admin/service Bearer)。
- 呼び出し頻度: 起動時 1 回 + `OSTIARIUS_SYNC_INTERVAL_MS` 毎 (既定 15min)。

## Ostiarius が期待するレスポンス形

`cernere-sync.ts` の `ExportResponse` / `ExportedCredential` が期待する形:

```jsonc
{
  "credentials": [
    {
      "userId": "string",          // 必須 (欠けると skip)
      "credentialId": "string",    // base64url、必須
      "publicKey": "string",       // base64 COSE、必須
      "counter": 0,                // 任意 (数値以外は 0)
      "transports": ["internal"]   // 任意 (配列以外は [])
    }
  ]
}
```

- `credentials` が配列でなければ空配列扱い。
- `userId` / `credentialId` / `publicKey` のいずれかが欠ける行は skip。
- 取り込んだ行は `credentials` テーブルへ upsert ([data/credentials.md](../data/credentials.md))。

## エラー時の挙動 (Ostiarius 側)

- 非 2xx / ネット不通 / JSON 不正 → warn のみ、前回キャッシュで継続 (hard fail しない)。

## 前提

- `CERNERE_BASE_URL` は末尾スラッシュ除去済み。
- WebAuthn の RP ID / origin は Cernere と同一 eTLD+1 に揃える
  (`OSTIARIUS_RP_ID` = Cernere `WEBAUTHN_RP_ID`、`OSTIARIUS_PWA_ORIGIN` は
  Cernere `WEBAUTHN_ORIGINS` に含まれる値)。

## 関連

- 同期機能: [feature/cernere-passkey-sync.md](../feature/cernere-passkey-sync.md)
- secret: [setup/secrets.md](../setup/secrets.md)
