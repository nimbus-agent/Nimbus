// Phase 7 (the Cost Pack, slice 6): the syncable shared by the AI-provider cost reports (OpenAI organization
// costs, Anthropic's legacy cost report). Each vendor supplies its URL, headers, paging and mapper; this runs
// the month loop (`cost-month-sync.ts`), the status rules and the one write door.
//
// The key is the service's OWN Vault entry (`<service>.admin_key`, owner ruling 1: a dedicated organization
// admin key, never the embeddings key), read through `getSecret` and sent only as the auth header of a request
// made with `fetchSameOriginOnly` to the vendor's fixed API origin (a redirect to another origin is refused, so
// the key never reaches another host). It is used for this cost GET alone.
//
// Per month: every page is fetched first (up to `MAX_PAGES`; more is a retry, never a partial write), then ALL
// the buckets are mapped together and written once through `replaceCostLinesForMonth` (D24). 401/403 and 404
// and 400 are stated gaps; 429 or a rate-limited response penalises the vendor's limiter and retries; a 5xx, a
// body that is not a page, or a non-empty report that maps to no line retries — a stored month is never cleared
// by a bad answer.
import type { CostMapResult } from "../finops/cost-bucket-map.ts";
import { decodeCostSyncCursor, encodeCostSyncCursor } from "../finops/cost-source-gaps.ts";
import { syncPassCursorSuccess } from "../sync/pass-cursor-sync-result.ts";
import type { Provider } from "../sync/rate-limiter.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import { type CostMonthOutcome, own, runCostAccounts } from "./cost-month-sync.ts";
import { fetchSameOriginOnly } from "./same-origin-fetch.ts";

const DAY_MS = 86_400_000;
/** At most this many pages per month; a longer report is retried (and logged), never written in part. */
export const AI_COST_MAX_PAGES = 20;

export interface AiCostVendor {
  readonly serviceId: "openai_billing" | "anthropic_billing";
  /** The rate-limiter provider (the service id). */
  readonly limiter: Provider;
  /** The cost line `provider` and the single account (one organization per admin key). */
  readonly provider: string;
  readonly account: string;
  readonly cursorPrefix: string;
  /** The request headers for an admin key. */
  readonly headers: (key: string) => Record<string, string>;
  /** The URL of one page of `month`, covering its first day to `endDay` (exclusive); `page` is the cursor. */
  readonly pageUrl: (month: string, endDay: string, page: string | null) => string;
  readonly map: (buckets: readonly unknown[], month: string, lastDay: string) => CostMapResult;
  readonly gaps: { readonly access: string; readonly missing: string; readonly refused: string };
}

export type AiCostSyncableOptions = {
  readonly now?: () => number;
  readonly fetch?: typeof fetchSameOriginOnly;
};

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

function isRateLimited(res: Response): boolean {
  return (
    res.status === 429 ||
    res.headers.get("x-ratelimit-remaining") === "0" ||
    res.headers.get("retry-after") !== null
  );
}

function penalise(ctx: SyncContext, limiter: Provider, res: Response): void {
  const sec = Number.parseInt(res.headers.get("retry-after") ?? "60", 10);
  ctx.rateLimiter.penalise(limiter, Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000);
}

/** The gap for a month that held rows the mapper could not read (the month is kept as it was). */
export function unreadableRowsGap(vendor: AiCostVendor, month: string, rows: number): string {
  return `${String(rows)} ${rows === 1 ? "row" : "rows"} of ${vendor.provider}'s ${month} cost report could not be read; that month was not updated`;
}

/** The day after `month`'s last day, or tomorrow when the month is the current one (`YYYY-MM-DD`). */
export function aiCostEndDay(month: string, nowMs: number): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const nextMonth = new Date(Date.UTC(y, m, 1)).toISOString().slice(0, 10);
  const tomorrow = new Date(nowMs + DAY_MS).toISOString().slice(0, 10);
  // `YYYY-MM-DD` strings order as dates; the earlier day bounds the range.
  if (tomorrow < nextMonth) return tomorrow;
  return nextMonth;
}

type PageResult =
  | { kind: "page"; data: unknown[]; next: string | null; bytes: number }
  | CostMonthOutcome;

