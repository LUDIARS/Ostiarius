// 会場登録で受け取った nonce の一回限り台帳 (メモリ上、再起動で消えてよい)。
//
// 現地確認 MFA と違い、会場登録は kiosk の前に立つ人と対応づけないので、同時に何件でも受ける
// (kiosk_busy の排他を持たない)。代わりに同じ nonce の再送だけを断る。
// 保持期間 (既定 10 分) は Cernere の venue challenge の寿命 (5 分) より長いので、盗聴した
// 要求を再送しても nonce_reused で断れる。Cernere 側も nonce を 1 回消費するので、ここは
// Os が同じ nonce で署名を重ねないための前段の防御。

export const VENUE_REGISTRATION_NONCE_RETENTION_MS = 10 * 60_000;

export interface VenueRegistrationNonceLedgerOptions {
  retentionMs?: number;
  now?: () => number;
}

export class VenueRegistrationNonceLedger {
  private readonly seenAt = new Map<string, number>();
  private readonly retentionMs: number;
  readonly now: () => number;

  constructor(options: VenueRegistrationNonceLedgerOptions = {}) {
    this.retentionMs = options.retentionMs ?? VENUE_REGISTRATION_NONCE_RETENTION_MS;
    this.now = options.now ?? Date.now;
  }

  /** 初めての nonce なら記録して true、保持期間内の再送なら false。 */
  claim(nonce: string): boolean {
    this.sweep();
    if (this.seenAt.has(nonce)) return false;
    this.seenAt.set(nonce, this.now());
    return true;
  }

  private sweep(): void {
    const now = this.now();
    for (const [nonce, seenAt] of this.seenAt) {
      if (seenAt + this.retentionMs <= now) this.seenAt.delete(nonce);
    }
  }
}
