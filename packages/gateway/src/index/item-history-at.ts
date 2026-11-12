import type { Database } from "bun:sqlite";

import { ITEM_HISTORY_SPECS, normalizeHistoryValue, specFor } from "./item-history-keys.ts";
import { itemPrimaryKey } from "./item-key.ts";

/**
 * Point-in-time reconstruction over `item_history` (Phase 10 IC1, incident-engine spec § 5.1). READ-ONLY:
 * the table is written only by `item-history.ts` (static D46(b)); reading it is unrestricted.
 *
 * An item that exists NOW is classified at instant T as `in` (it existed and its state at T can be
 * reconstructed), `out` (it did not exist at T) or `gap` (it may or may not have existed, or its state at T
 * cannot be reconstructed). With `H0(service)` = the earliest history row of that service:
 *
 * - `seen` = the item's earliest `__created` row; `born` = the provider creation time named by the spec;
 *   `covered` = `COALESCE(seen, H0)`; `tracks` = the spec's `modifiedAtTracksChange` (untracked pairs: true).
 * - OUT when the latest `__created`/`__deleted` row at or before T is `__deleted`, or `born > T`.
 * - Existence: `born <= T`, else (born unknown) `seen <= T`, else (a TRACKED pair with no `__created` row
 *   was inserted before history began) `T >= H0`, else `tracks AND modified_at <= T`; else GAP.
 * - State: IN when `T >= covered`, or `tracks AND modified_at <= T`; otherwise GAP (the state may have
 *   changed after T before history began).
 * - An IN item's value for a tracked key at T is the `old_value` of that key's earliest change after T, else
 *   the current value.
 *
 * Stated bounds: observation time is the sync's, not the provider's; an item deleted since T has no `item`
 * row and is not shown; the first observed state stands in for earlier states (the disclosure says so);
 * untracked item types are admitted only when `modified_at <= T` and otherwise counted as gaps.
 */

export type AtClause = { readonly sql: string; readonly params: ReadonlyArray<string | number> };
export type AtClass = "in" | "gap";

const ALIASES: ReadonlySet<string> = new Set(["i", "item"]);

/** Earliest history row per tracked service, one indexed seek per tracked `(service, type)` pair. */
export function loadServiceHistoryStarts(db: Database): Map<string, number> {
  const out = new Map<string, number>();
  const stmt = db.query(
    "SELECT MIN(observed_at_ms) AS m FROM item_history WHERE service = ? AND type = ?",
  );
  for (const pair of ITEM_HISTORY_SPECS.keys()) {
    const [service, type] = pair.split(":") as [string, string];
    const row = stmt.get(service, type) as { m: number | null };
    if (row.m !== null) {
      const prior = out.get(service);
      out.set(service, prior === undefined ? row.m : Math.min(prior, row.m));
    }
  }
  return out;
}

/** The earliest history row (optionally only for `services`), or null when there is none. */
export function earliestHistoryMs(db: Database, services?: readonly string[]): number | null {
  if (services === undefined) {
    const row = db.query("SELECT MIN(observed_at_ms) AS m FROM item_history").get() as {
      m: number | null;
    };
    return row.m;
  }
  const starts = loadServiceHistoryStarts(db);
  const wanted = services.map((s) => starts.get(s)).filter((m): m is number => m !== undefined);
  return wanted.length === 0 ? null : Math.min(...wanted);
}

type Binder = {
  readonly params: Array<string | number>;
  readonly p: (v: string | number) => string;
};

function binder(): Binder {
  const params: Array<string | number> = [];
  return {
    params,
    p: (v) => {
      params.push(v);
      return "?";
    },
  };
}

/** `CASE <alias>.service || ':' || <alias>.type WHEN ? THEN ... END` pieces for the born time. */
function bornExpr(a: string, b: Binder): string {
  const arms: string[] = [];
  for (const [id, spec] of ITEM_HISTORY_SPECS) {
    if (spec.born === null) continue;
    const path = `$.${spec.born.key}`;
    if (spec.born.kind === "ms") {
      arms.push(
        `WHEN ${b.p(id)} THEN CASE WHEN json_type(${a}.metadata, ${b.p(path)}) IN ('integer','real') THEN json_extract(${a}.metadata, ${b.p(path)}) END`,
      );
    } else {
      arms.push(
        `WHEN ${b.p(id)} THEN CASE WHEN json_type(${a}.metadata, ${b.p(path)}) = 'text' THEN CAST(strftime('%s', json_extract(${a}.metadata, ${b.p(path)})) AS INTEGER) * 1000 END`,
      );
    }
  }
  // `json_extract` raises on malformed JSON, so it is only reached behind `json_valid`.
  return `CASE WHEN json_valid(${a}.metadata) THEN CASE ${a}.service || ':' || ${a}.type ${arms.join(" ")} END END`;
}

