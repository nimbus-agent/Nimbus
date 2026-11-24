import type { Database } from "bun:sqlite";

import type { SchemaColumn } from "./schema-history-source.ts";

/**
 * The diff of two warehouse column sets and the read of a table's recorded history (Phase 10, the schema diff).
 * READ-ONLY: this module has no write verb (the writer is `index/schema-history.ts`, static D24 rule
 * `schema-history-confined`). A diff exists only between two adjacent COMPLETE observations; an incomplete one
 * is reported as a gap and never compared, so a column the sync failed to see is never "dropped".
 */

export type SchemaChangeKind = "added" | "dropped" | "type_changed" | "nullability_changed";

export type SchemaChange = {
  readonly kind: SchemaChangeKind;
  readonly column: string;
  /** The type before and after (added: from null; dropped: to null), or null when the source gave none. */
  readonly fromType: string | null;
  readonly toType: string | null;
  readonly fromNullable: boolean | null;
  readonly toNullable: boolean | null;
};

function codeUnit(a: string, b: string): number {
  if (a < b) return -1;
  return a > b ? 1 : 0;
}

/** Changes sorted by column name, then kind, so two runs over one history are byte-identical. */
export function diffColumns(
  before: readonly SchemaColumn[],
  after: readonly SchemaColumn[],
): SchemaChange[] {
  const prev = new Map(before.map((c) => [c.name, c]));
  const next = new Map(after.map((c) => [c.name, c]));
  const out: SchemaChange[] = [];
  for (const [name, c] of next) {
    const p = prev.get(name);
    if (p === undefined) {
      out.push({
        kind: "added",
        column: name,
        fromType: null,
        toType: c.type,
        fromNullable: null,
        toNullable: c.nullable,
      });
      continue;
    }
    if (p.type !== c.type) {
      out.push({
        kind: "type_changed",
        column: name,
        fromType: p.type,
        toType: c.type,
        fromNullable: p.nullable,
        toNullable: c.nullable,
      });
    }
    if (p.nullable !== c.nullable) {
      out.push({
        kind: "nullability_changed",
        column: name,
        fromType: p.type,
        toType: c.type,
        fromNullable: p.nullable,
        toNullable: c.nullable,
      });
    }
  }
  for (const [name, p] of prev) {
    if (next.has(name)) continue;
    out.push({
      kind: "dropped",
      column: name,
      fromType: p.type,
      toType: null,
      fromNullable: p.nullable,
      toNullable: null,
    });
  }
  return out.sort((a, b) =>
    a.column === b.column ? codeUnit(a.kind, b.kind) : codeUnit(a.column, b.column),
  );
}

type SchemaHistoryRow = {
  readonly observedAtMs: number;
  readonly complete: boolean;
  readonly columns: readonly SchemaColumn[] | null;
};

/** What the history says about one table inside a time window. */
export type SchemaHistoryReading = {
  readonly key: string;
  /** Diffs between adjacent complete observations whose newer one was observed inside the window. */
  readonly changes: ReadonlyArray<{ readonly atMs: number; readonly change: SchemaChange }>;
  /** Observation times inside the window that could not be diffed: an incomplete one, or one after one. */
  readonly incompleteAtMs: readonly number[];
  /** True when the table has no recorded observation at all (history begins at the upgrade). */
  readonly noHistory: boolean;
  /** True when more rows existed than were read, so the oldest part of the window may be missing. */
  readonly cut: boolean;
};

type RawRow = {
  observed_at_ms: number;
  complete: number;
  columns_json: string | null;
};

function parseColumnsJson(text: string | null): SchemaColumn[] | null {
  if (text === null) return null;
  try {
    const v: unknown = JSON.parse(text);
    return Array.isArray(v) ? (v as SchemaColumn[]) : null;
  } catch {
    return null;
  }
}

/** Upper bound of rows read for one table, newest first; a table with more changes than this is cut. */
export const SCHEMA_READ_ROW_CAP = 200;

/**
 * Reads a table's recorded observations and diffs adjacent complete pairs. `fromMs` and `toMs` bound the
 * NEWER observation of each diff; the row just before the window is its baseline.
 */
export function readSchemaHistory(
  db: Database,
  key: string,
  window: { readonly fromMs: number; readonly toMs: number },
): SchemaHistoryReading {
  const raw = db
    .query(
      `SELECT observed_at_ms, complete, columns_json FROM schema_history
        WHERE data_model_key = ? AND observed_at_ms <= ?
        ORDER BY id DESC LIMIT ${String(SCHEMA_READ_ROW_CAP)}`,
    )
    .all(key, window.toMs) as RawRow[];
  if (raw.length === 0) {
    return { key, changes: [], incompleteAtMs: [], noHistory: true, cut: false };
  }
  const rows: SchemaHistoryRow[] = raw
    .map((r) => ({
      observedAtMs: r.observed_at_ms,
      complete: r.complete === 1,
      columns: r.complete === 1 ? parseColumnsJson(r.columns_json) : null,
    }))
    .reverse();
  const changes: Array<{ atMs: number; change: SchemaChange }> = [];
  const incompleteAtMs: number[] = [];
  for (let i = 0; i < rows.length; i++) {
    const cur = rows[i];
    if (cur === undefined || cur.observedAtMs < window.fromMs) continue;
    const prev = i > 0 ? rows[i - 1] : undefined;
    // The oldest row held is a baseline: there is nothing to diff it against.
    if (prev === undefined) {
      if (cur.columns === null) incompleteAtMs.push(cur.observedAtMs);
      continue;
    }
    // An incomplete observation, or one that follows one, cannot be diffed: what changed is unknown.
    if (cur.columns === null || prev.columns === null) {
      incompleteAtMs.push(cur.observedAtMs);
      continue;
    }
    for (const change of diffColumns(prev.columns, cur.columns)) {
      changes.push({ atMs: cur.observedAtMs, change });
    }
  }
  return {
    key,
    changes,
    incompleteAtMs,
    noHistory: false,
    cut: raw.length >= SCHEMA_READ_ROW_CAP,
  };
}
