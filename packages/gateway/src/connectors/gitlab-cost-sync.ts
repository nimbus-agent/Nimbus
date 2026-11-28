// Phase 7 (the Cost Pack, slice 8; owner rulings 2026-11-28): GitLab compute minutes as cost lines, for the
// groups the owner lists in `[cost.gitlab] groups` (nothing is fetched until that is set), priced by the owner's
// `rate_per_minute` (unset: the lines are unpriced and every view says so).
//
// A companion of `gitlab` (`gitlab_billing`): it reads the Vault's `gitlab.pat` and `gitlab.api_base` through its
// shared-credential grant. The base decides the path: GitLab.com reads each group's per-project month-to-date
// minutes and stores daily deltas (`finops/gitlab-minutes-lines.ts`); a self-managed instance sums its jobs'
// durations per day, project and runner (`finops/gitlab-job-lines.ts`). Requests are in `gitlab-cost-fetch.ts`.
//
// Per group (one billing account each): the current UTC month, plus the previous month until the 5th or on the
// group's first sync, plus any month an earlier run could not finish (`cost-month-sync.ts`). Lines are written
// only through `replaceCostLinesForMonth` (D24). When the configured rates differ from those recorded in the
// cursor, the stored lines are priced again first (`repriceOwnCostLines`, no API call).

import type { NimbusCostGitlabConfig } from "../config/cost-gitlab-toml.ts";
import { type CostRates, costRatesFingerprint } from "../finops/cost-rate-price.ts";
import {
  COST_SYNC_CURSOR_PREFIXES,
  decodeCostSyncCursor,
  encodeCostSyncCursor,
} from "../finops/cost-source-gaps.ts";
import { gitlabJobLines } from "../finops/gitlab-job-lines.ts";
import {
  GITLAB_COST_PROVIDER,
  GITLAB_COST_SOURCE,
  gitlabMinutesLines,
  gitlabObservedDay,
} from "../finops/gitlab-minutes-lines.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { normalisedApiBase } from "./_lib/gitlab/events.ts";
import {
  type CostMonthOutcome,
  costMonthsToFetch,
  own,
  runCostAccounts,
} from "./cost-month-sync.ts";
import {
  GITLAB_COST_GAPS,
  type GitlabConn,
  type GitlabFetch,
  gitlabGroupId,
  gitlabGroupProjects,
  gitlabMonthUsage,
  gitlabProjectJobs,
} from "./gitlab-cost-fetch.ts";
import { fetchSameOriginOnly } from "./same-origin-fetch.ts";

export const GITLAB_BILLING_SERVICE_ID = GITLAB_COST_SOURCE;
const DAY_MS = 86_400_000;
/**
 * Jobs are listed newest first by id (creation order) but counted by `finished_at`, so the listing reaches this many
 * days before the earliest month: a job created earlier that finishes inside the month is not counted (a stated
 * bound; no creation boundary can guarantee it short of listing every job).
 */
export const GITLAB_JOB_LOOKBACK_DAYS = 7;
const PREFIX = COST_SYNC_CURSOR_PREFIXES.gitlab_billing;
const prev0 = () => ({ gaps: {}, synced: {}, pending: {} });

