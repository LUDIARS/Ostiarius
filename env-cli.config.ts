import type { EnvCliConfig } from "../Cernere/packages/env-cli/src/types.js";

/**
 * Ostiarius の env-cli 設定。
 *
 * INFISICAL_* (machine identity) は env-cli setup で .env.secrets に保存。
 * アプリ infra / secret 値は Infisical 側に置き、 起動時に fetch + inject する。
 * Aedilis / Memoria / Cernere / Bibliotheca と同パターン。
 *
 * secret 扱い ([[feedback_config_and_secrets]] — 平文保存しない):
 *   - CERNERE_SERVICE_TOKEN  : Cernere passkey export 用 admin Bearer
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

    // ─── Cernere 認証 (passkey export の取得元) ───────────────
    CERNERE_BASE_URL: "",
    CERNERE_FRONTEND_URL: "",
    // CERNERE_SERVICE_TOKEN は secret — Infisical のみ (default を置かない)

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
      "CERNERE_SERVICE_TOKEN",
      "OSTIARIUS_RP_ID",
      "OSTIARIUS_PWA_ORIGIN",
      "OSTIARIUS_KIOSK_TOKEN",
      // 本番は秘密鍵を inject (平文ファイルを使わない)
      "OSTIARIUS_PRIVATE_KEY",
    ],
  },
};

export default config;
