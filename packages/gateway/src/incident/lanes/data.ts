import type { Database } from "bun:sqlite";
import { matchesDataModelGlob } from "../../metrics/data-model-glob.ts";
import type { ServiceConfig } from "../../metrics/dora-config.ts";
import type { DataItemView, DataLane, DataLineageView, GapNote } from "../incident-record-types.ts";
import { CHAT_WINDOW_BEFORE_MS, codeUnitCompare, DATA_LIST_CAP, gap, oneLine } from "./caps.ts";
import { runsOfJobs } from "./data-runs.ts";

/**
 * Lane 6, data (Phase 10 IC3, design C step 8), for Monte Carlo and Bigeye triggers only: the monitored model
 * keys, one hop of lineage (the `derived_from` edges FROM the model), orchestration items (dbt jobs, Airflow
 * DAGs, Dagster jobs, Prefect deployments) whose TITLE holds the model's last identifier segment as a whole
 * token (a name match, not lineage: those items carry no model reference), and pull requests merged in the 24 h
 * before the trigger whose title or branch holds the same token. Runs of the Airflow, Dagster and Prefect items so matched
 * (failed, or running inside the incident window) are listed beside them (`data-runs.ts`); the other run-level
 * lanes the spec names (dbt test results, warehouse schema deltas) are not indexed, and are always listed as gaps.
 */

export type DataResult = { readonly lane: DataLane; readonly gaps: readonly GapNote[] };

const MIN_TOKEN = 3;
/** At most this many monitored model keys are followed; the true count is disclosed as a gap. */
export const MODEL_KEY_CAP = 50;
/** Rows a single lane query may load. A query that returns this many has been cut, and the lane says so. */
export const SCAN_ROW_CAP = 500;

/** Escape a token for a LIKE pattern (`!` is the ESCAPE character; tokens are already lower-cased). */
function likeOf(token: string): string {
  return `%${token.replace(/[!%_]/g, (ch) => `!${ch}`)}%`;
}

/** `(lower(col) LIKE ? ESCAPE '!' OR ...)` over the tokens: a SQL pre-filter, the whole-token check stays in JS. */
function likeAny(
  cols: readonly string[],
  tokens: readonly string[],
): { sql: string; args: string[] } {
  const parts: string[] = [];
  const args: string[] = [];
  for (const t of tokens) {
    for (const c of cols) {
      parts.push(`lower(${c}) LIKE ? ESCAPE '!'`);
      args.push(likeOf(t));
    }
  }
  return { sql: `(${parts.join(" OR ")})`, args };
}

const ORCHESTRATION: readonly (readonly [string, string])[] = [
  ["dbt", "job"],
  ["airflow", "dag"],
  ["dagster", "job"],
  ["prefect", "deployment"],
];
// Bitbucket writes no merge time (`merged_at` is never set), so its pull requests cannot be placed in the window.
const PR_SERVICES = ["github", "gitlab"] as const;

/** The last `.`-separated segment of a normalised model key, lower-cased, or null when too short. */
export function modelToken(key: string): string | null {
  const seg = key.split(".").pop() ?? "";
  const t = seg.toLowerCase();
  return t.length >= MIN_TOKEN ? t : null;
}

/** Whole-token match: the token bounded by non-alphanumeric characters (`orders` does not match `reorders`). */
export function holdsToken(text: string, token: string): boolean {
  const lower = text.toLowerCase();
  let from = 0;
  for (;;) {
    const at = lower.indexOf(token, from);
    if (at < 0) return false;
    const before = at === 0 ? "" : (lower[at - 1] ?? "");
    const after = lower[at + token.length] ?? "";
    if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) return true;
    from = at + 1;
  }
}

function monitoredKeys(metadata: Record<string, unknown> | null): string[] {
  // lane-census: scope=data_quality_test service=montecarlo,bigeye
  const v = metadata?.["monitoredDataModelKeys"];
  return Array.isArray(v)
    ? v.filter((x): x is string => typeof x === "string" && x !== "").sort(codeUnitCompare)
    : [];
}

