---
task: lan-http-hardening
project: Ostiarius
kind: 実装
status: in_review
created: 2026-10-05T00:00:00.000Z
delegation_run_id: b003c2d2-1dfe-43d8-9ddb-9b48197e84d9
memoria_task_id: null
actio_task_id: "actio:541fab55-36ce-4559-aad7-de28636cac82"
memory_links: []
---
# Ostiarius を HTTP の LAN 内サービスとして安全に動かす (HTTPS は後日)

設計: [../feature/lan-https-and-lan-url.md](../feature/lan-https-and-lan-url.md) §HTTP 運用時のセキュリティ要件。
親: 認証集約 / P4 実機確認 ([idv-p4-field.md](idv-p4-field.md)) の前提整備。GLAB / Cernere / Aedilis は触らない。

## 分解
- [x] 転送ヘッダの共通定義と転送路の分類 (`server/http-security/forwarded-headers.ts` / `transport.ts`)
- [x] kiosk token → cookie の交換と token / cookie 認可を loopback か TLS に限定、cookie を `Path=/kiosk`・1 時間に (`server/kiosk-authorization.ts`)
- [x] 写真・フレーム・テンプレート・登録・職員・互換経路を「LAN 内 かつ TLS か loopback」に限定 (`sensitive-route-guard.ts` / `face/lan-guard.ts`)
- [x] 一回限りの要求 nonce (`POST /api/lan/nonce` + `x-ostiarius-nonce`)、現地確認 MFA の nonce 再利用拒否
- [x] Host 許可リスト (421)、Origin 許可リスト (403)、防御ヘッダ (CSP nonce 等)、IP 単位レート制限 (429)
- [x] secure context でない画面のパスキー / カメラ非表示と案内、`/api/health` の `lanTransport` / `secureContextMethods`
- [x] モバイル互換経路の応答から氏名を外す (`publicProfile`)
- [x] Excubitor の追跡修正 (`node --run dev:excubitor`)
- [x] spec 更新 (feature / interface / configuration、idv-p4-field の Infisical → Vault)
- [x] 契約 C-15〜C-21 と C-12 更新、回帰テスト (`test/lan-http-hardening.test.ts` ほか)

## 残 (このタスク外)
- 証明書・LAN DNS を用意して `OSTIARIUS_TLS_MODE=required` へ切替 (スマホのカメラ顔認証・パスキーはその後)
- Cocoiru / GLAB 側の案内導線の確認 (GLAB はリンク遷移で `lanUrl` を開く前提)
