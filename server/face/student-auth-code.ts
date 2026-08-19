// 生徒本人の authCode を Cernere に交換させる 1 箇所。
//
// 契約: Cernere/spec/interface/auth-flows.md 「共通: kiosk 向け限定交換」
//   POST /api/auth/code/exchange (service Bearer) -> { userId, accessToken, expiresIn }
// 無認可の /api/auth/exchange と違い refreshToken は返らない。accessToken は
// 同意記録 (本人 token 必須) にだけ使い、共有端末へ保存しない。
//
// 職員立会い enroll (routes/identity-enroll.ts) と撮り直し承認
// (routes/identity-review.ts) の両方が使うため fetch をここに閉じる。

import type { ServiceTokenProvider } from '../cernere-service-token.ts';

export interface StudentAuthCodeOptions {
  baseUrl: string;
  serviceToken: ServiceTokenProvider;
}

export interface ResolvedStudent {
  userId: string;
  /** 同意記録用の短命 token。local mode では null。 */
  accessToken: string | null;
}

export async function exchangeStudentAuthCode(code: unknown, options: StudentAuthCodeOptions): Promise<ResolvedStudent | null> {
  if (typeof code !== 'string' || !code) return null;
  try {
    const response = await fetch(`${options.baseUrl}/api/auth/code/exchange`, {
      method: 'POST',
      headers: { authorization: `Bearer ${await options.serviceToken()}`, 'content-type': 'application/json' },
      body: JSON.stringify({ code }),
    });
    const body = await response.json() as { userId?: unknown; accessToken?: unknown; expiresIn?: unknown };
    // kiosk の enrollment session は最長 10 分なので、Cernere の契約どおり
    // 15 分 token だけを受け入れる。想定外に長寿命な資格情報を共有端末へ
    // 持ち込ませない。
    if (
      !response.ok
      || typeof body.userId !== 'string'
      || typeof body.accessToken !== 'string'
      || body.expiresIn !== 15 * 60
    ) return null;
    return { userId: body.userId, accessToken: body.accessToken };
  } catch {
    return null;
  }
}
