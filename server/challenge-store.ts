// challenge (nonce) の短命 in-memory ストア。
//
// CONTRACTS.md §3: /checkin/begin の challenge を TTL 2min で保持。
// 単一ゲートウェイ前提なので in-memory で十分 (再起動で消えてよい)。
// concurrent な begin を許すため challenge 値そのものをキーにする。

interface Entry {
  expiresAt: number;
}

export class ChallengeStore {
  private readonly map = new Map<string, Entry>();

  constructor(private readonly ttlMs: number) {}

  put(challenge: string): number {
    const expiresAt = Date.now() + this.ttlMs;
    this.map.set(challenge, { expiresAt });
    return expiresAt;
  }

  /** 存在し未失効なら true を返し、 1-shot で消費する (replay 防止)。 */
  consume(challenge: string): boolean {
    const e = this.map.get(challenge);
    if (!e) return false;
    this.map.delete(challenge);
    return e.expiresAt >= Date.now();
  }

  /** 失効済みエントリを掃除する (begin の度に呼ぶ程度で十分)。 */
  sweep(): void {
    const now = Date.now();
    for (const [k, v] of this.map) {
      if (v.expiresAt < now) this.map.delete(k);
    }
  }
}
