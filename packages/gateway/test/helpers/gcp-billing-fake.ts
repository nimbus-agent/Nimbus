// A fake BigQuery REST endpoint for the GCP billing sync tests (tables.get, jobs.query, getQueryResults). A column
// is returned only when the posted SQL selects it, like the real service. The posted job runs in `project`; the
// reply names its OWN project and location, and a poll anywhere else is a 404, so a sync that polls the wrong
// project or location fails here.
import { GCP_ROW_COLUMNS, type GcpRowColumn } from "../../src/finops/gcp-billing-lines.ts";

export type BqRow = Partial<Record<GcpRowColumn, string | null>>;

export const JOB_PROJECT = "job-proj";
export const JOB_LOCATION = "EU";

export class FakeBigQuery {
  /** Rows by the month's first day (`@start`). */
  readonly rows = new Map<string, BqRow[]>();
  meta: Record<string, unknown> = { timePartitioning: { type: "DAY" } };
  pageSize = 2;
  /** Replies with `jobComplete: false` this many times (the first reply, then each poll). */
  incomplete = 0;
  /** When set, answers the next request of that kind (`meta`, `query`, `poll`) instead of the normal reply. */
  failNext: { kind: "meta" | "query" | "poll"; status: number; body?: unknown } | null = null;
  /** Makes `getQueryResults` hand back the same page token every time. */
  stuckToken = false;
  /** Overrides `totalRows` of every reply. */
  totalRows: string | null = null;
  /** Drops this column from every reply's schema (and rows). */
  dropColumn: GcpRowColumn | null = null;
  readonly calls: {
    kind: "meta" | "query" | "poll";
    url: string;
    body?: Record<string, unknown>;
  }[] = [];
  private results: BqRow[] = [];
  private columns: GcpRowColumn[] = [];
  private polls = 0;

  private reply(status: number, body: unknown): Response {
    return new Response(JSON.stringify(body), { status });
  }

  private page(index: number): Record<string, unknown> {
    const slice = this.results.slice(index * this.pageSize, (index + 1) * this.pageSize);
    const more = (index + 1) * this.pageSize < this.results.length;
    const cols = this.columns.filter((c) => c !== this.dropColumn);
    const body: Record<string, unknown> = {
      jobComplete: this.polls >= this.incomplete,
      jobReference: { projectId: JOB_PROJECT, jobId: "job-1", location: JOB_LOCATION },
      schema: { fields: cols.map((name) => ({ name, type: "STRING" })) },
      totalRows: this.totalRows ?? String(this.results.length),
      rows: slice.map((r) => ({ f: cols.map((c) => ({ v: r[c] ?? null })) })),
    };
    if (more) body["pageToken"] = this.stuckToken ? "stuck" : `page-${String(index + 1)}`;
    return body;
  }

  readonly fetch = (async (url: string, init?: RequestInit): Promise<Response> => {
    const u = new URL(url);
    if (u.hostname !== "bigquery.googleapis.com") return this.reply(404, {});
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      this.calls.push({ kind: "query", url, body });
      if (this.failNext?.kind === "query") {
        const f = this.failNext;
        this.failNext = null;
        return this.reply(f.status, f.body ?? {});
      }
      const params = body["queryParameters"] as {
        name: string;
        parameterValue: { value: string };
      }[];
      const start = params.find((p) => p.name === "start")?.parameterValue.value ?? "";
      const sql = String(body["query"]);
      this.columns = GCP_ROW_COLUMNS.filter(
        (c) => sql.includes(` AS ${c}`) || sql.includes(`, ${c}`),
      );
      this.results = this.rows.get(start) ?? [];
      this.polls = 0;
      return this.reply(200, this.page(0));
    }
    if (u.pathname.includes("/tables/")) {
      this.calls.push({ kind: "meta", url });
      if (this.failNext?.kind === "meta") {
        const f = this.failNext;
        this.failNext = null;
        return this.reply(f.status, f.body ?? {});
      }
      return this.reply(200, this.meta);
    }
    this.calls.push({ kind: "poll", url });
    if (this.failNext?.kind === "poll") {
      const f = this.failNext;
      this.failNext = null;
      return this.reply(f.status, f.body ?? {});
    }
    if (
      !u.pathname.startsWith(`/bigquery/v2/projects/${JOB_PROJECT}/queries/job-1`) ||
      u.searchParams.get("location") !== JOB_LOCATION
    ) {
      return this.reply(404, {});
    }
    this.polls++;
    const token = u.searchParams.get("pageToken");
    const index = token === null ? 0 : token === "stuck" ? 1 : Number(token.slice("page-".length));
    return this.reply(200, this.page(index));
  }) as unknown as typeof import("../../src/connectors/same-origin-fetch.ts").fetchSameOriginOnly;
}

/** One export row; every column the sync selects, with the usual defaults. */
export function bqRow(over: BqRow = {}): BqRow {
  return {
    day: "2026-11-18",
    billing_account_id: "01AB23-CD45EF-6789AB",
    project_id: "web-prod",
    project_name: "Web Production",
    service: "Compute Engine",
    sku_id: "SKU-1",
    sku: "N2 Core running in Americas",
    region: "us-central1",
    currency: "USD",
    unit: "hour",
    cost_type: "regular",
    labels_json: "[]",
    cost: "10",
    credits: "0",
    quantity: "24",
    ...over,
  };
}
