// Phase 7 (the Cost Pack, slice 13): reading a Cloud Billing export table through the BigQuery REST API
// (https://docs.cloud.google.com/bigquery/docs/reference/rest/v2/jobs/query, .../jobs/getQueryResults and
// .../tables/get) with the owner's `gcloud` access token. Pure of the store: it returns raw rows; the sync writes.
//
// Partition filter (C3): BigQuery bills the bytes a query scans, so the query is bounded by the table's PARTITION
// column. Google's export pages do not name it for the standard table, and the detailed table's own sample queries
// filter on `_PARTITIONTIME` (https://docs.cloud.google.com/billing/docs/how-to/export-data-bigquery-tables/detailed-usage;
// the standard page, .../standard-usage, filters on `usage_start_time` and `invoice.month` only). So the table's
// metadata is read first (`tables.get`, free): an ingestion-time table filters on `_PARTITIONTIME`; one partitioned
// on a column filters on that column (DATE or TIMESTAMP); an unpartitioned or range-partitioned table is filtered on
// `usage_start_time` alone. Every query also sets `maximumBytesBilled`, so a scan past `[cost.gcp] max_bytes_billed`
// fails and bills nothing.
//
// A reply is read whole or not at all: an incomplete job after the poll cap, a page token that does not advance, a
// row count that differs from `totalRows`, missing columns or too many pages is a retry or a `month_gap`, never a
// partial result.
import { GCP_ROW_COLUMNS, type GcpRawRow } from "../finops/gcp-billing-lines.ts";
import type { Provider } from "../sync/rate-limiter.ts";
import type { SyncContext } from "../sync/types.ts";
import type { CostMonthOutcome } from "./cost-month-sync.ts";
import type { fetchSameOriginOnly } from "./same-origin-fetch.ts";

export const GCP_BQ_BASE = "https://bigquery.googleapis.com/bigquery/v2";
const LIMITER: Provider = "gcp_billing";
export const GCP_QUERY_PAGE_SIZE = 10_000;
/** Pages of one month's result; a longer result is a `month_gap`, never a partial write. */
export const GCP_QUERY_MAX_PAGES = 40;
/** Polls of an unfinished job (each waits up to `POLL_WAIT_MS` server side); then the month is retried. */
export const GCP_QUERY_MAX_POLLS = 6;
const POLL_WAIT_MS = 10_000;
const FIRST_WAIT_MS = 20_000;

/**
 * A failed read. `scanned` is true once BigQuery accepted the job (a scan may have been billed), so a retry would
 * bill another scan: the sync records it and does not rescan every day.
 */
export type GcpFail = Exclude<CostMonthOutcome, { kind: "ok" }> & { readonly scanned?: boolean };

export const GCP_COST_GAPS = {
  notConfigured:
    "GCP cost is not configured: set [cost.gcp] export_table to your Cloud Billing export table",
  noProject:
    "GCP cost runs its query in a project; store the GCP connector's project id (gcp.project_id)",
  access:
    "BigQuery refused the billing export read (the account needs bigquery.jobs.create in the project and read access to the export table)",
  notFound:
    "the Cloud Billing export table was not found (check [cost.gcp] export_table; the first export rows can take a day to arrive)",
  refused:
    "BigQuery refused the billing query (check that [cost.gcp] export_table is a Cloud Billing export)",
  bytes:
    "the billing query would scan more than [cost.gcp] max_bytes_billed; raise it, or check the export table's partitioning",
} as const;

export interface GcpBqDeps {
  readonly fetch: typeof fetchSameOriginOnly;
  readonly token: string;
}

type Reply = { readonly kind: "json"; readonly body: Record<string, unknown> } | GcpFail;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/** A reply member by name (BigQuery REST JSON, not an index item). */
const prop = (o: Record<string, unknown>, k: string): unknown => o[k];

function errorReasons(body: unknown): { reasons: string[]; message: string } {
  const e = isRecord(body) && isRecord(body["error"]) ? body["error"] : {};
  const errors = Array.isArray(e["errors"]) ? (e["errors"] as unknown[]) : [];
  const reasons = errors.flatMap((x) =>
    isRecord(x) && typeof x["reason"] === "string" ? [x["reason"]] : [],
  );
  if (typeof e["status"] === "string") reasons.push(e["status"]);
  return { reasons, message: typeof e["message"] === "string" ? e["message"] : "" };
}

function penalise(ctx: SyncContext, res: Response): void {
  const sec = Number.parseInt(res.headers.get("retry-after") ?? "60", 10);
  ctx.rateLimiter.penalise(LIMITER, Number.isFinite(sec) && sec > 0 ? sec * 1000 : 60_000);
}

