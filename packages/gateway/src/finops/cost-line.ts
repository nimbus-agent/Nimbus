// Phase 7 (the Cost Pack): the normalised cost line every source produces (FOCUS-shaped, daily).
//
// Confined by static rule D48 (no network, no connector, no model). Pure types and the grain hash; the
// only writer of the `cost_line` table is `cost-line-store.ts` (D24 rule `cost-line-confined`).
import { createHash } from "node:crypto";

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
}

/** The re-import unit: an import replaces this tuple's stored lines on the days it covers. */
export interface CostLineKey {
  readonly source: string;
  readonly provider: string;
  readonly billingAccountId: string;
  readonly billingPeriod: string;
}

export function sortedTags(tags: Readonly<Record<string, string>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(tags).sort()) {
    const v = tags[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/**
 * SHA-256 hex of the canonical JSON of the grain: (subAccountId, serviceName, resourceId ?? skuId,
 * chargeCategory, sorted tags, repo, workflow, model). Two raw rows with one grain on one day are one line.
 */
export function costLineGrainHash(line: CostLine): string {
  const canonical = JSON.stringify([
    line.subAccountId,
    line.serviceName,
    line.resourceId ?? line.skuId,
    line.chargeCategory,
    Object.entries(sortedTags(line.tags)),
    line.repo,
    line.workflow,
    line.model,
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}
