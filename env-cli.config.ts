import type { EnvCliConfig } from "../Cernere/packages/env-cli/src/types.js";

/**
 * Ostiarius の env-cli 設定。
 *
 * INFISICAL_* (machine identity) は env-cli setup で .env.secrets に保存。
 * アプリ infra / secret 値は Infisical 側に置き、 起動時に fetch + inject する。
 * Aedilis / Memoria / Cernere / Bibliotheca と同パターン。
 *
 * secret 扱い ([[feedback_config_and_secrets]] — 平文保存しない):
 *   - CERNERE_PROJECT_CLIENT_SECRET : Cernere project client credential の secret。
 *                               service token (passkey export / 失効指示の取得) はこれから都度取り直す。
 *                               通常は Excubitor が起動ごとに注入するので Infisical には置かない
 *   - OSTIARIUS_KIOSK_TOKEN  : kiosk 管理 API 用共有トークン
 *   - OSTIARIUS_PRIVATE_KEY   : Ed25519 秘密鍵 (PKCS#8 PEM)。 本番はこれを inject し
 *                               平文ファイル (OSTIARIUS_KEY_PATH) を置かない
 *   - AEDILIS_ADMIN_TOKEN     : 公開鍵 自己登録の admin Bearer
 * これらは infraKeys にデフォルト値を置かず、 必ず Infisical から供給する。
 */

const config: EnvCliConfig = {
  name: "Ostiarius",

  infraKeys: {
    // ─── Hono listen port ────────────────────────────────────
    OSTIARIUS_PORT: "17590",

    // ─── このゲートウェイの ID / 紐づく施設 ───────────────────
    OSTIARIUS_LAN_ID: "",
    OSTIARIUS_FACILITY_ID: "",
    OSTIARIUS_LABEL: "",

    // ─── Cernere 認証 (passkey export・失効指示・同意の取得元) ───
    CERNERE_BASE_URL: "",
    CERNERE_FRONTEND_URL: "",
    // CERNERE_PROJECT_CLIENT_ID / _SECRET は Excubitor が起動ごとに注入する (catalog の
    // cernere_launch_credentials)。 手動起動で使うときだけ Infisical に置く。
    // CERNERE_SERVICE_TOKEN は TTL 60 分の固定 token — 一時確認用で常用しない

    // ─── WebAuthn (Cernere と同 eTLD+1) ──────────────────────
    OSTIARIUS_RP_ID: "",
    OSTIARIUS_PWA_ORIGIN: "",
    OSTIARIUS_LEGACY_METHODS: "",
    // OSTIARIUS_KIOSK_TOKEN は secret — Infisical のみ (default を置かない)

    // ─── 公開鍵 自己登録先 (#167) ─────────────────────────────
    // 両方そろうと起動時に Aedilis へ自己登録、 無ければ手動 provision。
    AEDILIS_BASE_URL: "",
    // AEDILIS_ADMIN_TOKEN は secret — Infisical のみ

    // ─── 秘密鍵の供給 (#166) ──────────────────────────────────
    // OSTIARIUS_PRIVATE_KEY は secret — Infisical のみ (本番はこれを inject)。
    // OSTIARIUS_KEY_PATH は dev フォールバックのファイルパス。
    OSTIARIUS_KEY_PATH: "",

    // ─── データ保存 / 同期間隔 ────────────────────────────────
    OSTIARIUS_DATA: "",
    OSTIARIUS_SYNC_INTERVAL_MS: "900000",
    OSTIARIUS_CHALLENGE_TTL_MS: "120000",

    // ─── 顔認証 (spec/feature/identity-verification.md §8) ───────
    // 顔テンプレート・顔写真の封緘鍵は **kiosk ホスト内で生成** し、OSTIARIUS_DATA 配下の
    // 0600 鍵ファイルに置く (spec/plan/face-data-local-only.md §3)。Infisical・env には置かない。
    OSTIARIUS_FACE_SIDECAR_URL: "http://127.0.0.1:17591",
    OSTIARIUS_FACE_MATCH_THRESHOLD: "0.62",
    OSTIARIUS_FACE_MARGIN: "0.08",
    OSTIARIUS_LIVENESS_THRESHOLD: "0.90",
    OSTIARIUS_FACE_CHALLENGE: "required",
    // 同意記録を Cernere に打つか (local はオフライン検証用)。旧 OSTIARIUS_FACE_TEMPLATE_SOURCE。
    OSTIARIUS_FACE_CONSENT_SOURCE: "cernere",
    OSTIARIUS_STAFF_ROLES: "staff,admin",
    // 施設内バックアップの複製先 (USB / NAS)。鍵ファイルとは別媒体にする。
    OSTIARIUS_BACKUP_DIR: "",
    OSTIARIUS_STAFF_OVERRIDE_DAILY_LIMIT: "20",
    OSTIARIUS_EVENT_RETENTION_DAYS: "90",
    // AEDILIS_GATEWAY_TOKEN は secret — Infisical のみ (Aedilis /admin/gateways 登録時に払い出し)
  },

  secretsPath: ".env.secrets",
  dotenvPath: ".env",

  defaultSiteUrl: "https://infisical.vtn-game.com",
  defaultEnvironment: "dev",

  required: {
    production: [
      "OSTIARIUS_LAN_ID",
      "OSTIARIUS_FACILITY_ID",
      "CERNERE_BASE_URL",
      "OSTIARIUS_RP_ID",
      "OSTIARIUS_PWA_ORIGIN",
      "OSTIARIUS_KIOSK_TOKEN",
      // 本番は秘密鍵を inject (平文ファイルを使わない)
      "OSTIARIUS_PRIVATE_KEY",
    ],
  },
};

export default config;
