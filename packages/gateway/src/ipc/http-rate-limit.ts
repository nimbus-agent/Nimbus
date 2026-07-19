export interface HttpWriteRateLimitConfig {
  readonly maxRequests: number;
  readonly windowMs: number;
}

export interface RateLimitCheck {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetMs: number;
  readonly limit: number;
}

export class HttpWriteRateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly now: () => number;
  constructor(
    private readonly cfg: HttpWriteRateLimitConfig,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }

  /**
   * Consumes one slot for `fingerprint`. `maxRequests` is an optional per-route override that may
   * only *tighten* the configured limit (the effective limit is the smaller of the two) — a route
   * can never buy itself more headroom than the server was configured to allow. The returned
   * `limit` is the effective one, so the `X-RateLimit-*` headers always report what actually applied.
   */
  check(fingerprint: string, maxRequests?: number): RateLimitCheck {
    const effectiveMax = Math.min(this.cfg.maxRequests, maxRequests ?? Number.POSITIVE_INFINITY);
    const t = this.now();
    const cutoff = t - this.cfg.windowMs;
    const prev = this.hits.get(fingerprint) ?? [];
    const live = prev.filter((ts) => ts > cutoff);
    if (live.length >= effectiveMax) {
      const earliest = live[0] ?? t;
      return {
        allowed: false,
        remaining: 0,
        resetMs: earliest + this.cfg.windowMs,
        limit: effectiveMax,
      };
    }
    live.push(t);
    this.hits.set(fingerprint, live);
    return {
      allowed: true,
      remaining: effectiveMax - live.length,
      resetMs: (live[0] ?? t) + this.cfg.windowMs,
      limit: effectiveMax,
    };
  }
}
