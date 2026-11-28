// Phase 7 (the Cost Pack, slice 8; owner ruling 2026-11-28): the usage a source could not price. A CI source with
// no owner-configured rate stores its minutes as `priced: false` lines with a cost of 0 (V110), so they add
// nothing to any money total; every cost view names them here instead, per source and unit, beside the money.
//
// Confined by static rule D48 (no network, no connector, no model). Pure.
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import type { CostLine } from "./cost-line.ts";

export interface CostUnpriced {
  /** The line's `consumedUnit`, or `unit` when the source reported none. */
  readonly unit: string;
  readonly quantity: number;
  readonly lines: number;
}

/** Where the owner sets the rate that prices a source's lines, by source. */
const COST_RATE_CONFIG_HINT: ReadonlyMap<string, string> = new Map([
  ["gitlab_billing", "[cost.gitlab] rate_per_minute"],
]);

/** The config key that would price `source`'s unpriced lines, or undefined. */
export function rateHintOf(source: string): string | undefined {
  return COST_RATE_CONFIG_HINT.get(source);
}

/** Each source's unpriced quantity per unit, over the lines whose charge day is in `[fromDay, toDay]`. */
export function unpricedBySource(
  lines: readonly CostLine[],
  range: { readonly fromDay: string; readonly toDay: string },
): Map<string, CostUnpriced[]> {
  const acc = new Map<string, Map<string, { quantity: number; lines: number }>>();
  for (const l of lines) {
    if (l.priced !== false || l.chargeDay < range.fromDay || l.chargeDay > range.toDay) continue;
    const bySource = acc.get(l.source) ?? new Map<string, { quantity: number; lines: number }>();
    acc.set(l.source, bySource);
    const unit = l.consumedUnit ?? "unit";
    const u = bySource.get(unit) ?? { quantity: 0, lines: 0 };
    u.quantity += l.consumedQuantity ?? 0;
    u.lines++;
    bySource.set(unit, u);
  }
  const out = new Map<string, CostUnpriced[]>();
  for (const source of [...acc.keys()].sort(codeUnitCompare)) {
    const units = acc.get(source) ?? new Map<string, { quantity: number; lines: number }>();
    out.set(
      source,
      [...units.keys()].sort(codeUnitCompare).map((unit) => {
        const u = units.get(unit) ?? { quantity: 0, lines: 0 };
        return { unit, quantity: u.quantity, lines: u.lines };
      }),
    );
  }
  return out;
}

const QUANTITY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/**
 * `1,240.5 minute unpriced (set a rate: [cost.gitlab] rate_per_minute)`, one source's units joined. `escapeText` is applied
 * to each unit and to the hint alone (a report escapes per value, and its length cap must never cut this text short).
 */
export function unpricedText(
  source: string,
  units: readonly CostUnpriced[],
  escapeText: (s: string) => string = (s) => s,
): string {
  const amounts = units
    .map((u) => `${QUANTITY.format(u.quantity)} ${escapeText(u.unit)}`)
    .join(", ");
  const hint = rateHintOf(source);
  return `${amounts} unpriced${hint === undefined ? "" : ` (set a rate: ${escapeText(hint)})`}`;
}
