// Phase 7 (the Cost Pack): a read-side adapter that projects the indexed Vantage `cost_allocation` rows (Phase 10
// FinOps) into `CostLine` shape, so the cost views can show a provider that has no raw lines. Nothing is
// rewritten: the rows stay where the Vantage sync put them.
//
// Confined by static rule D48 (no network, no connector, no model). Read only.
//
// One Vantage report configuration (the series scope: report or workspace plus `group_by`) partitions that
// day's spend; two configurations re-describe the same spend. So per day only the configuration whose rows were
// synced last is used, and the days where another one was set aside are counted (`supersededDays`), never
// summed. Kubecost and OpenCost rows re-describe the cluster machines a cloud bill already holds: they are never
// adapted into cloud lines, only read by {@link readClusterAllocations} for `--allocation cluster`.
import type { Database } from "bun:sqlite";

import { DAY_MS } from "./cost-item-contract.ts";
import type { CostLine } from "./cost-line.ts";

export const VANTAGE_SOURCE = "vantage";
export const CLUSTER_COST_SERVICES = ["kubecost", "opencost"] as const;

type Row = {
  scope: string | null;
  kind: string | null;
  dkey: string | null;
  value: string | null;
  day: number | null;
  amount: number | null;
  currency: string | null;
  provider: string | null;
  cloud: string | null;
  synced: number;
};

const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

function readRows(
  db: Database,
  services: readonly string[],
  fromDay: string,
  toDay: string,
): Row[] {
  const marks = services.map(() => "?").join(", ");
  return db
    .query(
      `SELECT json_extract(metadata, '$.scopeSeries') AS scope,
              json_extract(metadata, '$.dimensionKind') AS kind,
              json_extract(metadata, '$.dimensionKey') AS dkey,
              json_extract(metadata, '$.dimensionValue') AS value,
              json_extract(metadata, '$.periodStartMs') AS day,
              json_extract(metadata, '$.amount') AS amount,
              json_extract(metadata, '$.currency') AS currency,
              json_extract(metadata, '$.provider') AS provider,
              json_extract(metadata, '$.cloudService') AS cloud,
              synced_at AS synced
         FROM item
        WHERE service IN (${marks})
          AND type = 'cost_allocation'
          AND json_extract(metadata, '$.periodStartMs') BETWEEN ? AND ?`,
    )
    .all(...services, dayMs(fromDay), dayMs(toDay) + DAY_MS - 1) as Row[];
}

/** `<report>~<seriesHash>`: the configuration is the part before the last `~`. */
function configOf(scope: string | null): string {
  if (scope === null) return "";
  const i = scope.lastIndexOf("~");
  return i < 0 ? scope : scope.slice(0, i);
}

export interface AdaptedAllocations {
  readonly lines: CostLine[];
  /** Days on which a second Vantage report configuration was set aside (never summed). */
  readonly supersededDays: number;
  /** The newest day with a Vantage row, any window. */
  readonly lastDay: string | null;
}

/** The Vantage rows of `[fromDay, toDay]` as cost lines (one configuration per day). */
export function adaptCostAllocationItems(
  db: Database,
  window: { readonly fromDay: string; readonly toDay: string },
): AdaptedAllocations {
  const rows = readRows(db, [VANTAGE_SOURCE], window.fromDay, window.toDay).filter(
    (r) => r.day !== null && typeof r.amount === "number" && Number.isFinite(r.amount),
  );
  const newestConfig = new Map<number, { config: string; synced: number }>();
  const configsPerDay = new Map<number, Set<string>>();
  for (const r of rows) {
    const day = r.day as number;
    const config = configOf(r.scope);
    const seen = configsPerDay.get(day) ?? new Set<string>();
    seen.add(config);
    configsPerDay.set(day, seen);
    const cur = newestConfig.get(day);
    if (cur === undefined || r.synced > cur.synced)
      newestConfig.set(day, { config, synced: r.synced });
  }
  const lines: CostLine[] = [];
  for (const r of rows) {
    const day = r.day as number;
    if (newestConfig.get(day)?.config !== configOf(r.scope)) continue;
    const chargeDay = dayText(day);
    const tags: Record<string, string> = {};
    if (r.kind === "tag" && r.dkey !== null && r.value !== null) tags[r.dkey] = r.value;
    lines.push({
      source: VANTAGE_SOURCE,
      provider: r.provider ?? "unknown",
      billingAccountId: configOf(r.scope),
      billingPeriod: chargeDay.slice(0, 7),
      chargeDay,
      subAccountId: r.kind === "account" ? r.value : null,
      subAccountName: null,
      serviceName:
        r.cloud ??
        (r.kind === "service" && r.value !== null ? r.value : `(vantage ${r.kind ?? "total"})`),
      serviceCategory: null,
      regionId: null,
      resourceId: null,
      resourceName: null,
      skuId: null,
      chargeCategory: "usage",
      billedCost: r.amount as number,
      effectiveCost: null,
      currency: r.currency ?? "unknown",
      tags,
      repo: null,
      workflow: null,
      model: null,
      importId: VANTAGE_SOURCE,
    });
  }
  let supersededDays = 0;
  for (const set of configsPerDay.values()) if (set.size > 1) supersededDays++;
  const last = db
    .query(
      `SELECT MAX(json_extract(metadata, '$.periodStartMs')) AS d FROM item
        WHERE service = ? AND type = 'cost_allocation'`,
    )
    .get(VANTAGE_SOURCE) as { d: number | null } | null;
  return { lines, supersededDays, lastDay: last?.d == null ? null : dayText(last.d) };
}

export interface ClusterAllocationRow {
  readonly service: string;
  readonly dimension: string;
  readonly name: string;
  readonly currency: string;
  readonly amount: number;
}

/** Kubecost / OpenCost allocations in the window, summed per (service, dimension, name, currency). */
export function readClusterAllocations(
  db: Database,
  window: { readonly fromDay: string; readonly toDay: string },
): ClusterAllocationRow[] {
  const sums = new Map<string, ClusterAllocationRow>();
  const services = db
    .query(
      `SELECT DISTINCT service FROM item WHERE type = 'cost_allocation' AND service IN (${CLUSTER_COST_SERVICES.map(() => "?").join(", ")})`,
    )
    .all(...CLUSTER_COST_SERVICES) as { service: string }[];
  for (const { service } of services) {
    for (const r of readRows(db, [service], window.fromDay, window.toDay)) {
      if (typeof r.amount !== "number" || !Number.isFinite(r.amount)) continue;
      const currency = r.currency ?? "unknown";
      const dimension = r.kind ?? "other";
      const name = r.value ?? "";
      const k = JSON.stringify([service, dimension, name, currency]);
      const prior = sums.get(k);
      sums.set(k, { service, dimension, name, currency, amount: (prior?.amount ?? 0) + r.amount });
    }
  }
  return [...sums.values()].sort((a, b) => b.amount - a.amount || a.name.localeCompare(b.name));
}
