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

export function gatherCostViewInput(
  db: Database,
  cfg: CostViewConfig,
  range: CostWindow,
  nowMs: number,
): CostViewInput {
  const raw = readCostLines(db, { fromDay: range.fromDay, toDay: range.toDay });
  const adapted = adaptCostAllocationItems(db, range);
  const all: CostLine[] = [...raw, ...adapted.lines];
  const sourcesByProvider = new Map<string, Set<string>>();
  for (const l of all) {
    const s = sourcesByProvider.get(l.provider) ?? new Set<string>();
    s.add(l.source);
    sourcesByProvider.set(l.provider, s);
  }
  const excluded: CostViewResult["excludedSources"][number][] = [];
  const keep = new Map<string, (source: string) => boolean>();
  for (const [provider, sources] of [...sourcesByProvider.entries()].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const chosen = cfg.error === null ? cfg.authoritative[provider] : undefined;
    if (chosen !== undefined) {
      keep.set(provider, (s) => s === chosen);
      for (const s of [...sources].sort()) {
        if (s !== chosen) {
          excluded.push({
            source: s,
            provider,
            reason: `[cost] authoritative names ${chosen} for ${provider}`,
          });
        }
      }
      continue;
    }
    const hasRaw = [...sources].some((s) => s !== VANTAGE_SOURCE);
    if (hasRaw && sources.has(VANTAGE_SOURCE)) {
      keep.set(provider, (s) => s !== VANTAGE_SOURCE);
      excluded.push({
        source: VANTAGE_SOURCE,
        provider,
        reason: "raw cost lines exist for this provider (set [cost] authoritative to choose)",
      });
    }
  }
  const lines = all.filter((l) => keep.get(l.provider)?.(l.source) ?? true);
  const lastDays = readCostLineFreshness(db);
  if (adapted.lastDay !== null) lastDays.push({ source: VANTAGE_SOURCE, lastDay: adapted.lastDay });
  const currencies = new Set(readCostLineCurrencies(db));
  for (const l of adapted.lines) currencies.add(l.currency);
  const notes: string[] = [];
  if (adapted.supersededDays > 0) {
    notes.push(
      `${String(adapted.supersededDays)} days had Vantage rows from more than one report configuration; only the newest synced one was used`,
    );
  }
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
