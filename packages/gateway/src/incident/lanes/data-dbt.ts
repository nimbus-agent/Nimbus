import type { Database } from "bun:sqlite";
import type { DataLineageView, DataTestView, GapNote } from "../incident-record-types.ts";
import { CHAT_WINDOW_BEFORE_MS, codeUnitCompare, gap, oneLine } from "./caps.ts";

/**
 * The dbt Cloud test results of the Data Incident Brief's data lane (owner ruling OR-S4-DATA-INPUTS): the
 * failing, erroring or warning tests on the monitored models and one hop of their lineage inside the incident
 * window. A MODEL-KEY match (the dbt sync writes `monitoredDataModelKeys` with `normalizeDataModelKey`, the key
 * space Monte Carlo and Bigeye use), not a name match. Index only (I57 (a)); status and counts, never a test's
 * SQL, message or rows.
 */

/** dbt tests are read from this long before the trigger to this long after it. */
export const DBT_WINDOW_BEFORE_MS = CHAT_WINDOW_BEFORE_MS;
export const DBT_WINDOW_AFTER_MS = 3_600_000;
/** At most this many model keys (monitored plus one hop upstream) are matched against dbt tests. */
export const DBT_KEY_CAP = 200;
const ROW_CAP = 500;
const SEVERITY: Record<DataTestView["status"], number> = { fail: 0, error: 1, warn: 2 };

function isIndexedStatus(s: string): s is DataTestView["status"] {
  return s in SEVERITY;
}

type DbtRow = {
  id: string;
  title: string;
  url: string | null;
  modified_at: number;
  metadata: string;
  model: string;
};

/** The row's metadata is a JSON object here: the query's `json_valid` guard and `json_each` yield nothing else. */
function readMeta(metadata: string): {
  status: string;
  failures: number | null;
  runId: number | null;
} {
  const m = JSON.parse(metadata) as Record<string, unknown>;
  return {
    status: typeof m["status"] === "string" ? m["status"] : "",
    failures: typeof m["failures"] === "number" ? m["failures"] : null,
    runId: typeof m["run_id"] === "number" ? m["run_id"] : null,
  };
}

function order(a: DataTestView, b: DataTestView): number {
  return SEVERITY[a.status] - SEVERITY[b.status] || b.atMs - a.atMs || codeUnitCompare(a.id, b.id);
}

/** A test on several models is listed once, against the most direct one (a monitored model over a lineage hop). */
export function dbtTests(
  db: Database,
  models: readonly string[],
  lin: readonly DataLineageView[],
  openedAtMs: number,
  truncated: { value: boolean },
): DataTestView[] {
  const via = new Map<string, "monitored" | "lineage">();
  for (const l of lin) via.set(l.to, "lineage");
  for (const m of models) via.set(m, "monitored");
  const keys = [...via.keys()].sort(codeUnitCompare);
  if (keys.length > DBT_KEY_CAP) truncated.value = true;
  const used = keys.slice(0, DBT_KEY_CAP);
  if (used.length === 0) return [];
  // lane-census: scope=data_quality_test service=dbt
  const rows = db
    .query(
      `SELECT i.id, i.title, i.url, i.modified_at, i.metadata, j.value AS model
         FROM item i, json_each(CASE WHEN json_valid(i.metadata)
                                     THEN json_extract(i.metadata, '$.monitoredDataModelKeys') END) j
        WHERE i.service = 'dbt' AND i.type = 'data_quality_test'
          AND i.modified_at BETWEEN ? AND ?
          AND j.value IN (${used.map(() => "?").join(",")})
        ORDER BY i.modified_at DESC, i.id ASC
        LIMIT ${String(ROW_CAP)}`,
    )
    .all(openedAtMs - DBT_WINDOW_BEFORE_MS, openedAtMs + DBT_WINDOW_AFTER_MS, ...used) as DbtRow[];
  if (rows.length >= ROW_CAP) truncated.value = true;
  const best = new Map<string, DataTestView>();
  for (const r of rows) {
    const meta = readMeta(r.metadata);
    if (!isIndexedStatus(meta.status)) continue;
    const rowVia = via.get(r.model) === "monitored" ? "monitored" : "lineage";
    const prev = best.get(r.id);
    if (prev !== undefined && (prev.via === "monitored" || rowVia !== "monitored")) continue;
    best.set(r.id, {
      id: r.id,
      title: oneLine(r.title),
      url: r.url,
      status: meta.status,
      failures: meta.failures,
      runId: meta.runId,
      atMs: r.modified_at,
      model: r.model,
      via: rowVia,
      rule: "data:dbt_test",
    });
  }
  return [...best.values()].sort(order);
}

/** No dbt item at all, or the bounds of what the sync keeps (an empty list proves nothing). */
export function dbtGap(db: Database): GapNote {
  const present = db.query("SELECT 1 AS n FROM item WHERE service = 'dbt' LIMIT 1").get();
  return present === null
    ? gap(
        "missing_entity_type",
        "dbt test results are not indexed (no dbt data), so a failing test on the monitored models is absent here.",
      )
    : gap(
        "missing_entity_type",
        "Only failing, erroring and warning dbt tests of recent runs are indexed (never a passing test); a model whose job has not run in the window is absent, so an empty dbt list does not show the tests passed.",
      );
}
