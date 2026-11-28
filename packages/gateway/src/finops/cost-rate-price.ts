// Phase 7 (the Cost Pack, slice 8; owner rulings 2026-11-28): pricing a CI source's minutes with the owner's
// configured rate. GitLab (and the later CI sources) report minutes, never money, so a line's cost is
// `consumed_quantity × rate`; with no rate the line is stored unpriced (V110 `priced` 0, cost 0).
//
// Every priced line carries the tag `rate_key` naming the rate it was priced with: `default`
// (`rate_per_minute`) or `runner:<description>` (a `runner_rates` entry). A re-price (`repriceCostLines`)
// reads that key, so changing a rate re-prices the stored lines locally with no API call. A `runner:` key whose
// runner is no longer listed falls back to the default rate, exactly as a fresh sync of that job would.
//
// Confined by static rule D48 (no network, no connector, no model). Pure.
import { createHash } from "node:crypto";

export const COST_RATE_KEY_TAG = "rate_key";
export const COST_RATE_KEY_DEFAULT = "default";
const RUNNER_PREFIX = "runner:";

export interface CostRates {
  /** Null: no default rate. */
  readonly ratePerMinute: number | null;
  readonly currency: string;
  /** Runner description → rate per minute. */
  readonly runnerRates: readonly (readonly [string, number])[];
}

export const runnerRateKey = (description: string): string => `${RUNNER_PREFIX}${description}`;

/**
 * The rate key a self-managed job's line carries: its runner's whenever it has a description (an unlisted runner
 * prices at the default rate through {@link rateForKey}, and a runner rate added later re-prices its stored lines),
 * else `default`.
 */
export function rateKeyForRunner(description: string | null): string {
  return description === null ? COST_RATE_KEY_DEFAULT : runnerRateKey(description);
}

/** The rate per minute a rate key prices at now, or null (the line is unpriced). */
export function rateForKey(rates: CostRates, key: string): number | null {
  if (key.startsWith(RUNNER_PREFIX)) {
    const desc = key.slice(RUNNER_PREFIX.length);
    const hit = rates.runnerRates.find(([d]) => d === desc);
    if (hit !== undefined) return hit[1];
  }
  return rates.ratePerMinute;
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
  const canonical = JSON.stringify([rates.ratePerMinute, rates.currency, rates.runnerRates]);
  return createHash("sha256").update(canonical).digest("hex");
}
