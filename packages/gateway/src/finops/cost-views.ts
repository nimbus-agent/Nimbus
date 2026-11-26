// Phase 7 (the Cost Pack): `nimbus cost products` and `nimbus cost internal`, the two allocation views over the
// cost lines and the owner's rules.
//
// Confined by static rule D48 (no network, no connector, no model). Pure: lines and rules in, a view out.
// Every amount is grouped by currency and NEVER summed across currencies: a range with two currencies has two
// subtotals and no grand total. Every view states the unassigned share and the source freshness, and "no cost
// data imported" (`empty`) is a different answer from a period whose cost is 0.
import { DAY_MS } from "./cost-item-contract.ts";
import type { CostLine } from "./cost-line.ts";
import { allocate, type CostAllocation, type CostRule } from "./cost-rules.ts";

/** The last this-many days of a source are provisional (the provider may still restate them). */
export const COST_PROVISIONAL_DAYS = 3;
export const COST_PERIOD_MAX_DAYS = 400;
/** At most this many distinct unassigned reasons per currency; the rest are folded into one counted entry. */
export const COST_MAX_REASONS = 10;

export interface CostWindow {
  readonly fromDay: string;
  readonly toDay: string;
  readonly label: string;
}

export const dayText = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/**
 * The range a `--period` names, ending today (UTC): `<N>d` is the last N days including today, `week` is this
 * Monday to today, `month` is the first of this month to today. Undefined for anything else.
 */
export function periodWindow(period: string, nowMs: number): CostWindow | undefined {
  const today = dayText(nowMs);
  const todayMs = dayMs(today);
  const m = /^(\d{1,3})d$/.exec(period);
  if (m?.[1] !== undefined) {
    const n = Number(m[1]);
    if (n < 1 || n > COST_PERIOD_MAX_DAYS) return undefined;
    return {
      fromDay: dayText(todayMs - (n - 1) * DAY_MS),
      toDay: today,
      label: `last ${String(n)} days`,
    };
  }
  if (period === "week") {
    const dow = (new Date(todayMs).getUTCDay() + 6) % 7;
    return {
      fromDay: dayText(todayMs - dow * DAY_MS),
      toDay: today,
      label: "this week (Monday to today)",
    };
  }
  if (period === "month")
    return { fromDay: `${today.slice(0, 8)}01`, toDay: today, label: "this month to date" };
  return undefined;
}

export interface CostViewRow {
  /** `products`: the product; `internal`: the env. */
  readonly key: string;
  /** `products`: the env; `internal`: the product. */
  readonly secondary: string | null;
  /** The rule's `service` output, else the provider's service name. */
  readonly part: string;
  readonly provider: string;
  readonly amount: number;
}

export interface CostCurrencyBlock {
  /** Assigned + unassigned (+ `outside` for `internal`): every line of this currency in the range. */
  readonly total: number;
  readonly rows: CostViewRow[];
  readonly unassigned: number;
  readonly unassignedReasons: {
    readonly reason: string;
    readonly amount: number;
    readonly lines: number;
  }[];
  /** `internal` only: lines whose env is set but is not an internal env. */
  readonly outside: number;
}

export interface CostFreshness {
  readonly source: string;
  readonly lastDay: string | null;
  /** Days from here to `lastDay` are provisional; null when the source has no line in that range. */
  readonly provisionalFrom: string | null;
}

export interface CostViewResult {
  readonly view: "products" | "internal";
  readonly range: CostWindow;
  readonly byCurrency: Record<string, CostCurrencyBlock>;
  readonly freshness: CostFreshness[];
  /** True only when no cost line and no adapted row exists at all: "no cost data imported". */
  readonly empty: boolean;
  readonly excludedSources: {
    readonly source: string;
    readonly provider: string;
    readonly reason: string;
  }[];
  readonly notes: string[];
  /** Non-null: the cost config was refused; nothing was allocated. */
  readonly configError: string | null;
  readonly internalEnvs?: readonly string[];
}

export interface CostViewInput {
  readonly lines: readonly CostLine[];
  readonly rules: readonly CostRule[];
  readonly range: CostWindow;
  readonly nowMs: number;
  readonly empty: boolean;
  /** The newest day per source, any range. */
  readonly lastDays: readonly { readonly source: string; readonly lastDay: string }[];
  /** Currencies seen in the store, shown with 0 when the range holds none. */
  readonly knownCurrencies: readonly string[];
  readonly excludedSources: CostViewResult["excludedSources"];
  readonly notes: readonly string[];
  readonly configError: string | null;
}

type Acc = {
  total: number;
  rows: Map<string, CostViewRow>;
  unassigned: number;
  reasons: Map<string, { amount: number; lines: number }>;
  outside: number;
};

