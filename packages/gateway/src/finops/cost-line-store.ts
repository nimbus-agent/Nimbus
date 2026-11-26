// Phase 7 (the Cost Pack): the ONLY module with a write verb on `cost_line` (schema V109, static D24 rule
// `cost-line-confined`). Callers: the FOCUS import (`finops/cost-import.ts`), the owner erasures
// (`LocalIndex.removeConnectorIndexData`, `runDataDelete`) and the FinOps retention tick.
//
// Confined by static rule D48 (no network, no connector, no model).
import type { Database } from "bun:sqlite";

import { dbRun, dbStmtRun } from "../db/write.ts";
import {
  COST_CHARGE_CATEGORIES,
  type CostChargeCategory,
  type CostLine,
  type CostLineKey,
  costLineGrainHash,
  sortedTags,
} from "./cost-line.ts";

export interface ReplaceCostLinesResult {
  /** Lines whose grain was not stored on that day. */
  readonly inserted: number;
  /** Lines whose grain was stored on that day with a different value (a restatement). */
  readonly replaced: number;
  /** Lines identical to the stored ones. */
  readonly unchanged: number;
  /** Stored lines on a covered day whose grain the new set no longer has. */
  readonly removed: number;
}

type Row = {
  source: string;
  provider: string;
  billing_account_id: string;
  billing_period: string;
  charge_day: string;
  sub_account_id: string | null;
  sub_account_name: string | null;
  service_name: string;
  service_category: string | null;
  region_id: string | null;
  resource_id: string | null;
  resource_name: string | null;
  sku_id: string | null;
  charge_category: string;
  billed_cost: number;
  effective_cost: number | null;
  currency: string;
  tags_json: string;
  repo: string | null;
  workflow: string | null;
  model: string | null;
  import_id: string;
  grain_hash: string;
};

const COLUMNS =
  "source, provider, billing_account_id, billing_period, charge_day, sub_account_id, sub_account_name, service_name, service_category, region_id, resource_id, resource_name, sku_id, charge_category, billed_cost, effective_cost, currency, tags_json, repo, workflow, model, import_id, grain_hash";

function parseTags(text: string): Record<string, string> {
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string") out[k] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function toCategory(v: string): CostChargeCategory {
  return (COST_CHARGE_CATEGORIES as readonly string[]).includes(v)
    ? (v as CostChargeCategory)
    : "usage";
}

function rowToLine(r: Row): CostLine {
  return {
    source: r.source,
    provider: r.provider,
    billingAccountId: r.billing_account_id,
    billingPeriod: r.billing_period,
    chargeDay: r.charge_day,
    subAccountId: r.sub_account_id,
    subAccountName: r.sub_account_name,
    serviceName: r.service_name,
    serviceCategory: r.service_category,
    regionId: r.region_id,
    resourceId: r.resource_id,
    resourceName: r.resource_name,
    skuId: r.sku_id,
    chargeCategory: toCategory(r.charge_category),
    billedCost: r.billed_cost,
    effectiveCost: r.effective_cost,
    currency: r.currency,
    tags: parseTags(r.tags_json),
    repo: r.repo,
    workflow: r.workflow,
    model: r.model,
    importId: r.import_id,
  };
}

/** The stored value of a line, without the import that produced it (an identical re-import is unchanged). */
function storedValue(l: CostLine): string {
  const { importId: _importId, ...rest } = l;
  return JSON.stringify({ ...rest, tags: sortedTags(l.tags) });
}