function lineage(
  db: Database,
  keys: readonly string[],
  truncated: { value: boolean },
): DataLineageView[] {
  const out: DataLineageView[] = [];
  for (const model of keys) {
    const rows = db
      .query(
        `SELECT up.external_id AS ext FROM graph_entity m
           JOIN graph_relation r ON r.from_id = m.id AND r.type = 'derived_from'
           JOIN graph_entity up ON up.id = r.to_id
          WHERE m.type = 'data_model' AND m.external_id = ?
          ORDER BY up.external_id ASC
          LIMIT ${String(SCAN_ROW_CAP)}`,
      )
      .all(model) as { ext: string }[];
    if (rows.length >= SCAN_ROW_CAP) truncated.value = true;
    for (const r of rows) out.push({ model, to: r.ext, rule: "data:derived_from" });
  }
  return out.sort((a, b) =>
    a.model === b.model ? codeUnitCompare(a.to, b.to) : codeUnitCompare(a.model, b.model),
  );
}

type ItemRow = {
  id: string;
  service: string;
  type: string;
  title: string;
  url: string | null;
  modified_at: number;
  metadata: string | null;
};

function orchestration(
  db: Database,
  tokens: readonly string[],
  truncated: { value: boolean },
): DataItemView[] {
  const out = new Map<string, DataItemView>();
  if (tokens.length === 0) return [];
  const like = likeAny(["title"], tokens);
  const q = db.query(
    `SELECT id, service, type, title, url, modified_at, metadata FROM item
      WHERE service = ? AND type = ? AND ${like.sql} ORDER BY title ASC, id ASC LIMIT ${String(SCAN_ROW_CAP)}`,
  );
  for (const [service, type] of ORCHESTRATION) {
    const found = q.all(service, type, ...like.args) as ItemRow[];
    if (found.length >= SCAN_ROW_CAP) truncated.value = true;
    for (const r of found) {
      if (out.has(r.id) || !tokens.some((t) => holdsToken(r.title, t))) continue;
      out.set(r.id, {
        id: r.id,
        service: r.service,
        type: r.type,
        title: oneLine(r.title),
        url: r.url,
        atMs: r.modified_at,
        rule: "name_match",
      });
    }
  }
  return [...out.values()].sort((a, b) =>
    a.title === b.title ? codeUnitCompare(a.id, b.id) : codeUnitCompare(a.title, b.title),
  );
}

function branchOf(metadata: string | null): string {
  if (metadata === null) return "";
  try {
    const v: unknown = JSON.parse(metadata);
    const b = v !== null && typeof v === "object" ? (v as Record<string, unknown>)["branch"] : null;
    return typeof b === "string" ? b : "";
  } catch {
    return "";
  }
}

function mergedPrs(
  db: Database,
  tokens: readonly string[],
  openedAtMs: number,
  truncated: { value: boolean },
): { readonly items: DataItemView[]; readonly mergedAt: Map<string, number> } {
  const from = openedAtMs - CHAT_WINDOW_BEFORE_MS;
  if (tokens.length === 0) return { items: [], mergedAt: new Map() };
  const like = likeAny(["title", "metadata"], tokens);
  // lane-census: scope=pr service=github,gitlab
  const rows = db
    .query(
      `SELECT id, service, type, title, url, modified_at, metadata,
              CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.merged_at') END AS merged_at
         FROM item
        WHERE type = 'pr' AND service IN (${PR_SERVICES.map(() => "?").join(",")})
          AND CASE WHEN json_valid(metadata) THEN json_extract(metadata, '$.merged_at') END BETWEEN ? AND ?
          AND ${like.sql}
        ORDER BY merged_at DESC, id ASC
        LIMIT ${String(SCAN_ROW_CAP)}`,
    )
    .all(...PR_SERVICES, from, openedAtMs, ...like.args) as (ItemRow & { merged_at: number })[];
  if (rows.length >= SCAN_ROW_CAP) truncated.value = true;
  const mergedAt = new Map<string, number>();
  const items: DataItemView[] = [];
  for (const r of rows) {
    const hay = `${r.title}\n${branchOf(r.metadata)}`;
    if (!tokens.some((t) => holdsToken(hay, t))) continue;
    mergedAt.set(r.id, r.merged_at);
    items.push({
      id: r.id,
      service: r.service,
      type: r.type,
      title: oneLine(r.title),
      url: r.url,
      atMs: r.merged_at,
      rule: "data:pr_title_or_branch",
    });
  }
  return { items, mergedAt };
}

