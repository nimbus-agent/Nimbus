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

  check(fingerprint: string): RateLimitCheck {
    const t = this.now();
    const cutoff = t - this.cfg.windowMs;
    const prev = this.hits.get(fingerprint) ?? [];
    const live = prev.filter((ts) => ts > cutoff);
    if (live.length >= this.cfg.maxRequests) {
      const earliest = live[0] ?? t;
      return {
        allowed: false,
        remaining: 0,
        resetMs: earliest + this.cfg.windowMs,
        limit: this.cfg.maxRequests,
      };
    }
    live.push(t);
    this.hits.set(fingerprint, live);
    return {
      allowed: true,
      remaining: this.cfg.maxRequests - live.length,
      resetMs: (live[0] ?? t) + this.cfg.windowMs,
      limit: this.cfg.maxRequests,
    };
  }
}
