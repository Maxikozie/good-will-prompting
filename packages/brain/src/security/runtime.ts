import { LIMITS } from './limits';
import { ResourceError } from './errors';

/** Deadline plus cancellation hook; attach both outcomes so a late rejection is never unhandled. */
export async function deadline<T>(operation: () => Promise<T>, ms: number, cancel?: () => void): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([Promise.resolve().then(operation), new Promise<never>((_, reject) => {
      timer = setTimeout(() => { try { cancel?.(); } finally { reject(new ResourceError(504, 'Operation timed out')); } }, ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

/** Shared by server instances in this process; callers cannot pick the principal or tool key. */
export class TokenBuckets {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(private readonly clock = () => performance.now(), private readonly burst = LIMITS.toolBurst, private readonly refill = LIMITS.toolRefillPerSecond) {}
  consume(principal: string, tool: string): void {
    const key = JSON.stringify([principal, tool]);
    const now = this.clock();
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= LIMITS.bucketEntries) {
        for (const [k, b] of this.buckets) if (now - b.at >= this.burst / this.refill * 1000) this.buckets.delete(k);
        if (this.buckets.size >= LIMITS.bucketEntries) throw new ResourceError(429, 'Rate limit exceeded');
      }
      bucket = { tokens: this.burst, at: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.burst, bucket.tokens + Math.max(0, now - bucket.at) * this.refill / 1000);
    bucket.at = now;
    if (bucket.tokens < 1) throw new ResourceError(429, 'Rate limit exceeded');
    bucket.tokens--;
  }
}
export const toolBuckets = new TokenBuckets();