export type GitlabCostSyncableOptions = {
  /**
   * `[cost.gitlab]`, read at every run so a config edit takes effect on the next one; null when the cost config
   * could not be read (the run then keeps its cursor whole: pending months and gaps survive the bad config).
   */
  readonly gitlab: () => NimbusCostGitlabConfig | null;
  /** Test seams. */
  readonly now?: () => number;
  readonly fetch?: GitlabFetch;
  readonly maxJobPages?: number;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** One usage node as `{ projectId, projectFullPath, minutes }`, or null when it is not the documented shape. */
function usageOf(
  n: unknown,
): { projectId: string; projectFullPath: string; minutes: number } | null {
  if (!isRecord(n) || !isRecord(n["project"])) return null;
  const path = n["project"]["fullPath"];
  const minutes = n["minutes"];
  if (typeof path !== "string" || path.length === 0) return null;
  if (typeof minutes !== "number" || !Number.isFinite(minutes) || minutes < 0) return null;
  const id = n["project"]["id"];
  if (typeof id !== "string" || id.length === 0) return null;
  return { projectId: id, projectFullPath: path, minutes };
}

type RunState = {
  readonly c: GitlabConn;
  readonly rates: CostRates;
  readonly today: string;
  readonly groupIds: Map<string, string>;
  /** Per group, the earliest month this run reads (`YYYY-MM`): jobs are paged down to it ONCE. */
  readonly earliestMonth: (group: string) => string;
  /** Per group, every project's jobs down to the earliest month, or why they could not be read. */
  readonly jobs: Map<string, GroupJobs>;
};

type GroupJobs =
  | { readonly kind: "jobs"; readonly perProject: { projectFullPath: string; jobs: unknown[] }[] }
  | Exclude<CostMonthOutcome, { kind: "ok" }>;

/** A group's jobs for this run, paged once down to the day before its earliest month. */
async function groupJobs(s: RunState, group: string): Promise<GroupJobs> {
  const cached = s.jobs.get(group);
  if (cached !== undefined) return cached;
  const earliest = s.earliestMonth(group);
  const since = new Date(Date.parse(`${earliest}-01T00:00:00Z`) - GITLAB_JOB_LOOKBACK_DAYS * DAY_MS)
    .toISOString()
    .slice(0, 10);
  let out: GroupJobs = { kind: "jobs", perProject: [] };
  const projects = await gitlabGroupProjects(s.c, group);
  if (projects.kind === "projects") {
    const perProject: { projectFullPath: string; jobs: unknown[] }[] = [];
    for (const p of projects.projects) {
      const r = await gitlabProjectJobs(s.c, group, p, since, earliest);
      if (r.kind !== "jobs") {
        out = r;
        break;
      }
      perProject.push({ projectFullPath: p.fullPath, jobs: r.jobs });
    }
    if (out.kind === "jobs") out = { kind: "jobs", perProject };
  } else {
    out = projects;
  }
  s.jobs.set(group, out);
  return out;
}

function write(
  s: RunState,
  group: string,
  month: string,
  lines: Parameters<SyncContext["replaceCostLinesForMonth"]>[1],
): CostMonthOutcome {
  try {
    s.c.ctx.replaceCostLinesForMonth(
      { provider: GITLAB_COST_PROVIDER, billingAccountId: group, month },
      lines,
    );
  } catch (e) {
    s.c.ctx.logger.warn(
      {
        serviceId: GITLAB_BILLING_SERVICE_ID,
        group,
        month,
        err: e instanceof Error ? e.message : String(e),
      },
      "gitlab_billing sync: the lines were refused; retrying next run",
    );
    return { kind: "retry" };
  }
  return { kind: "ok", lines: lines.length, bytes: 0 };
}

async function dotComMonth(s: RunState, group: string, month: string): Promise<CostMonthOutcome> {
  let id = s.groupIds.get(group);
  if (id === undefined) {
    const r = await gitlabGroupId(s.c, group);
    if (r.kind !== "id") return r;
    id = r.id;
    s.groupIds.set(group, id);
  }
  const usage = await gitlabMonthUsage(s.c, group, id, month);
  if (usage.kind !== "nodes") return usage;
  const fetched = usage.nodes.map(usageOf);
  const bad = fetched.filter((u) => u === null).length;
  // A month is written whole or not at all: an unreadable node would silently lower it.
  if (bad > 0) {
    return {
      kind: "month_gap",
      reason: `${String(bad)} of GitLab's ${month} usage rows for ${group} could not be read; that month was not updated`,
    };
  }
  const target = { provider: GITLAB_COST_PROVIDER, billingAccountId: group, month };
  const mapped = gitlabMinutesLines({
    account: group,
    month,
    observedDay: gitlabObservedDay(month, s.today),
    fetched: fetched.filter((u) => u !== null),
    stored: s.c.ctx.readOwnCostLinesForMonth(target),
    rates: s.rates,
  });
  if (mapped.restated.length > 0) {
    s.c.ctx.logger.warn(
      { serviceId: GITLAB_BILLING_SERVICE_ID, group, month, restated: mapped.restated },
      "gitlab_billing sync: a month-to-date total fell; the latest earlier days were lowered",
    );
  }
  return write(s, group, month, mapped.lines);
}

async function selfManagedMonth(
  s: RunState,
  group: string,
  month: string,
): Promise<CostMonthOutcome> {
  const all = await groupJobs(s, group);
  if (all.kind !== "jobs") return all;
  const perProject = all.perProject;
  // An empty listing is not a report of zero minutes: it must never clear a month that holds lines.
  const stored = s.c.ctx.readOwnCostLinesForMonth({
    provider: GITLAB_COST_PROVIDER,
    billingAccountId: group,
    month,
  });
  if (perProject.length === 0 && stored.length > 0) {
    return { kind: "month_gap", reason: GITLAB_COST_GAPS.noProjects(group) };
  }
  const mapped = gitlabJobLines(group, month, perProject, s.rates, s.today);
  // A project the listing no longer shows (the token lost it, it moved away) keeps its stored lines: the month is
  // replaced only for the projects whose jobs were read.
  const listed = new Set(perProject.map((p) => p.projectFullPath));
  const kept = stored.filter((l) => l.subAccountId === null || !listed.has(l.subAccountId));
  const dropped = Object.values(mapped.dropped).reduce((a, b) => a + b, 0);
  if (dropped > 0) {
    s.c.ctx.logger.info(
      { serviceId: GITLAB_BILLING_SERVICE_ID, group, month, ...mapped.dropped },
      "gitlab_billing sync: jobs not counted (no runner, unfinished, or outside the month)",
    );
  }
  return write(s, group, month, [...kept, ...mapped.lines]);
}

export function createGitlabCostSyncable(options: GitlabCostSyncableOptions): Syncable {
  const fetchFn = options.fetch ?? fetchSameOriginOnly;
  return {
    serviceId: GITLAB_BILLING_SERVICE_ID,
    defaultIntervalMs: DAY_MS,
    initialSyncDepthDays: 62,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const cfg = options.gitlab();
      if (cfg === null) {
        return syncPassCursorSuccess(t0, 0, cursor ?? encodeCostSyncCursor(PREFIX, prev0()), 0);
      }
      const groups = cfg.groups;
      const prev = decodeCostSyncCursor(PREFIX, cursor);
      const keep = <T>(m: Readonly<Record<string, T>>): Record<string, T> => {
        const out: Record<string, T> = {};
        for (const g of groups) {
          const v = own(m, g);
          if (v !== undefined) out[g] = v;
        }
        return out;
      };
      const rates: CostRates = {
        ratePerMinute: cfg.ratePerMinute,
        currency: cfg.currency,
        runnerRates: cfg.runnerRates,
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
      if (groups.length === 0) return idle();
      const pat = (await ctx.getSharedSecret("gitlab", "pat"))?.trim() ?? "";
      // No token: nothing is read, and the gaps recorded earlier are kept, not cleared.
      if (pat === "") return idle(keep(prev.gaps));
      const apiBase = normalisedApiBase(await ctx.getSharedSecret("gitlab", "api_base"));
      const dotCom = new URL(apiBase).host === "gitlab.com";
      if (dotCom && cfg.runnerRates.length > 0) {
        return idle(
          Object.fromEntries(groups.map((g) => [g, GITLAB_COST_GAPS.runnerRatesOnDotCom])),
        );
      }
      const fingerprint = costRatesFingerprint(rates);
      // No recorded fingerprint (a first run, or a cursor that did not decode) re-prices too: it is local and cheap,
      // and lines priced at an unknown rate must not stay as they are.
      if (prev.rates !== fingerprint) {
        try {
          const r = ctx.repriceOwnCostLines(rates);
          ctx.logger.info(
            { serviceId: GITLAB_BILLING_SERVICE_ID, ...r },
            "gitlab_billing sync: re-priced the stored lines",
          );
        } catch (e) {
          ctx.logger.warn(
            {
              serviceId: GITLAB_BILLING_SERVICE_ID,
              err: e instanceof Error ? e.message : String(e),
            },
            "gitlab_billing sync: re-pricing failed; retrying next run",
          );
          return idle(keep(prev.gaps));
        }
      }
      const nowMs = (options.now ?? Date.now)();
      const state: RunState = {
        c: {
          ctx,
          fetchFn,
          apiBase,
          pat,
          ...(options.maxJobPages === undefined ? {} : { maxJobPages: options.maxJobPages }),
        },
        rates,
        today: new Date(nowMs).toISOString().slice(0, 10),
        groupIds: new Map(),
        earliestMonth: (group) => {
          const months = costMonthsToFetch(
            nowMs,
            own(prev.synced, group) === undefined,
            own(prev.pending, group) ?? [],
          );
          return [...months].sort(codeUnitCompare)[0] ?? new Date(nowMs).toISOString().slice(0, 7);
        },
        jobs: new Map(),
      };
      const run = await runCostAccounts(prev, groups, nowMs, (group, month) =>
        dotCom ? dotComMonth(state, group, month) : selfManagedMonth(state, group, month),
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
