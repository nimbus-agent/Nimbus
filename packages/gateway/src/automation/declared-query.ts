// packages/gateway/src/automation/declared-query.ts
// The executor of a workflow `query` step (Phase 10 SA2, spec § 5.4): one bound SELECT over the
// local `item` table, built from the closed {@link DeclaredQuery} form. Nothing in the query is ever
// concatenated into SQL: the service, type, predicate values, cutoffs and limit are bound
// parameters, and a metadata key (already validated against `METADATA_KEY_PATTERN`) travels as a
// bound JSON path (`$.<key>`), so the SQL text is one of a fixed few shapes (a test pins it).
//
// The values it returns are ids, never free text: a value that is not a string of the id alphabet
// is dropped and counted. WHICH items match is decided by indexed data that connectors wrote, so a
// sender of mail can influence membership (the stated residual of spec § 5.4); the owner's
// predicates, not the sender, choose the shape, and the limit bounds the count.
import type { Database } from "bun:sqlite";
import {
  type DeclaredPredicate,
  type DeclaredQuery,
  isSelectableColumn,
  METADATA_KEY_PATTERN,
  QUERY_LIMIT_MAX,
} from "./workflow-steps.ts";

/** A selected value must match this (an id), else it is dropped and counted. */
export const SELECTED_VALUE_PATTERN = /^[A-Za-z0-9_.:-]{1,256}$/;

const DAY_MS = 86_400_000;

export type DeclaredQueryResult = {
  /** The accepted values, in `modified_at` order, deduplicated when the query asked. */
  readonly values: readonly string[];
  /** Rows whose selected value was absent, not a string or not an id. */
  readonly dropped: number;
};

export type CompiledQuery = { readonly sql: string; readonly params: readonly (string | number)[] };

function jsonPath(key: string): string {
  if (!METADATA_KEY_PATTERN.test(key)) throw new Error("declared query: invalid metadata key");
  return `$.${key}`;
}

/** One predicate as SQL over `item`, with its bound parameters. */
function predicateSql(
  p: DeclaredPredicate,
  now: number,
): { sql: string; params: (string | number)[] } {
  if ("olderThanDays" in p) {
    return { sql: "modified_at < ?", params: [now - p.olderThanDays * DAY_MS] };
  }
  if ("newerThanDays" in p) {
    return { sql: "modified_at > ?", params: [now - p.newerThanDays * DAY_MS] };
  }
  const path = jsonPath(p.metadata);
  // json_each / json_extract raise on malformed JSON, so the CASE guards them (SQLite evaluates a
  // CASE branch only when chosen).
  if ("contains" in p) {
    return {
      sql: "CASE WHEN json_valid(metadata) THEN EXISTS (SELECT 1 FROM json_each(item.metadata, ?) WHERE value = ?) ELSE 0 END",
      params: [path, p.contains],
    };
  }
  if ("notContains" in p) {
    return {
      sql: "CASE WHEN json_valid(metadata) THEN NOT EXISTS (SELECT 1 FROM json_each(item.metadata, ?) WHERE value = ?) ELSE 0 END",
      params: [path, p.notContains],
    };
  }
  // SQLite's JSON booleans compare as 1 / 0.
  let equals = p.equals;
  if (typeof equals === "boolean") equals = equals ? 1 : 0;
  return {
    sql: "CASE WHEN json_valid(metadata) THEN json_extract(metadata, ?) = ? ELSE 0 END",
    params: [path, equals],
  };
}

/** Compiles a validated query to one statement; throws when it was not validated. */
export function compileDeclaredQuery(q: DeclaredQuery, now: number): CompiledQuery {
  if (!isSelectableColumn(q.select)) throw new Error("declared query: invalid select");
  if (!Number.isInteger(q.limit) || q.limit < 1 || q.limit > QUERY_LIMIT_MAX) {
    throw new Error("declared query: invalid limit");
  }
  const params: (string | number)[] = [];
  let column: string;
  if (q.select === "id" || q.select === "external_id") {
    column = q.select;
  } else {
    column = "CASE WHEN json_valid(metadata) THEN json_extract(metadata, ?) END";
    params.push(jsonPath(q.select.slice("metadata.".length)));
  }
  const clauses = ["service = ?", "type = ?"];
  params.push(q.service, q.type);
  for (const p of q.where) {
    const c = predicateSql(p, now);
    clauses.push(c.sql);
    params.push(...c.params);
  }
  params.push(q.limit);
  return {
    sql: `SELECT ${column} AS v FROM item WHERE ${clauses.join(" AND ")} ORDER BY modified_at ASC, id ASC LIMIT ?`,
    params,
  };
}

/** Runs a validated declared query against the local index (read only) and filters its values. */
export function runDeclaredQuery(
  db: Database,
  q: DeclaredQuery,
  now: number = Date.now(),
): DeclaredQueryResult {
  const compiled = compileDeclaredQuery(q, now);
  const rows = db.query(compiled.sql).all(...compiled.params) as { v: unknown }[];
  const values: string[] = [];
  const seen = new Set<string>();
  let dropped = 0;
  for (const { v } of rows) {
    if (typeof v !== "string" || !SELECTED_VALUE_PATTERN.test(v)) {
      dropped++;
      continue;
    }
    if (q.distinct) {
      if (seen.has(v)) continue;
      seen.add(v);
    }
    values.push(v);
  }
  return { values, dropped };
}
