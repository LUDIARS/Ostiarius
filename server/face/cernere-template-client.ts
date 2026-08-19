// Cernere 顔テンプレートの書き込み接点 (同意記録 + テンプレート登録)。
//
// 職員立会い enroll (routes/identity-enroll.ts) と写真由来 pending の承認
// (face/review-service.ts) の両方が使うため、fetch をここ 1 箇所に閉じる。
//
// 契約: Cernere/server/src/http/face-template-handler.ts:54-63
//   - POST /api/identity/face-consent      -> { consentId, at }  ※生徒本人 token
//   - PUT  /api/identity/face-template     -> { version }
//     body {userId, template: base64(float32[512]), modelId, quality, facilityId, enrolledBy, consentId}
//     Cernere/server/src/identity/face-template-store.ts:104-141 は state='active' で保存する
//     (= 職員が撮ったテンプレートは審査済み扱い)。
//
// 埋め込み (template) は引数と body としてのみ扱い、ログには出さない。

import type { ServiceTokenProvider } from '../cernere-service-token.ts';

export interface CernereTemplateClientOptions {
  baseUrl: string;
  serviceToken: ServiceTokenProvider;
  facilityId: string;
}

export interface PutTemplateInput {
  userId: string;
  template: Float32Array;
  modelId: string;
  quality: number;
  /** Cernere 側で施設の審査者 role を持つ userId。 */
  enrolledBy: string;
  consentId: string;
}

export class CernereTemplateClient {
  constructor(private readonly options: CernereTemplateClientOptions) {}

  /**
   * 同意を記録して consentId を得る。失敗は null (呼び出し側が 503 に落とす)。
   *
   * 同意は本人しか記録できない (Cernere は authHeader の sub を同意者にする)。
   * kiosk は生徒の authCode を `POST /api/auth/code/exchange` で交換した
   * 短命 accessToken を渡す。service token では 401 になる。
   */
  async recordConsent(studentAccessToken: string, policyVersion: string): Promise<string | null> {
    try {
      const response = await fetch(`${this.options.baseUrl}/api/identity/face-consent`, {
        method: 'POST',
        headers: { authorization: `Bearer ${studentAccessToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ policyVersion, facilityId: this.options.facilityId }),
      });
      const body = await response.json() as { consentId?: unknown };
      return response.ok && typeof body.consentId === 'string' ? body.consentId : null;
    } catch {
      return null;
    }
  }

  /** テンプレートを登録する。true なら Cernere 側は state='active'。 */
  async putTemplate(input: PutTemplateInput): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.baseUrl}/api/identity/face-template`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${await this.options.serviceToken()}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          userId: input.userId,
          template: Buffer.from(input.template.buffer, input.template.byteOffset, input.template.byteLength).toString('base64'),
          modelId: input.modelId,
          quality: input.quality,
          facilityId: this.options.facilityId,
          enrolledBy: input.enrolledBy,
          consentId: input.consentId,
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }
}
