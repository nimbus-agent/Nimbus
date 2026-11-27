import { stripControlChars } from "../lib/strip-control-chars.ts";

/** One source's freshness as the cost views return it; `gap` is what its sync could not read (Phase 7 slice 5). */
export type CostFreshnessRow = {
  source: string;
  lastDay: string | null;
  provisionalFrom: string | null;
  gap?: string;
};

const clean = (s: string): string => stripControlChars(s).slice(0, 300);

/** The `Source …: data up to …` line every cost view prints, plus the sync's gap when it has one. */
export function costFreshnessLine(f: CostFreshnessRow): string {
  const prov = f.provisionalFrom === null ? "" : ` (provisional from ${clean(f.provisionalFrom)})`;
  const line = `Source ${clean(f.source)}: data up to ${f.lastDay === null ? "none" : clean(f.lastDay)}${prov}\n`;
  return f.gap === undefined ? line : `${line}  Not synced: ${clean(f.gap)}\n`;
}
