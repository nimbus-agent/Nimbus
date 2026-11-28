// Phase 7 (the Cost Pack, slice 8; owner rulings 2026-11-28): pricing a CI source's minutes with the owner's
// configured rate. GitLab (and the later CI sources) report minutes, never money, so a line's cost is
// `consumed_quantity × rate`; with no rate the line is stored unpriced (V110 `priced` 0, cost 0).
//
// Every line carries the tag `rate_key` naming the identity its rate is looked up by: `default`, or a prefixed key
// (`runner:<description>`, `size:<n>x`, `agent:<name>`, `label:<name>`). A re-price (`repriceCostLines`) reads that
// key, so changing a rate re-prices the stored lines locally with no API call, and a rate added LATER prices lines
// that were stored before it existed (a line keeps its key even when no rate is listed for it). A key with no
// listed rate falls back to the default rate, exactly as a fresh sync of that line would.
//
// Confined by static rule D48 (no network, no connector, no model). Pure.
import { createHash } from "node:crypto";

export const COST_RATE_KEY_TAG = "rate_key";
export const COST_RATE_KEY_DEFAULT = "default";
export type CostRateKeyPrefix = "runner" | "size" | "agent" | "label";

export interface CostRates {
  /** Null: no default rate. */
  readonly ratePerMinute: number | null;
  readonly currency: string;
  /** Full rate key (prefix included, e.g. `runner:big`, `size:4x`) → rate per minute. */
  readonly keyedRates: readonly (readonly [string, number])[];
}

/**
 * The rate key a line carries: `<prefix>:<value>` whenever its source gave it that identity (an unlisted one prices
 * at the default rate through {@link rateForKey}, and a rate added later re-prices its stored lines), else `default`.
 */
export function rateKeyFor(prefix: CostRateKeyPrefix, value: string | null): string {
  return value === null ? COST_RATE_KEY_DEFAULT : `${prefix}:${value}`;
}

/** The rate per minute a rate key prices at now: its own listed rate, else the default, else null (unpriced). */
export function rateForKey(rates: CostRates, key: string): number | null {
  const hit = rates.keyedRates.find(([k]) => k === key);
  return hit === undefined ? rates.ratePerMinute : hit[1];
}

/** `quantity × rate`, rounded to 1e-9 so a re-price of the same numbers stores the same value. */
export function ratePrice(quantity: number, rate: number): number {
  return Math.round(quantity * rate * 1e9) / 1e9;
}

/** The money fields of a line of `quantity` minutes at `rate` (null = unpriced). */
export function pricedFields(
  quantity: number,
  rate: number | null,
): { billedCost: number; effectiveCost: number | null; priced: boolean } {
  if (rate === null) return { billedCost: 0, effectiveCost: null, priced: false };
  const cost = ratePrice(quantity, rate);
  return { billedCost: cost, effectiveCost: cost, priced: true };
}

/** A stable fingerprint of the rates: a change of any rate or of the currency changes it. */
export function costRatesFingerprint(rates: CostRates): string {
  const canonical = JSON.stringify([rates.ratePerMinute, rates.currency, rates.keyedRates]);
  return createHash("sha256").update(canonical).digest("hex");
}
