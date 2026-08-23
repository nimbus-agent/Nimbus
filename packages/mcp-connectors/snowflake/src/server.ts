import { z } from "zod";
import { type ConsentServer, createWriteToolRegistrar } from "../../shared/consent-kit.ts";
import { searchToolInputSchema } from "../../shared/mcp-search-tool.ts";
import { fetchWithTimeout, mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import {
  runReadOnlyMcpConnector,
  type ZodToolRegistrar,
} from "../../shared/run-read-only-mcp-connector.ts";
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

/**
 * POST a single SQL statement to the Snowflake SQL REST API (`/api/v2/statements`) with the
 * connector's Bearer auth. Returns the parsed JSON response; throws on a non-OK status. Shared by
 * the read-only `fetchTables` path and the HITL-gated write tools so auth/transport stays in one place.
 */
async function executeStatement(statement: string): Promise<unknown> {
  const url = `https://${snowflakeAccount()}.snowflakecomputing.com/api/v2/statements`;
  const res = await fetchWithTimeout(url, {
    method: "POST",
    headers: authHeader(),
    body: JSON.stringify({ statement, timeout: 60 }),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Snowflake ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

// Each dot-separated part is an unquoted identifier OR a fully double-quoted token (no embedded ").
const SF_IDENT_PART = /^(?:[A-Za-z_][A-Za-z0-9_$]*|"[^"]+")$/;
function assertSfIdentifier(name: string, label: string): string {
  const parts = name.split(".");
  for (const part of parts) {
    if (!SF_IDENT_PART.test(part)) {
      throw new Error(`unsafe Snowflake identifier component for ${label}: ${part} in ${name}`);
    }
  }
  return name;
}

// String literals are escaped by doubling single quotes (the only Snowflake literal-injection vector).
function sfLiteral(v: string): string {
  return `'${v.replaceAll("'", "''")}'`;
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

/**
 * Fetch table metadata. With no `page`, returns the full set (used by `snowflake_get` /
 * `snowflake_search`, which must scan every table). With a `page`, appends a deterministic
 * `ORDER BY … LIMIT … OFFSET …` so `snowflake_list` can drain pages — only numbers are
 * interpolated, so there is no SQL-injection surface.
 */
async function fetchTables(page?: {
  limit: number;
  offset: number;
}): Promise<Record<string, unknown>[]> {
  const statement =
    page === undefined
      ? TABLES_SQL
      : // (table_catalog, table_schema, table_name) uniquely identifies a table in INFORMATION_SCHEMA
        // — a TOTAL order, so OFFSET paging cannot skip or duplicate rows across pages.
        `${TABLES_SQL} ORDER BY table_catalog, table_schema, table_name LIMIT ${page.limit} OFFSET ${page.offset}`;
  return rowsFromStatementsResponse(await executeStatement(statement));
}

function tableKey(row: Record<string, unknown>): string {
  const db = typeof row["database_name"] === "string" ? row["database_name"].toLowerCase() : "";
  const schema = typeof row["schema_name"] === "string" ? row["schema_name"].toLowerCase() : "";
  const table = typeof row["table_name"] === "string" ? row["table_name"].toLowerCase() : "";
  return `${db}.${schema}.${table}`;
}

/**
 * Register the three read-only Snowflake tools on `reg`. Exported (rather than inlined into the
 * `runReadOnlyMcpConnector` call) so the tool handlers can be exercised in unit tests without
 * starting a real stdio transport.
 */
export function registerSnowflakeTools(reg: ZodToolRegistrar, server: unknown): void {
  // Despite the read-only helper's name, this connector exposes write tools. The consent
  // kit needs the real server, which the helper now passes through as its second argument.
  const registerWriteTool = createWriteToolRegistrar(server as ConsentServer, {
    connector: "snowflake",
    scopeEnv: "NIMBUS_MCP_SNOWFLAKE_WRITE_SCOPE",
    scopeKinds: ["object"],
  });

  reg(
    "snowflake_list",
    "List Snowflake tables across all databases and schemas. Paginated: `cursor` (opaque offset) + `limit` (default 200, max 500) → `{ items, nextCursor }`.",
    z.object({
      cursor: z.string().nullable().optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    async (p) => {
      const limit = p.limit ?? 200;
      const offset =
        p.cursor === null || p.cursor === undefined || p.cursor === ""
          ? 0
          : Math.max(0, Number.parseInt(p.cursor, 10) || 0);
      const items = await fetchTables({ limit, offset });
      const nextCursor = items.length === limit ? String(offset + limit) : null;
      return jsonResult({ items, nextCursor });
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
    searchToolInputSchema(200),
    async (p) => {
      const tables = await fetchTables();
      const matches = filterSnowflakeTables(tables, { query: p.query, limit: p.limit });
      return jsonResult({ matches });
    },
  );

  registerWriteTool(
    "snowflake_tag_set",
    {
      mutates: "snowflake.tag.set",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "object", value: p.object }),
    },
    "Set or unset a governance TAG on a table. `ALTER TABLE <object> SET TAG <tag> = '<value>'`; omit `value` to UNSET.",
    z.object({
      object: z.string().min(1),
      tag: z.string().min(1),
      value: z.string().optional(),
    }),
    async (p) => {
      const obj = assertSfIdentifier(p.object, "object");
      const tag = assertSfIdentifier(p.tag, "tag");
      const statement =
        p.value === undefined
          ? `ALTER TABLE ${obj} UNSET TAG ${tag}`
          : `ALTER TABLE ${obj} SET TAG ${tag} = ${sfLiteral(p.value)}`;
      await executeStatement(statement);
      return jsonResult({ status: "ok", object: obj, tag });
    },
  );

  registerWriteTool(
    "snowflake_comment_set",
    {
      mutates: "snowflake.comment.set",
      recoverable: true,
      scopeTargetOf: (p) => ({ kind: "object", value: p.object }),
    },
    "Set a COMMENT on a table. `COMMENT ON TABLE <object> IS '<comment>'`.",
    z.object({ object: z.string().min(1), comment: z.string() }),
    async (p) => {
      const obj = assertSfIdentifier(p.object, "object");
      await executeStatement(`COMMENT ON TABLE ${obj} IS ${sfLiteral(p.comment)}`);
      return jsonResult({ status: "ok", object: obj });
    },
  );
}

// Exported so the bundled-connector registry can start this server explicitly: `import.meta.main`
// is false under an import, and the module must stay importable by tests without connecting stdio.
export async function startConnector(): Promise<void> {
  await runReadOnlyMcpConnector("nimbus-snowflake", registerSnowflakeTools);
}

if (import.meta.main) await startConnector();
