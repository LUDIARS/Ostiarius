/**
 * @ludiars/cernere-composite — 型定義
 *
 * バックエンド用。サービスが Cernere に接続し、
 * ユーザー認証を仲介するための型。
 */

/** Composite 設定 */
export interface CompositeConfig {
  /** Cernere サーバーの HTTP URL (例: "http://localhost:8080") */
  cernereUrl: string;
  /** Registered project key; checked against project authentication. */
  projectKey: string;
  /** Registered project client_id; never infer this from serviceCode. */
  clientId: string;
  /** Registered project secret, backend memory only. */
  clientSecret: string;
}

/** Cernere ユーザー情報 */
export interface CernereUser {
  id: string;
  displayName: string;
  email: string | null;
  role: string;
}

/** auth_code 交換後の結果 */
export interface ExchangeResult {
  /** Cr-signed user_for_project token; the service owns its subsequent session. */
  projectToken: string;
  /** ユーザー情報 */
  user: CernereUser;
}