/** Maps one failing HTTP answer to its outcome (no write in any of them). */
function failureOf(
  ctx: SyncContext,
  res: Response,
  body: unknown,
  notFoundIsGap: boolean,
): GcpFail {
  const { reasons, message } = errorReasons(body);
  const has = (...r: string[]): boolean => r.some((x) => reasons.includes(x));
  if (has("bytesBilledLimitExceeded") || (res.status === 400 && /bytes billed/i.test(message))) {
    return { kind: "gap", reason: GCP_COST_GAPS.bytes };
  }
  if (res.status === 429 || has("rateLimitExceeded", "quotaExceeded", "RESOURCE_EXHAUSTED")) {
    penalise(ctx, res);
    return { kind: "retry" };
  }
  if (res.status === 401 || res.status === 403)
    return { kind: "gap", reason: GCP_COST_GAPS.access };
  // Only the table (tables.get) or the query itself can be "not found"; a poll or page that 404s is an expired job
  // or a wrong location, which a retry sorts out.
  if (res.status === 404 && notFoundIsGap) return { kind: "gap", reason: GCP_COST_GAPS.notFound };
  if (res.status === 404) return { kind: "retry" };
  if (res.status === 400) return { kind: "gap", reason: GCP_COST_GAPS.refused };
  return { kind: "retry" };
}

async function bqRequest(
  ctx: SyncContext,
  deps: GcpBqDeps,
  url: string,
  json?: unknown,
  notFoundIsGap = true,
): Promise<Reply> {
  await ctx.rateLimiter.acquire(LIMITER);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${deps.token}`,
    Accept: "application/json",
  };
  let res: Response;
  let text: string;
  try {
    res =
      json === undefined
        ? await deps.fetch(url, { headers })
        : await deps.fetch(url, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify(json),
          });
    text = await res.text();
  } catch (e) {
    // A refused redirect or a network failure: nothing was read, so nothing is written.
    ctx.logger.warn(
      { serviceId: "gcp_billing", err: e instanceof Error ? e.name : "error" },
      "gcp_billing sync: the request failed; retrying next run",
    );
    return { kind: "retry" };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }
  if (!res.ok) return failureOf(ctx, res, body, notFoundIsGap);
  return isRecord(body) ? { kind: "json", body } : { kind: "retry" };
}

// --- table metadata and the partition filter -------------------------------------------------------------------

/** How a query bounds its scan by the table's partition column. */
export type GcpPartition =
  | { readonly kind: "ingestion" }
  | { readonly kind: "column"; readonly name: string; readonly type: "TIMESTAMP" | "DATE" }
  | { readonly kind: "none" };

const COLUMN_RE = /^[A-Za-z_][A-Za-z0-9_]{0,299}$/;

/** The partition scheme of a `tables.get` reply. */
export function partitionOf(meta: Record<string, unknown>): GcpPartition {
  const tp = prop(meta, "timePartitioning");
  if (!isRecord(tp)) return { kind: "none" };
  const field = tp["field"];
  if (field === undefined || field === null) return { kind: "ingestion" };
  if (typeof field !== "string" || !COLUMN_RE.test(field)) return { kind: "none" };
  const sch = prop(meta, "schema");
  const fields = isRecord(sch) && Array.isArray(sch["fields"]) ? (sch["fields"] as unknown[]) : [];
  const f = fields.find((x) => isRecord(x) && x["name"] === field);
  const type = isRecord(f) ? f["type"] : undefined;
  if (type === "TIMESTAMP" || type === "DATE") return { kind: "column", name: field, type };
  return { kind: "none" };
}

export async function readTablePartition(
  ctx: SyncContext,
  deps: GcpBqDeps,
  table: string,
): Promise<{ kind: "ok"; partition: GcpPartition } | GcpFail> {
  const [p, d, t] = table.split(".") as [string, string, string];
  const url = `${GCP_BQ_BASE}/projects/${encodeURIComponent(p)}/datasets/${encodeURIComponent(d)}/tables/${encodeURIComponent(t)}`;
  const r = await bqRequest(ctx, deps, url);
  if (r.kind !== "json") return r;
  return { kind: "ok", partition: partitionOf(r.body) };
}

// --- the query -------------------------------------------------------------------------------------------------

function partitionClause(p: GcpPartition): string {
  // A LOWER bound only: usage of the month can be exported (restated) into any later partition, and the month is
  // replaced whole, so an upper bound would drop late rows. The usage_start_time range below stays exact; the
  // day before the start covers usage that is exported just ahead of its own day.
  if (p.kind === "ingestion") {
    return "_PARTITIONTIME >= TIMESTAMP_SUB(TIMESTAMP(@start), INTERVAL 1 DAY) AND ";
  }
  if (p.kind === "column" && p.type === "DATE") {
    return `\`${p.name}\` >= DATE_SUB(DATE(@start), INTERVAL 1 DAY) AND `;
  }
  if (p.kind === "column") {
    return `\`${p.name}\` >= TIMESTAMP_SUB(TIMESTAMP(@start), INTERVAL 1 DAY) AND `;
  }
  return "";
}

