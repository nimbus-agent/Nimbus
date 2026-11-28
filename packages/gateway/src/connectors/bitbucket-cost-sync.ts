// Phase 7 (the Cost Pack, slice 9; owner rulings 2026-11-28): Bitbucket Pipelines minutes as cost lines, for the
// workspaces the owner lists in `[cost.bitbucket] workspaces` (nothing is fetched until that is set), priced by the
// owner's `rate_per_minute` and `size_rates` (unset: the lines are unpriced and every view says so).
//
// A companion of `bitbucket` (`bitbucket_billing`): it reads the Vault's Bitbucket credential (an Atlassian API
// token pair, or the deprecated app password pair) through its shared-credential grant. Per workspace (one billing
// account each) it lists the repositories, then each repository's pipelines newest first, and sums
// `build_seconds_used` per UTC day of `completed_on` and repository (`finops/bitbucket-pipeline-lines.ts`).
// Requests are in `bitbucket-cost-fetch.ts`.
//
// Per workspace: the current UTC month, plus the previous month until the 5th or on the workspace's first sync, plus
// any month an earlier run could not finish (`cost-month-sync.ts`). Lines are written only through
// `replaceCostLinesForMonth` (D24), ONCE per (workspace, month). A repository the listing no longer shows, or whose
// pipelines Bitbucket reports as not found, keeps its stored lines; a month that reads as empty although it holds
// lines is a `month_gap`, never a clear. When the configured rates differ from those recorded in the cursor, the
// stored lines are priced again first (`repriceOwnCostLines`, no API call).
import type { NimbusCostBitbucketConfig } from "../config/cost-bitbucket-toml.ts";
import {
  BITBUCKET_COST_PROVIDER,
  BITBUCKET_COST_SOURCE,
  bitbucketPipelineLines,
} from "../finops/bitbucket-pipeline-lines.ts";
import { type CostRates, costRatesFingerprint, rateKeyFor } from "../finops/cost-rate-price.ts";
import {
  COST_SYNC_CURSOR_PREFIXES,
  decodeCostSyncCursor,
  encodeCostSyncCursor,
} from "../finops/cost-source-gaps.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { basicAuthHeader } from "./atlassian-api-sync-helpers.ts";
import {
  BITBUCKET_COST_GAPS,
  type BitbucketConn,
  type BitbucketFetch,
  type BitbucketRepo,
  bitbucketRepoPipelines,
  bitbucketWorkspaceRepos,
} from "./bitbucket-cost-fetch.ts";
import { readBitbucketCredential } from "./bitbucket-credential.ts";
import {
  type CostMonthOutcome,
  costMonthsToFetch,
  own,
  runCostAccounts,
} from "./cost-month-sync.ts";
import { fetchSameOriginOnly } from "./same-origin-fetch.ts";

export const BITBUCKET_BILLING_SERVICE_ID = BITBUCKET_COST_SOURCE;
export const BITBUCKET_API_ROOT = "https://api.bitbucket.org/2.0";
const DAY_MS = 86_400_000;
/**
 * Pipelines are listed newest first by creation but counted by `completed_on`, so the listing reaches this many days
 * before the earliest month: a pipeline created earlier that completes inside the month is not counted (a stated
 * bound; no creation boundary can guarantee it short of listing every pipeline).
 */
export const BITBUCKET_PIPELINE_LOOKBACK_DAYS = 7;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.bitbucket_billing;
const prev0 = () => ({ gaps: {}, synced: {}, pending: {} });

export type BitbucketCostSyncableOptions = {
  /**
   * `[cost.bitbucket]`, read at every run so a config edit takes effect on the next one; null when the cost config
   * could not be read (the run then keeps its cursor whole: pending months and gaps survive the bad config).
   */
  readonly bitbucket: () => NimbusCostBitbucketConfig | null;
  /** Test seams. */
  readonly now?: () => number;
  readonly fetch?: BitbucketFetch;
  readonly apiRoot?: string;
  readonly maxPipelinePages?: number;
};

