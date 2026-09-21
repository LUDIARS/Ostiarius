# feature: mobile-checkin フォールバック

PC を持たない、または passkey を未登録の来場者が、会場 LAN 内で Wi-Fi 接続から
チェックインまで進める代替経路。実装は `server/mobile-checkin.ts` と
`server/routes/mobile-checkin.ts`、HTTP 契約は
[interface/http-checkin.md](../interface/http-checkin.md) を参照する。

## 適用条件とトレードオフ

- 通常の passkey 経路を利用できない来場者向けで、email/password による本人確認を使う。
- passkey より本人確認強度は低いが、PC や事前登録を必須にしないアクセシビリティとの
  明示的なトレードオフとして許容する。
- MFA 有効アカウントには対応せず、途中まで成功させずに passkey 経路を案内する。
- 到達制御は他の check-in API と同じく会場 LAN への配置境界で担う。

## Wi-Fi QR

- `OSTIARIUS_WIFI_SSID` が設定されている場合だけページに QR を表示し、
  `GET /mobile-checkin/wifi-qr.png` から WPA 形式の PNG を返す。
- SSID が空なら QR セクションを表示せず、PNG endpoint は 404 を返す。
- SSID と password の `\\` / `;` / `,` / `:` は Wi-Fi QR 形式に従って escape する。

## login と attestation

1. `POST /checkin/mobile-login` が email/password を Cernere login へ渡す。
2. 認証成功時は passkey 経路と同じ `{ sub, placeId, lanId, nonce, issuedAt }` を
   gateway の Ed25519 鍵で署名し、`{ accessToken, attestation, profile }` を返す。
3. ブラウザは `accessToken` と `attestation` を Aedilis の check-in verify endpoint へ送る。

認証失敗では email と password のどちらが誤っているかを区別しない。Cernere 不通、
非 2xx、応答形状不正も秘密情報を含まない利用者向けエラーに変換する。

## vantan_user enrichment

- 確認画面用の department / grade / name は Cernere project WS から best-effort で取得する。
- 未接続、認証失敗、timeout、対象データなしでは `profile: null` とし、login と attestation
  発行そのものは成功させる。
- project credential は passkey export と同じ起動時 credential を使うが、WS client は
  接続ライフサイクルに合わせて独立に短期 token を取得する。

## 構成不備

`AEDILIS_BASE_URL` が空の場合はフォームを無効化し、passkey 経路を案内する。Wi-Fi QR と
enrichment は補助機能であり、それぞれの不成立を check-in 本体の暗黙成功として扱わない。
