// Phase 7 (the Cost Pack, slice 5): GitHub's metered billing usage as cost lines, for the organizations the
// owner lists in `[cost.github] orgs` (owner ruling 4: nothing is fetched until that is set).
//
// `GET /organizations/{org}/settings/billing/usage?year=&month=` — documentation-verified only. It serves only
// organizations on GitHub's enhanced billing platform, to an org owner or billing manager, and only on
// github.com (a GitHub Enterprise Server base is a stated gap: no request is made with that token). The PAT is
// the Vault's `github.pat`, read through this service's shared-credential grant (owner ruling 3).
//
// Per org: the current UTC month, plus the previous month until the 5th (GitHub restates days of a month that
// just closed) or on the org's first sync. Rows become lines through the pure mapper
// (`finops/github-billing-lines.ts`) and are written only through `replaceCostLinesForMonth` (D24), which
// binds the source to this service. The cursor codec lives in `finops/cost-source-gaps.ts`, which also
// reads the gaps for the cost views. A 403 without rate-limit headers or a 404 is a GAP for that org (kept in
// the cursor and shown in every cost view's freshness), never a retry loop; a rate-limit 403 penalises
// the shared `github` limiter; a 5xx writes nothing and the next daily run tries again.
import {
  decodeGithubBillingCursor,
  encodeGithubBillingCursor,
} from "../finops/cost-source-gaps.ts";
import { githubBillingLines } from "../finops/github-billing-lines.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { readGithubCredentialPair } from "./github-api-base.ts";
import { fetchSameOriginOnly } from "./same-origin-fetch.ts";

export const GITHUB_BILLING_SERVICE_ID = "github_billing";
const DAY_MS = 86_400_000;
const RESTATEMENT_DAYS = 5;

export const GITHUB_BILLING_GAPS = {
  enterpriseServer:
    "GitHub's billing usage API is on github.com only; this gateway's GitHub is an Enterprise Server",
  refused: (org: string): string =>
    `GitHub refused the billing usage request for ${org} (400 Bad Request)`,
  access: (org: string): string =>
    `cannot read billing for ${org}: the token needs org owner or billing-manager access, and the org must be on GitHub's enhanced billing platform`,
} as const;

/** The months to fetch for an org at `nowMs` (`YYYY-MM`, the current first). */
export function githubBillingMonths(nowMs: number, firstSync: boolean): string[] {
  const now = new Date(nowMs);
  const current = now.toISOString().slice(0, 7);
  const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
  const previous = prev.toISOString().slice(0, 7);
  return firstSync || now.getUTCDate() <= RESTATEMENT_DAYS ? [current, previous] : [current];
}

export type GithubBillingSyncableOptions = {
  /** `[cost.github] orgs`, read at every run so a config edit takes effect on the next one. */
  readonly githubOrgs: () => readonly string[];
  /** Test seams. */
  readonly now?: () => number;
  readonly fetch?: typeof fetchSameOriginOnly;
};

type OrgOutcome =
  | { kind: "ok"; lines: number; bytes: number }
  | { kind: "gap"; reason: string }
  | {
      kind: "retry";
    };

const isRateLimited = (res: Response): boolean =>
  res.headers.get("x-ratelimit-remaining") === "0" || res.headers.get("retry-after") !== null;

function penalise(ctx: SyncContext, res: Response): void {
  const sec = Number.parseInt(res.headers.get("retry-after") ?? "60", 10);
  ctx.rateLimiter.penalise("github", Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000);
}

async function syncOrgMonth(
  ctx: SyncContext,
  fetchFn: typeof fetchSameOriginOnly,
  args: {
    org: string;
    month: string;
    today: string;
    headers: Record<string, string>;
    restRoot: string;
  },
): Promise<OrgOutcome> {
  const { org, month, today, headers, restRoot } = args;
  await ctx.rateLimiter.acquire("github");
  const u = new URL(`${restRoot}/organizations/${encodeURIComponent(org)}/settings/billing/usage`);
  u.searchParams.set("year", month.slice(0, 4));
  u.searchParams.set("month", String(Number(month.slice(5, 7))));
  const res = await fetchFn(u.toString(), { headers });
  const text = await res.text();
  if (res.status === 429 || (res.status === 403 && isRateLimited(res))) {
    penalise(ctx, res);
    return { kind: "retry" };
  }
  if (res.status === 403 || res.status === 404) {
    return { kind: "gap", reason: GITHUB_BILLING_GAPS.access(org) };
  }
  if (res.status === 400) return { kind: "gap", reason: GITHUB_BILLING_GAPS.refused(org) };
  if (!res.ok) return { kind: "retry" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "retry" };
  }
  const items =
    body !== null && typeof body === "object"
      ? (body as Record<string, unknown>)["usageItems"]
      : null;
  // A body that is not a report must never clear the stored month: only a real (possibly empty) list may.
  if (!Array.isArray(items)) return { kind: "retry" };
  const mapped = githubBillingLines(org, month, items, today);
  const dropped =
    mapped.dropped.malformed + mapped.dropped.outside_month + mapped.dropped.other_org;
  if (dropped > 0) {
    ctx.logger.warn(
      { serviceId: GITHUB_BILLING_SERVICE_ID, org, month, ...mapped.dropped },
      "github_billing sync: dropped usage rows",
    );
  }
  // A report whose every row is malformed is not a report of zero cost: never clear the month for it.
  if (items.length > 0 && mapped.dropped.malformed === items.length) return { kind: "retry" };
  try {
    ctx.replaceCostLinesForMonth(
      { provider: "github", billingAccountId: org.toLowerCase(), month },
      mapped.lines,
    );
  } catch (e) {
    ctx.logger.warn(
      {
        serviceId: GITHUB_BILLING_SERVICE_ID,
        org,
        month,
        err: e instanceof Error ? e.message : String(e),
      },
      "github_billing sync: the lines were refused; retrying next run",
    );
    return { kind: "retry" };
  }
  return { kind: "ok", lines: mapped.lines.length, bytes: text.length };
}

