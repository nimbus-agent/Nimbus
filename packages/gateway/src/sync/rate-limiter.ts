/**
 * Shared token-bucket rate limiter per upstream provider.
 * One instance per Gateway process; injected via `SyncContext`.
 */

export type Provider =
  | "google"
  | "microsoft"
  | "slack"
  | "github"
  | "gitlab"
  | "bitbucket"
  | "linear"
  | "jira"
  | "notion"
  | "confluence"
  | "discord"
  | "jenkins"
  | "circleci"
  | "pagerduty"
  | "filesystem"
  | "kubernetes"
  | "aws"
  | "azure"
  | "gcp"
  | "iac"
  | "grafana"
  | "sentry"
  | "newrelic"
  | "datadog"
  | "snyk"
  | "bitrise"
  | "sonarqube"
  | "semgrep"
  | "wiz"
  | "launchdarkly"
  | "flagsmith"
  | "argocd"
  | "flux"
  | "dbt";

export interface ProviderQuota {
  requestsPerMinute: number;
  burstSize: number;
}

/** Conservative defaults; override via constructor or future `nimbus.toml` wiring. */
export const DEFAULT_QUOTAS: Record<Provider, ProviderQuota> = {
  google: { requestsPerMinute: 600, burstSize: 20 },
  microsoft: { requestsPerMinute: 600, burstSize: 20 },
  slack: { requestsPerMinute: 20, burstSize: 5 },
  github: { requestsPerMinute: 83, burstSize: 10 },
  gitlab: { requestsPerMinute: 120, burstSize: 10 },
  bitbucket: { requestsPerMinute: 60, burstSize: 5 },
  linear: { requestsPerMinute: 60, burstSize: 10 },
  jira: { requestsPerMinute: 60, burstSize: 10 },
  notion: { requestsPerMinute: 30, burstSize: 5 },
  confluence: { requestsPerMinute: 60, burstSize: 10 },
  discord: { requestsPerMinute: 50, burstSize: 10 },
  jenkins: { requestsPerMinute: 60, burstSize: 10 },
  circleci: { requestsPerMinute: 60, burstSize: 10 },
  pagerduty: { requestsPerMinute: 60, burstSize: 10 },
  filesystem: { requestsPerMinute: 120, burstSize: 20 },
  kubernetes: { requestsPerMinute: 60, burstSize: 10 },
  aws: { requestsPerMinute: 40, burstSize: 8 },
  azure: { requestsPerMinute: 40, burstSize: 8 },
  gcp: { requestsPerMinute: 40, burstSize: 8 },
  iac: { requestsPerMinute: 20, burstSize: 3 },
  grafana: { requestsPerMinute: 60, burstSize: 10 },
  sentry: { requestsPerMinute: 60, burstSize: 10 },
  newrelic: { requestsPerMinute: 60, burstSize: 10 },
  datadog: { requestsPerMinute: 60, burstSize: 10 },
  snyk: { requestsPerMinute: 60, burstSize: 10 },
  bitrise: { requestsPerMinute: 60, burstSize: 10 },
  sonarqube: { requestsPerMinute: 60, burstSize: 10 },
  semgrep: { requestsPerMinute: 60, burstSize: 10 },
  wiz: { requestsPerMinute: 60, burstSize: 10 },
  launchdarkly: { requestsPerMinute: 60, burstSize: 10 },
  flagsmith: { requestsPerMinute: 60, burstSize: 10 },
  argocd: { requestsPerMinute: 60, burstSize: 10 },
  flux: { requestsPerMinute: 60, burstSize: 10 },
  dbt: { requestsPerMinute: 60, burstSize: 10 },
};

type BucketState = {
  tokens: number;
  lastRefillMs: number;
  penaltyUntilMs: number;
  quota: ProviderQuota;
};

function sleepMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Serializes async work per provider so bucket math stays consistent with `penalise`. */
class ProviderMutex {
  private tail: Promise<void> = Promise.resolve();

  runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const ready = new Promise<void>((r) => {
      release = r;
    });
    const run = this.tail.then(() => ready).then(fn);
    this.tail = run.then(
      () => undefined,
      () => undefined,
    );
    queueMicrotask(release);
    return run;
  }
}

function mergeQuota(
  provider: Provider,
  overrides?: Partial<Record<Provider, ProviderQuota>>,
): ProviderQuota {
  const base = DEFAULT_QUOTAS[provider];
  const o = overrides?.[provider];
  if (o === undefined) {
    return { ...base };
  }
  return {
    requestsPerMinute: o.requestsPerMinute ?? base.requestsPerMinute,
    burstSize: o.burstSize ?? base.burstSize,
  };
}

function refill(state: BucketState, now: number): void {
  if (now < state.penaltyUntilMs) {
    return;
  }
  const elapsed = Math.max(0, now - state.lastRefillMs);
  const ratePerMs = state.quota.requestsPerMinute / 60_000;
  state.tokens = Math.min(state.quota.burstSize, state.tokens + elapsed * ratePerMs);
  state.lastRefillMs = now;
}

export class ProviderRateLimiter {
  private readonly states = new Map<Provider, BucketState>();
  private readonly mutexes = new Map<Provider, ProviderMutex>();

  constructor(quotaOverrides?: Partial<Record<Provider, ProviderQuota>>) {
    const now = Date.now();
    for (const p of Object.keys(DEFAULT_QUOTAS) as Provider[]) {
      const quota = mergeQuota(p, quotaOverrides);
      this.states.set(p, {
        tokens: quota.burstSize,
        lastRefillMs: now,
        penaltyUntilMs: 0,
        quota,
      });
    }
  }

  private mutexFor(provider: Provider): ProviderMutex {
    let m = this.mutexes.get(provider);
    if (m === undefined) {
      m = new ProviderMutex();
      this.mutexes.set(provider, m);
    }
    return m;
  }

  private stateFor(provider: Provider): BucketState {
    const s = this.states.get(provider);
    if (s === undefined) {
      throw new Error("Unknown rate-limit provider");
    }
    return s;
  }

  /**
   * Waits until `tokens` permits are available (default 1), then consumes them.
   * Call once per outbound HTTP batch for that provider.
   */
  async acquire(provider: Provider, tokens = 1): Promise<void> {
    if (!Number.isInteger(tokens) || tokens < 1) {
      throw new Error("acquire tokens must be a positive integer");
    }
    const state = this.stateFor(provider);
    if (tokens > state.quota.burstSize) {
      throw new Error("acquire exceeds provider burstSize");
    }
    await this.mutexFor(provider).runExclusive(async () => {
      await this.acquireUnderLock(provider, tokens);
    });
  }

  private async acquireUnderLock(provider: Provider, tokens: number): Promise<void> {
    const state = this.stateFor(provider);
    for (;;) {
      const now = Date.now();
      if (now < state.penaltyUntilMs) {
        await sleepMs(state.penaltyUntilMs - now);
        continue;
      }
      refill(state, now);
      if (state.tokens >= tokens) {
        state.tokens -= tokens;
        return;
      }
      const deficit = tokens - state.tokens;
      const ratePerMs = state.quota.requestsPerMinute / 60_000;
      const waitMs = Math.ceil(deficit / ratePerMs);
      await sleepMs(Math.max(1, waitMs));
    }
  }

  /**
   * Drains the bucket and blocks new acquires until `retryAfterMs` has elapsed (429 backoff).
   */
  penalise(provider: Provider, retryAfterMs: number): void {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      return;
    }
    void this.mutexFor(provider).runExclusive(async () => {
      const state = this.stateFor(provider);
      const now = Date.now();
      state.tokens = 0;
      state.penaltyUntilMs = Math.max(state.penaltyUntilMs, now + Math.floor(retryAfterMs));
      state.lastRefillMs = now;
    });
  }
}
