---
task: pr206-relanding-on-main
project: Ostiarius
kind: 実装
created: 2026-09-21
memory_links: []
---
# PR #206 (LAN 内 HTTPS) を現在の main の上に載せ直す

## 目的

Revisor local PR #206 (`feat/lan-tls-and-project-token`) は main から 21 コミット取り残され、
13 ファイルで衝突して `action_required` のまま止まっていた。main 側が後から入れた変更を正とし、
この PR が持つ機能のうち **いま必要なものだけ**を main の上に載せ直して審査を通す。

PR #206 は 2 つの機能を抱えていた。棚卸しの結果、片方は main へ別経路で着地済みだった。

- **LAN 内 HTTPS の配信 — まだ必要 (本 PR で載せ直す)。**
  main は `server/acme/*` (`tls:issue` / `tls:renew`) で証明書を **発行** できるようになったが、
  発行した PEM を **配信** する側が無い。main の `server/index.ts` は今も
  `serve({ fetch, port })` の平文 HTTP で listen しており、`OSTIARIUS_TLS_*` を読む実装が
  どこにも無い。main の ACME CLI 自身が「発行後に `OSTIARIUS_TLS_CERTIFICATE_PEM` /
  `OSTIARIUS_TLS_PRIVATE_KEY_PEM` / `OSTIARIUS_TLS_MODE` を登録せよ」と出力し、
  `excubitor.catalog.yaml` も既にこの 4 key を `include` に並べている。本 PR の
  `server/tls-config.ts` はその受け取り口そのもので、欠けている最後の一枚に当たる。
- **Cernere project 認証への移行 — 不要 (main に着地済み)。**
  main の `c09db6a` が `server/cernere-service-token.ts` を入れ、`CERNERE_PROJECT_CLIENT_ID` /
  `_SECRET` から service token を都度取り直す経路が完成している。本 PR の
  `server/cernere-project-token.ts` は同じ目的の重複実装なので、載せ直さず破棄する。

## 完了条件

- ローカル `main` を本ブランチへ取り込み、13 ファイルの衝突を「main を土台に本 PR 固有の
  差分だけを足す」方針で解消していること。main が後から入れた変更を巻き戻していないこと。
- `server/tls-config.ts` / `server/lan-route.ts` が main の上で成立し、`server/config.ts` の
  `config.tls`、`server/index.ts` の HTTPS listen と `GET /api/health` の `lanUrl` に
  つながっていること。
- 重複していた `server/cernere-project-token.ts` とその spec / テストが残っていないこと
  (Cernere 連携は main の `cernere-service-token.ts` に一本化)。
- main が `spec/domains/` へ移した domain 定義の置き場に合わせ、本 PR が `.anatomia/domains/`
  に置いていた定義を撤去し、新規ファイルの着地先 `lan-https-endpoint` を
  `spec/domains/lan-https-endpoint.domain.json` として宣言していること。
- 受け入れ条件 C-7 / C-8 / C-9 の述語を `contracts/` に実装し、`augur.contracts.json` へ
  登録していること。
- `npm run typecheck` と登録テスト (`npm test`) が緑であること。
- `git diff | anatomia verify` が block されないこと。

## スコープ (編集可ディレクトリ)

- `server/`、`test/`、`contracts/`、`spec/`、`docs/`、リポジトリ直下の設定ファイル。
- PR #206 以外の未マージ PR には触れない。

## 参考

- 配信側の仕様: [feature/lan-https-and-lan-url.md](../feature/lan-https-and-lan-url.md)
- 発行側の仕様 (main で先行着地): [feature/lan-tls-certificate.md](../feature/lan-tls-certificate.md)
- 実機確認の切り出し: [tasks/2026-08-11-lan-https-runtime-verification.md](2026-08-11-lan-https-runtime-verification.md)
