# feature: LAN 用 TLS 証明書の発行 / 更新 (ACME DNS-01)

会場 LAN のゲートウェイは自宅・インターネットから到達できない
([setup/secrets.md](../setup/secrets.md)) ため、HTTP-01 では証明書を取れない。
公開 DNS (Cloudflare) に TXT を張る **DNS-01** で、LAN 内ホスト名の証明書を発行・更新する。

- 実装: `server/acme/cli.ts` (コマンド / 設定解決)、`server/acme/order.ts` (ACME 注文)、
  `server/acme/cloudflare-dns.ts` (TXT ライフサイクル + 権威 DNS 伝播確認)、
  `server/acme/renewal.ts` (更新要否判定)
- テスト: `test/acme-cli.test.ts` / `test/acme-cloudflare-dns.test.ts` /
  `test/acme-renewal.test.ts` ([test/test-strategy.md](../test/test-strategy.md))
- 実行: `npm run tls:issue` / `npm run tls:renew`

## コマンド

| コマンド | 動作 |
|---|---|
| `tls:issue` | 常に発行する |
| `tls:renew` | `{outputDir}/fullchain.pem` を読み、更新期限内なら何もせず `already valid` |

引数は `--hostname <fqdn>` のように env と同名の値を上書きする
(`--account-key-path` / `--directory` / `--email` / `--hostname` / `--output-dir` /
`--renew-before-days` / `--token`)。未知の option・値欠落は即エラーにする。

> `--token` は Cloudflare API token を argv に載せる。プロセス一覧・シェル履歴に残るため、
> 常用は env (`CLOUDFLARE_DNS_API_TOKEN`) 経由にする ([setup/secrets.md](../setup/secrets.md))。

## 発行フロー (`issueCertificate`)

1. account key を `OSTIARIUS_ACME_ACCOUNT_KEY_PATH` から読む。無ければ RSA 鍵を生成して
   `mode 0600` で保存する (Windows では mode は best-effort)。
2. ACME account 作成 → CSR 生成 → order 作成。
3. authorization ごとに **その identifier に対して** `_acme-challenge.<identifier>` の TXT
   (`ttl 120`) を Cloudflare に作る。値は acme-client の `getChallengeKeyAuthorization` の
   戻り値をそのまま使う (dns-01 では既に `base64url(sha256(token.thumbprint))`、RFC 8555 §8.4)。
   呼び出し側で再度 sha256 しない。
4. zone の権威 NS を直接引いて TXT の伝播を待つ (既定 120s、2s 間隔)。
   キャッシュ resolver を見ないのは、未伝播の NXDOMAIN をキャッシュさせないため。
5. `verifyChallenge` → `completeChallenge` → `waitForValidStatus` → `finalizeOrder`。
6. `{outputDir}/fullchain.pem` (`0644`) と `{outputDir}/privkey.pem` (`0600`) を書く。
   `writeFile` の `mode` は新規作成時しか効かないので、privkey は書き込み後に `chmod 0600`
   で締め直す (再発行で緩いパーミッションを引き継がないため)。
7. **finally で作成した TXT を必ず削除する**。削除失敗は stderr に警告するだけで、
   本来の発行エラーを置き換えない (TXT は ttl 120s の使い捨て)。

zone 名は FQDN の末尾 2 ラベル (`os.example.com` → `example.com`)。
`co.jp` のような multi-label な公開 suffix は対象外 (現行の LAN ホスト名は 2 ラベル運用)。

## 更新判定 (`decideRenewal`)

I/O を持たない純関数。`reason` は `certificate_missing` / `certificate_invalid` /
`renewal_window` / `already_valid`。

- PEM 無し (ENOENT) → `certificate_missing` で発行。
- パース不能 / `validTo` が不正 → `certificate_invalid` で発行。
- `validTo <= now + OSTIARIUS_ACME_RENEW_BEFORE_DAYS` → `renewal_window` で発行。
- それ以外 → 発行しない。

## 秘密情報の扱い

- 出力先 `data/acme/` は gitignore 済み (`/data/`・`*.pem`・`*.key` でも二重に除外)。
  秘密鍵・account key をリポジトリに入れない。
- CLI は **Infisical を更新しない**。発行後に `OSTIARIUS_TLS_CERTIFICATE_PEM` /
  `OSTIARIUS_TLS_PRIVATE_KEY_PEM` / `OSTIARIUS_TLS_MODE` を運用者が登録する
  ([setup/secrets.md](../setup/secrets.md))。
- エラーメッセージに token・鍵・PEM を含めない (Cloudflare の応答は status + message のみ)。

## 自動テストで担保できない範囲

実際の証明書発行は Let's Encrypt + Cloudflare + 公開 DNS への到達を伴うため自動化しない。
staging directory (`--directory staging`) での通し確認は運用者が行う
([test/test-strategy.md](../test/test-strategy.md) の「ライブ統合」区分)。

## 関連

- env / secret: [setup/configuration.md](../setup/configuration.md) /
  [setup/secrets.md](../setup/secrets.md)
- タスク: [tasks/acme-dns01-cli.md](../tasks/acme-dns01-cli.md)
