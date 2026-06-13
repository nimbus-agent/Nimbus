import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { runReadOnlyMcpConnector } from "../../shared/run-read-only-mcp-connector.ts";

function accountId(): string {
  const v = process.env["SNOWFLAKE_ACCOUNT"]?.trim();
  if (v === undefined || v === "") {
    throw new Error("SNOWFLAKE_ACCOUNT is not set");
  }
  return v;
}

function authHeader(): Record<string, string> {
  const tok = process.env["SNOWFLAKE_TOKEN"]?.trim();
  if (tok === undefined || tok === "") {
    throw new Error("SNOWFLAKE_TOKEN is not set");
  }
  return { Authorization: `Bearer ${tok}`, Accept: "application/json" };
}

const TABLES_SQL =
  "SELECT table_catalog AS database_name, table_schema AS schema_name, table_name, " +
  "row_count, last_altered FROM information_schema.tables WHERE table_schema <> 'INFORMATION_SCHEMA'";

interface TableRow {
  database_name: string;
  schema_name: string;
  table_name: string;
  row_count: string | null;
  last_altered: string | null;
}

async function fetchTables(): Promise<TableRow[]> {
  const url = `https://${accountId()}.snowflakecomputing.com/api/v2/statements`;
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeader(), "Content-Type": "application/json" },
    body: JSON.stringify({ statement: TABLES_SQL, timeout: 60 }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Snowflake ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  const body = JSON.parse(text) as {
    resultSetMetaData?: { rowType?: Array<{ name?: string }> };
    data?: string[][];
  };
  const names = (body.resultSetMetaData?.rowType ?? []).map((c) => (c.name ?? "").toLowerCase());
  const rows: TableRow[] = [];
  for (const rr of body.data ?? []) {
    const obj: Record<string, string | null> = {};
    names.forEach((name, i) => {
      obj[name] = rr[i] ?? null;
    });
    rows.push({
      database_name: obj["database_name"] ?? "",
      schema_name: obj["schema_name"] ?? "",
      table_name: obj["table_name"] ?? "",
      row_count: obj["row_count"] ?? null,
      last_altered: obj["last_altered"] ?? null,
    });
  }
  return rows;
}

function tableId(row: TableRow): string {
  return `${row.database_name}.${row.schema_name}.${row.table_name}`.toLowerCase();
}

function matchesQuery(row: TableRow, query: string): boolean {
  const q = query.toLowerCase();
  return (
    row.table_name.toLowerCase().includes(q) ||
    row.schema_name.toLowerCase().includes(q) ||
    row.database_name.toLowerCase().includes(q)
  );
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
      const target = p.id.toLowerCase();
      const found = tables.find((t) => tableId(t) === target);
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
      const matches = tables.filter((t) => matchesQuery(t, p.query)).slice(0, p.limit ?? 50);
      return jsonResult({ matches });
    },
  );
});