function checkLine(key: CostLineKey, days: ReadonlySet<string>, l: CostLine): void {
  if (
    l.source !== key.source ||
    l.provider !== key.provider ||
    l.billingAccountId !== key.billingAccountId ||
    l.billingPeriod !== key.billingPeriod
  ) {
    throw new Error(
      `cost line ${l.chargeDay} ${l.serviceName} does not match the import key ${key.source}/${key.provider}/${key.billingAccountId}/${key.billingPeriod}`,
    );
  }
  if (!days.has(l.chargeDay)) {
    throw new Error(`cost line day ${l.chargeDay} is not among the covered days`);
  }
  if (
    !Number.isFinite(l.billedCost) ||
    (l.effectiveCost !== null && !Number.isFinite(l.effectiveCost))
  ) {
    throw new Error(`cost line ${l.chargeDay} ${l.serviceName} has a cost that is not finite`);
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

/**
 * Replace the stored lines of `key` on exactly `days` with `lines`, in one transaction. Lines on other days
 * are kept. Every line must belong to `key` and to one of `days`, or nothing is written.
 */
export function replaceCostLines(
  db: Database,
  key: CostLineKey,
  days: readonly string[],
  lines: readonly CostLine[],
): ReplaceCostLinesResult {
  const daySet = new Set(days);
  for (const l of lines) checkLine(key, daySet, l);
  const dayList = [...daySet];
  if (dayList.length === 0) return { inserted: 0, replaced: 0, unchanged: 0, removed: 0 };
  return db.transaction((): ReplaceCostLinesResult => {
    const where = `source = ? AND provider = ? AND billing_account_id = ? AND billing_period = ? AND charge_day IN (${placeholders(dayList.length)})`;
    const params = [key.source, key.provider, key.billingAccountId, key.billingPeriod, ...dayList];
    const existing = new Map<string, string>();
    for (const r of db
      .query(`SELECT ${COLUMNS} FROM cost_line WHERE ${where}`)
      .all(...params) as Row[]) {
      existing.set(`${r.charge_day}|${r.grain_hash}`, storedValue(rowToLine(r)));
    }
    dbRun(db, `DELETE FROM cost_line WHERE ${where}`, params);
    const insert = db.prepare(`INSERT INTO cost_line (${COLUMNS}) VALUES (${placeholders(23)})`);
    let inserted = 0;
    let replaced = 0;
    let unchanged = 0;
    const seen = new Set<string>();
    try {
      for (const l of lines) {
        const grain = costLineGrainHash(l);
        const k = `${l.chargeDay}|${grain}`;
        seen.add(k);
        const prior = existing.get(k);
        if (prior === undefined) inserted++;
        else if (prior === storedValue(l)) unchanged++;
        else replaced++;
        dbStmtRun(
          insert,
          l.source,
          l.provider,
          l.billingAccountId,
          l.billingPeriod,
          l.chargeDay,
          l.subAccountId,
          l.subAccountName,
          l.serviceName,
          l.serviceCategory,
          l.regionId,
          l.resourceId,
          l.resourceName,
          l.skuId,
          l.chargeCategory,
          l.billedCost,
          l.effectiveCost,
          l.currency,
          JSON.stringify(sortedTags(l.tags)),
          l.repo,
          l.workflow,
          l.model,
          l.importId,
          grain,
        );
      }
    } finally {
      insert.finalize();
    }
    let removed = 0;
    for (const k of existing.keys()) if (!seen.has(k)) removed++;
    return { inserted, replaced, unchanged, removed };
  })();
}

export interface ReadCostLinesQuery {
  /** Inclusive `YYYY-MM-DD`. */
  readonly fromDay: string;
  /** Inclusive `YYYY-MM-DD`. */
  readonly toDay: string;
  /** Restrict to these sources; an empty list reads nothing. */
  readonly sources?: readonly string[];
}

export function readCostLines(db: Database, q: ReadCostLinesQuery): CostLine[] {
  if (q.sources?.length === 0) return [];
  const bySource =
    q.sources === undefined ? "" : ` AND source IN (${placeholders(q.sources.length)})`;
  const rows = db
    .query(
      `SELECT ${COLUMNS} FROM cost_line WHERE charge_day >= ? AND charge_day <= ?${bySource}
        ORDER BY charge_day, source, provider, billing_account_id, id`,
    )
    .all(q.fromDay, q.toDay, ...(q.sources ?? [])) as Row[];
  return rows.map(rowToLine);
}

/** The newest stored charge day per source (`null` when the source has no lines). */
export function readCostLineFreshness(db: Database): { source: string; lastDay: string }[] {
  return db
    .query(
      "SELECT source, MAX(charge_day) AS lastDay FROM cost_line GROUP BY source ORDER BY source",
    )
    .all() as { source: string; lastDay: string }[];
}

/** An owner erasure of one source (`connector remove`, `nimbus data delete`). */
export function deleteCostLinesBySource(db: Database, source: string): number {
  return dbRun(db, "DELETE FROM cost_line WHERE source = ?", [source]).changes;
}

/** `nimbus cost import --remove <importId>`. */
export function deleteCostImport(db: Database, importId: string): number {
  return dbRun(db, "DELETE FROM cost_line WHERE import_id = ?", [importId]).changes;
}

/** Retention: delete lines whose charge day is before `cutoffDay` (`YYYY-MM-DD`). */
export function pruneCostLinesBefore(db: Database, cutoffDay: string): number {
  return dbRun(db, "DELETE FROM cost_line WHERE charge_day < ?", [cutoffDay]).changes;
}

/** Every currency the stored lines use (a zero-cost window is shown in these). */
export function readCostLineCurrencies(db: Database): string[] {
  return (
    db.query("SELECT DISTINCT currency FROM cost_line ORDER BY currency").all() as {
      currency: string;
    }[]
  ).map((r) => r.currency);
}
