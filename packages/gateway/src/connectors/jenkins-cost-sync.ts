// Phase 7 (the Cost Pack, slice 10; owner rulings 2026-11-28, D4 and D9): Jenkins build minutes as cost lines, for the
// Jenkins the owner already connected, once `[cost.jenkins]` exists, priced by the owner's `rate_per_minute` and
// `agent_rates` (unset: the lines are unpriced and every view says so).
//
// A companion of `jenkins` (`jenkins_billing`): it reads the Vault's `jenkins.base_url`, `jenkins.username` and
// `jenkins.api_token` through its shared-credential grant. The base host is the billing account. It lists the jobs,
// then each job's builds newest first, and sums each finished build's wall-clock minutes per UTC day of its END and
// per job and agent (`finops/jenkins-build-lines.ts`). Requests are in `jenkins-cost-fetch.ts`. A non-loopback
// `http` base is a stated gap BEFORE any request (D9): the token is never sent over plain http.
//
// The current UTC month, plus the previous month until the 5th or on the first sync, plus any month an earlier run
// could not finish (`cost-month-sync.ts`). Lines are written only through `replaceCostLinesForMonth` (D24), ONCE per
// (host, month). A job the listing no longer shows, or that Jenkins reports as gone, keeps its stored lines; a job
// whose builds were capped before the lookback is incomplete for the months its read does not reach (its stored
// lines are kept and one gap names it) without holding back the other jobs; a month that reads as empty although it
// holds lines is a `month_gap`, never a clear. When the configured rates differ from those recorded in the cursor,
// the stored lines are priced again first (`repriceOwnCostLines`, no API call).
import type { NimbusCostJenkinsConfig } from "../config/cost-jenkins-toml.ts";
import { type CostRates, costRatesFingerprint, rateKeyFor } from "../finops/cost-rate-price.ts";
import {
  COST_SYNC_CURSOR_PREFIXES,
  decodeCostSyncCursor,
  encodeCostSyncCursor,
} from "../finops/cost-source-gaps.ts";
import {
  JENKINS_COST_PROVIDER,
  JENKINS_COST_SOURCE,
  jenkinsBuildLines,
} from "../finops/jenkins-build-lines.ts";
import { stripTrailingSlashes } from "../string/strip-trailing-slashes.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { basicAuthHeader } from "./atlassian-api-sync-helpers.ts";
import {
  type CostMonthOutcome,
  costMonthsToFetch,
  own,
  runCostAccounts,
} from "./cost-month-sync.ts";
import {
  JENKINS_COST_GAPS,
  type JenkinsConn,
  type JenkinsFetch,
  type JenkinsJob,
  jenkinsJobBuilds,
  jenkinsJobList,
} from "./jenkins-cost-fetch.ts";
import { fetchSameOriginOnly } from "./same-origin-fetch.ts";

export const JENKINS_BILLING_SERVICE_ID = JENKINS_COST_SOURCE;
const DAY_MS = 86_400_000;
/**
 * Builds are listed newest first by number but counted by their END day, so the listing reaches this many days
 * before the earliest month: a build that started earlier and ends inside the month is not counted (a stated
 * bound; no boundary can guarantee it short of listing every build).
 */
export const JENKINS_BUILD_LOOKBACK_DAYS = 7;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.jenkins_billing;
const prev0 = () => ({ gaps: {}, synced: {}, pending: {} });

export type JenkinsCostSyncableOptions = {
  /**
   * `[cost.jenkins]`, read at every run so a config edit takes effect on the next one; null when the cost config
   * could not be read (the run then keeps its cursor whole: pending months and gaps survive the bad config).
   */
  readonly jenkins: () => NimbusCostJenkinsConfig | null;
  /** Test seams. */
  readonly now?: () => number;
  readonly fetch?: JenkinsFetch;
  readonly maxJobs?: number;
  readonly maxBuildPages?: number;
};

type HostData =
  | {
      readonly kind: "data";
      /** Every listed job (a job whose builds were unavailable is not in `read`). */
      readonly jobs: readonly JenkinsJob[];
      readonly read: {
        fullName: string;
        builds: unknown[];
        complete: boolean;
        oldestDay: string | null;
        gap: string | null;
      }[];
    }
  | Exclude<CostMonthOutcome, { kind: "ok" }>;

type RunState = {
  readonly c: JenkinsConn;
  readonly rates: CostRates;
  readonly today: string;
  readonly earliestMonth: (host: string) => string;
  readonly data: Map<string, HostData>;
};

