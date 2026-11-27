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
import {
  type CostMonthOutcome,
  own,
  requiredCostMonths,
  runCostAccounts,
} from "./cost-month-sync.ts";
import { readGithubCredentialPair } from "./github-api-base.ts";
import { fetchSameOriginOnly } from "./same-origin-fetch.ts";

export const GITHUB_BILLING_SERVICE_ID = "github_billing";
const DAY_MS = 86_400_000;

export const GITHUB_BILLING_GAPS = {
  enterpriseServer:
    "GitHub's billing usage API is on github.com only; this gateway's GitHub is an Enterprise Server",
  refused: (org: string): string =>
    `GitHub refused the billing usage request for ${org} (400 Bad Request)`,
  access: (org: string): string =>
    `cannot read billing for ${org}: the token needs org owner or billing-manager access, and the org must be on GitHub's enhanced billing platform`,
} as const;

/** The months to fetch for an org at `nowMs` (`YYYY-MM`, the current first): the shared rule. */
export const githubBillingMonths = requiredCostMonths;

export type GithubBillingSyncableOptions = {
  /** `[cost.github] orgs`, read at every run so a config edit takes effect on the next one. */
  readonly githubOrgs: () => readonly string[];
  /** Test seams. */
  readonly now?: () => number;
  readonly fetch?: typeof fetchSameOriginOnly;
};

type OrgOutcome = CostMonthOutcome;

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
  // A month is written whole or not at all: an unreadable row would silently lower it (and a report whose every
  // row is unreadable is not a report of zero cost).
  if (mapped.dropped.malformed > 0) {
    return {
      kind: "month_gap",
      reason: `${String(mapped.dropped.malformed)} of GitHub's ${month} billing rows for ${org} could not be read; that month was not updated`,
    };
  }
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
      // Only configured orgs are kept, so an org removed and added back is a first sync again.
      const synced: Record<string, string> = {};
      for (const org of orgs) {
        const day = own(prev.synced, org);
        if (day !== undefined) synced[org] = day;
      }
      const idle = (gaps: Record<string, string> = {}): SyncResult =>
        syncPassCursorSuccess(t0, 0, encodeGithubBillingCursor({ gaps, synced, pending: {} }), 0);
      // Nothing to sync: no gap is left behind for an org that is no longer listed or readable.
      if (orgs.length === 0) return idle();
      const pair = await readGithubCredentialPair((k) => ctx.getSharedSecret("github", k));
      if (pair.kind !== "ok" || pair.pat === null || pair.pat.trim() === "") return idle();
      if (pair.base.host !== null) {
        return idle(Object.fromEntries(orgs.map((o) => [o, GITHUB_BILLING_GAPS.enterpriseServer])));
      }
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        Authorization: `Bearer ${pair.pat.trim()}`,
      };
      const nowMs = (options.now ?? Date.now)();
      const today = new Date(nowMs).toISOString().slice(0, 10);
      const restRoot = pair.base.restRoot;
      const run = await runCostAccounts(prev, orgs, nowMs, (org, month) =>
        syncOrgMonth(ctx, fetchFn, { org, month, today, headers, restRoot }),
      );
      return syncPassCursorSuccess(t0, run.bytes, encodeGithubBillingCursor(run.cursor), run.lines);
    },
  };
}
