// C-18 hitRateLimit(buckets, key, now, policy)
//
// 窓内の要求数が上限を超えたら拒否し、再試行までの秒数 (1 以上) を返す。

import type { RateLimitBuckets, RateLimitPolicy, RateLimitResult } from '../server/http-security/rate-limit.ts';

export default {
  post: (result: RateLimitResult, buckets: RateLimitBuckets, key: string, now: number, policy: RateLimitPolicy) => {
    const bucket = buckets.get(key);
    if (!bucket) return 'the hit must be recorded for the key';
    if (bucket.windowStartedAt > now || now - bucket.windowStartedAt >= policy.windowMs) return 'the bucket window must contain now';
    if (result.allowed) return bucket.count <= policy.limit || 'a request above the limit was allowed';
    if (bucket.count <= policy.limit) return 'a request within the limit was rejected';
    return result.retryAfterSec >= 1 || 'a rejection must tell the client when to retry';
  },
};
