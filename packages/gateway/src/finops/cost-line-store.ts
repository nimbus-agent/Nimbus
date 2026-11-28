// Phase 7 (the Cost Pack): the ONLY module with a write verb on `cost_line` and its import ledger
// `cost_import` (schema V109, static D24 rule `cost-line-confined`). Callers: the FOCUS import (`finops/cost-import.ts`), the owner erasures
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
  mergeMeasures,
  setTag,
  sortedTags,
  tagOf,
} from "./cost-line.ts";
import { COST_RATE_KEY_TAG, type CostRates, pricedFields, rateForKey } from "./cost-rate-price.ts";

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
  consumed_quantity: number | null;
  consumed_unit: string | null;
  priced: number;
};

const COLUMNS =
  "source, provider, billing_account_id, billing_period, charge_day, sub_account_id, sub_account_name, service_name, service_category, region_id, resource_id, resource_name, sku_id, charge_category, billed_cost, effective_cost, currency, tags_json, repo, workflow, model, import_id, grain_hash, consumed_quantity, consumed_unit, priced";
const COLUMN_COUNT = 26;

function parseTags(text: string): Record<string, string> {
  try {
    const v: unknown = JSON.parse(text);
    if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) {
      if (typeof val === "string") setTag(out, k, val);
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
    consumedQuantity: r.consumed_quantity,
    consumedUnit: r.consumed_unit,
    priced: r.priced !== 0,
  };
}

/**
 * The stored value of a line in an explicit field order, without the import that produced it (an identical
 * re-import is unchanged however the line object was built).
 */
function storedValue(l: CostLine): string {
  return JSON.stringify([
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
    Object.entries(sortedTags(l.tags)),
    l.repo,
    l.workflow,
    l.model,
    l.consumedQuantity ?? null,
    l.consumedUnit ?? null,
    l.priced !== false,
  ]);
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
  checkMeasure(l);
}

