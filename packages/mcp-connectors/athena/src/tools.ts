import { z } from "zod";
import { mcpJsonResult as jsonResult } from "../../shared/mcp-tool-kit.ts";
import { nimbusSpawn } from "../../shared/nimbus-spawn.ts";
import type { ZodToolRegistrar } from "../../shared/run-read-only-mcp-connector.ts";
import { isSafeCliArg } from "../../shared/safe-cli-arg.ts";

/**
 * A catalog / database / table name passed as a value to the `aws athena` CLI.
 * Rejected at the schema boundary if it begins with `-` (argv flag smuggling) or
 * contains control characters.
 */
const cliArg = z
  .string()
  .min(1)
  .refine(isSafeCliArg, { message: 'must not start with "-" or contain control characters' });

/**
 * Amazon Athena (Tier-3, metadata-only) MCP tool surface. ALL tools index
 * catalog / database / TABLE-metadata only (data catalogs, databases, table
 * names, table types, column names + types, partition keys, parameters,
 * timestamps). NONE fetch row / cell / query-result data — there is NO
 * `start-query-execution`, NO `get-query-results`, NO `get-query-execution`.
 * The names are introspected by the `assertNoRowDataTools` contract test, so
 * they must never contain a row-data segment (query/rows/results/scan/…).
 */
export const ATHENA_TOOL_NAMES = ["athena_list", "athena_get", "athena_search"] as const;

const PAGE = "200";

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strField(r: Record<string, unknown>, key: string): string {
  const v = r[key];
  return typeof v === "string" ? v : "";
}

function asArray(parsed: unknown, key: string): unknown[] {
  if (!isRecord(parsed)) {
    return [];
  }
  const arr = parsed[key];
  return Array.isArray(arr) ? arr : [];
}

/**
 * Run `aws athena <args> --output json` and parse stdout. The AWS CLI reads
 * AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY / AWS_DEFAULT_REGION / AWS_PROFILE
 * natively from the process env injected at spawn time. Throws on non-zero exit.
 */
async function athenaCli(args: string[]): Promise<unknown> {
  const { code, stdout, stderr } = await nimbusSpawn(
    ["aws", "athena", ...args, "--output", "json"],
    {},
  );
  const out = stdout.trim();
  const err = stderr.trim();
  if (code !== 0) {
    throw new Error(`aws athena ${args[0] ?? ""} failed: ${err.slice(0, 400)}`);
  }
  return out === "" ? {} : (JSON.parse(out) as unknown);
}

function catalogMatches(entry: unknown, q: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return strField(entry, "CatalogName").toLowerCase().includes(q.toLowerCase());
}

function nameMatches(entry: unknown, q: string): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return strField(entry, "Name").toLowerCase().includes(q.toLowerCase());
}

// Databases and tables are both matched on their `Name` field.
const databaseMatches = nameMatches;
const tableMatches = nameMatches;

/**
 * Register the read-only, metadata-only Athena tools onto the given registrar.
 * Shared between `server.ts` (live) and the contract test (introspection).
 */
export function registerAthenaTools(reg: ZodToolRegistrar): void {
  reg(
    "athena_list",
    "List Athena data catalogs, the databases in a catalog, or the tables in a database — METADATA ONLY. With no arguments, lists data catalogs (`aws athena list-data-catalogs`). With `catalog` set, lists that catalog's databases (`aws athena list-databases`). With `catalog` + `database` set, lists that database's table metadata (`aws athena list-table-metadata`) — each entry carries `Name`, `TableType`, `Columns`, and `PartitionKeys`. Never runs a query or returns row/cell data.",
    z.object({
      catalog: cliArg.optional(),
      database: cliArg.optional(),
    }),
    async (p) => {
      if (p.catalog === undefined) {
        return jsonResult(await athenaCli(["list-data-catalogs", "--max-results", PAGE]));
      }
      if (p.database === undefined) {
        return jsonResult(
          await athenaCli(["list-databases", "--catalog-name", p.catalog, "--max-results", PAGE]),
        );
      }
      return jsonResult(
        await athenaCli([
          "list-table-metadata",
          "--catalog-name",
          p.catalog,
          "--database-name",
          p.database,
          "--max-results",
          PAGE,
        ]),
      );
    },
  );

  reg(
    "athena_get",
    "Fetch one Athena table's schema + METADATA (`aws athena get-table-metadata`). Returns the table object including `Columns` (column names + types only), `PartitionKeys`, `TableType`, `Parameters`, and timestamps. No cell values or query results are returned — schema/metadata only.",
    z.object({
      catalog: cliArg,
      database: cliArg,
      table: cliArg,
    }),
    async (p) => {
      return jsonResult(
        await athenaCli([
          "get-table-metadata",
          "--catalog-name",
          p.catalog,
          "--database-name",
          p.database,
          "--table-name",
          p.table,
        ]),
      );
    },
  );

  reg(
    "athena_search",
    "Substring search over Athena catalog, database, and table NAMES (case-insensitive) — METADATA ONLY. With no `catalog`, searches data-catalog names. With `catalog` set (no `database`), searches that catalog's database names. With `catalog` + `database` set, searches that database's table names. Returns a `{ matches: [...] }` envelope of metadata entries. Never runs a query or samples row data.",
    z.object({
      catalog: cliArg.optional(),
      database: cliArg.optional(),
      query: z.string().min(1),
    }),
    async (p) => {
      if (p.catalog === undefined) {
        const root = await athenaCli(["list-data-catalogs", "--max-results", PAGE]);
        const matches = asArray(root, "DataCatalogsSummary").filter((c) =>
          catalogMatches(c, p.query),
        );
        return jsonResult({ matches });
      }
      if (p.database === undefined) {
        const root = await athenaCli([
          "list-databases",
          "--catalog-name",
          p.catalog,
          "--max-results",
          PAGE,
        ]);
        const matches = asArray(root, "DatabaseList").filter((d) => databaseMatches(d, p.query));
        return jsonResult({ matches });
      }
      const root = await athenaCli([
        "list-table-metadata",
        "--catalog-name",
        p.catalog,
        "--database-name",
        p.database,
        "--max-results",
        PAGE,
      ]);
      const matches = asArray(root, "TableMetadataList").filter((t) => tableMatches(t, p.query));
      return jsonResult({ matches });
    },
  );
}
