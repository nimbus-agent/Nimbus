import { stripControlChars } from "../lib/strip-control-chars.ts";
import { type CostFreshnessRow, costFreshnessLine, noCostDataText } from "./cost-freshness-line.ts";
import { COST_PERIOD_RE, type CostWhyIpc, type CostWhySink } from "./cost-why-cli.ts";

/**
 * `nimbus cost rules check [--period <N>d|week|month] [--json]` (Phase 7, the Cost Pack): how the owner's
 * `[[cost.rule]]` list allocates the period - the unassigned share per currency, what each rule matched
 * (including matches whose value was refused), the rules nothing matched, and the largest groups of unassigned
 * lines with their reasons. Read from the local index only.
 *
 * Exit codes: 0 for a check, 1 for a refused `[cost]` config, "no cost data imported" and any error.
 */
export interface CostRulesCheckArgs {
  readonly period: string;
  readonly json: boolean;
}

/** `args` starts after `nimbus cost rules`. */
export function parseCostRulesCheckArgs(args: readonly string[]): CostRulesCheckArgs | undefined {
  if (args[0] !== "check") return undefined;
  let period = "30d";
  let json = false;
  for (let i = 1; i < args.length; i++) {
    const a = args[i] ?? "";
    if (a === "--json") json = true;
    else if (a === "--period" && COST_PERIOD_RE.test(args[i + 1] ?? "")) {
      period = args[i + 1] as string;
      i++;
    } else return undefined;
  }
  return { period, json };
}

type Amounts = Record<string, number>;
type CheckResult = {
  empty: boolean;
  range: { fromDay: string; toDay: string; label: string };
  configError: string | null;
  byCurrency: Record<string, { total: number; unassigned: number; unassignedPct: number | null }>;
  rules: { index: number; lines: number; amountByCurrency: Amounts; unassignedLines: number }[];
  unusedRules: number[];
  topUnassigned: {
    provider: string;
    service: string;
    subAccount: string | null;
    tagKeys: string[];
    lines: number;
    amountByCurrency: Amounts;
    reason: string;
  }[];
  topUnassignedTruncated: number;
  freshness: CostFreshnessRow[];
};

const clean = (s: string): string => stripControlChars(s).slice(0, 200);
const money = (n: number): string => n.toFixed(2);
const plural = (n: number, word: string): string => `${String(n)} ${word}${n === 1 ? "" : "s"}`;
const amounts = (m: Amounts): string =>
  Object.keys(m)
    .sort((a, b) => a.localeCompare(b))
    .map((c) => `${clean(c)} ${money(m[c] ?? 0)}`)
    .join(", ");

function renderRules(r: CheckResult, sink: CostWhySink): void {
  sink.out("Rules:\n");
  for (const rule of r.rules) {
    if (rule.lines === 0) {
      sink.out(`  rule ${String(rule.index)}: matched nothing\n`);
      continue;
    }
    const refused =
      rule.unassignedLines === 0
        ? ""
        : `, ${String(rule.unassignedLines)} matched but its value was refused`;
    sink.out(
      `  rule ${String(rule.index)}: ${plural(rule.lines, "line")} (${amounts(rule.amountByCurrency)})${refused}\n`,
    );
  }
}

function renderGroups(r: CheckResult, sink: CostWhySink): void {
  if (r.topUnassigned.length === 0) return;
  sink.out("Largest unassigned groups:\n");
  for (const g of r.topUnassigned) {
    const sub = g.subAccount === null ? "" : `, sub-account ${clean(g.subAccount)}`;
    const tags = g.tagKeys.length === 0 ? "no tags" : `tags ${g.tagKeys.map(clean).join(", ")}`;
    sink.out(
      `  ${clean(g.provider)} ${clean(g.service)}${sub}, ${tags}: ${plural(g.lines, "line")} (${amounts(g.amountByCurrency)}): ${clean(g.reason)}\n`,
    );
  }
  if (r.topUnassignedTruncated > 0) {
    sink.out(`  ... and ${plural(r.topUnassignedTruncated, "more group")}\n`);
  }
}

function renderText(r: CheckResult, sink: CostWhySink): number {
  if (r.configError !== null) {
    sink.err(`The [cost] config is refused, so no rule applies: ${clean(r.configError)}\n`);
    return 1;
  }
  if (r.empty) {
    sink.err(noCostDataText(r.freshness));
    return 1;
  }
  sink.out(`Cost rules check, ${r.range.fromDay} to ${r.range.toDay} (${r.range.label})\n`);
  for (const [c, t] of Object.entries(r.byCurrency)) {
    const pct = t.unassignedPct === null ? "" : ` (${t.unassignedPct.toFixed(1)}%)`;
    sink.out(`${clean(c)}  ${money(t.unassigned)} of ${money(t.total)} unassigned${pct}\n`);
  }
  renderRules(r, sink);
  renderGroups(r, sink);
  for (const f of r.freshness) sink.out(costFreshnessLine(f));
  return 0;
}

export async function runCostRulesCheckWith(
  c: CostWhyIpc,
  a: CostRulesCheckArgs,
  sink: CostWhySink,
): Promise<number> {
  try {
    const r = (await c.call("cost.rulesCheck", { period: a.period })) as CheckResult;
    if (a.json) {
      sink.out(`${JSON.stringify(r)}\n`);
      return r.empty || r.configError !== null ? 1 : 0;
    }
    return renderText(r, sink);
  } catch (e) {
    sink.err(`nimbus cost rules check: ${clean(e instanceof Error ? e.message : String(e))}\n`);
    return 1;
  }
}
