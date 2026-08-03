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
  | "blame"
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
  | "codemagic"
  | "testflight"
  | "firebase"
  | "sonarqube"
  | "semgrep"
  | "wiz"
  | "launchdarkly"
  | "flagsmith"
  | "argocd"
  | "flux"
  | "dbt"
  | "metabase"
  | "superset"
  | "databricks"
  | "mlflow"
  | "vercel"
  | "netlify"
  | "stripe"
  | "mercury"
  | "readwise"
  | "raindrop"
  | "intercom"
  | "zendesk"
  | "lever"
  | "greenhouse"
  | "pipedrive"
  | "stackoverflow"
  | "zotero"
  | "mendeley"
  | "dependencytrack"
  | "elasticsearch"
  | "airflow"
  | "prefect"
  | "dagster"
  | "ramp"
  | "zoom"
  | "hubspot"
  | "miro"
  | "canva"
  | "figma"
  | "salesforce"
  | "bigquery"
  | "athena"
  | "cloudwatch"
  | "sagemaker"
  | "cloud_logging"
  | "vertex_ai"
  | "imap"
  | "fastmail"
  | "protonmail"
  | "great_expectations"
  | "snowflake"
  | "tableau"
  | "looker"
  | "powerbi"
  | "montecarlo"
  | "bigeye"
  | "workday"
  | "apple";

export interface ProviderQuota {
  requestsPerMinute: number;
  burstSize: number;
}

