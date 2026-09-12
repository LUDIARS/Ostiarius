// Cernere の **同意記録** の HTTP 接点。
//
// 2026-09-12 (spec/plan/face-data-local-only.md §2): 顔テンプレート・顔写真は Cernere に
// 置かないので、`PUT /api/identity/face-template` は廃止した。Cernere に残る顔まわりの
// 書き込みは「同意の記録」と「同意の撤回」だけで、どちらも生体情報を運ばない。
//
// 契約 (spec/interface/cernere-face-template.md §A):
//   - POST /api/identity/face-consent        -> { consentId, at }  ※生徒本人 token
//   - POST /api/identity/face-consent/revoke -> 204/200            ※service token
//
// 同意は本人しか記録できない (Cernere は authHeader の sub を同意者にする)。
// kiosk は生徒の authCode を `POST /api/auth/code/exchange` で交換した短命
// accessToken を渡す。service token では 401 になる。

import type { ServiceTokenProvider } from '../cernere-service-token.ts';

export interface CernereConsentClientOptions {
  baseUrl: string;
  serviceToken: ServiceTokenProvider;
  facilityId: string;
}

export interface RecordedConsent {
  consentId: string;
  /** Cernere が実際に受理した版 (新版を拒否されたら fallback 版になる)。 */
  policyVersion: string;
  at: number;
}

export interface RevokeConsentInput {
  userId: string;
  consentId: string | null;
  /** 立ち会った職員 (Cernere 側の audit に残る)。 */
  revokedBy: string;
}

/** Cernere が版そのものを知らないときだけ次の版へ落とす (認可・通信の失敗では落とさない)。 */
function isUnknownPolicyVersion(status: number): boolean {
  return status === 400 || status === 404 || status === 422;
}

/**
 * 同意の記録・撤回だけを担う Cernere クライアント (生体情報は運ばない)。
 *
 * @implements spec/plan/biometric-data-policy.md#4-同意
 */
export class CernereConsentClient {
  /** @implements spec/plan/biometric-data-policy.md#4-同意 */
  constructor(private readonly options: CernereConsentClientOptions) {}

  /**
   * 同意を記録して consentId を得る。失敗は null (呼び出し側が 503 に落とす)。
   *
   * `policyVersions` は新しい版から順に試す。Cernere がまだ新版を知らない場合に
   * 同意経路そのものを止めないための後方互換 (受理された版を戻り値で返す)。
   */
  /** @implements spec/plan/biometric-data-policy.md#4-同意 */
  async recordConsent(
    studentAccessToken: string,
    policyVersions: readonly string[],
  ): Promise<RecordedConsent | null> {
    for (const policyVersion of policyVersions) {
      try {
        const response = await fetch(`${this.options.baseUrl}/api/identity/face-consent`, {
          method: 'POST',
          headers: { authorization: `Bearer ${studentAccessToken}`, 'content-type': 'application/json' },
          body: JSON.stringify({ policyVersion, facilityId: this.options.facilityId }),
        });
        if (!response.ok) {
          if (isUnknownPolicyVersion(response.status)) continue;
          return null;
        }
        const body = await response.json() as { consentId?: unknown; at?: unknown };
        if (typeof body.consentId !== 'string') return null;
        return {
          consentId: body.consentId,
          policyVersion,
          at: typeof body.at === 'number' ? body.at : Date.now(),
        };
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * kiosk 上で本人が (職員立会いで) 登録を消したことを Cernere の同意へ反映する。
   * ローカル削除は先に完了させ、この呼び出しは outbox で再送する。
   */
  async revokeConsent(input: RevokeConsentInput): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.baseUrl}/api/identity/face-consent/revoke`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.options.serviceToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: input.userId,
          consentId: input.consentId,
          facilityId: this.options.facilityId,
          revokedBy: input.revokedBy,
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