const newAcc = (): Acc => ({
  total: 0,
  rows: new Map(),
  unassigned: 0,
  reasons: new Map(),
  outside: 0,
});

function freshness(input: CostViewInput): CostFreshness[] {
  const provisionalFrom = dayText(
    dayMs(dayText(input.nowMs)) - (COST_PROVISIONAL_DAYS - 1) * DAY_MS,
  );
  return input.lastDays.map((s) => ({
    source: s.source,
    lastDay: s.lastDay,
    provisionalFrom: s.lastDay >= provisionalFrom ? provisionalFrom : null,
  }));
}

function finish(acc: Acc): CostCurrencyBlock {
  const reasons = [...acc.reasons.entries()]
    .map(([reason, v]) => ({ reason, ...v }))
    .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount) || a.reason.localeCompare(b.reason));
  const kept = reasons.slice(0, COST_MAX_REASONS);
  const rest = reasons.slice(COST_MAX_REASONS);
  if (rest.length > 0) {
    kept.push({
      reason: `${String(rest.length)} other reasons`,
      amount: rest.reduce((a, r) => a + r.amount, 0),
      lines: rest.reduce((a, r) => a + r.lines, 0),
    });
  }
  return {
    total: acc.total,
    rows: [...acc.rows.values()].sort(
      (a, b) => a.key.localeCompare(b.key) || b.amount - a.amount || a.part.localeCompare(b.part),
    ),
    unassigned: acc.unassigned,
    unassignedReasons: kept,
    outside: acc.outside,
  };
}

/** Why a line is unassigned in this view, or null: no rule, a refused value, or no value for the view's key. */
function unassignedReasonOf(a: CostAllocation, view: "products" | "internal"): string | null {
  if (a.unassignedReason !== null) return a.unassignedReason;
  if (view === "products" && a.product === null) return `rule ${String(a.rule)} sets no product`;
  if (view === "internal" && a.env === null) return `rule ${String(a.rule)} sets no env`;
  return null;
}

function addUnassigned(acc: Acc, reason: string, amount: number): void {
  acc.unassigned += amount;
  const r = acc.reasons.get(reason) ?? { amount: 0, lines: 0 };
  r.amount += amount;
  r.lines++;
  acc.reasons.set(reason, r);
}

function addRow(acc: Acc, l: CostLine, a: CostAllocation, view: "products" | "internal"): void {
  const key = (view === "products" ? a.product : a.env) as string;
  const secondary = view === "products" ? a.env : a.product;
  const part = a.service ?? l.serviceName;
  const k = JSON.stringify([key, secondary, part, l.provider]);
  const prior = acc.rows.get(k)?.amount ?? 0;
  acc.rows.set(k, { key, secondary, part, provider: l.provider, amount: prior + l.billedCost });
}

/** Add one line to its currency's accumulator. */
function addLine(
  acc: Acc,
  l: CostLine,
  a: CostAllocation,
  view: "products" | "internal",
  internalEnvs: readonly string[],
): void {
  acc.total += l.billedCost;
  const reason = unassignedReasonOf(a, view);
  if (reason !== null) addUnassigned(acc, reason, l.billedCost);
  else if (view === "internal" && !internalEnvs.includes(a.env as string))
    acc.outside += l.billedCost;
  else addRow(acc, l, a, view);
}

function build(
  input: CostViewInput,
  view: "products" | "internal",
  internalEnvs: readonly string[],
): CostViewResult {
  const accs = new Map<string, Acc>();
  const rules = input.configError === null ? input.rules : [];
  for (const l of input.lines) {
    if (l.chargeDay < input.range.fromDay || l.chargeDay > input.range.toDay) continue;
    const acc = accs.get(l.currency) ?? newAcc();
    accs.set(l.currency, acc);
    addLine(acc, l, allocate(l, rules), view, internalEnvs);
  }
  if (accs.size === 0 && !input.empty) for (const c of input.knownCurrencies) accs.set(c, newAcc());
  const byCurrency: Record<string, CostCurrencyBlock> = {};
  for (const c of [...accs.keys()].sort()) byCurrency[c] = finish(accs.get(c) as Acc);
  return {
    view,
    range: input.range,
    byCurrency,
    freshness: freshness(input),
    empty: input.empty,
    excludedSources: [...input.excludedSources],
    notes: [...input.notes],
    configError: input.configError,
    ...(view === "internal" ? { internalEnvs: [...internalEnvs] } : {}),
  };
}

/** Cost per product, with its parts (service, provider) and env. */
export function productView(input: CostViewInput): CostViewResult {
  return build(input, "products", []);
}

/** The internal cost: lines whose env is one of `internalEnvs` (default `ci, dev, test, staging`). */
export function internalView(
  input: CostViewInput,
  internalEnvs: readonly string[],
): CostViewResult {
  return build(input, "internal", internalEnvs);
}