/** The month's query. `table` has passed `GCP_EXPORT_TABLE_RE` (config), so interpolating it is safe. */
export function billingSql(table: string, partition: GcpPartition): string {
  // Every alias is new (never a table column's name), so no GROUP BY or expression can resolve to a table column.
  return `SELECT DATE(usage_start_time) AS usage_day, billing_account_id AS account_key, project.id AS project_key,
  project.name AS project_label, service.description AS service_name, sku.id AS sku_key,
  sku.description AS sku_name, location.region AS region_key, currency AS currency_code,
  usage.unit AS unit_name, cost_type AS cost_kind,
  TO_JSON_STRING(ARRAY(SELECT AS STRUCT key, value FROM UNNEST(IFNULL(labels, [])) ORDER BY key, value)) AS labels_json,
  SUM(cost) AS cost_sum,
  SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(IFNULL(credits, [])) c), 0)) AS credits_sum,
  SUM(usage.amount) AS quantity_sum
FROM \`${table}\`
WHERE ${partitionClause(partition)}usage_start_time >= TIMESTAMP(@start) AND usage_start_time < TIMESTAMP(@end)
GROUP BY usage_day, account_key, project_key, project_label, service_name, sku_key, sku_name, region_key, currency_code, unit_name, cost_kind, labels_json`;
}

export interface GcpQueryArgs {
  /** The project the job runs (and is billed) in. */
  readonly project: string;
  readonly table: string;
  readonly partition: GcpPartition;
  /** `YYYY-MM-DD`: the month's first day, and the exclusive end (the month's end, or tomorrow). */
  readonly start: string;
  readonly end: string;
  readonly maxBytesBilled: number;
}

type Page = {
  readonly names: string[];
  readonly rows: unknown[];
  readonly pageToken: string | null;
  readonly complete: boolean;
  readonly totalRows: number | null;
  readonly job: { readonly project: string; readonly id: string; readonly location: string | null };
};

function readPage(body: Record<string, unknown>, args: GcpQueryArgs): Page | null {
  const ref = isRecord(body["jobReference"]) ? body["jobReference"] : {};
  const id = ref["jobId"];
  if (typeof id !== "string" || id === "") return null;
  const names: string[] = [];
  const schema = isRecord(body["schema"]) ? body["schema"] : {};
  for (const f of Array.isArray(schema["fields"]) ? (schema["fields"] as unknown[]) : []) {
    if (isRecord(f) && typeof f["name"] === "string") names.push(f["name"]);
  }
  const token = body["pageToken"];
  const total = body["totalRows"];
  return {
    names,
    rows: Array.isArray(body["rows"]) ? (body["rows"] as unknown[]) : [],
    pageToken: typeof token === "string" && token !== "" ? token : null,
    complete: body["jobComplete"] === true,
    totalRows: typeof total === "string" && /^\d+$/.test(total) ? Number(total) : null,
    // The job's own project and location: a poll in another project or location would not find it.
    job: {
      project: typeof ref["projectId"] === "string" ? ref["projectId"] : args.project,
      id,
      location:
        typeof ref["location"] === "string" && ref["location"] !== "" ? ref["location"] : null,
    },
  };
}

function decodeRows(names: readonly string[], rows: readonly unknown[]): GcpRawRow[] | null {
  const index = new Map(names.map((n, i) => [n, i] as const));
  const out: GcpRawRow[] = [];
  for (const row of rows) {
    const cells = isRecord(row) && Array.isArray(row["f"]) ? (row["f"] as unknown[]) : null;
    if (cells === null || cells.length !== names.length) return null;
    const r: Record<string, string | null> = {};
    for (const c of GCP_ROW_COLUMNS) {
      const cell = cells[index.get(c) as number];
      const v = isRecord(cell) ? cell["v"] : undefined;
      if (v !== null && typeof v !== "string") return null;
      r[c] = v;
    }
    out.push(r as GcpRawRow);
  }
  return out;
}

function pollUrl(job: Page["job"], token: string | null): string {
  const q = new URLSearchParams({
    maxResults: String(GCP_QUERY_PAGE_SIZE),
    timeoutMs: String(POLL_WAIT_MS),
  });
  if (job.location !== null) q.set("location", job.location);
  if (token !== null) q.set("pageToken", token);
  return `${GCP_BQ_BASE}/projects/${encodeURIComponent(job.project)}/queries/${encodeURIComponent(job.id)}?${q.toString()}`;
}