/** The host's jobs and builds for this run, paged once down to the day before its earliest month. */
async function hostData(s: RunState, host: string): Promise<HostData> {
  const cached = s.data.get(host);
  if (cached !== undefined) return cached;
  const sinceMs =
    Date.parse(`${s.earliestMonth(host)}-01T00:00:00Z`) - JENKINS_BUILD_LOOKBACK_DAYS * DAY_MS;
  let out: HostData;
  const listing = await jenkinsJobList(s.c, host);
  if (listing.kind === "jobs") {
    out = { kind: "data", jobs: listing.jobs, read: [] };
    for (const job of listing.jobs) {
      const r = await jenkinsJobBuilds(s.c, host, job, sinceMs);
      if (r.kind === "unavailable") continue;
      if (r.kind !== "builds") {
        out = r;
        break;
      }
      out.read.push({
        fullName: job.fullName,
        builds: r.builds,
        complete: r.complete,
        oldestDay: r.oldestDay,
        gap: r.gap,
      });
    }
  } else {
    out = listing;
  }
  s.data.set(host, out);
  return out;
}

function write(
  s: RunState,
  host: string,
  month: string,
  lines: Parameters<SyncContext["replaceCostLinesForMonth"]>[1],
): CostMonthOutcome {
  try {
    s.c.ctx.replaceCostLinesForMonth(
      { provider: JENKINS_COST_PROVIDER, billingAccountId: host, month },
      lines,
    );
  } catch (e) {
    s.c.ctx.logger.warn(
      {
        serviceId: JENKINS_BILLING_SERVICE_ID,
        host,
        month,
        err: e instanceof Error ? e.message : String(e),
      },
      "jenkins_billing sync: the lines were refused; retrying next run",
    );
    return { kind: "retry" };
  }
  return { kind: "ok", lines: lines.length, bytes: 0 };
}

