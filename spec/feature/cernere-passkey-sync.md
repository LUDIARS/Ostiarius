# feature: Cernere passkey 同期 (オフライン検証の土台)

Ostiarius が Cernere から passkey 公開鍵を引いて `credentials` テーブルへキャッシュする
機能。これにより会場で Cernere に届かなくても assertion を検証できる。

- 実装: `server/cernere-sync.ts`
- 連携先 contract: [interface/cernere-passkey-export.md](../interface/cernere-passkey-export.md)
- 格納先: [data/credentials.md](../data/credentials.md)

## 目的

来場者が「いま会場にいる」ことの検証 (= 家からは LAN に届かない) を成立させるための土台。
事前に公開鍵を取り込んでおき、検証時は Cernere に問い合わせない。

## 振る舞い

- **起動時に 1 回** + `OSTIARIUS_SYNC_INTERVAL_MS` (既定 15min) 毎に
  `GET {CERNERE_BASE_URL}/api/auth/passkey/export` (Bearer `CERNERE_SERVICE_TOKEN`) を呼ぶ。
- レスポンス `{ credentials: ExportedCredential[] }` の各件を、`userId` / `credentialId`
  / `publicKey` が揃ったものだけ `upsertCredential` する (1 トランザクション)。
- `counter` 未指定は 0、`transports` 非配列は `[]` に正規化。
- upsert 件数とキャッシュ総数をログ出力。

## エラーハンドリング (best-effort)

- HTTP 非 2xx / ネット不通 / JSON parse 失敗 はすべて catch して **warn ログのみ**。
  起動は止めず、`{ ok: false, synced: 0 }` を返す。
- 不通でも**前回キャッシュで運用継続**できる (これが offline 設計の肝)。
- タイマーは `unref()` してプロセス終了をブロックしない。

## 制約 / 前提

- `CERNERE_BASE_URL` は末尾スラッシュを除去済み (`config.ts`)。
- export は **公開鍵のみ** (個人データは含めない、Cernere 単一情報源)。
- credential の正本は Cernere。Ostiarius は削除同期を行わない (export に無い既存行は残る)
  — キャッシュは upsert のみで、失効は Cernere 側 export からの除外で運用上扱う想定。

## 関連

- export API の形式: [interface/cernere-passkey-export.md](../interface/cernere-passkey-export.md)
- 同期間隔 env: [setup/configuration.md](../setup/configuration.md)