/** 1 when the pair is in the tracked set (its first observation writes a `__created` row), else 0. */
function trackedExpr(a: string, b: Binder): string {
  const arms = [...ITEM_HISTORY_SPECS.keys()].map((id) => `WHEN ${b.p(id)} THEN 1`);
  return `CASE ${a}.service || ':' || ${a}.type ${arms.join(" ")} ELSE 0 END`;
}

/** 1 when `modified_at` is the provider's change clock for the pair (untracked pairs: 1), else 0. */
function tracksExpr(a: string, b: Binder): string {
  const arms: string[] = [];
  for (const [id, spec] of ITEM_HISTORY_SPECS) {
    if (!spec.modifiedAtTracksChange) arms.push(`WHEN ${b.p(id)} THEN 0`);
  }
  return `CASE ${a}.service || ':' || ${a}.type ${arms.join(" ")} ELSE 1 END`;
}

function startExpr(a: string, h0: ReadonlyMap<string, number>, b: Binder): string {
  if (h0.size === 0) return "NULL";
  const arms: string[] = [];
  for (const [service, ms] of h0) arms.push(`WHEN ${b.p(service)} THEN ${b.p(ms)}`);
  return `CASE ${a}.service ${arms.join(" ")} END`;
}

/**
 * `(<classExpr>) = 'in'` (or `'gap'`) over the item aliased `alias`, as a single `CASE` over correlated
 * subqueries with every spec value and instant BOUND (I9). The alias is from a closed set. Pure: the only
 * database reads (the per-service history start) are passed in as `h0`.
 *
 * The outer `CASE` text comes first, so its parameters are pushed first; the one-row derived table that
 * computes each fact ONCE per item comes second. Do not reorder the two without reordering the binds.
 */
export function composeAtClause(
  h0: ReadonlyMap<string, number>,
  atMs: number,
  alias: string,
  cls: AtClass,
): AtClause {
  if (!ALIASES.has(alias)) throw new Error(`point-in-time clause: unsupported alias "${alias}"`);
  const b = binder();
  const a = alias;
  const state = (): string =>
    `CASE WHEN COALESCE(x.seen, x.h0) IS NOT NULL AND ${b.p(atMs)} >= COALESCE(x.seen, x.h0) THEN 'in' WHEN x.tracks = 1 AND x.modified <= ${b.p(atMs)} THEN 'in' ELSE 'gap' END`;
  const outer = `CASE
    WHEN x.last = '__deleted' THEN 'out'
    WHEN x.born IS NOT NULL THEN CASE WHEN x.born > ${b.p(atMs)} THEN 'out' ELSE ${state()} END
    WHEN x.seen IS NOT NULL THEN CASE WHEN x.seen <= ${b.p(atMs)} THEN ${state()} ELSE 'gap' END
    WHEN x.tracked = 1 AND x.h0 IS NOT NULL AND ${b.p(atMs)} >= x.h0 THEN 'in'
    WHEN x.tracks = 1 AND x.modified <= ${b.p(atMs)} THEN ${state()}
    ELSE 'gap'
  END`;
  const inner = `SELECT ${bornExpr(a, b)} AS born,
      (SELECT MIN(h.observed_at_ms) FROM item_history h WHERE h.item_id = ${a}.id AND h.key = '__created') AS seen,
      ${startExpr(a, h0, b)} AS h0,
      ${trackedExpr(a, b)} AS tracked,
      ${tracksExpr(a, b)} AS tracks,
      ${a}.modified_at AS modified,
      (SELECT h.key FROM item_history h WHERE h.item_id = ${a}.id AND h.key IN ('__created','__deleted') AND h.observed_at_ms <= ${b.p(atMs)} ORDER BY h.observed_at_ms DESC, h.id DESC LIMIT 1) AS last`;
  return { sql: `((SELECT ${outer} FROM (${inner}) x) = '${cls}')`, params: b.params };
}

/** The admit clause (`= 'in'`) for the current database. */
export function buildAtClause(db: Database, atMs: number, alias: string): AtClause {
  return composeAtClause(loadServiceHistoryStarts(db), atMs, alias, "in");
}

/** The unplaceable clause (`= 'gap'`) for the current database; counts what the admit clause drops. */
export function buildAtGapClause(db: Database, atMs: number, alias: string): AtClause {
  return composeAtClause(loadServiceHistoryStarts(db), atMs, alias, "gap");
}