export const DEFAULT_QUOTAS: Record<Provider, ProviderQuota> = {
  google: { requestsPerMinute: 600, burstSize: 20 },
  microsoft: { requestsPerMinute: 600, burstSize: 20 },
  slack: { requestsPerMinute: 20, burstSize: 5 },
  github: { requestsPerMinute: 83, burstSize: 10 },
  gitlab: { requestsPerMinute: 120, burstSize: 10 },
  bitbucket: { requestsPerMinute: 60, burstSize: 5 },
  linear: { requestsPerMinute: 60, burstSize: 10 },
  jira: { requestsPerMinute: 60, burstSize: 10 },
  notion: { requestsPerMinute: 120, burstSize: 5 },
  confluence: { requestsPerMinute: 60, burstSize: 10 },
  discord: { requestsPerMinute: 50, burstSize: 10 },
  jenkins: { requestsPerMinute: 60, burstSize: 10 },
  circleci: { requestsPerMinute: 60, burstSize: 10 },
  pagerduty: { requestsPerMinute: 60, burstSize: 10 },
  filesystem: { requestsPerMinute: 120, burstSize: 20 },
  blame: { requestsPerMinute: 120, burstSize: 20 },
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
  codemagic: { requestsPerMinute: 60, burstSize: 10 },
  testflight: { requestsPerMinute: 50, burstSize: 10 },
  firebase: { requestsPerMinute: 40, burstSize: 8 },
  sonarqube: { requestsPerMinute: 60, burstSize: 10 },
  semgrep: { requestsPerMinute: 60, burstSize: 10 },
  wiz: { requestsPerMinute: 60, burstSize: 10 },
  launchdarkly: { requestsPerMinute: 60, burstSize: 10 },
  flagsmith: { requestsPerMinute: 60, burstSize: 10 },
  argocd: { requestsPerMinute: 60, burstSize: 10 },
  flux: { requestsPerMinute: 60, burstSize: 10 },
  dbt: { requestsPerMinute: 60, burstSize: 10 },
  metabase: { requestsPerMinute: 60, burstSize: 10 },
  superset: { requestsPerMinute: 60, burstSize: 10 },
  databricks: { requestsPerMinute: 60, burstSize: 10 },
  mlflow: { requestsPerMinute: 60, burstSize: 10 },
  vercel: { requestsPerMinute: 60, burstSize: 10 },
  netlify: { requestsPerMinute: 60, burstSize: 10 },
  stripe: { requestsPerMinute: 60, burstSize: 10 },
  mercury: { requestsPerMinute: 60, burstSize: 10 },
  readwise: { requestsPerMinute: 60, burstSize: 10 },
  raindrop: { requestsPerMinute: 60, burstSize: 10 },
  intercom: { requestsPerMinute: 60, burstSize: 10 },
  zendesk: { requestsPerMinute: 60, burstSize: 10 },
  lever: { requestsPerMinute: 60, burstSize: 10 },
  greenhouse: { requestsPerMinute: 60, burstSize: 10 },
  pipedrive: { requestsPerMinute: 60, burstSize: 10 },
  stackoverflow: { requestsPerMinute: 60, burstSize: 10 },
  zotero: { requestsPerMinute: 60, burstSize: 10 },
  mendeley: { requestsPerMinute: 60, burstSize: 10 },
  dependencytrack: { requestsPerMinute: 60, burstSize: 10 },
  elasticsearch: { requestsPerMinute: 60, burstSize: 10 },
  airflow: { requestsPerMinute: 60, burstSize: 10 },
  prefect: { requestsPerMinute: 60, burstSize: 10 },
  dagster: { requestsPerMinute: 60, burstSize: 10 },
  ramp: { requestsPerMinute: 60, burstSize: 10 },
  zoom: { requestsPerMinute: 60, burstSize: 10 },
  hubspot: { requestsPerMinute: 100, burstSize: 10 },
  miro: { requestsPerMinute: 60, burstSize: 10 },
  canva: { requestsPerMinute: 60, burstSize: 10 },
  figma: { requestsPerMinute: 60, burstSize: 10 },
  salesforce: { requestsPerMinute: 60, burstSize: 10 },
  bigquery: { requestsPerMinute: 40, burstSize: 8 },
  athena: { requestsPerMinute: 40, burstSize: 8 },
  cloudwatch: { requestsPerMinute: 40, burstSize: 8 },
  sagemaker: { requestsPerMinute: 40, burstSize: 8 },
  cloud_logging: { requestsPerMinute: 40, burstSize: 8 },
  vertex_ai: { requestsPerMinute: 40, burstSize: 8 },
  great_expectations: { requestsPerMinute: 60, burstSize: 10 },
  imap: { requestsPerMinute: 60, burstSize: 10 },
  fastmail: { requestsPerMinute: 60, burstSize: 10 },
  protonmail: { requestsPerMinute: 60, burstSize: 10 },
  snowflake: { requestsPerMinute: 60, burstSize: 10 },
  tableau: { requestsPerMinute: 60, burstSize: 10 },
  looker: { requestsPerMinute: 60, burstSize: 10 },
  powerbi: { requestsPerMinute: 60, burstSize: 10 },
  montecarlo: { requestsPerMinute: 60, burstSize: 10 },
  bigeye: { requestsPerMinute: 60, burstSize: 10 },
  workday: { requestsPerMinute: 60, burstSize: 10 },
  // iCloud IMAP: Apple imposes no documented rate limit; 60 rpm / burst 10 is
  // conservative and consistent with the other IMAP-family connectors.
  apple: { requestsPerMinute: 60, burstSize: 10 },
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
  private readonly nowFn: () => number;

  constructor(
    quotaOverrides?: Partial<Record<Provider, ProviderQuota>>,
    now: () => number = () => Date.now(),
  ) {
    this.nowFn = now;
    const t = now();
    for (const p of Object.keys(DEFAULT_QUOTAS) as Provider[]) {
      const quota = mergeQuota(p, quotaOverrides);
      this.states.set(p, {
        tokens: quota.burstSize,
        lastRefillMs: t,
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
      const now = this.nowFn();
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

  penalise(provider: Provider, retryAfterMs: number): void {
    if (!Number.isFinite(retryAfterMs) || retryAfterMs < 0) {
      return;
    }
    void this.mutexFor(provider).runExclusive(async () => {
      const state = this.stateFor(provider);
      const now = this.nowFn();
      state.tokens = 0;
      state.penaltyUntilMs = Math.max(state.penaltyUntilMs, now + Math.floor(retryAfterMs));
      state.lastRefillMs = now;
    });
  }
}
