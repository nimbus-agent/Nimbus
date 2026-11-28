// Phase 7 (the Cost Pack): gathers what the cost views read - the stored cost lines, the adapted Vantage rows,
// freshness and the currencies in use - and applies the authoritative-source rule per provider.
//
// Confined by static rule D48 (no network, no connector, no model). Read only.
//
// Overlap rule (spec, Resolved 6): when `[cost] authoritative` names a source for a provider, only that source's
// lines are used for it. Otherwise, when raw lines (a FOCUS import or a direct source) exist for a provider in the
// range, its Vantage rows are excluded. Every exclusion is listed, so the output says which source it set aside.
import type { Database } from "bun:sqlite";

import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { adaptCostAllocationItems, VANTAGE_SOURCE } from "./cost-allocation-adapter.ts";
import type { CostLine } from "./cost-line.ts";
import { readCostLineCurrencies, readCostLineFreshness, readCostLines } from "./cost-line-store.ts";
import type { CostRule } from "./cost-rules.ts";
import { readCostSourceGaps } from "./cost-source-gaps.ts";
import type { CostViewInput, CostViewResult, CostWindow } from "./cost-views.ts";
import { FOCUS_SOURCE } from "./focus-csv.ts";

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
      .sort(codeUnitCompare)
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

/** The cloud billing syncs (C4): each reads a cloud's own export or cost API, the same bill a FOCUS file holds. */
export const CLOUD_SYNC_SOURCES: ReadonlySet<string> = new Set([
  "aws_billing",
  "azure_billing",
  "gcp_billing",
]);

/**
 * C4 (Phase 7 slice 11a): on a day a cloud sync has lines for a provider, a FOCUS file import's lines of that
 * provider and day are the same bill and are set aside, so the two are never added together. A day only the file
 * covers (history from before the sync, or a day the sync has not read) keeps the file's lines. A provider
 * `[cost] authoritative` names is left to the authoritative rule.
 */
function setAsideFocusDays(
  all: readonly CostLine[],
  chosenFor: (provider: string) => string | undefined,
): { drop: (l: CostLine) => boolean; excluded: Excluded[] } {
  const cloudDays = new Map<string, Set<string>>();
  for (const l of all) {
    if (!CLOUD_SYNC_SOURCES.has(l.source) || chosenFor(l.provider) !== undefined) continue;
    const days = cloudDays.get(l.provider) ?? new Set<string>();
    days.add(l.chargeDay);
    cloudDays.set(l.provider, days);
  }
  const dropped = new Map<string, Set<string>>();
  for (const l of all) {
    if (l.source !== FOCUS_SOURCE || cloudDays.get(l.provider)?.has(l.chargeDay) !== true) continue;
    const days = dropped.get(l.provider) ?? new Set<string>();
    days.add(l.chargeDay);
    dropped.set(l.provider, days);
  }
  const excluded: Excluded[] = [...dropped]
    .sort(([x], [y]) => codeUnitCompare(x, y))
    .map(([provider, days]) => ({
      source: FOCUS_SOURCE,
      provider,
      reason: `cloud sync active for this provider on ${String(days.size)} day${days.size === 1 ? "" : "s"} (set [cost] authoritative to choose)`,
    }));
  return {
    drop: (l) => l.source === FOCUS_SOURCE && (dropped.get(l.provider)?.has(l.chargeDay) ?? false),
    excluded,
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
  const focus = setAsideFocusDays(all, (p) =>
    cfg.error === null ? cfg.authoritative[p] : undefined,
  );
  excluded.push(...focus.excluded);
  const lines = all.filter((l) => !focus.drop(l) && (keep.get(l.provider)?.(l.source) ?? true));
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
    knownCurrencies: [...currencies].sort(codeUnitCompare),
    excludedSources: excluded,
    notes,
    configError: cfg.error,
    presentDays: new Set(all.map((l) => l.chargeDay)),
    sourceGaps: readCostSourceGaps(db),
  };
}