export type AsOfState = {
  readonly atMs: number;
  /** Tracked keys only; never a title or a body. */
  readonly state: Readonly<Record<string, string | null>>;
  /** `history`: at least one tracked key changed after T and its earlier value is shown; else `current`. */
  readonly basis: "history" | "current";
};

type AnnotatableItem = {
  readonly id: string;
  readonly service: string;
  readonly itemType: string;
  readonly rawMeta?: Record<string, unknown>;
};

const ANNOTATE_CHUNK = 500;

type ChangeRow = { item_id: string; key: string; old_value: string | null };

function changesAfter(
  db: Database,
  ids: readonly string[],
  atMs: number,
): Map<string, ChangeRow[]> {
  const out = new Map<string, ChangeRow[]>();
  for (let i = 0; i < ids.length; i += ANNOTATE_CHUNK) {
    const chunk = ids.slice(i, i + ANNOTATE_CHUNK);
    const marks = chunk.map(() => "?").join(",");
    const rows = db
      .query(
        `SELECT item_id, key, old_value FROM item_history
         WHERE item_id IN (${marks}) AND observed_at_ms > ? AND key NOT IN ('__created','__deleted')
         ORDER BY item_id, observed_at_ms, id`,
      )
      .all(...chunk, atMs) as ChangeRow[];
    for (const r of rows) {
      const list = out.get(r.item_id);
      if (list === undefined) out.set(r.item_id, [r]);
      else list.push(r);
    }
  }
  return out;
}

/**
 * Adds `asOf` to each item: the tracked state keys as they stood at `atMs`. A key's value is the `old_value`
 * of its earliest change after T, else the current value (omitted when the metadata does not carry it).
 * One batched read of the items' history rows (500 ids per statement); untracked pairs get an empty state.
 */
export function annotateStateAt<T extends AnnotatableItem>(
  db: Database,
  items: readonly T[],
  atMs: number,
): Array<T & { asOf: AsOfState }> {
  const keyed = items.map((item) => ({ item, pk: itemPrimaryKey(item.service, item.id) }));
  const changes = changesAfter(
    db,
    keyed.map((k) => k.pk),
    atMs,
  );
  return keyed.map(({ item, pk }) => {
    const spec = specFor(item.service, item.itemType);
    const state: Record<string, string | null> = {};
    let basis: AsOfState["basis"] = "current";
    if (spec !== undefined) {
      const earliest = new Map<string, string | null>();
      for (const c of changes.get(pk) ?? []) {
        if (!earliest.has(c.key)) earliest.set(c.key, c.old_value);
      }
      for (const k of spec.keys) {
        if (earliest.has(k.key)) {
          state[k.key] = earliest.get(k.key) ?? null;
          basis = "history";
          continue;
        }
        const current = normalizeHistoryValue(item.rawMeta?.[k.key]);
        if (current !== undefined) state[k.key] = current;
      }
    }
    return { ...item, asOf: { atMs, state, basis } };
  });
}

/** What a point-in-time retrieval knows for its disclosure: the instant, where history starts, the gap count. */
export type PointInTimeFacts = {
  readonly atMs: number;
  readonly historyStartMs: number | null;
  readonly gapCount: number;
};

export type PointInTimeDisclosureInput = {
  readonly atMs: number;
  readonly zone: string;
  /** The earliest history row for the in-scope services, or null when the table has none. */
  readonly historyStartMs: number | null;
  readonly gapCount: number;
};

/** The deterministic honesty block shared by `ask`, `query` and `search`; never asked of a model. */
export function pointInTimeDisclosure(input: PointInTimeDisclosureInput): string[] {
  const lines = [
    `As of ${new Date(input.atMs).toISOString()} (${input.zone}). State keys come from item history; titles and bodies are as of now.`,
  ];
  if (input.historyStartMs === null) {
    lines.push("Item history is empty; only items unchanged since that time are shown.");
  } else if (input.historyStartMs > input.atMs) {
    lines.push(
      `History starts ${new Date(input.historyStartMs).toISOString()}; state before then is the first observed state.`,
    );
  }
  const n = input.gapCount;
  lines.push(
    "## Gaps",
    n === 1
      ? "1 item could not be placed at that time (its state changed after it and the change predates item history, or its birth is unknown); it is not shown."
      : `${String(n)} items could not be placed at that time (their state changed after it and the change predates item history, or their birth is unknown); they are not shown.`,
  );
  return lines;
}