type WorkspaceData =
  | {
      readonly kind: "data";
      /** Every listed repository (a repository whose pipelines were unavailable is not in `read`). */
      readonly repos: readonly BitbucketRepo[];
      readonly read: { repoUuid: string; fullName: string; pipelines: unknown[] }[];
    }
  | Exclude<CostMonthOutcome, { kind: "ok" }>;

type RunState = {
  readonly c: BitbucketConn;
  readonly rates: CostRates;
  readonly today: string;
  /** Per workspace, the earliest month this run reads (`YYYY-MM`): pipelines are paged down to it ONCE. */
  readonly earliestMonth: (workspace: string) => string;
  readonly data: Map<string, WorkspaceData>;
};

/** A workspace's repositories and pipelines for this run, paged once down to the day before its earliest month. */
async function workspaceData(s: RunState, workspace: string): Promise<WorkspaceData> {
  const cached = s.data.get(workspace);
  if (cached !== undefined) return cached;
  const earliest = s.earliestMonth(workspace);
  const since = new Date(
    Date.parse(`${earliest}-01T00:00:00Z`) - BITBUCKET_PIPELINE_LOOKBACK_DAYS * DAY_MS,
  )
    .toISOString()
    .slice(0, 10);
  let out: WorkspaceData;
  const listing = await bitbucketWorkspaceRepos(s.c, workspace);
  if (listing.kind === "repos") {
    out = { kind: "data", repos: listing.repos, read: [] };
    for (const repo of listing.repos) {
      const r = await bitbucketRepoPipelines(s.c, workspace, repo, since, earliest);
      if (r.kind === "unavailable") continue;
      if (r.kind !== "pipelines") {
        out = r;
        break;
      }
      out.read.push({ repoUuid: repo.uuid, fullName: repo.fullName, pipelines: r.pipelines });
    }
  } else {
    out = listing;
  }
  s.data.set(workspace, out);
  return out;
}

function write(
  s: RunState,
  workspace: string,
  month: string,
  lines: Parameters<SyncContext["replaceCostLinesForMonth"]>[1],
): CostMonthOutcome {
  try {
    s.c.ctx.replaceCostLinesForMonth(
      { provider: BITBUCKET_COST_PROVIDER, billingAccountId: workspace, month },
      lines,
    );
  } catch (e) {
    s.c.ctx.logger.warn(
      {
        serviceId: BITBUCKET_BILLING_SERVICE_ID,
        workspace,
        month,
        err: e instanceof Error ? e.message : String(e),
      },
      "bitbucket_billing sync: the lines were refused; retrying next run",
    );
    return { kind: "retry" };
  }
  return { kind: "ok", lines: lines.length, bytes: 0 };
}

async function workspaceMonth(
  s: RunState,
  workspace: string,
  month: string,
): Promise<CostMonthOutcome> {
  const all = await workspaceData(s, workspace);
  if (all.kind !== "data") return all;
  // An empty listing is not a report of zero minutes: it must never clear a month that holds lines.
  const stored = s.c.ctx.readOwnCostLinesForMonth({
    provider: BITBUCKET_COST_PROVIDER,
    billingAccountId: workspace,
    month,
  });
  if (all.repos.length === 0 && stored.length > 0) {
    return { kind: "month_gap", reason: BITBUCKET_COST_GAPS.noRepos(workspace) };
  }
  const mapped = bitbucketPipelineLines(workspace, month, all.read, s.rates, s.today);
  // A repository the listing no longer shows (the token lost it, it moved away), or whose pipelines were not
  // available, keeps its stored lines: the month is replaced only for the repositories whose pipelines were read.
  const read = new Set(all.read.map((r) => r.repoUuid));
  const kept = stored.filter((l) => l.subAccountId === null || !read.has(l.subAccountId));
  if (mapped.lines.length === 0 && stored.length > kept.length) {
    return { kind: "month_gap", reason: BITBUCKET_COST_GAPS.noPipelines(workspace, month) };
  }
  const dropped = Object.values(mapped.dropped).reduce((a, b) => a + b, 0);
  if (dropped > 0) {
    s.c.ctx.logger.info(
      { serviceId: BITBUCKET_BILLING_SERVICE_ID, workspace, month, ...mapped.dropped },
      "bitbucket_billing sync: pipelines not counted (unfinished, unreadable seconds, or outside the month)",
    );
  }
  return write(s, workspace, month, [...kept, ...mapped.lines]);
}

