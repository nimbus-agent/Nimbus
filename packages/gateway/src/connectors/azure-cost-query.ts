// Phase 7 (the Cost Pack, slice 12b; owner ruling D10, 2026-11-28): reading Azure cost from the Cost Management
// Query API over HTTPS with a management-scope bearer token (`_lib/azure-token.ts`, `AZURE_MANAGEMENT_SCOPE`). No
// `az` CLI: a credential never goes in argv.
//
// Request (https://learn.microsoft.com/en-us/rest/api/cost-management/query/usage, api-version 2026-06-01, the
// reference's current non-preview version when this was written):
//   POST https://management.azure.com/{scope}/providers/Microsoft.CostManagement/query?api-version=...
//   { type: "ActualCost", timeframe: "Custom", timePeriod: { from, to },
//     dataset: { granularity: "Daily", aggregation: { totalCost: { name: "Cost", function: "Sum" } },
//                grouping: [ServiceName, ResourceGroupName] } }
// A page that holds `nextLink` is followed with the SAME body; every link must stay on management.azure.com, must be
// new (a repeated link would loop) and at most 20 pages are read. The grain is aggregated (a day, a service and a
// resource group), never per resource.
//
// Throttling (https://learn.microsoft.com/en-us/azure/cost-management-billing/costs/manage-automation: 12 QPU per
// 10 seconds, 60 per minute and 600 per hour per tenant, one QPU per month of data queried): on a 429 the client
// waits the seconds the `x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after` header names ONCE per run (at most
// 30 s) and repeats the request. A second 429, a wait over 30 s or a missing header (taken as 60 s) is a retry for
// the next run with no sleep, and after any 429 the rest of the run's scopes and months stay pending, unasked. A month is read whole or not at all: any drop, cap or unreadable page keeps
// the stored month as it was.

import { azureQueryLines } from "../finops/azure-query-lines.ts";
import type { CostLine } from "../finops/cost-line.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  AZURE_MANAGEMENT_SCOPE,
  type AzureFetch,
  type AzureTokenSource,
} from "./_lib/azure-token.ts";
import { monthGap } from "./aws-billing-export.ts";
import type { CostMonthOutcome } from "./cost-month-sync.ts";
import { RedirectRefusedError } from "./same-origin-fetch.ts";
import { asRecord } from "./unknown-record.ts";

export const AZURE_QUERY_API_VERSION = "2026-06-01";
export const AZURE_QUERY_HOST = "management.azure.com";
export const AZURE_QUERY_MAX_PAGES = 20;
export const AZURE_QUERY_TIMEOUT_MS = 2 * 60 * 1000;
export const AZURE_QUERY_RETRY_HEADER = "x-ms-ratelimit-microsoft.costmanagement-qpu-retry-after";
export const AZURE_QUERY_DEFAULT_RETRY_SECONDS = 60;
export const AZURE_QUERY_MAX_WAIT_SECONDS = 30;

export const AZURE_QUERY_GAPS = {
  access:
    "Azure refused the Cost Management query (the service principal needs the Cost Management Reader role on this scope)",
  notFound: "Azure did not find this Cost Management scope (check [cost.azure] scopes)",
  rejected:
    "Azure rejected the Cost Management query for this scope (use a subscription, a resource group or a billing account)",
  redirect: "Azure redirected the request to another host; the token is never sent there",
} as const;

export type QueryReply =
  | {
      readonly kind: "page";
      readonly columns: readonly unknown[];
      readonly rows: readonly unknown[];
      readonly next: string | null;
    }
  | { readonly kind: "gap"; readonly reason: string }
  | { readonly kind: "retry" };

/** What the month read needs of the API; a test passes a fake. */
export interface AzureQueryClient {
  post(url: string, body: unknown): Promise<QueryReply>;
  /** True once a request of this run was answered 429: the quota is not asked again until the next run. */
  throttled?(): boolean;
}

export function queryUrl(scope: string): string {
  return `https://${AZURE_QUERY_HOST}/${scope}/providers/Microsoft.CostManagement/query?api-version=${AZURE_QUERY_API_VERSION}`;
}

/** The request body for one month: `lastDay` (`YYYY-MM-DD`) is the last day asked for. */
export function queryBody(month: string, lastDay: string): unknown {
  return {
    type: "ActualCost",
    timeframe: "Custom",
    timePeriod: { from: `${month}-01T00:00:00Z`, to: `${lastDay}T23:59:59Z` },
    dataset: {
      granularity: "Daily",
      aggregation: { totalCost: { name: "Cost", function: "Sum" } },
      grouping: [
        { type: "Dimension", name: "ServiceName" },
        { type: "Dimension", name: "ResourceGroupName" },
      ],
    },
  };
}

