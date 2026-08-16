// Wi-Fi QR 生成 + email/password ログイン→attestation 発行のオーケストレーション (SRP)。
//
// PC無し/未登録passkeyの来場者向けフォールバック経路。 会場 LAN 上で完結する
// server/routes/checkin.ts (passkey) とは別ルートだが、 attestation の署名形式は
// 完全に同じ (server/attestation.ts, 変えると Aedilis 側検証が破綻する)。
//
// パスワードのみでの本人確認は passkey より弱いため、呼び出し元が
// OSTIARIUS_LEGACY_METHODS=password を明示した場合だけ HTTP route として公開する。

import { randomBytes } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type Database from 'better-sqlite3';
import { toBuffer as qrToBuffer } from 'qrcode';

import { b64urlEncode, signAttestation } from './attestation.ts';
import { recordVerificationIssued } from './db.ts';
import type { ChallengeStore } from './challenge-store.ts';
import type { VantanUserProfile } from './vantan-user-client.ts';

/**
 * loginAndAttest が必要とする最小の vantan_user プロフィール取得インターフェース。
 * 具象クラス (VantanUserClient) ではなくこの形に依存することで、 未構成 (null) でも
 * テストでフェイクを注入しても、 呼び出し側の型は変わらない。
 */
export interface VantanUserClientLike {
  getVantanUserProfile(userId: string): Promise<VantanUserProfile | null>;
}

export interface MobileCheckinDeps {
  /** 末尾スラッシュ無し (config.cernereBaseUrl は既に正規化済み)。 */
  cernereBaseUrl: string;
  facilityId: string;
  lanId: string;
  challenges: ChallengeStore;
  privateKey: KeyObject;
  /** 未構成 (OSTIARIUS_CERNERE_PROJECT_CLIENT_ID/_SECRET 未設定) なら null。 */
  vantanUserClient: VantanUserClientLike | null;
  /** 本人確認の発行監査を必ず記録する永続層。 */
  db: Database.Database;
  /** テスト注入用。 未指定ならグローバル fetch。 */
  fetchImpl?: typeof fetch;
}

export interface LoginAndAttestResult {
  accessToken: string;
  attestation: string;
  profile: VantanUserProfile | null;
}

interface CernereLoginBody {
  mfaRequired?: unknown;
  user?: { id?: unknown };
  accessToken?: unknown;
}

/**
 * Wi-Fi QR (WIFI:S:...;T:WPA;P:...;;) の各フィールドをエスケープする。
 * 仕様上エスケープが必要な文字は `\` `;` `,` `:` の 4 種 (この順にではなく、
 * 1 回の正規表現パスで全て置換することで二重エスケープを避ける)。
 */
function escapeWifiField(value: string): string {
  return value.replace(/([\\;,:])/g, '\\$1');
}

/**
 * Wi-Fi QR ペイロード文字列を組み立てる (エスケープ込み)。
 * generateWifiQrPng から分離してあるのはテスト容易性のため
 * (QR デコードなしにエスケープ結果そのものを検証できる)。
 */
export function buildWifiQrPayload(ssid: string, password: string): string {
  return `WIFI:S:${escapeWifiField(ssid)};T:WPA;P:${escapeWifiField(password)};;`;
}

/**
 * 会場 Wi-Fi 接続用 QR コード (PNG buffer) を生成する。
 * ペイロードは標準 Wi-Fi QR フォーマット: `WIFI:S:<ssid>;T:WPA;P:<password>;;`
 */
export async function generateWifiQrPng(ssid: string, password: string): Promise<Buffer> {
  return qrToBuffer(buildWifiQrPayload(ssid, password), { type: 'png' });
}

/** attestation.nonce 用の乱数。 checkin.ts の challenge (WebAuthn challenge) と同じ base64url 表現。 */
function newNonce(): string {
  return b64urlEncode(randomBytes(32));
}

/**
 * email/password で Cernere にログインし、 成功したら presence attestation を発行する。
 *
 * - Cernere 到達不能 / HTTP 非 200 / 認証情報不一致 → 汎用エラー (どちらが誤りかは
 *   漏らさない、 通常のログインエラーの流儀に合わせる)。
 * - MFA 有効アカウント → この簡易フォールバックでは扱えない旨の実行可能なエラー
 *   (PC/passkey フローへの誘導) を返す。 黙って半端に成功させない。
 * - vantan_user プロフィール enrichment は best-effort — 失敗してもチェックイン自体は
 *   ブロックしない (profile: null を返すだけ)。
 */