/** One month's rows: the first `jobs.query`, the polls of an unfinished job, then every result page. */
export async function runBillingQuery(
  ctx: SyncContext,
  deps: GcpBqDeps,
  args: GcpQueryArgs,
): Promise<{ kind: "ok"; rows: GcpRawRow[] } | GcpFail> {
  const param = (name: string, value: string) => ({
    name,
    parameterType: { type: "STRING" },
    parameterValue: { value },
  });
  const first = await bqRequest(
    ctx,
    deps,
    `${GCP_BQ_BASE}/projects/${encodeURIComponent(args.project)}/queries`,
    {
      query: billingSql(args.table, args.partition),
      useLegacySql: false,
      maximumBytesBilled: String(args.maxBytesBilled),
      parameterMode: "NAMED",
      queryParameters: [param("start", args.start), param("end", args.end)],
      timeoutMs: FIRST_WAIT_MS,
      maxResults: GCP_QUERY_PAGE_SIZE,
    },
  );
  if (first.kind !== "json") return first;
  const rest = await finishQuery(ctx, deps, args, first.body);
  // The job was accepted: a failure from here on may have billed a scan.
  return rest.kind === "ok" ? rest : { ...rest, scanned: true };
}

/** Cancels a job that did not finish in time (best effort: the answer is not needed). */
async function cancelJob(ctx: SyncContext, deps: GcpBqDeps, job: Page["job"]): Promise<void> {
  const q = job.location === null ? "" : `?location=${encodeURIComponent(job.location)}`;
  await bqRequest(
    ctx,
    deps,
    `${GCP_BQ_BASE}/projects/${encodeURIComponent(job.project)}/jobs/${encodeURIComponent(job.id)}/cancel${q}`,
    {},
    false,
  );
}

async function finishQuery(
  ctx: SyncContext,
  deps: GcpBqDeps,
  args: GcpQueryArgs,
  firstBody: Record<string, unknown>,
): Promise<{ kind: "ok"; rows: GcpRawRow[] } | GcpFail> {
  let page = readPage(firstBody, args);
  if (page === null) return { kind: "retry" };
  const job = page.job;
  let polls = 0;
  while (!page.complete) {
    if (++polls > GCP_QUERY_MAX_POLLS) {
      await cancelJob(ctx, deps, job);
      return {
        kind: "month_gap",
        reason: `the ${args.start.slice(0, 7)} billing query did not finish in time and was cancelled`,
      };
    }
    const r = await bqRequest(ctx, deps, pollUrl(job, null), undefined, false); // NOSONAR S9382: each poll depends on the previous reply
    if (r.kind !== "json") return r;
    const next = readPage(r.body, args);
    if (next === null) return { kind: "retry" };
    page = next;
  }
  const names = page.names;
  if (!GCP_ROW_COLUMNS.every((c) => names.includes(c))) {
    return {
      kind: "month_gap",
      reason:
        "BigQuery returned the billing rows without the columns the sync reads; that month was not updated",
    };
  }
  const collected: unknown[] = [...page.rows];
  const seen = new Set<string>();
  let total = page.totalRows;
  let pages = 1;
  while (page.pageToken !== null) {
    if (seen.has(page.pageToken)) {
      // a token that does not advance
      return { kind: "month_gap", reason: "BigQuery repeated a result page token" };
    }
    seen.add(page.pageToken);
    if (++pages > GCP_QUERY_MAX_PAGES) {
      return {
        kind: "month_gap",
        reason: `the ${args.start.slice(0, 7)} billing result is longer than ${String(GCP_QUERY_MAX_PAGES * GCP_QUERY_PAGE_SIZE)} rows; that month was not updated`,
      };
    }
    const r = await bqRequest(ctx, deps, pollUrl(job, page.pageToken), undefined, false); // NOSONAR S9382: each page token comes from the previous page
    if (r.kind !== "json") return r;
    const next = readPage(r.body, args);
    if (next === null || !next.complete) return { kind: "retry" };
    if (next.names.length > 0 && next.names.join() !== names.join()) return { kind: "retry" };
    collected.push(...next.rows);
    total = next.totalRows ?? total;
    page = next;
  }
  if (total !== null && total !== collected.length) {
    return {
      kind: "month_gap",
      reason: `BigQuery returned ${String(collected.length)} of ${String(total)} billing rows`,
    };
  }
  const rows = decodeRows(names, collected);
  if (rows === null) {
    return {
      kind: "month_gap",
      reason: "BigQuery returned billing rows that could not be read; that month was not updated",
    };
  }
  return { kind: "ok", rows };
}
