// Cernere のプロフィール顔写真・写真由来 pending テンプレート審査の HTTP 接点。
//
// 契約は Cernere#681 の実装に合わせる (推測しない):
//   - GET  /api/identity/face-photo/:userId
//       Cernere/server/src/http/face-photo-handler.ts:172-179 (scope face-photo:read)
//       応答は画像バイナリ (face-photo-handler.ts:149-156 の binary)。JSON ではない。
//   - POST /api/identity/face-template/:userId/promote
//       同 :196-215 / body {enrolledBy, facilityId, mode: 'reenroll' | 'promote-photo'}
//   - POST /api/identity/face-template/:userId/reject
//       同 :217-236 / body {enrolledBy, facilityId, reason} — reason は 1〜256 文字必須
//   いずれも scope が要る (face-photo:read / face-photo:manage)。Cernere の
//   service-scope-auth.ts:41-44 は project token を拒否するため、export 用の
//   project credential 由来Bearer（または固定tokenの代替経路）とは別の token を使う。
//
// 写真バイトはこのモジュールの戻り値としてのみ扱う。ファイルにも、ログにも、
// エラー文言にも載せない (biometric-data-policy §1.1)。

export interface CernerePhotoClientOptions {
  baseUrl: string;
  /** scope face-photo:read / face-photo:manage を持つ Bearer。 */
  token: string;
  facilityId: string;
  /** promote / reject の enrolledBy に載せる Cernere 上の審査者 userId。 */
  reviewerUserId: string;
}

export interface FacePhoto {
  bytes: Buffer;
  contentType: string;
}

export type PromoteMode = 'reenroll' | 'promote-photo';

/** 写真が無い状態と、通信できない状態を呼び出し側で区別できるようにする。 */
export type PhotoResult =
  | { kind: 'photo'; photo: FacePhoto }
  | { kind: 'absent' }
  | { kind: 'unavailable'; status: number };

export interface CernerePhotoClient {
  fetchPhoto(userId: string): Promise<PhotoResult>;
  promote(userId: string, mode: PromoteMode): Promise<boolean>;
  reject(userId: string, reason: string): Promise<boolean>;
}

/**
 * token / 審査者 userId が揃っていなければ null。 呼び出し側は審査経路そのものを
 * 公開しない (権限が無いまま画面だけ出して失敗させない)。
 */
export function createCernerePhotoClient(options: CernerePhotoClientOptions): CernerePhotoClient | null {
  if (!options.token || !options.reviewerUserId || !options.facilityId) return null;

  const authorized = (extra: Record<string, string> = {}): Record<string, string> => ({
    authorization: `Bearer ${options.token}`,
    ...extra,
  });

  const manage = async (userId: string, action: 'promote' | 'reject', body: Record<string, unknown>): Promise<boolean> => {
    const url = new URL(`/api/identity/face-template/${encodeURIComponent(userId)}/${action}`, options.baseUrl);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: authorized({ 'content-type': 'application/json' }),
        body: JSON.stringify({ enrolledBy: options.reviewerUserId, facilityId: options.facilityId, ...body }),
      });
      return response.ok;
    } catch {
      return false;
    }
  };

  return {
    async fetchPhoto(userId) {
      const url = new URL(`/api/identity/face-photo/${encodeURIComponent(userId)}`, options.baseUrl);
      try {
        const response = await fetch(url, { headers: authorized() });
        if (response.status === 404) return { kind: 'absent' };
        if (!response.ok) return { kind: 'unavailable', status: response.status };
        const bytes = Buffer.from(await response.arrayBuffer());
        return {
          kind: 'photo',
          photo: { bytes, contentType: response.headers.get('content-type') ?? 'image/jpeg' },
        };
      } catch {
        return { kind: 'unavailable', status: 503 };
      }
    },
    promote: (userId, mode) => manage(userId, 'promote', { mode }),
    reject: (userId, reason) => manage(userId, 'reject', { reason }),
  };
}
