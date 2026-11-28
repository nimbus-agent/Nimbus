// Phase 7 (the Cost Pack, slice 3): the model a cost report renders from — the scoped cost of the report's
// period beside the period before, per currency, with the parts that moved most, a breakdown, the
// unassigned share, the freshness and the provisional marker.
//
// Confined by static rule D48 (no network, no connector, no model). Pure. Amounts are NEVER summed across
// currencies. Unassigned cost (no rule, or a refused value) is stated beside the total, never inside it.
import type { CostReportDef, CostReportScope } from "../config/cost-report-toml.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { DAY_MS } from "./cost-item-contract.ts";
import type { CostLine } from "./cost-line.ts";
import { allocate, type CostAllocation, type CostRule } from "./cost-rules.ts";
import {
  COST_PROVISIONAL_DAYS,
  type CostFreshness,
  type CostWindow,
  costFreshness,
  dayText,
} from "./cost-views.ts";
import { rulesInForce } from "./cost-why.ts";

/** At most this many movers per currency in the model. */
export const COST_REPORT_MAX_MOVERS = 3;

export interface CostReportMover {
  readonly service: string | null;
  readonly part: string;
  readonly provider: string;
  readonly change: number;
}

export interface CostReportBreakdownRow {
  /** The rule's `service` output, else the provider's service name. */
  readonly part: string;
  readonly provider: string;
  readonly env: string | null;
  readonly amount: number;
}

export interface CostReportCurrency {
  readonly total: number;
  readonly previous: number;
  readonly change: number;
  /** Null when the previous amount is 0. */
  readonly changePct: number | null;
  readonly topMovers: CostReportMover[];
  /** Largest first, the full list (the template shrinks it to fit a channel). */
  readonly breakdown: CostReportBreakdownRow[];
  /** This currency's cost in the range that no rule assigned, over ALL lines (not only the scope). */
  readonly unassigned: number;
  readonly unassignedPct: number | null;
}

export interface CostReportModel {
  readonly name: string;
  readonly scope: CostReportScope;
  readonly range: CostWindow;
  readonly previous: CostWindow;
  readonly weekStart: string | null;
  readonly byCurrency: Record<string, CostReportCurrency>;
  readonly provisionalFrom: string | null;
  readonly freshness: CostFreshness[];
  readonly empty: boolean;
  readonly configError: string | null;
  /** The exact command that renders this report now. */
  readonly command: string;
}

export interface BuildCostReportInput {
  /** Lines of BOTH periods; each is placed by its charge day. */
  readonly lines: readonly CostLine[];
  readonly rules: readonly CostRule[];
  readonly configError: string | null;
  readonly def: CostReportDef;
  readonly range: CostWindow;
  readonly previous: CostWindow;
  readonly weekStart: string | null;
  readonly nowMs: number;
  readonly lastDays: readonly { readonly source: string; readonly lastDay: string }[];
  /** Per source, what its sync could not read (shown in the freshness).  */
  readonly sourceGaps?: ReadonlyMap<string, readonly string[]>;
  readonly empty: boolean;
}

type MoverAcc = {
  service: string | null;
  part: string;
  provider: string;
  current: number;
  previous: number;
};
type Acc = {
  total: number;
  previous: number;
  allInRange: number;
  unassigned: number;
  movers: Map<string, MoverAcc>;
  breakdown: Map<string, CostReportBreakdownRow>;
};

const newAcc = (): Acc => ({
  total: 0,
  previous: 0,
  allInRange: 0,
  unassigned: 0,
  movers: new Map(),
  breakdown: new Map(),
});
const inRange = (day: string, w: CostWindow): boolean => day >= w.fromDay && day <= w.toDay;
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** Every scope key given must match the line's allocation (`provider` matches the line itself). */
function inScope(l: CostLine, a: CostAllocation, scope: CostReportScope): boolean {
  if (a.unassignedReason !== null) return false;
  if (scope.product !== undefined && a.product !== scope.product) return false;
  if (scope.env !== undefined && a.env !== scope.env) return false;
  if (scope.service !== undefined && a.service !== scope.service) return false;
  return scope.provider === undefined || l.provider === scope.provider;
}