async function fetchPage(
  ctx: SyncContext,
  vendor: AiCostVendor,
  fetchFn: typeof fetchSameOriginOnly,
  url: string,
  headers: Record<string, string>,
): Promise<PageResult> {
  await ctx.rateLimiter.acquire(vendor.limiter);
  let res: Response;
  let text: string;
  try {
    res = await fetchFn(url, { headers });
    text = await res.text();
  } catch (e) {
    // A refused cross-origin redirect or a network failure: nothing was read, so nothing is written.
    ctx.logger.warn(
      { serviceId: vendor.serviceId, err: e instanceof Error ? e.name : "error" },
      "AI cost sync: the request failed; retrying next run",
    );
    return { kind: "retry" };
  }
  if (isRateLimited(res) && (res.status === 429 || res.status === 403)) {
    penalise(ctx, vendor.limiter, res);
    return { kind: "retry" };
  }
  if (res.status === 401 || res.status === 403) return { kind: "gap", reason: vendor.gaps.access };
  if (res.status === 404) return { kind: "gap", reason: vendor.gaps.missing };
  if (res.status === 400) return { kind: "gap", reason: vendor.gaps.refused };
  if (!res.ok) return { kind: "retry" };
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: "retry" };
  }
  if (!isRecord(body) || !Array.isArray(body["data"])) return { kind: "retry" };
  // Both vendors define `has_more` as the continuation flag: anything but a boolean is not a page.
  if (typeof body["has_more"] !== "boolean") return { kind: "retry" };
  const more = body["has_more"];
  const cursor = body["next_page"];
  const next = typeof cursor === "string" && cursor !== "" ? cursor : null;
  // `has_more` says whether to go on; a page that says there is more but gives no cursor cannot be completed.
  if (more && next === null) return { kind: "retry" };
  return {
    kind: "page",
    data: body["data"] as unknown[],
    next: more ? next : null,
    bytes: text.length,
  };
}

async function syncMonth(
  ctx: SyncContext,
  vendor: AiCostVendor,
  fetchFn: typeof fetchSameOriginOnly,
  args: { month: string; nowMs: number; headers: Record<string, string> },
): Promise<CostMonthOutcome> {
  const { month, nowMs, headers } = args;
  const endDay = aiCostEndDay(month, nowMs);
  const buckets: unknown[] = [];
  let bytes = 0;
  let page: string | null = null;
  const seen = new Set<string>();
  for (let n = 0; ; n++) {
    if (n === AI_COST_MAX_PAGES) {
      ctx.logger.warn(
        { serviceId: vendor.serviceId, month },
        "AI cost sync: page cap reached; retrying next run",
      );
      return { kind: "retry" };
    }
    const r = await fetchPage(ctx, vendor, fetchFn, vendor.pageUrl(month, endDay, page), headers); // NOSONAR S9382: pages are sequential (each needs the previous cursor)
    if (r.kind !== "page") return r;
    buckets.push(...r.data);
    bytes += r.bytes;
    if (r.next === null) break;
    // A cursor seen before would read the same rows twice: never sum a page into the month again.
    if (seen.has(r.next)) return { kind: "retry" };
    seen.add(r.next);
    page = r.next;
  }
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const mapped = vendor.map(buckets, month, today);
  // A month is written whole or not at all: a row that cannot be read would silently lower it.
  if (mapped.dropped.malformed > 0) {
    return {
      kind: "month_gap",
      reason: unreadableRowsGap(vendor, month, mapped.dropped.malformed),
    };
  }
  if (mapped.rows > 0 && mapped.lines.length === 0) return { kind: "retry" };
  if (mapped.dropped.malformed + mapped.dropped.outside_month > 0) {
    ctx.logger.warn(
      { serviceId: vendor.serviceId, month, ...mapped.dropped },
      "AI cost sync: dropped rows",
    );
  }
  try {
    ctx.replaceCostLinesForMonth(
      { provider: vendor.provider, billingAccountId: vendor.account, month },
      mapped.lines,
    );
  } catch (e) {
    ctx.logger.warn(
      { serviceId: vendor.serviceId, month, err: e instanceof Error ? e.message : String(e) },
      "AI cost sync: the lines were refused; retrying next run",
    );
    return { kind: "retry" };
  }
  return { kind: "ok", lines: mapped.lines.length, bytes };
}

export function createAiCostSyncable(
  vendor: AiCostVendor,
  options: AiCostSyncableOptions = {},
): Syncable {
  const fetchFn = options.fetch ?? fetchSameOriginOnly;
  return {
    serviceId: vendor.serviceId,
    defaultIntervalMs: DAY_MS,
    initialSyncDepthDays: 62,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const prev = decodeCostSyncCursor(vendor.cursorPrefix, cursor);
      const key = ((await ctx.getSecret("admin_key")) ?? "").trim();
      if (key === "") {
        // No key stored: nothing is fetched and no gap is left behind.
        const day = own(prev.synced, vendor.account);
        const synced = day === undefined ? {} : { [vendor.account]: day };
        const idle = encodeCostSyncCursor(vendor.cursorPrefix, { gaps: {}, synced, pending: {} });
        return syncPassCursorSuccess(t0, 0, idle, 0);
      }
      const nowMs = (options.now ?? Date.now)();
      const headers = vendor.headers(key);
      const run = await runCostAccounts(prev, [vendor.account], nowMs, (_account, month) =>
        syncMonth(ctx, vendor, fetchFn, { month, nowMs, headers }),
      );
      return syncPassCursorSuccess(
        t0,
        run.bytes,
        encodeCostSyncCursor(vendor.cursorPrefix, run.cursor),
        run.lines,
      );
    },
  };
}
