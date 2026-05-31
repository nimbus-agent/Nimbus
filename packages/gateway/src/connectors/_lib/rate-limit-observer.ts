export interface RateLimitSnapshot {
  readonly remaining: number;
  readonly resetAtMs: number;
}

export interface RateLimitObserver {
  observe(headers: Headers): RateLimitSnapshot | null;
}

export class GithubStyleHeaders implements RateLimitObserver {
  observe(headers: Headers): RateLimitSnapshot | null {
    const rem = headers.get("X-RateLimit-Remaining") ?? headers.get("x-ratelimit-remaining");
    const reset = headers.get("X-RateLimit-Reset") ?? headers.get("x-ratelimit-reset");
    if (rem === null || reset === null) return null;
    const r = Number.parseInt(rem, 10);
    const resetSec = Number.parseInt(reset, 10);
    if (Number.isNaN(r) || Number.isNaN(resetSec)) return null;
    return { remaining: r, resetAtMs: resetSec * 1000 };
  }
}

export class RetryAfterHeader implements RateLimitObserver {
  observe(headers: Headers): RateLimitSnapshot | null {
    const v = headers.get("Retry-After") ?? headers.get("retry-after");
    if (v === null) return null;
    const sec = Number.parseInt(v, 10);
    if (Number.isNaN(sec)) return null;
    return { remaining: 0, resetAtMs: Date.now() + sec * 1000 };
  }
}

export class NoopObserver implements RateLimitObserver {
  observe(_headers: Headers): RateLimitSnapshot | null {
    return null;
  }
}
