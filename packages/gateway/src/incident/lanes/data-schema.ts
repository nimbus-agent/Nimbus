import type { Database } from "bun:sqlite";

import { readSchemaHistory, type SchemaChange } from "../../index/schema-diff.ts";
import type {
  DataLineageView,
  DataSchemaChangeView,
  DataSchemaLane,
  GapNote,
} from "../incident-record-types.ts";
import { codeUnitCompare, gap, oneLine } from "./caps.ts";

/**
 * The schema half of the data lane (Phase 10, the Data Incident Brief's warehouse schema diff, owner ruling
 * OR-S4-DATA-INPUTS): the column-level changes of the monitored tables and of their one-hop upstream models
 * that the schema history (`schema_history`, V108) observed in the window, with the change kind and the column
 * name and type only. Reads the local index only (I57 (a)); a diff exists only between two complete
 * observations, and anything the history could not prove is a named gap, never a "dropped" column.
 *
 * The window runs from the trigger's open time minus `[incident] data_schema_lookback_hours` to the assembly
 * time, at most {@link AFTER_OPEN_MS} after the open time. The end is NOT stored in the record (it would change
 * on every assembly); the list changes only when a new change is observed.
 */

export const AFTER_OPEN_MS = 24 * 3_600_000;
/** Tables examined: the monitored ones first, then their upstream models; the rest is disclosed. */
export const SCHEMA_KEY_CAP = 100;
/** Changes kept in a record; the true total is stored beside them. */
export const SCHEMA_CHANGE_CAP = 40;
const NAMES_IN_GAP = 3;
const TEXT_MAX = 128;

export type SchemaLaneResult = { readonly lane: DataSchemaLane | null; readonly gaps: GapNote[] };

function text(v: string | null): string | null {
  return v === null ? null : oneLine(v, TEXT_MAX);
}

function nullableText(v: boolean | null): string {
  if (v === null) return "unknown";
  return v ? "nullable" : "required";
}

function viewOf(
  model: string,
  via: "monitored" | "upstream",
  atMs: number,
  c: SchemaChange,
): DataSchemaChangeView {
  const nullability = c.kind === "nullability_changed";
  return {
    model,
    via,
    atMs,
    kind: c.kind,
    column: oneLine(c.column, TEXT_MAX),
    from: nullability ? nullableText(c.fromNullable) : text(c.fromType),
    to: nullability ? nullableText(c.toNullable) : text(c.toType),
    rule: "data:schema_history",
  };
}

function names(keys: readonly string[]): string {
  const shown = keys.slice(0, NAMES_IN_GAP).join(", ");
  return keys.length > NAMES_IN_GAP
    ? `${shown} and ${String(keys.length - NAMES_IN_GAP)} more`
    : shown;
}

const REDSHIFT_BOUND =
  "Schema history is kept only for Snowflake and BigQuery tables; Redshift has no connector, so its tables never have one.";

function compareChanges(a: DataSchemaChangeView, b: DataSchemaChangeView): number {
  if (a.atMs !== b.atMs) return b.atMs - a.atMs;
  if (a.model !== b.model) return codeUnitCompare(a.model, b.model);
  return codeUnitCompare(a.column, b.column);
}

/** The lane's gaps: tables with no history, with an incomplete column list, with history cut, past the cap. */
function schemaGaps(t: {
  readonly noHistory: readonly string[];
  readonly incomplete: readonly string[];
  readonly cut: readonly string[];
  readonly examined: number;
  readonly found: number;
}): GapNote[] {
  const gaps: GapNote[] = [];
  if (t.noHistory.length > 0) {
    gaps.push(
      gap(
        "missing_entity_type",
        `No schema history is recorded for ${String(t.noHistory.length)} of ${String(t.examined)} tables (${names(t.noHistory)}): a warehouse sync has not yet seen them with a complete column list, so their schema changes could not be checked. ${REDSHIFT_BOUND}`,
      ),
    );
  }
  if (t.incomplete.length > 0) {
    gaps.push(
      gap(
        "missing_entity_type",
        `For ${String(t.incomplete.length)} tables (${names(t.incomplete)}) a sync could not list every column in the window, so what changed between those observations is unknown and no column is reported dropped.`,
      ),
    );
  }
  if (t.cut.length > 0) {
    gaps.push(
      gap(
        "missing_entity_type",
        `${String(t.cut.length)} tables (${names(t.cut)}) have more recorded schema observations than were read, so the oldest changes in the window may be absent.`,
      ),
    );
  }
  if (t.found > t.examined) {
    gaps.push(
      gap(
        "missing_entity_type",
        `${String(t.found)} monitored and upstream tables were found; only the first ${String(SCHEMA_KEY_CAP)} were checked for schema changes.`,
      ),
    );
  }
  return gaps;
}

/** Each examined table's schema changes in the window, and which tables could not be fully read. */
function readChanges(
  db: Database,
  examined: readonly { readonly key: string; readonly via: "monitored" | "upstream" }[],
  bounds: { readonly fromMs: number; readonly toMs: number },
): {
  changes: DataSchemaChangeView[];
  noHistory: string[];
  incomplete: string[];
  cut: string[];
} {
  const changes: DataSchemaChangeView[] = [];
  const noHistory: string[] = [];
  const incomplete: string[] = [];
  const cut: string[] = [];
  for (const { key, via } of examined) {
    const r = readSchemaHistory(db, key, bounds);
    if (r.noHistory) noHistory.push(key);
    if (r.incompleteAtMs.length > 0) incomplete.push(key);
    if (r.cut) cut.push(key);
    for (const c of r.changes) changes.push(viewOf(key, via, c.atMs, c.change));
  }
  return { changes, noHistory, incomplete, cut };
}

export function schemaLane(
  db: Database,
  input: {
    readonly models: readonly string[];
    readonly lineage: readonly DataLineageView[];
    readonly openedAtMs: number | null;
    readonly nowMs: number | null;
    readonly lookbackHours: number;
  },
): SchemaLaneResult {
  if (input.models.length === 0) return { lane: null, gaps: [] };
  if (input.openedAtMs === null) {
    return {
      lane: null,
      gaps: [
        gap(
          "missing_entity_type",
          "This item has no open time, so the warehouse schema changes before it could not be placed in a window.",
        ),
      ],
    };
  }
  const fromMs = input.openedAtMs - input.lookbackHours * 3_600_000;
  const afterOpen = input.openedAtMs + AFTER_OPEN_MS;
  const toMs = input.nowMs === null ? afterOpen : Math.min(input.nowMs, afterOpen);
  const keys: Array<{ key: string; via: "monitored" | "upstream" }> = [];
  const seen = new Set<string>();
  const add = (key: string, via: "monitored" | "upstream"): void => {
    if (seen.has(key)) return;
    seen.add(key);
    keys.push({ key, via });
  };
  for (const m of input.models) add(m, "monitored");
  for (const l of input.lineage) add(l.to, "upstream");
  const examined = keys.slice(0, SCHEMA_KEY_CAP);

  const { changes, noHistory, incomplete, cut } = readChanges(db, examined, { fromMs, toMs });
  changes.sort(compareChanges);

  const gaps = schemaGaps({
    noHistory,
    incomplete,
    cut,
    examined: examined.length,
    found: keys.length,
  });
  return {
    lane: {
      changes: changes.slice(0, SCHEMA_CHANGE_CAP),
      total: changes.length,
      windowFromMs: fromMs,
      lookbackHours: input.lookbackHours,
    },
    gaps,
  };
}
