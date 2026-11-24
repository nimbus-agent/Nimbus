import {
  type CostDimensionKind,
  type CostPoint,
  type RolledCostRow,
  seriesHashOf,
  seriesKeyOf,
  startOfUtcDay,
  utcDateString,
} from "../finops/cost-item-contract.ts";
import type { MappedRow } from "./mapped-row.ts";
import { asRecord, stringField } from "./unknown-record.ts";
import { boundedValue } from "./vantage-cost-mapping.ts";

/** The two Kubernetes cost services (Phase 10 FinOps, OR-S4-FINOPS). */
export type K8sCostService = "opencost" | "kubecost";

/** What an allocation is grouped by: the two the sync offers. */
export type K8sAggregate = "namespace" | "controller";

export type K8sMappedRow = MappedRow<K8sCostService, "cost_allocation">;

const TITLE_MAX = 200;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

const KIND_BY_AGGREGATE: Readonly<Record<K8sAggregate, CostDimensionKind>> = {
  namespace: "namespace",
  controller: "controller",
};

export interface K8sCostMapContext {
  readonly service: K8sCostService;
  /** The owner's cluster label (`<service>.cluster`) or "default". */
  readonly scopeId: string;
  readonly aggregate: K8sAggregate;
}

/**
 * One row of `<service>_allocation_list` to a {@link CostPoint}, or null when it cannot be one (not
 * an object, a day that is not a real `YYYY-MM-DD` date, no key, no finite `totalCost`). The row has already
 * been normalised by the connector; this re-checks it, because it crossed a process boundary.
 * Nothing about a dropped row is logged by value. The currency is not reported by either API.
 */
export function mapK8sCostRow(raw: unknown, ctx: K8sCostMapContext): CostPoint | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const date = stringField(row, "date");
  const key = stringField(row, "key");
  const amount = row["totalCost"];
  if (
    date === undefined ||
    !DAY.test(date) ||
    key === undefined ||
    key === "" ||
    typeof amount !== "number" ||
    !Number.isFinite(amount)
  ) {
    return null;
  }
  const parsed = Date.parse(`${date}T00:00:00Z`);
  // Date.parse rolls a day the month lacks into the next month (2026-02-30 is March 2): refused.
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== date) {
    return null;
  }
  const kind = KIND_BY_AGGREGATE[ctx.aggregate];
  const value = boundedValue(key);
  return {
    scopeId: ctx.scopeId,
    dimensionKind: kind,
    dimensionKey: null,
    dimensionValue: value,
    groupings: [ctx.aggregate],
    seriesKey: seriesKeyOf(ctx.service, ctx.scopeId, kind, null, value),
    seriesHash: seriesHashOf(kind, null, value),
    dayMs: startOfUtcDay(parsed),
    amount,
    currency: null,
    provider: null,
    cloudService: null,
  };
}

/** The index row of one rolled-up day of one series (metadata_only, no body). */
export function k8sCostAllocationItem(
  service: K8sCostService,
  rolled: RolledCostRow,
  syncedAt: number,
): K8sMappedRow {
  const m = rolled.metadata;
  const title = `${m.dimensionValue} ${utcDateString(rolled.dayMs)} ${String(m.amount)}`.slice(
    0,
    TITLE_MAX,
  );
  // The metadata keys are literal on purpose: the index-lane census reads them as the writer's
  // emissions (docs/structure-audit/index-lane-census.json), and a spread would hide them.
  return {
    // A ternary of the two literals, so the index-lane census resolves BOTH writers.
    service: service === "opencost" ? "opencost" : "kubecost",
    type: "cost_allocation",
    externalId: rolled.externalId,
    title,
    bodyPreview: title,
    url: null,
    canonicalUrl: null,
    modifiedAt: Math.min(m.periodEndMs, syncedAt),
    metadata: {
      seriesKey: m.seriesKey,
      seriesHash: m.seriesHash,
      scopeSeries: m.scopeSeries,
      scopeId: m.scopeId,
      dimensionKind: m.dimensionKind,
      dimensionKey: m.dimensionKey,
      dimensionValue: m.dimensionValue,
      groupings: m.groupings,
      periodStartMs: m.periodStartMs,
      periodEndMs: m.periodEndMs,
      granularity: m.granularity,
      amount: m.amount,
      currency: m.currency,
      costKind: m.costKind,
      unit: m.unit,
      finalized: m.finalized,
      provider: m.provider,
      cloudService: m.cloudService,
      rowCount: m.rowCount,
    },
    syncedAt,
  };
}