/** The gaps every data record carries: the run-level lanes the index does not hold. */
export function dataSubstrateGaps(): GapNote[] {
  return [
    gap(
      "missing_entity_type",
      "dbt test results and warehouse schema deltas are not indexed, so what a failing test or a schema change did is absent here. Orchestrator run logs are never indexed: a run shows its state, timing and failed task names only.",
    ),
    gap(
      "missing_relation_emit",
      "Orchestration jobs listed here are matched by NAME only (they carry no model reference), so a job that builds the model under another name is absent.",
    ),
  ];
}

/**
 * A PAGERDUTY incident is a data incident when its bound `[ci.service.<id>]` declares `data_models` (owner
 * ruling OR-S4-DATA: PagerDuty incidents carry no tag the index keeps, so the owner's own configuration is the
 * tag). The monitored models are the indexed warehouse models (`data_model` graph entities) whose key one of
 * the globs matches, in key order and at most {@link SCAN_ROW_CAP} scanned; then the lane is the one a Monte
 * Carlo or Bigeye trigger gets. Any other trigger, an unbound incident and a service with no `data_models`
 * return null (the general incident brief).
 */
export function pagerdutyDataLane(
  db: Database,
  input: {
    readonly service: string;
    readonly cfg: ServiceConfig | null;
    readonly openedAtMs: number | null;
  },
): DataResult | null {
  if (input.service !== "pagerduty" || input.cfg === null || input.cfg.dataModels.length === 0) {
    return null;
  }
  const rows = db
    .query(
      `SELECT external_id AS ext FROM graph_entity WHERE type = 'data_model'
        ORDER BY external_id ASC LIMIT ${String(SCAN_ROW_CAP)}`,
    )
    .all() as { ext: string }[];
  const globs = input.cfg.dataModels;
  const keys = rows.map((r) => r.ext).filter((k) => globs.some((g) => matchesDataModelGlob(g, k)));
  return dataLane(db, {
    metadata: { monitoredDataModelKeys: keys },
    openedAtMs: input.openedAtMs,
  });
}

export function dataLane(
  db: Database,
  input: { readonly metadata: Record<string, unknown> | null; readonly openedAtMs: number | null },
): DataResult {
  const allModels = monitoredKeys(input.metadata);
  const models = allModels.slice(0, MODEL_KEY_CAP);
  const tokens = models.map(modelToken).filter((t): t is string => t !== null);
  const truncated = { value: false };
  const lin = lineage(db, models, truncated);
  const orch = orchestration(db, tokens, truncated);
  const prs =
    input.openedAtMs === null ? { items: [] } : mergedPrs(db, tokens, input.openedAtMs, truncated);
  const runs = runsOfJobs(db, orch, input.openedAtMs, SCAN_ROW_CAP);
  if (runs.truncated) truncated.value = true;
  const gaps = [...dataSubstrateGaps(), ...runs.gaps];
  if (allModels.length > MODEL_KEY_CAP) {
    gaps.push(
      gap(
        "missing_entity_type",
        `This item monitors ${String(allModels.length)} models; only the first ${String(MODEL_KEY_CAP)} (by key) were followed.`,
      ),
    );
  }
  if (truncated.value) {
    gaps.push(
      gap(
        "missing_entity_type",
        `A data query reached its ${String(SCAN_ROW_CAP)}-row limit, so the counts here are lower bounds.`,
      ),
    );
  }
  if (models.length === 0) {
    gaps.push(
      gap(
        "missing_relation_emit",
        "This item names no monitored table, so no lineage, job or change could be matched.",
      ),
    );
  }
  return {
    lane: {
      models,
      lineage: lin.slice(0, DATA_LIST_CAP),
      orchestration: orch.slice(0, DATA_LIST_CAP),
      prs: prs.items.slice(0, DATA_LIST_CAP),
      runs: runs.runs.slice(0, DATA_LIST_CAP),
      totals: {
        lineage: lin.length,
        orchestration: orch.length,
        prs: prs.items.length,
        runs: runs.total,
      },
    },
    gaps,
  };
}