/** The API root when it is https (http only to this machine), else null. */
function safeRoot(root: string): string | null {
  let base: URL;
  try {
    base = new URL(root);
  } catch {
    return null;
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  const ok = base.protocol === "https:" || (base.protocol === "http:" && loopback);
  return ok ? root.replace(/\/+$/, "") : null;
}

export function createBitbucketCostSyncable(options: BitbucketCostSyncableOptions): Syncable {
  const fetchFn = options.fetch ?? fetchSameOriginOnly;
  return {
    serviceId: BITBUCKET_BILLING_SERVICE_ID,
    defaultIntervalMs: DAY_MS,
    initialSyncDepthDays: 62,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const cfg = options.bitbucket();
      if (cfg === null) {
        return syncPassCursorSuccess(t0, 0, cursor ?? encodeCostSyncCursor(PREFIX, prev0()), 0);
      }
      const workspaces = cfg.workspaces;
      const prev = decodeCostSyncCursor(PREFIX, cursor);
      const keep = <T>(m: Readonly<Record<string, T>>): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const w of workspaces) {
          const v = own(m, w);
          if (v !== undefined) out[w] = v;
        }
        return out;
      };
      const rates: CostRates = {
        ratePerMinute: cfg.ratePerMinute,
        currency: cfg.currency,
        keyedRates: cfg.sizeRates.map((e): readonly [string, number] => [
          rateKeyFor("size", e[0]),
          e[1],
        ]),
      };
      const recorded = prev.rates === undefined ? {} : { rates: prev.rates };
      const idle = (gaps: Record<string, string> = {}): SyncResult =>
        syncPassCursorSuccess(
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
      if (workspaces.length === 0) return idle();
      const cred = await readBitbucketCredential((k) => ctx.getSharedSecret("bitbucket", k));
      // No credential: nothing is read, and the gaps recorded earlier are kept, not cleared.
      if (cred.kind === "none") return idle(keep(prev.gaps));
      // The credential is sent only over https (http only to this machine), whatever root a test points at.
      const apiRoot = safeRoot(options.apiRoot ?? BITBUCKET_API_ROOT);
      if (apiRoot === null) {
        return idle(
          Object.fromEntries(workspaces.map((w) => [w, BITBUCKET_COST_GAPS.insecureBase])),
        );
      }
      const fingerprint = costRatesFingerprint(rates);
      // No recorded fingerprint (a first run, or a cursor that did not decode) re-prices too: it is local and cheap,
      // and lines priced at an unknown rate must not stay as they are.
      if (prev.rates !== fingerprint) {
        try {
          const r = ctx.repriceOwnCostLines(rates);
          ctx.logger.info(
            { serviceId: BITBUCKET_BILLING_SERVICE_ID, ...r },
            "bitbucket_billing sync: re-priced the stored lines",
          );
        } catch (e) {
          ctx.logger.warn(
            {
              serviceId: BITBUCKET_BILLING_SERVICE_ID,
              err: e instanceof Error ? e.message : String(e),
            },
            "bitbucket_billing sync: re-pricing failed; retrying next run",
          );
          return idle(keep(prev.gaps));
        }
      }
      const nowMs = (options.now ?? Date.now)();
      const state: RunState = {
        c: {
          ctx,
          fetchFn,
          apiRoot,
          auth: basicAuthHeader(cred.user, cred.secret),
          ...(options.maxPipelinePages === undefined
            ? {}
            : { maxPipelinePages: options.maxPipelinePages }),
        },
        rates,
        today: new Date(nowMs).toISOString().slice(0, 10),
        earliestMonth: (workspace) => {
          const months = costMonthsToFetch(
            nowMs,
            own(prev.synced, workspace) === undefined,
            own(prev.pending, workspace) ?? [],
          );
          return [...months].sort(codeUnitCompare)[0] ?? new Date(nowMs).toISOString().slice(0, 7);
        },
        data: new Map(),
      };
      const run = await runCostAccounts(prev, workspaces, nowMs, (workspace, month) =>
        workspaceMonth(state, workspace, month),
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
