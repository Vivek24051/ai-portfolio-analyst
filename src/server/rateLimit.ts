// Fixed-window per-user rate limit to cap LLM spend from a single session.
// In-memory, so it is per server instance — adequate for the demo; a shared store (e.g. Upstash
// Redis or a Postgres counter) would be needed for a hard global limit at scale.

export class RateLimiter {
  private readonly hits = new Map<string, { windowStart: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** True if the key has used up its allowance in the current window (does not count a hit). */
  blocked(key: string, nowMs = Date.now()): boolean {
    const h = this.hits.get(key);
    return !!h && nowMs - h.windowStart < this.windowMs && h.count >= this.limit;
  }

  /** Returns true if allowed (and counts the hit). */
  take(key: string, nowMs = Date.now()): boolean {
    const h = this.hits.get(key);
    if (!h || nowMs - h.windowStart >= this.windowMs) {
      this.hits.set(key, { windowStart: nowMs, count: 1 });
      return true;
    }
    if (h.count >= this.limit) return false;
    h.count += 1;
    return true;
  }
}