export function azureQueryClient(
  ctx: SyncContext,
  tokens: AzureTokenSource,
  fetchFn: AzureFetch,
  sleep: (ms: number) => Promise<void> = (ms) => Bun.sleep(ms),
): AzureQueryClient {
  let waited = false;
  let throttled = false;
  return {
    throttled: () => throttled,
    async post(url, body) {
      let refreshed = false;
      let token = await tokens.get(AZURE_MANAGEMENT_SCOPE);
      // At most: the first send, one repeat after a new token (401), one repeat after the one wait (429).
      for (let attempt = 0; attempt < 3; attempt++) {
        if (token.kind !== "token") return token;
        await ctx.rateLimiter.acquire("azure"); // NOSONAR S9382: one request at a time
        let res: Response;
        try {
          res = await fetchFn(url, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token.token}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(AZURE_QUERY_TIMEOUT_MS),
          }); // NOSONAR S9382: one request at a time
        } catch (e) {
          return e instanceof RedirectRefusedError
            ? { kind: "gap", reason: AZURE_QUERY_GAPS.redirect }
            : { kind: "retry" };
        }
        if (res.status === 401 && !refreshed) {
          // The token expired mid-run: drop it once and send the request again.
          await res.body?.cancel().catch(() => undefined);
          refreshed = true;
          token = await tokens.refresh(AZURE_MANAGEMENT_SCOPE); // NOSONAR S9382
          continue;
        }
        if (res.status === 429) {
          await res.body?.cancel().catch(() => undefined);
          throttled = true;
          const given = Number.parseInt(res.headers.get(AZURE_QUERY_RETRY_HEADER) ?? "", 10);
          const seconds =
            Number.isFinite(given) && given > 0 ? given : AZURE_QUERY_DEFAULT_RETRY_SECONDS;
          // A long back-off is not slept through (it would stall the whole sync): the next run asks again.
          if (waited || seconds > AZURE_QUERY_MAX_WAIT_SECONDS) return { kind: "retry" };
          waited = true;
          await sleep(seconds * 1000); // NOSONAR S9382: the one wait of the run
          continue;
        }
        return replyOf(res);
      }
      return { kind: "retry" };
    },
  };
}

async function replyOf(res: Response): Promise<QueryReply> {
  if (res.status === 401 || res.status === 403) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "gap", reason: AZURE_QUERY_GAPS.access };
  }
  if (res.status === 404) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "gap", reason: AZURE_QUERY_GAPS.notFound };
  }
  if (res.status === 400) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "gap", reason: AZURE_QUERY_GAPS.rejected };
  }
  // 204: the scope has no cost data for the period.
  if (res.status === 204) return { kind: "page", columns: [], rows: [], next: null };
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return { kind: "retry" };
  }
  try {
    const props = asRecord(asRecord((await res.json()) as unknown)?.["properties"]);
    const columns = props?.["columns"];
    const rows = props?.["rows"];
    const next = props?.["nextLink"];
    if (!Array.isArray(columns) || !Array.isArray(rows)) return { kind: "retry" };
    return {
      kind: "page",
      columns,
      rows,
      next: typeof next === "string" && next !== "" ? next : null,
    };
  } catch {
    return { kind: "retry" };
  }
}

/** A `nextLink` is followed only when it is https, on management.azure.com and not one already read. */
export function acceptableNextLink(link: string, seen: ReadonlySet<string>): boolean {
  let u: URL;
  try {
    u = new URL(link);
  } catch {
    return false;
  }
  return u.protocol === "https:" && u.host === AZURE_QUERY_HOST && !seen.has(u.toString());
}

/**
 * One scope's month as cost lines, or why they cannot be written: an account gap (access, scope), a retry, or a
 * `month_gap` (a page cap, a link that does not advance, rows that could not be read).
 */
export async function readAzureQueryMonth(
  client: AzureQueryClient,
  scope: string,
  month: string,
  lastDay: string,
): Promise<CostLine[] | CostMonthOutcome> {
  const body = queryBody(month, lastDay);
  const pages: { columns: readonly unknown[]; rows: readonly unknown[] }[] = [];
  const seen = new Set<string>();
  let url: string = queryUrl(scope);
  for (let page = 0; ; page++) {
    if (page >= AZURE_QUERY_MAX_PAGES) {
      return monthGap(
        `the ${month} cost query for ${scope} has more than ${String(AZURE_QUERY_MAX_PAGES)} pages; that month was not updated`,
      );
    }
    seen.add(new URL(url).toString());
    const r = await client.post(url, body); // NOSONAR S9382: pages are read one at a time
    if (r.kind !== "page") return r;
    pages.push(r);
    if (r.next === null) break;
    if (!acceptableNextLink(r.next, seen)) {
      return monthGap(
        `the ${month} cost query for ${scope} returned a next page link that does not advance or leaves ${AZURE_QUERY_HOST}; that month was not updated`,
      );
    }
    url = r.next;
  }
  // A 204 / empty reply carries no columns: it has nothing to map.
  const mapped = azureQueryLines(
    { scope, month, lastDay },
    pages.filter((p) => p.columns.length > 0 || p.rows.length > 0),
  );
  if (mapped.kind === "retry") return { kind: "retry" };
  if (mapped.dropped.malformed > 0) {
    return monthGap(
      `${String(mapped.dropped.malformed)} rows of the ${month} cost query for ${scope} could not be read; that month was not updated`,
    );
  }
  return [...mapped.lines];
}