/** An org's entry in a cursor map, read as an OWN property (an org may be named `constructor`). */
function own<T>(map: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(map, key) ? map[key] : undefined;
}

/** The months to fetch for one org: the required ones, then any month an earlier run could not finish. */
function monthsForOrg(nowMs: number, firstSync: boolean, pending: readonly string[]): string[] {
  const current = new Date(nowMs).toISOString().slice(0, 7);
  const all = new Set([...githubBillingMonths(nowMs, firstSync), ...pending]);
  return [...all].filter((m) => m <= current).sort((a, b) => (a < b ? 1 : -1));
}

type OrgRun = {
  lines: number;
  bytes: number;
  gap: string | null;
  retried: boolean;
  /** The months not finished in this run, fetched again next run. */
  pending: string[];
};

/** One org, month by month; the first gap or retry stops it and leaves the rest pending. */
async function syncOrg(
  ctx: SyncContext,
  fetchFn: typeof fetchSameOriginOnly,
  args: {
    org: string;
    months: readonly string[];
    today: string;
    headers: Record<string, string>;
    restRoot: string;
  },
): Promise<OrgRun> {
  const run: OrgRun = { lines: 0, bytes: 0, gap: null, retried: false, pending: [] };
  for (const [i, month] of args.months.entries()) {
    const r = await syncOrgMonth(ctx, fetchFn, { ...args, month }); // NOSONAR S9382: one request at a time through the shared GitHub rate limiter
    if (r.kind === "ok") {
      run.lines += r.lines;
      run.bytes += r.bytes;
      continue;
    }
    if (r.kind === "gap") run.gap = r.reason;
    else run.retried = true;
    run.pending = args.months.slice(i);
    break;
  }
  return run;
}

export function createGithubBillingCostSyncable(options: GithubBillingSyncableOptions): Syncable {
  const fetchFn = options.fetch ?? fetchSameOriginOnly;
  return {
    serviceId: GITHUB_BILLING_SERVICE_ID,
    defaultIntervalMs: DAY_MS,
    initialSyncDepthDays: 62,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const orgs = options.githubOrgs();
      const prev = decodeGithubBillingCursor(cursor);
      const gaps: Record<string, string> = {};
      const pending: Record<string, string[]> = {};
      // Only configured orgs are kept, so an org removed and added back is a first sync again.
      const synced: Record<string, string> = {};
      for (const org of orgs) {
        const day = own(prev.synced, org);
        if (day !== undefined) synced[org] = day;
      }
      const save = (bytes: number, lines: number): SyncResult =>
        syncPassCursorSuccess(
          t0,
          bytes,
          encodeGithubBillingCursor({ gaps, synced, pending }),
          lines,
        );
      // Nothing to sync: no gap is left behind for an org that is no longer listed or readable.
      if (orgs.length === 0) return save(0, 0);
      const pair = await readGithubCredentialPair((k) => ctx.getSharedSecret("github", k));
      if (pair.kind !== "ok" || pair.pat === null || pair.pat.trim() === "") return save(0, 0);
      if (pair.base.host !== null) {
        for (const org of orgs) gaps[org] = GITHUB_BILLING_GAPS.enterpriseServer;
        return save(0, 0);
      }
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${pair.pat.trim()}`,
      };
      const nowMs = (options.now ?? Date.now)();
      const today = new Date(nowMs).toISOString().slice(0, 10);
      let lines = 0;
      let bytes = 0;
      for (const org of orgs) {
        const first = own(synced, org) === undefined;
        const months = monthsForOrg(nowMs, first, own(prev.pending, org) ?? []);
        const r = await syncOrg(ctx, fetchFn, {
          org,
          months,
          today,
          headers,
          restRoot: pair.base.restRoot,
        }); // NOSONAR S9382: one org at a time through the shared GitHub rate limiter
        lines += r.lines;
        bytes += r.bytes;
        if (r.gap !== null) gaps[org] = r.gap;
        else if (r.retried && own(prev.gaps, org) !== undefined)
          gaps[org] = own(prev.gaps, org) as string;
        if (r.pending.length > 0) pending[org] = r.pending;
        // A first sync that was cut short still counts: the months it missed are pending, not lost.
        if (r.gap === null) synced[org] = today;
      }
      return save(bytes, lines);
    },
  };
}
