import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";
import { filterSnowflakeTables } from "./search-filter.ts";

function snowflakeAccount(): string {
  const v = process.env["SNOWFLAKE_ACCOUNT"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("SNOWFLAKE_ACCOUNT is not set");
  }
  return v;
}

function authHeader(): Record<string, string> {
  const t = process.env["SNOWFLAKE_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("SNOWFLAKE_TOKEN is not set");
  }
  return {
    Authorization: `Bearer ${t}`,
    "Content-Type": "application/json",
    Accept: "application/json",
  };
}

const TABLES_SQL =
  "SELECT table_catalog AS database_name, table_schema AS schema_name, table_name, " +
  "row_count, last_altered FROM information_schema.tables WHERE table_schema <> 'INFORMATION_SCHEMA'";

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function rowsFromStatementsResponse(parsed: unknown): Record<string, unknown>[] {
  const root = asRecord(parsed);
  const meta = asRecord(root?.["resultSetMetaData"]);
  const rowType = Array.isArray(meta?.["rowType"]) ? meta["rowType"] : [];
  const names = rowType.map(
    (c) => (asRecord(c)?.["name"] as string | undefined)?.toLowerCase() ?? "",
  );
  const data = Array.isArray(root?.["data"]) ? root["data"] : [];
  const out: Record<string, unknown>[] = [];
  for (const rr of data) {
    if (!Array.isArray(rr)) continue;
    const obj: Record<string, unknown> = {};
    names.forEach((name, i) => {
      if (name !== "") obj[name] = rr[i];
    });
    if (typeof obj["row_count"] === "string" && obj["row_count"] !== "") {
      obj["row_count"] = Number(obj["row_count"]);
    }
    out.push(obj);
  }
  return out;
}

async function fetchTables(): Promise<Record<string, unknown>[]> {
  const url = `https://${snowflakeAccount()}.snowflakecomputing.com/api/v2/statements`;
  const res = await fetch(url, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify({ statement: TABLES_SQL, timeout: 60 }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Snowflake ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return rowsFromStatementsResponse(JSON.parse(text) as unknown);
}

function tableKey(row: Record<string, unknown>): string {
  const db = typeof row["database_name"] === "string" ? row["database_name"].toLowerCase() : "";
  const schema = typeof row["schema_name"] === "string" ? row["schema_name"].toLowerCase() : "";
  const table = typeof row["table_name"] === "string" ? row["table_name"].toLowerCase() : "";
  return `${db}.${schema}.${table}`;
}

await runReadOnlyMcpConnector("nimbus-snowflake", (reg) => {
  reg(
    "snowflake_list",
    "List Snowflake tables across all databases and schemas. `limit` (default 200, max 500) caps the returned list.",
    z.object({
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const tables = await fetchTables();
      const cap = p.limit ?? 200;
      return jsonResult({ items: tables.slice(0, cap) });
    },
  );

  reg(
    "snowflake_get",
    "Fetch one Snowflake table by its fully-qualified id (`database.schema.table`, case-insensitive). Throws when the table is not found.",
    z.object({
      id: z.string().min(1),
    }),
    async (p) => {
      const tables = await fetchTables();
      const needle = p.id.toLowerCase();
      const found = tables.find((row) => tableKey(row) === needle);
      if (found === undefined) {
        throw new Error(`Snowflake table not found: ${p.id}`);
      }
      return jsonResult(found);
    },
  );

  reg(
    "snowflake_search",
    "Substring search across Snowflake tables. Matches the query (case-insensitive) against table name, schema name, and database name. Returns a `{ matches: [...] }` envelope.",
    z.object({
      query: z.string().min(1),
      limit: z.number().int().min(1).max(200).optional(),
    }),
    async (p) => {
      const tables = await fetchTables();
      const matches = filterSnowflakeTables(tables, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );
});