export async function loginAndAttest(
  deps: MobileCheckinDeps,
  email: string,
  password: string,
): Promise<LoginAndAttestResult | { error: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${deps.cernereBaseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[ostiarius] mobile-checkin login 失敗 (Cernere 不通): ${msg}`);
    return { error: 'ログインサーバーに接続できませんでした。しばらくしてから再度お試しください。' };
  }

  let body: CernereLoginBody | null;
  try {
    body = (await res.json()) as CernereLoginBody;
  } catch {
    body = null;
  }

  if (!res.ok) {
    return { error: 'メールアドレスまたはパスワードが正しくありません。' };
  }

  if (body?.mfaRequired === true) {
    return {
      error:
        'このアカウントは多要素認証 (MFA) が有効なため、この簡易チェックインでは利用できません。PC のパスキーチェックインをご利用ください。',
    };
  }

  const userId = body?.user?.id;
  const accessToken = body?.accessToken;
  if (typeof userId !== 'string' || !userId || typeof accessToken !== 'string' || !accessToken) {
    console.warn('[ostiarius] mobile-checkin login: Cernere response が想定形状と異なる');
    return { error: 'メールアドレスまたはパスワードが正しくありません。' };
  }

  const nonce = newNonce();
  deps.challenges.put(nonce);
  const attestation = signAttestation(
    { sub: userId, placeId: deps.facilityId, lanId: deps.lanId, nonce, issuedAt: Date.now(), method: 'password', assurance: 'low' },
    deps.privateKey,
  );
  recordVerificationIssued(deps.db, { method: 'password', subjectUser: userId });

  let profile: VantanUserProfile | null = null;
  if (deps.vantanUserClient) {
    try {
      profile = await deps.vantanUserClient.getVantanUserProfile(userId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[ostiarius] mobile-checkin: vantan_user profile 取得失敗 (継続): ${msg}`);
    }
  }

  console.log(`[ostiarius] mobile check-in verified user=${userId} → attestation issued`);
  return { accessToken, attestation, profile };
}

/**
 * 既に Cernere にログイン済みのユーザ向け。 保持している accessToken を Cernere で
 * 検証 (`/api/auth/me`) し、 有効なら passkey/パスワードを再入力させずに presence
 * attestation を発行する。 「会場 LAN に届く = presence」 の前提は passkey 経路と
 * 同じで、 ここでは本人性を既存セッションで代替する (端末に passkey が無いスマホでも
 * 一度 Cernere ログイン済みなら自動チェックインできる)。
 *
 * - token 無効 / Cernere 不通 → 再ログイン誘導のエラー。
 * - attestation 形式は loginAndAttest と完全に同一 (Aedilis 側検証が同じ)。
 * - `OSTIARIUS_LEGACY_METHODS=session` を明示した場合だけ route から到達する
 *   ([spec/feature/passkey-fallback.md](../spec/feature/passkey-fallback.md) §5)。
 */
export async function tokenAndAttest(
  deps: MobileCheckinDeps,
  accessToken: string,
): Promise<LoginAndAttestResult | { error: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch;

  let res: Response;
  try {
    res = await fetchImpl(`${deps.cernereBaseUrl}/api/auth/me`, {
      headers: { authorization: `Bearer ${accessToken}` },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[ostiarius] session check-in 失敗 (Cernere 不通): ${msg}`);
    return { error: 'ログインサーバーに接続できませんでした。しばらくしてから再度お試しください。' };
  }

  if (!res.ok) {
    return { error: 'セッションが無効です。もう一度ログインしてください。' };
  }

  let body: { id?: unknown } | null;
  try {
    body = (await res.json()) as { id?: unknown };
  } catch {
    body = null;
  }
  const userId = body?.id;
  if (typeof userId !== 'string' || !userId) {
    console.warn('[ostiarius] session check-in: /api/auth/me response が想定形状と異なる');
    return { error: 'セッションが無効です。もう一度ログインしてください。' };
  }

  const nonce = newNonce();
  deps.challenges.put(nonce);
  const attestation = signAttestation(
    { sub: userId, placeId: deps.facilityId, lanId: deps.lanId, nonce, issuedAt: Date.now(), method: 'session', assurance: 'low' },
    deps.privateKey,
  );
  recordVerificationIssued(deps.db, { method: 'session', subjectUser: userId });

  let profile: VantanUserProfile | null = null;
  if (deps.vantanUserClient) {
    try {
      profile = await deps.vantanUserClient.getVantanUserProfile(userId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[ostiarius] session check-in: vantan_user profile 取得失敗 (継続): ${msg}`);
    }
  }

  console.log(`[ostiarius] session check-in verified user=${userId} → attestation issued`);
  return { accessToken, attestation, profile };
}