/** V110: a finite quantity, a 1-32 character unit, and an unpriced line that carries no cost. */
function checkMeasure(l: CostLine): void {
  const q = l.consumedQuantity ?? null;
  if (q !== null && !Number.isFinite(q)) {
    throw new Error(`cost line ${l.chargeDay} ${l.serviceName} has a quantity that is not finite`);
  }
  const u = l.consumedUnit ?? null;
  if (u !== null && (u.length === 0 || u.length > 32)) {
    throw new Error(
      `cost line ${l.chargeDay} ${l.serviceName} has a unit that is not 1 to 32 characters`,
    );
  }
  if (l.priced === false && (l.billedCost !== 0 || l.effectiveCost !== null)) {
    throw new Error(`cost line ${l.chargeDay} ${l.serviceName} is unpriced but carries a cost`);
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
    const insert = db.prepare(
      `INSERT INTO cost_line (${COLUMNS}) VALUES (${placeholders(COLUMN_COUNT)})`,
    );
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
          l.consumedQuantity ?? null,
          l.consumedUnit ?? null,
          l.priced === false ? 0 : 1,
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

/** One source's stored lines of one (provider, billing account, billing period), by day. Read only. */
export function readCostLinesForAccountMonth(
  db: Database,
  source: string,
  target: { readonly provider: string; readonly billingAccountId: string; readonly month: string },
): CostLine[] {
  const rows = db
    .query(
      `SELECT ${COLUMNS} FROM cost_line
        WHERE source = ? AND provider = ? AND billing_account_id = ? AND billing_period = ?
        ORDER BY charge_day, id`,
    )
    .all(source, target.provider, target.billingAccountId, target.month) as Row[];
  return rows.map(rowToLine);
}

export interface RepriceCostLinesResult {
  /** Lines priced again (their cost, currency or priced flag may be unchanged). */
  readonly repriced: number;
  /** Lines left as stored: no `rate_key` tag or no quantity to price. */
  readonly skipped: number;
}

/** A line priced again with `rates`; null when it carries nothing to price from. */
function repricedLine(l: CostLine, rates: CostRates): CostLine | null {
  const key = tagOf(l.tags, COST_RATE_KEY_TAG);
  const q = l.consumedQuantity ?? null;
  if (key === undefined || q === null) return null;
  return { ...l, ...pricedFields(q, rateForKey(rates, key)), currency: rates.currency };
}

/**
 * Price `source`'s stored lines again with `rates` (Phase 7 slice 8: a CI source after the owner changed a rate
 * or the currency), from each line's stored quantity and `rate_key`, with no API call. The currency is part of the
 * grain, so each (provider, account, period) is rewritten through {@link replaceCostLines}, which recomputes the
 * grain; lines that come to share a grain are merged (summed). One transaction: a failure leaves every line as it
 * was. Only the caller's own source is touched (the capability binds it).
 */
export function repriceCostLines(
  db: Database,
  source: string,
  rates: CostRates,
): RepriceCostLinesResult {
  return db.transaction((): RepriceCostLinesResult => {
    const rows = db
      .query(`SELECT ${COLUMNS} FROM cost_line WHERE source = ? ORDER BY id`)
      .all(source) as Row[];
    const groups = new Map<string, { key: CostLineKey; lines: CostLine[] }>();
    for (const l of rows.map(rowToLine)) {
      const g = JSON.stringify([l.provider, l.billingAccountId, l.billingPeriod]);
      const entry = groups.get(g) ?? {
        key: {
          source,
          provider: l.provider,
          billingAccountId: l.billingAccountId,
          billingPeriod: l.billingPeriod,
        },
        lines: [],
      };
      entry.lines.push(l);
      groups.set(g, entry);
    }
    let repriced = 0;
    let skipped = 0;
    for (const { key, lines } of groups.values()) {
      const merged = new Map<string, CostLine>();
      for (const l of lines) {
        const next = repricedLine(l, rates);
        if (next === null) skipped++;
        else repriced++;
        const line = next ?? l;
        const k = `${line.chargeDay}|${costLineGrainHash(line)}`;
        const prior = merged.get(k);
        merged.set(
          k,
          prior === undefined
            ? line
            : {
                ...prior,
                billedCost: prior.billedCost + line.billedCost,
                effectiveCost:
                  prior.effectiveCost === null && line.effectiveCost === null
                    ? null
                    : (prior.effectiveCost ?? 0) + (line.effectiveCost ?? 0),
                ...mergeMeasures(prior, line),
              },
        );
      }
      const days = [...new Set(lines.map((l) => l.chargeDay))];
      replaceCostLines(db, key, days, [...merged.values()]);
    }
    return { repriced, skipped };
  })();
}

/** The newest stored charge day per source (`null` when the source has no lines). */
export function readCostLineFreshness(db: Database): { source: string; lastDay: string }[] {
  return db
    .query(
      "SELECT source, MAX(charge_day) AS lastDay FROM cost_line GROUP BY source ORDER BY source",
    )
    .all() as { source: string; lastDay: string }[];
}

/** An owner erasure of one source (`connector remove`, `nimbus data delete`): its lines and its ledger rows. */
export function deleteCostLinesBySource(db: Database, source: string): number {
  return db.transaction((): number => {
    dbRun(db, "DELETE FROM cost_import WHERE source = ?", [source]);
    return dbRun(db, "DELETE FROM cost_line WHERE source = ?", [source]).changes;
  })();
}

/** `nimbus cost import --remove <importId>`: its lines and its ledger row, so it can be imported again. */
export function deleteCostImport(db: Database, importId: string): number {
  return db.transaction((): number => {
    dbRun(db, "DELETE FROM cost_import WHERE import_id = ?", [importId]);
    return dbRun(db, "DELETE FROM cost_line WHERE import_id = ?", [importId]).changes;
  })();
}

export interface CostImportRecord {
  readonly importId: string;
  readonly source: string;
  /** The providers of the accepted lines, sorted and comma-joined (empty when the file had none). */
  readonly provider: string;
  readonly fileSha256: string;
  readonly importedAtMs: number;
}

/** Whether the import ledger holds this import id (an accepted import, not removed since). */
export function isCostImportAccepted(db: Database, importId: string): boolean {
  return db.query("SELECT 1 FROM cost_import WHERE import_id = ?").get(importId) !== null;
}

/** Record an accepted import; call it in the import's own transaction. A replay refreshes `imported_at`. */
export function recordCostImport(db: Database, r: CostImportRecord): void {
  dbRun(
    db,
    `INSERT INTO cost_import (import_id, source, provider, file_sha256, imported_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (import_id) DO UPDATE SET imported_at = excluded.imported_at`,
    [r.importId, r.source, r.provider, r.fileSha256, r.importedAtMs],
  );
}

/**
 * Retention: delete lines whose charge day is before `cutoffDay` (`YYYY-MM-DD`). The import ledger is KEPT: a
 * pruned export stays accepted, so replaying it later is still a no-op.
 */
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