function addMover(acc: Acc, l: CostLine, a: CostAllocation, isCurrent: boolean): void {
  const key = JSON.stringify([a.service, l.serviceName, l.provider]);
  const m = acc.movers.get(key) ?? {
    service: a.service,
    part: l.serviceName,
    provider: l.provider,
    current: 0,
    previous: 0,
  };
  acc.movers.set(key, m);
  if (isCurrent) m.current += l.billedCost;
  else m.previous += l.billedCost;
}

function addBreakdown(acc: Acc, l: CostLine, a: CostAllocation): void {
  const part = a.service ?? l.serviceName;
  const key = JSON.stringify([part, l.provider, a.env]);
  const prior = acc.breakdown.get(key)?.amount ?? 0;
  acc.breakdown.set(key, { part, provider: l.provider, env: a.env, amount: prior + l.billedCost });
}

/** Step 1: every line of either period into its currency's accumulator. */
function accumulate(input: BuildCostReportInput): Map<string, Acc> {
  const rules = rulesInForce(input.rules, input.configError);
  const accs = new Map<string, Acc>();
  for (const l of input.lines) {
    const isCurrent = inRange(l.chargeDay, input.range);
    if (!isCurrent && !inRange(l.chargeDay, input.previous)) continue;
    const acc = accs.get(l.currency) ?? newAcc();
    accs.set(l.currency, acc);
    const a = allocate(l, rules);
    if (isCurrent) {
      acc.allInRange += l.billedCost;
      if (a.unassignedReason !== null) acc.unassigned += l.billedCost;
    }
    if (!inScope(l, a, input.def.scope)) continue;
    addMover(acc, l, a, isCurrent);
    if (isCurrent) {
      acc.total += l.billedCost;
      addBreakdown(acc, l, a);
    } else {
      acc.previous += l.billedCost;
    }
  }
  return accs;
}

/** Step 2: one currency's block. */
function finish(acc: Acc): CostReportCurrency {
  const change = acc.total - acc.previous;
  const topMovers = [...acc.movers.values()]
    .map((m) => ({
      service: m.service,
      part: m.part,
      provider: m.provider,
      change: m.current - m.previous,
    }))
    .filter((m) => m.change !== 0)
    .sort((a, b) => Math.abs(b.change) - Math.abs(a.change) || codeUnitCompare(a.part, b.part))
    .slice(0, COST_REPORT_MAX_MOVERS);
  const breakdown = [...acc.breakdown.values()].sort(
    (a, b) => b.amount - a.amount || codeUnitCompare(a.part, b.part),
  );
  return {
    total: acc.total,
    previous: acc.previous,
    change,
    changePct: acc.previous === 0 ? null : (change / acc.previous) * 100,
    topMovers,
    breakdown,
    unassigned: acc.unassigned,
    unassignedPct: acc.allInRange === 0 ? null : (acc.unassigned / acc.allInRange) * 100,
  };
}

function provisionalFromOf(range: CostWindow, nowMs: number): string | null {
  const from = dayText(dayMs(dayText(nowMs)) - (COST_PROVISIONAL_DAYS - 1) * DAY_MS);
  return range.toDay >= from ? from : null;
}

export function buildCostReport(input: BuildCostReportInput): CostReportModel {
  const accs = accumulate(input);
  const byCurrency: Record<string, CostReportCurrency> = {};
  for (const c of [...accs.keys()].sort(codeUnitCompare))
    byCurrency[c] = finish(accs.get(c) as Acc);
  return {
    name: input.def.name,
    scope: input.def.scope,
    range: input.range,
    previous: input.previous,
    weekStart: input.weekStart,
    byCurrency,
    provisionalFrom: provisionalFromOf(input.range, input.nowMs),
    freshness: costFreshness({
      lastDays: input.lastDays,
      lines: input.lines,
      range: input.range,
      nowMs: input.nowMs,
      ...(input.sourceGaps === undefined ? {} : { sourceGaps: input.sourceGaps }),
    }),
    empty: input.empty,
    configError: input.configError,
    command: `nimbus cost report ${input.def.name}`,
  };
}
