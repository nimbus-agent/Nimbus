import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { nimbusSpawn } from "../../shared/nimbus-spawn.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";

/**
 * BigQuery (Tier-3, metadata-only) MCP tool surface. ALL tools index schema /
 * METADATA only (datasets, tables, schema field names + types, row COUNTS, byte
 * sizes, timestamps). NONE fetch row / cell / query-result data — no `bq query`,
 * no `bq head`, no `tabledata.list`. The names are introspected by the
 * `assertNoRowDataTools` contract test, so they must never contain a row-data
 * segment (query/rows/sample/scan/preview/head/export/…).
 */
export const BIGQUERY_TOOL_NAMES = ["bigquery_list", "bigquery_get", "bigquery_search"] as const;

const BASE = "https://bigquery.googleapis.com/bigquery/v2";

function project(explicit?: string): string {
  const p = (explicit ?? process.env["BIGQUERY_PROJECT"])?.trim();
  if (p === undefined || p === "") {
    throw new Error("BIGQUERY_PROJECT is not set and no project argument was provided");
  }
  return p;
}

function gcloudEnv(): Record<string, string | undefined> {
  const e = { ...process.env } as Record<string, string | undefined>;
  const cf = process.env["GOOGLE_APPLICATION_CREDENTIALS"]?.trim();
  if (cf !== undefined && cf !== "") {
    e["GOOGLE_APPLICATION_CREDENTIALS"] = cf;
  }
  return e;
}

/** Mint a short-lived access token via `gcloud auth print-access-token`. */
async function accessToken(): Promise<string> {
  const { code, stdout, stderr } = await nimbusSpawn(
    ["gcloud", "auth", "print-access-token"],
    // Restores GOOGLE_APPLICATION_CREDENTIALS when set; nimbusSpawn already merges process.env.
    gcloudEnv(),
  );
  const out = stdout.trim();
  const err = stderr.trim();
  if (code !== 0 || out === "") {
    throw new Error(`gcloud auth print-access-token failed: ${err.slice(0, 300)}`);
  }
  return out;
}

async function bqGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`BigQuery ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strField(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === "string" ? v : "";
}

function tableMatches(entry: unknown, q: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  const ref = entry["tableReference"];
  const datasetId = isRecord(ref) ? strField(ref, "datasetId") : "";
  const tableId = isRecord(ref) ? strField(ref, "tableId") : "";
  const friendly = strField(entry, "friendlyName");
  const hay = `${datasetId}.${tableId} ${friendly}`.toLowerCase();
  return hay.includes(q.toLowerCase());
}

function datasetMatches(entry: unknown, q: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  const ref = entry["datasetReference"];
  const datasetId = isRecord(ref) ? strField(ref, "datasetId") : "";
  return datasetId.toLowerCase().includes(q.toLowerCase());
}

function asArray(parsed: unknown, key: string): unknown[] {
  if (!isRecord(parsed)) {
    return [];
  }
  const arr = parsed[key];
  return Array.isArray(arr) ? arr : [];
}

/**
 * Register the read-only, metadata-only BigQuery tools onto the given registrar.
 * Shared between `server.ts` (live) and the contract test (introspection).
 */
export function registerBigqueryTools(reg: ZodToolRegistrar): void {
  reg(
    "bigquery_list",
    "List BigQuery datasets, or the tables in a dataset — METADATA ONLY. With no `dataset` argument, lists datasets (`GET /projects/<project>/datasets`). With `dataset` set, lists that dataset's tables (`GET /projects/<project>/datasets/<dataset>/tables`) — each entry carries `tableReference`, `type`, and `creationTime`. Never returns row or cell data.",
    z.object({
      project: z.string().min(1).optional(),
      dataset: z.string().min(1).optional(),
    }),
    async (p) => {
      const token = await accessToken();
      const proj = project(p.project);
      if (p.dataset === undefined) {
        return jsonResult(
          await bqGet(token, `/projects/${encodeURIComponent(proj)}/datasets?maxResults=200`),
        );
      }
      return jsonResult(
        await bqGet(
          token,
          `/projects/${encodeURIComponent(proj)}/datasets/${encodeURIComponent(p.dataset)}/tables?maxResults=200`,
        ),
      );
    },
  );

  reg(
    "bigquery_get",
    "Fetch one BigQuery table's schema + METADATA (`GET /projects/<project>/datasets/<dataset>/tables/<table>`). Returns the table object including `schema.fields` (field names + types only), `numRows`, `numBytes`, `creationTime`, and `lastModifiedTime`. Row COUNTS and byte sizes are metadata, NOT row data; no cell values are returned.",
    z.object({
      project: z.string().min(1).optional(),
      dataset: z.string().min(1),
      table: z.string().min(1),
    }),
    async (p) => {
      const token = await accessToken();
      const proj = project(p.project);
      return jsonResult(
        await bqGet(
          token,
          `/projects/${encodeURIComponent(proj)}/datasets/${encodeURIComponent(p.dataset)}/tables/${encodeURIComponent(p.table)}`,
        ),
      );
    },
  );

  reg(
    "bigquery_search",
    "Substring search over dataset and table NAMES (case-insensitive) — METADATA ONLY. With no `dataset`, searches dataset ids. With `dataset` set, searches that dataset's table ids + friendly names. Returns a `{ matches: [...] }` envelope of metadata entries. Never queries or samples row data.",
    z.object({
      project: z.string().min(1).optional(),
      dataset: z.string().min(1).optional(),
      query: z.string().min(1),
    }),
    async (p) => {
      const token = await accessToken();
      const proj = project(p.project);
      if (p.dataset === undefined) {
        const root = await bqGet(
          token,
          `/projects/${encodeURIComponent(proj)}/datasets?maxResults=200`,
        );
        const matches = asArray(root, "datasets").filter((d) => datasetMatches(d, p.query));
        return jsonResult({ matches });
      }
      const root = await bqGet(
        token,
        `/projects/${encodeURIComponent(proj)}/datasets/${encodeURIComponent(p.dataset)}/tables?maxResults=200`,
      );
      const matches = asArray(root, "tables").filter((t) => tableMatches(t, p.query));
      return jsonResult({ matches });
    },
  );
}
