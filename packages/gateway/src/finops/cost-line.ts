// Phase 7 (the Cost Pack): the normalised cost line every source produces (FOCUS-shaped, daily).
//
// Confined by static rule D48 (no network, no connector, no model). Pure types and the grain hash; the
// only writer of the `cost_line` table is `cost-line-store.ts` (D24 rule `cost-line-confined`).
import { createHash } from "node:crypto";
import { codeUnitCompare } from "../util/code-unit-compare.ts";

export const COST_CHARGE_CATEGORIES = ["usage", "purchase", "tax", "credit", "adjustment"] as const;
export type CostChargeCategory = (typeof COST_CHARGE_CATEGORIES)[number];

export interface CostLine {
  /** Who produced the line: `focus` for a file import, otherwise the connector service id. */
  readonly source: string;
  /** `aws|azure|gcp|github|openai|anthropic|…` */
  readonly provider: string;
  readonly billingAccountId: string;
  /** `YYYY-MM` */
  readonly billingPeriod: string;
  /** `YYYY-MM-DD`, the UTC day of the charge period's start. */
  readonly chargeDay: string;
  readonly subAccountId: string | null;
  readonly subAccountName: string | null;
  readonly serviceName: string;
  readonly serviceCategory: string | null;
  readonly regionId: string | null;
  readonly resourceId: string | null;
  readonly resourceName: string | null;
  readonly skuId: string | null;
  readonly chargeCategory: CostChargeCategory;
  readonly billedCost: number;
  readonly effectiveCost: number | null;
  readonly currency: string;
  readonly tags: Readonly<Record<string, string>>;
  readonly repo: string | null;
  readonly workflow: string | null;
  readonly model: string | null;
  readonly importId: string;
  /**
   * FOCUS ConsumedQuantity (V110): how much was used, in `consumedUnit`. A measure, never in the grain. Absent
   * = not reported (stored as NULL).
   */
  readonly consumedQuantity?: number | null;
  /** FOCUS ConsumedUnit (V110), 1 to 32 characters (`minute`, `tokens`, …). */
  readonly consumedUnit?: string | null;
  /**
   * `false` when the source could not price the line (a CI source with no configured rate, V110): its
   * `billedCost` is 0 and its `effectiveCost` null, and the views name its quantity as unpriced. Absent = priced.
   */
  readonly priced?: boolean;
}

/**
 * The measure of two merged rows of one grain (V110): the summed quantity in their shared unit. When either row
 * reported no quantity (a partial sum would understate the usage) or the units differ (the unit is not part of
 * the grain, and minutes plus hours is no number), the merged line has none.
 */
export function mergeMeasures(
  a: CostLine,
  b: CostLine,
): { consumedQuantity: number | null; consumedUnit: string | null } {
  const qa = a.consumedQuantity ?? null;
  const qb = b.consumedQuantity ?? null;
  const ua = a.consumedUnit ?? null;
  if (qa === null || qb === null || ua !== (b.consumedUnit ?? null)) {
    return { consumedQuantity: null, consumedUnit: null };
  }
  return { consumedQuantity: qa + qb, consumedUnit: ua };
}

/** A vendor's unit text as a `consumedUnit`: trimmed, 1 to 32 characters, otherwise null (never refused). */
export function measureUnit(v: string | null | undefined): string | null {
  const t = v?.trim() ?? "";
  return t.length === 0 || t.length > 32 ? null : t;
}

/** The re-import unit: an import replaces this tuple's stored lines on the days it covers. */
export interface CostLineKey {
  readonly source: string;
  readonly provider: string;
  readonly billingAccountId: string;
  readonly billingPeriod: string;
}

/**
 * Set one tag as an OWN property: a plain assignment of `__proto__` would set the prototype instead and drop
 * the tag (a vendor's tag key is external data).
 */
export function setTag(out: Record<string, string>, key: string, value: string): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

/** One tag's value, read as an OWN property only (never from the prototype). */
export function tagOf(tags: Readonly<Record<string, string>>, key: string): string | undefined {
  const v = Object.getOwnPropertyDescriptor(tags, key)?.value as unknown;
  return typeof v === "string" ? v : undefined;
}

export function sortedTags(tags: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(tags).sort(codeUnitCompare)) {
    const v = tagOf(tags, k);
    if (v !== undefined) setTag(out, k, v);
  }
  return out;
}

/**
 * SHA-256 hex of the canonical JSON of the grain: (subAccountId, serviceName, regionId, resourceId ?? skuId,
 * chargeCategory, currency, sorted tags, repo, workflow, model). Two raw rows with one grain on one day are one
 * line; amounts in two currencies are never one line.
 */
export function costLineGrainHash(line: CostLine): string {
  const canonical = JSON.stringify([
    line.subAccountId,
    line.serviceName,
    line.regionId,
    line.resourceId ?? line.skuId,
    line.chargeCategory,
    line.currency,
    Object.entries(sortedTags(line.tags)),
    line.repo,
    line.workflow,
    line.model,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
