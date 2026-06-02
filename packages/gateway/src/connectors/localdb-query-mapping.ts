import type { MappedRow } from "./mapped-row.ts";

/**
 * A saved SQL query read from a local DB tool's scripts/console directory
 * (DBeaver, DataGrip, pgAdmin export, or any .sql file tree). The gateway cannot
 * import the connector package, so this mirrors the scanned shape.
 *
 * Local-only, no-network, no-DB-connection: the SQL TEXT is read from disk and
 * indexed for semantic recall ("that one query I wrote last month"). No database
 * is ever connected to and no query is ever executed.
 */
export interface LocalDbQueryInput {
  /** Path relative to the configured scripts dir — the stable external id. */
  readonly relativePath: string;
  readonly sizeBytes: number;
  readonly modifiedAtMs: number | null;
  readonly sql: string;
}

export interface LocalDbMappingContext {
  readonly syncedAt: number;
}

export type LocalDbMappedRow = MappedRow<"localdb", "saved_query">;

const TITLE_MAX = 256;
const PREVIEW_MAX = 2000;
const MAX_TABLES = 32;
const SERVICE = "localdb" as const;
const TYPE = "saved_query" as const;

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Best-effort base name (no extension) of a relative path, for the title. */
export function baseTitle(relativePath: string): string {
  const segments = relativePath.split(/[/\\]/);
  const last = segments[segments.length - 1] ?? relativePath;
  return last.replace(/\.sql$/i, "");
}

/** Strip SQL line and block comments before scanning. */
function stripSqlComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/**
 * Heuristic extraction of referenced table/view identifiers from SQL — matches
 * the identifier following FROM / JOIN / INTO / UPDATE, after stripping comments.
 * Quote and bracket wrappers are removed first, so a quoted schema-qualified name
 * collapses to its dotted form (e.g. public.sales). Pure + deterministic; this is
 * metadata, not a SQL parser.
 */
export function extractTableNames(sql: string): string[] {
  // Remove double-quote / backtick / square-bracket identifier wrappers so a
  // quoted, schema-qualified name becomes a plain dotted identifier. Single
  // quotes (string literals) are intentionally left untouched.
  const cleaned = stripSqlComments(sql).replace(/["`\][]/g, "");
  const re = /\b(?:from|join|into|update)\s+([a-zA-Z_][\w.$]*)/gi;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of cleaned.matchAll(re)) {
    const name = m[1];
    if (name === undefined) {
      continue;
    }
    const key = name.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(name);
      if (out.length >= MAX_TABLES) {
        break;
      }
    }
  }
  return out;
}

/** Count terminated statements (best-effort; a trailing fragment counts as one). */
export function countStatements(sql: string): number {
  const trimmed = sql.trim();
  if (trimmed === "") {
    return 0;
  }
  const terminated = (trimmed.match(/;/g) ?? []).length;
  return trimmed.endsWith(";") ? terminated : terminated + 1;
}

/**
 * Pure mapper: a scanned local .sql file → a localdb:saved_query IndexedItem.
 * Stores the SQL TEXT (capped) as the body preview plus lightweight metadata
 * (referenced tables, statement count, size). Returns null for an empty file.
 */
export function mapLocalDbQueryToItem(
  input: LocalDbQueryInput,
  ctx: LocalDbMappingContext,
): LocalDbMappedRow | null {
  const sql = input.sql ?? "";
  if (sql.trim() === "") {
    return null;
  }
  const relativePath = input.relativePath.trim();
  if (relativePath === "") {
    return null;
  }

  const title = clamp(baseTitle(relativePath) || relativePath, TITLE_MAX);
  const bodyPreview = clamp(sql, PREVIEW_MAX);
  const tables = extractTableNames(sql);

  const metadata: Record<string, unknown> = {
    relativePath,
    sizeBytes: input.sizeBytes,
    statementCount: countStatements(sql),
    tables,
  };

  return {
    service: SERVICE,
    type: TYPE,
    externalId: relativePath,
    title,
    bodyPreview,
    url: null,
    canonicalUrl: null,
    modifiedAt: input.modifiedAtMs ?? ctx.syncedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
