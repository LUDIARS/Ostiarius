# GPS チェックイン — 位置の宣言 (G1、Ostiarius 側)

親タスク: 認証集約 (Memoria #769)。Actio: `actio:ed838229-a7a5-4518-beaa-8790d6d91906`。
共通契約「GPS + 写真チェックイン」(G1〜G3) のうち、Ostiarius が担う G1 の仕様。
G2 (スマホ → GLAB) と G3 (GLAB → Aedilis の検証・記録) は別リポの担当。

## 1. 目的

スマホの GPS チェックインでは、スマホの GPS が **Ostiarius が返す会場位置** と一致しているかで出席を判定する
(method=`gps`、assurance=`low`)。会場位置は Ostiarius が gateway 鍵で署名した「位置の宣言」として返し、
Aedilis は gateway_registry に登録済みの公開鍵で検証する。会場位置の正本は Ostiarius の設定にある。

Ostiarius は当面 HTTP の LAN 内サービスである。HTTPS の GLAB の画面からは http の Ostiarius を fetch できないため、
宣言は GLAB がサーバ側の health 確認 (既存の probe) で受け取り、GPS チェックインに付けて Aedilis へ中継する。

## 2. 設定

| env | 意味 |
|---|---|
| `OSTIARIUS_FACILITY_LAT` | 会場の緯度 (10 進度、-90〜90) |
| `OSTIARIUS_FACILITY_LON` | 会場の経度 (10 進度、-180〜180) |
| `OSTIARIUS_FACILITY_RADIUS_M` | 会場とみなす半径 (正の整数、m) |

- 値は Excubitor の Vault (ostiarius の紐付け) で与える。
- **3 値が揃わなければ宣言を出さない** (= その会場は GPS チェックイン不可)。範囲外や形式違いも同じ扱いにする。
  GPS は任意機能なので起動は止めず、起動ログに `location statement=disabled` と、不正値のキー名 (値は出さない) を警告する。

## 3. 宣言の形式

attestation と同じ `base64url(JSON payload) + "." + base64url(Ed25519 署名)`。gateway 鍵 (attestation と同じ鍵) で署名する。
payload のキー順は固定:

```
{ lanId, facilityId, lat, lon, radiusM, issuedAt, purpose: "location" }
```

- `issuedAt` は epoch ms (ゲートウェイ時計)。Aedilis は 15 分以内の宣言だけ受理する。
- `purpose: "location"` は位置の宣言専用。出席・MFA の attestation としては受理されない
  (Aedilis・Cernere はどちらも `purpose_mismatch` で拒否する)。逆に出席・MFA の attestation は
  Aedilis の GPS チェックインで `statement_invalid` になる。
- 実装: `server/location-statement.ts` (`signLocationStatement`)、署名の共通部は `server/attestation.ts` の `signCompactPayload`。

## 4. 公開

- `GET /api/health` の応答に `locationStatement` (文字列) を足す。宣言が無い会場ではキーごと省略する。
- `GET /api/location` → `200 { locationStatement }`。宣言が無い会場は `404 { error: "location_not_configured" }`。
- どちらも要求ごとに新しく署名する (`issuedAt` は応答時刻)。
- 宣言に秘密は含まない (会場の位置と半径だけ)。LAN 防御 (Host 許可リスト等、`lan-https-and-lan-url.md` §8) はそのまま掛かる。

## 5. 契約 (Augur)

- `C-22 signLocationStatement(payload, privateKey)`: 固定キー順・purpose=location で署名する
- `C-23 resolveFacilityLocation(env)`: 3 値が揃って範囲内のときだけ位置を返す

## 6. 運用手順 (人間)

1. 会場の緯度・経度・半径を決め、Vault に `OSTIARIUS_FACILITY_LAT` / `_LON` / `_RADIUS_M` を登録して ostiarius に紐付ける。
2. Ostiarius を再起動し、起動ログの `location statement=enabled` と `/api/health` の `locationStatement` を確認する。
3. 解除するときは 3 値のどれかを紐付けから外して再起動する (宣言が消え、GPS チェックインは `statement_invalid` で止まる)。
