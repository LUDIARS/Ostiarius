---
task: lan-https-runtime-verification
project: Ostiarius
kind: テスト
created: 2026-08-11
memory_links: []
---
# 会場 LAN 実機での HTTPS 起動 / チェックイン動作確認

## 目的

PR #206 (`feat/lan-tls-and-project-token`) は entrypoint (`server/index.ts` の listen) を
HTTP から HTTPS へ切り替える。Revisor の runtimeVerification が `required=true`
(要因: entrypoint に触れる変更 / `runtime: true` の登録テストが無い / レビュアーが動作確認を
要求) となっており、登録テストだけでは「会場 LAN 上の来場者端末から実際に到達して
チェックインできる」ことを保証できない。

> Cernere 認証を長命 service token から project client credential へ移す作業は、本 PR が
> 取り残されている間に main 側 (`server/cernere-service-token.ts`) で別途完了した。
> 本タスクの確認対象は HTTPS 配信と `lanUrl` の広告だけに絞る。

実機確認は AI では実施できない (別 PC・会場 LAN のサブネット分離・実証明書の inject が要る)
ため、人間の作業として切り出す。

## 完了条件

- `OSTIARIUS_TLS_MODE=required` + `OSTIARIUS_LAN_HOSTNAME` + 証明書 / 秘密鍵 PEM を inject した
  状態で起動し、`node:https` で listen していること。
- 3 値のいずれかを欠いた状態では **起動が失敗する** こと (HTTP へフォールバックしない)。
  例外メッセージに証明書 / 鍵の値が出ていないこと。
- 会場 LAN 上の別端末のブラウザから `https://<OSTIARIUS_LAN_HOSTNAME>:<port>/checkin/` が
  secure context として開き、WebAuthn (passkey) が起動すること。
- `GET /api/health` の `lanUrl` が、その端末から実際に到達できる URL を返すこと
  (Wi-Fi インターフェースが優先され、VPN 等の別経路を広告しないこと)。
- Excubitor catalog の health URL / `provides` が `https://` + LAN hostname に揃っていること。
- 実施結果 (成否と観測値) を PR #206 へ戻し、runtimeVerification の要求を解消すること。

## スコープ (編集可ディレクトリ)

- 実機確認が主目的。コード修正が必要と判明した場合は別タスクへ分解する。
- `docs/` (runbook の追記)、`spec/` (確認手順・前提の反映) のみ編集可。
- `server/` の実装変更は本タスクでは行わない。

## 参考

- 手動 runbook: [docs/E2E-checkin.md](../../docs/E2E-checkin.md)
- 仕様: [feature/lan-https-and-lan-url.md](../feature/lan-https-and-lan-url.md) /
  [feature/lan-tls-certificate.md](../feature/lan-tls-certificate.md) (証明書の発行側)
- 既存の自動 E2E (`test/checkin.e2e.test.ts`) はソフトウェア WebAuthn authenticator で
  passkey フローを実機なしに駆動する。物理端末での生体タップと LAN 分離はこのタスクの範囲。
