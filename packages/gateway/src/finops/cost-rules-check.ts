// Phase 7 (the Cost Pack): `nimbus cost rules check` - how the owner's `[[cost.rule]]` list allocates a range:
// the unassigned share per currency, what each rule matched (including matches whose value was refused), the
// rules nothing matched, and the largest groups of unassigned lines with their reasons, so the next rule to write
// is visible.
//
// Confined by static rule D48 (no network, no connector, no model). Pure. Amounts are per currency, never summed
// across currencies.

import { codeUnitCompare } from "../util/code-unit-compare.ts";
import type { CostLine } from "./cost-line.ts";
import { allocate, type CostAllocation } from "./cost-rules.ts";
import type { CostViewInput, CostWindow } from "./cost-views.ts";

/** At most this many unassigned groups; the rest are counted. */
export const COST_RULES_CHECK_MAX_GROUPS = 10;

export interface CostRuleCount {
  readonly index: number;
  readonly lines: number;
  readonly amountByCurrency: Record<string, number>;
  /** Lines this rule matched whose substituted value was refused. */
  readonly unassignedLines: number;
}

export interface CostUnassignedGroup {
  readonly provider: string;
  readonly service: string;
  readonly subAccount: string | null;
  readonly tagKeys: string[];
  readonly lines: number;
  readonly amountByCurrency: Record<string, number>;
  readonly reason: string;
}

export interface CostRulesCheck {
  readonly range: CostWindow;
  readonly configError: string | null;
  readonly byCurrency: Record<
    string,
    { readonly total: number; readonly unassigned: number; readonly unassignedPct: number | null }
  >;
  readonly rules: CostRuleCount[];
  readonly unusedRules: number[];
  readonly topUnassigned: CostUnassignedGroup[];
  readonly topUnassignedTruncated: number;
}

type RuleAcc = { lines: number; amountByCurrency: Record<string, number>; unassignedLines: number };
type GroupAcc = Omit<CostUnassignedGroup, "lines"> & { lines: number };

const addAmount = (m: Record<string, number>, currency: string, amount: number): void => {
  m[currency] = (m[currency] ?? 0) + amount;
};

function groupOf(groups: Map<string, GroupAcc>, l: CostLine, reason: string): GroupAcc {
  const tagKeys = Object.keys(l.tags).sort(codeUnitCompare);
  const key = JSON.stringify([l.provider, l.serviceName, l.subAccountId, tagKeys, reason]);
  const g = groups.get(key) ?? {
    provider: l.provider,
    service: l.serviceName,
    subAccount: l.subAccountId,
    tagKeys,
    lines: 0,
    amountByCurrency: {},
    reason,
  };
  groups.set(key, g);
  return g;
}

function rankGroups(groups: Map<string, GroupAcc>): {
  top: CostUnassignedGroup[];
  truncated: number;
} {
  const all = [...groups.entries()]
    .sort(([ka, a], [kb, b]) => b.lines - a.lines || ka.localeCompare(kb))
    .map(([, g]) => g);
  return {
    top: all.slice(0, COST_RULES_CHECK_MAX_GROUPS),
    truncated: Math.max(0, all.length - COST_RULES_CHECK_MAX_GROUPS),
  };
}

type Totals = { total: number; unassigned: number };
type CheckAcc = {
  readonly ruleAccs: Map<number, RuleAcc>;
  readonly totals: Map<string, Totals>;
  readonly groups: Map<string, GroupAcc>;
};

/** One in-range line: its currency total, the rule it matched, and (when unassigned) its group. */
function countLine(acc: CheckAcc, l: CostLine, a: CostAllocation, groupUnassigned: boolean): void {
  const t = acc.totals.get(l.currency) ?? { total: 0, unassigned: 0 };
  acc.totals.set(l.currency, t);
  t.total += l.billedCost;
  const ruleAcc = a.rule === null ? undefined : acc.ruleAccs.get(a.rule);
  if (ruleAcc !== undefined) {
    ruleAcc.lines++;
    addAmount(ruleAcc.amountByCurrency, l.currency, l.billedCost);
    if (a.unassignedReason !== null) ruleAcc.unassignedLines++;
  }
  if (a.unassignedReason === null) return;
  t.unassigned += l.billedCost;
  if (!groupUnassigned) return;
  const g = groupOf(acc.groups, l, a.unassignedReason);
  g.lines++;
  addAmount(g.amountByCurrency, l.currency, l.billedCost);
}

export function checkCostRules(input: CostViewInput): CostRulesCheck {
  const refused = input.configError !== null;
  const rules = refused ? [] : input.rules;
  const acc: CheckAcc = {
    ruleAccs: new Map(
      rules.map((r) => [r.index, { lines: 0, amountByCurrency: {}, unassignedLines: 0 }]),
    ),
    totals: new Map(),
    groups: new Map(),
  };
  for (const l of input.lines) {
    if (l.chargeDay < input.range.fromDay || l.chargeDay > input.range.toDay) continue;
    countLine(acc, l, allocate(l, rules), !refused);
  }
  const { ruleAccs, totals, groups } = acc;
  const byCurrency: CostRulesCheck["byCurrency"] = {};
  for (const c of [...totals.keys()].sort(codeUnitCompare)) {
    const t = totals.get(c) as Totals;
    byCurrency[c] = { ...t, unassignedPct: t.total === 0 ? null : (t.unassigned / t.total) * 100 };
  }
  const ruleCounts = rules.map((r) => ({ index: r.index, ...(ruleAccs.get(r.index) as RuleAcc) }));
  const { top, truncated } = rankGroups(groups);
  return {
    range: input.range,
    configError: input.configError,
    byCurrency,
    rules: ruleCounts,
    unusedRules: ruleCounts.filter((r) => r.lines === 0).map((r) => r.index),
    topUnassigned: top,
    topUnassignedTruncated: truncated,
  };
}