async function hostMonth(s: RunState, host: string, month: string): Promise<CostMonthOutcome> {
  const all = await hostData(s, host);
  if (all.kind !== "data") return all;
  // An empty listing is not a report of zero minutes: it must never clear a month that holds lines.
  const stored = s.c.ctx.readOwnCostLinesForMonth({
    provider: JENKINS_COST_PROVIDER,
    billingAccountId: host,
    month,
  });
  if (all.jobs.length === 0 && stored.length > 0) {
    return { kind: "month_gap", reason: JENKINS_COST_GAPS.noJobs(host) };
  }
  // A job whose builds were capped or refused is incomplete for the months its read does not reach: for those it
  // is treated like a job the listing no longer shows (its stored lines are kept) and says so in one gap, while
  // every other job is still written.
  const monthFloor = new Date(
    Date.parse(`${month}-01T00:00:00Z`) - JENKINS_BUILD_LOOKBACK_DAYS * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  const complete = all.read.filter(
    (r) => r.complete || (r.oldestDay !== null && r.oldestDay <= monthFloor),
  );
  const note = all.read
    .filter((r) => !complete.includes(r))
    .map((r) => r.gap)
    .filter((g): g is string => g !== null)
    .join("; ")
    .slice(0, 600);
  const mapped = jenkinsBuildLines(host, month, complete, s.rates, s.today);
  const read = new Set(complete.map((r) => r.fullName));
  const kept = stored.filter((l) => !read.has(String(l.subAccountId)));
  if (mapped.lines.length === 0 && stored.length > kept.length) {
    return { kind: "month_gap", reason: JENKINS_COST_GAPS.noBuilds(host, month) };
  }
  const dropped = Object.values(mapped.dropped).reduce((a, b) => a + b, 0);
  if (dropped > 0) {
    s.c.ctx.logger.info(
      { serviceId: JENKINS_BILLING_SERVICE_ID, host, month, ...mapped.dropped },
      "jenkins_billing sync: builds not counted (unfinished, unreadable duration, or outside the month)",
    );
  }
  const written = write(s, host, month, [...kept, ...mapped.lines]);
  return written.kind === "ok" && note !== "" ? { ...written, note } : written;
}

/** The base as `{ root, host }` when it is https (http only to this machine), else null. */
function safeBase(raw: string): { root: string; host: string } | null {
  let base: URL;
  try {
    base = new URL(raw);
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  const ok = base.protocol === "https:" || (base.protocol === "http:" && loopback);
  return ok ? { root: stripTrailingSlashes(raw), host: base.host } : null;
}

/** The Jenkins connector's base URL, user and token (trimmed) through the shared grant, or null when any is blank. */
async function readJenkinsCredential(
  ctx: SyncContext,
): Promise<{ base: string; user: string; token: string } | null> {
  const get = async (k: "base_url" | "username" | "api_token"): Promise<string> =>
    (await ctx.getSharedSecret("jenkins", k))?.trim() ?? "";
  const base = await get("base_url");
  const user = await get("username");
  const token = await get("api_token");
  return base === "" || user === "" || token === "" ? null : { base, user, token };
}

/** The host a gap names for a base that is not usable: its own host, else the generic name. */
function hostName(raw: string): string {
  try {
    const h = new URL(raw).host;
    return h === "" ? "jenkins" : h;
  } catch {
    return "jenkins";
  }
}

export function createJenkinsCostSyncable(options: JenkinsCostSyncableOptions): Syncable {
  const fetchFn = options.fetch ?? fetchSameOriginOnly;
  return {
    serviceId: JENKINS_BILLING_SERVICE_ID,
    defaultIntervalMs: DAY_MS,
    initialSyncDepthDays: 62,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const cfg = options.jenkins();
      if (cfg === null) {
        return syncPassCursorSuccess(t0, 0, cursor ?? encodeCostSyncCursor(PREFIX, prev0()), 0);
      }
      const prev = decodeCostSyncCursor(PREFIX, cursor);
      const recorded = prev.rates === undefined ? {} : { rates: prev.rates };
      const idle = (host: string | null, gaps: Record<string, string> = {}): SyncResult => {
        const keep = <T>(m: Readonly<Record<string, T>>): Record<string, T> => {
          const v = host === null ? undefined : own(m, host);
          return host !== null && v !== undefined ? { [host]: v } : {};
        };
        return syncPassCursorSuccess(
          t0,
          0,
          encodeCostSyncCursor(PREFIX, {
            gaps,
            synced: keep(prev.synced),
            pending: keep(prev.pending),
            ...recorded,
          }),
          0,
        );
      };
      if (!cfg.enabled) return idle(null);
      const cred = await readJenkinsCredential(ctx);
      // No credential: nothing is read, and the gaps recorded earlier are kept, not cleared.
      if (cred === null) {
        return syncPassCursorSuccess(t0, 0, cursor ?? encodeCostSyncCursor(PREFIX, prev0()), 0);
      }
      const base = safeBase(cred.base);
      if (base === null)
        return idle(null, { [hostName(cred.base)]: JENKINS_COST_GAPS.insecureBase });
      const keyed = (m: Readonly<Record<string, string>>): Record<string, string> => {
        const v = own(m, base.host);
        return v === undefined ? {} : { [base.host]: v };
      };
      const rates: CostRates = {
        ratePerMinute: cfg.ratePerMinute,
        currency: cfg.currency,
        keyedRates: cfg.agentRates.map((e): readonly [string, number] => [
          rateKeyFor("agent", e[0]),
          e[1],
        ]),
      };
      const fingerprint = costRatesFingerprint(rates);
      // No recorded fingerprint (a first run, or a cursor that did not decode) re-prices too: it is local and cheap,
      // and lines priced at an unknown rate must not stay as they are.
      if (prev.rates !== fingerprint) {
        try {
          const r = ctx.repriceOwnCostLines(rates);
          ctx.logger.info(
            { serviceId: JENKINS_BILLING_SERVICE_ID, ...r },
            "jenkins_billing sync: re-priced the stored lines",
          );
        } catch (e) {
          ctx.logger.warn(
            {
              serviceId: JENKINS_BILLING_SERVICE_ID,
              err: e instanceof Error ? e.message : String(e),
            },
            "jenkins_billing sync: re-pricing failed; retrying next run",
          );
          return idle(base.host, keyed(prev.gaps));
        }
      }
      const nowMs = (options.now ?? Date.now)();
      const state: RunState = {
        c: {
          ctx,
          fetchFn,
          base: base.root,
          auth: basicAuthHeader(cred.user, cred.token),
          ...(options.maxJobs === undefined ? {} : { maxJobs: options.maxJobs }),
          ...(options.maxBuildPages === undefined ? {} : { maxBuildPages: options.maxBuildPages }),
        },
        rates,
        today: new Date(nowMs).toISOString().slice(0, 10),
        earliestMonth: (host) => {
          const months = costMonthsToFetch(
            nowMs,
            own(prev.synced, host) === undefined,
            own(prev.pending, host) ?? [],
          );
          // `costMonthsToFetch` lists the months newest first and always holds the current one: the last is the earliest.
          return String(months.at(-1));
        },
        data: new Map(),
      };
      const run = await runCostAccounts(prev, [base.host], nowMs, (host, month) =>
        hostMonth(state, host, month),
      );
      return syncPassCursorSuccess(
        t0,
        run.bytes,
        encodeCostSyncCursor(PREFIX, { ...run.cursor, rates: fingerprint }),
        run.lines,
      );
    },
  };
}
