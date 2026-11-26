// Phase 7 (the Cost Pack): gathers what the cost views read - the stored cost lines, the adapted Vantage rows,
// freshness and the currencies in use - and applies the authoritative-source rule per provider.
//
// Confined by static rule D48 (no network, no connector, no model). Read only.
//
// Overlap rule (spec, Resolved 6): when `[cost] authoritative` names a source for a provider, only that source's
// lines are used for it. Otherwise, when raw lines (a FOCUS import or a direct source) exist for a provider in the
// range, its Vantage rows are excluded. Every exclusion is listed, so the output says which source it set aside.
import type { Database } from "bun:sqlite";

import { adaptCostAllocationItems, VANTAGE_SOURCE } from "./cost-allocation-adapter.ts";
import type { CostLine } from "./cost-line.ts";
import { readCostLineCurrencies, readCostLineFreshness, readCostLines } from "./cost-line-store.ts";
import type { CostRule } from "./cost-rules.ts";
import type { CostViewInput, CostViewResult, CostWindow } from "./cost-views.ts";

export interface CostViewConfig {
  readonly rules: readonly CostRule[];
  readonly authoritative: Readonly<Record<string, string>>;
  readonly error: string | null;
}

type Excluded = CostViewResult["excludedSources"][number];

function sourcesByProvider(lines: readonly CostLine[]): [string, Set<string>][] {
  const m = new Map<string, Set<string>>();
  for (const l of lines) {
    const s = m.get(l.provider) ?? new Set<string>();
    s.add(l.source);
    m.set(l.provider, s);
  }
  return [...m.entries()].sort(([a], [b]) => a.localeCompare(b));
}

/** One provider's source rule: which sources stay, and the exclusions to report. */
function chooseSources(
  provider: string,
  sources: ReadonlySet<string>,
  chosen: string | undefined,
): { keep: ((source: string) => boolean) | null; excluded: Excluded[] } {
  if (chosen !== undefined) {
    const excluded = [...sources]
      .sort()
      .filter((s) => s !== chosen)
      .map((source) => ({
        source,
        provider,
        reason: `[cost] authoritative names ${chosen} for ${provider}`,
      }));
    return { keep: (s) => s === chosen, excluded };
  }
  const hasRaw = [...sources].some((s) => s !== VANTAGE_SOURCE);
  if (!hasRaw || !sources.has(VANTAGE_SOURCE)) return { keep: null, excluded: [] };
  return {
    keep: (s) => s !== VANTAGE_SOURCE,
    excluded: [
      {
        source: VANTAGE_SOURCE,
        provider,
        reason: "raw cost lines exist for this provider (set [cost] authoritative to choose)",
      },
    ],
  };
}

export function gatherCostViewInput(
  db: Database,
  cfg: CostViewConfig,
  range: CostWindow,
  nowMs: number,
): CostViewInput {
  const raw = readCostLines(db, { fromDay: range.fromDay, toDay: range.toDay });
  const adapted = adaptCostAllocationItems(db, range);
  const all: CostLine[] = [...raw, ...adapted.lines];
  const excluded: Excluded[] = [];
  const keep = new Map<string, (source: string) => boolean>();
  for (const [provider, sources] of sourcesByProvider(all)) {
    const chosen = cfg.error === null ? cfg.authoritative[provider] : undefined;
    const c = chooseSources(provider, sources, chosen);
    if (c.keep !== null) keep.set(provider, c.keep);
    excluded.push(...c.excluded);
  }
  const lines = all.filter((l) => keep.get(l.provider)?.(l.source) ?? true);
  const lastDays = readCostLineFreshness(db);
  if (adapted.lastDay !== null) lastDays.push({ source: VANTAGE_SOURCE, lastDay: adapted.lastDay });
  const currencies = new Set([...readCostLineCurrencies(db), ...adapted.currencies]);
  const notes =
    adapted.supersededDays > 0
      ? [
          `${String(adapted.supersededDays)} days had Vantage rows from more than one report configuration; only the newest synced one was used`,
        ]
      : [];
  return {
    lines,
    rules: cfg.rules,
    range,
    nowMs,
    empty: lastDays.length === 0,
    lastDays,
    knownCurrencies: [...currencies].sort(),
    excludedSources: excluded,
    notes,
    configError: cfg.error,
  };
}
