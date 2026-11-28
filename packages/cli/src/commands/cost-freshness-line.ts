import { stripControlChars } from "../lib/strip-control-chars.ts";

/** One source's freshness as the cost views return it; `gap` is what its sync could not read (Phase 7 slice 5). */
export type CostFreshnessRow = {
  source: string;
  lastDay: string | null;
  provisionalFrom: string | null;
  gap?: string;
  /** Usage in the range this source could not price (Phase 7 slice 8, V110), per unit. */
  unpriced?: { unit: string; quantity: number; lines: number }[];
  /** The config key that would price it, e.g. `[cost.gitlab] rate_per_minute`. */
  rateHint?: string;
};

const clean = (s: string): string => stripControlChars(s).slice(0, 300);
const QUANTITY = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

/** `  Unpriced: 1,240 minute (set a rate: …)`, or nothing when the source priced everything. */
function unpricedLine(f: CostFreshnessRow): string {
  if (f.unpriced === undefined || f.unpriced.length === 0) return "";
  const amounts = f.unpriced
    .map((u) => `${QUANTITY.format(u.quantity)} ${clean(u.unit)}`)
    .join(", ");
  const hint = f.rateHint === undefined ? "" : ` (set a rate: ${clean(f.rateHint)})`;
  return `  Unpriced: ${amounts}${hint}\n`;
}

/**
 * The "no cost data" refusal every view prints, followed by what a cost sync could not read, so a sync that
 * was denied on its first run is never hidden behind the import hint.
 */
export function noCostDataText(freshness: readonly CostFreshnessRow[] | undefined): string {
  const gaps = (freshness ?? []).filter((f) => f.gap !== undefined).map(costFreshnessLine);
  return `No cost data imported. Import a FOCUS export with "nimbus cost import <file|dir>".\n${gaps.join("")}`;
}

/** The `Source …: data up to …` line every cost view prints, plus the sync's gap when it has one. */
export function costFreshnessLine(f: CostFreshnessRow): string {
  const prov = f.provisionalFrom === null ? "" : ` (provisional from ${clean(f.provisionalFrom)})`;
  const line = `Source ${clean(f.source)}: data up to ${f.lastDay === null ? "none" : clean(f.lastDay)}${prov}\n`;
  const gap = f.gap === undefined ? "" : `  Not synced: ${clean(f.gap)}\n`;
  return `${line}${unpricedLine(f)}${gap}`;
}
