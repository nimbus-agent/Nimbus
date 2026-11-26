// Phase 7 (the Cost Pack): the comparison behind `nimbus cost why <product|service>`. A range's cost for one
// target is compared with the same number of days immediately before it, per currency; the day the cost rose
// most above the previous period's daily mean is the spike day, and the parts that moved most are listed.
//
// Confined by static rule D48 (no network, no connector, no model). Pure: lines and rules in, a comparison out.
// It never sees a deploy, a pull request or an owner: the IPC layer joins those (`agents/_lib/cost-why-query.ts`)
// to the `services` this returns. Amounts are NEVER summed across currencies.
import { DAY_MS } from "./cost-item-contract.ts";
import type { CostLine } from "./cost-line.ts";
import { allocate, type CostAllocation, type CostRule } from "./cost-rules.ts";
import { COST_PROVISIONAL_DAYS, type CostWindow, dayText } from "./cost-views.ts";

/** At most this many movers per currency; the rest are counted. */
export const COST_WHY_MAX_MOVERS = 10;

export type CostTarget = { readonly kind: "product" | "service"; readonly name: string };
export type CostTargetResolution =
  | CostTarget
  | {
      readonly kind: "unknown";
      readonly known: { readonly products: string[]; readonly services: string[] };
    };

export interface CostMover {
  /** The rule's `service` output, or null when the rule sets none. */
  readonly service: string | null;
  /** The provider's service name (e.g. `Amazon EC2`). */
  readonly part: string;
  readonly provider: string;
  readonly current: number;
  readonly previous: number;
  readonly change: number;
}

export interface CostWhyCurrency {
  readonly current: number;
  readonly previous: number;
  readonly change: number;
  /** Null when the previous amount is 0 (the CLI says "new"). */
  readonly changePct: number | null;
  readonly spikeDay: string | null;
  readonly movers: CostMover[];
  readonly moversTruncated: number;
}

export interface CostWhy {
  readonly target: CostTarget;
  readonly range: CostWindow;
  readonly previous: CostWindow;
  readonly byCurrency: Record<string, CostWhyCurrency>;
  /** The target's rule `service` outputs, those that rose first. */
  readonly services: string[];
  readonly provisionalFrom: string | null;
}

export interface CompareCostInput {
  /** Lines of BOTH ranges; each is placed by its charge day. */
  readonly lines: readonly CostLine[];
  readonly rules: readonly CostRule[];
  readonly target: CostTarget;
  readonly range: CostWindow;
  readonly previous: CostWindow;
  readonly nowMs: number;
}

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);
const daysIn = (w: CostWindow): number =>
  Math.round((dayMs(w.toDay) - dayMs(w.fromDay)) / DAY_MS) + 1;
const inRange = (day: string, w: CostWindow): boolean => day >= w.fromDay && day <= w.toDay;

/** The rules a comparison applies: none when the `[cost]` config was refused (every line is unassigned). */
export function rulesInForce(
  rules: readonly CostRule[],
  configError: string | null,
): readonly CostRule[] {
  return configError === null ? rules : [];
}

/** The same number of days immediately before `range`. */
export function previousRange(range: CostWindow): CostWindow {
  const n = daysIn(range);
  const toMs = dayMs(range.fromDay) - DAY_MS;
  return {
    fromDay: dayText(toMs - (n - 1) * DAY_MS),
    toDay: dayText(toMs),
    label: `the ${String(n)} days before`,
  };
}

/** A product wins over a service id of the same name; the result says which it read. */
export function resolveCostTarget(
  lines: readonly CostLine[],
  rules: readonly CostRule[],
  name: string,
): CostTargetResolution {
  const products = new Set<string>();
  const services = new Set<string>();
  for (const l of lines) {
    const a = allocate(l, rules);
    if (a.unassignedReason !== null) continue;
    if (a.product !== null) products.add(a.product);
    if (a.service !== null) services.add(a.service);
  }
  if (products.has(name)) return { kind: "product", name };
  if (services.has(name)) return { kind: "service", name };
  return {
    kind: "unknown",
    known: { products: [...products].sort(), services: [...services].sort() },
  };
}

function matchesTarget(a: CostAllocation, t: CostTarget): boolean {
  if (a.unassignedReason !== null) return false;
  return t.kind === "product" ? a.product === t.name : a.service === t.name;
}

type MoverAcc = {
  service: string | null;
  part: string;
  provider: string;
  current: number;
  previous: number;
};
type CurrencyAcc = {
  current: number;
  previous: number;
  daily: Map<string, number>;
  movers: Map<string, MoverAcc>;
};

const newCurrencyAcc = (): CurrencyAcc => ({
  current: 0,
  previous: 0,
  daily: new Map(),
  movers: new Map(),
});

/** Step 1: put each of the target's lines into its currency, range and mover. */
function accumulate(input: CompareCostInput): {
  accs: Map<string, CurrencyAcc>;
  services: Set<string>;
} {
  const accs = new Map<string, CurrencyAcc>();
  const services = new Set<string>();
  for (const l of input.lines) {
    const isCurrent = inRange(l.chargeDay, input.range);
    if (!isCurrent && !inRange(l.chargeDay, input.previous)) continue;
    const a = allocate(l, input.rules);
    if (!matchesTarget(a, input.target)) continue;
    if (a.service !== null) services.add(a.service);
    const acc = accs.get(l.currency) ?? newCurrencyAcc();
    accs.set(l.currency, acc);
    const key = JSON.stringify([a.service, l.serviceName, l.provider]);
    const m = acc.movers.get(key) ?? {
      service: a.service,
      part: l.serviceName,
      provider: l.provider,
      current: 0,
      previous: 0,
    };
    acc.movers.set(key, m);
    if (isCurrent) {
      acc.current += l.billedCost;
      m.current += l.billedCost;
      acc.daily.set(l.chargeDay, (acc.daily.get(l.chargeDay) ?? 0) + l.billedCost);
    } else {
      acc.previous += l.billedCost;
      m.previous += l.billedCost;
    }
  }
  return { accs, services };
}

/** Step 2: the day furthest above the previous daily mean; the earliest on a tie; null when none exceeds it. */
function spikeDayOf(acc: CurrencyAcc, previous: CostWindow): string | null {
  const mean = acc.previous / daysIn(previous);
  let best: { day: string; over: number } | null = null;
  for (const day of [...acc.daily.keys()].sort()) {
    const over = (acc.daily.get(day) ?? 0) - mean;
    if (over > 0 && (best === null || over > best.over)) best = { day, over };
  }
  return best?.day ?? null;
}

/** Step 3: the movers ranked by the size of their change. */
function rankMovers(acc: CurrencyAcc): { movers: CostMover[]; truncated: number } {
  const all = [...acc.movers.values()]
    .map((m) => ({ ...m, change: m.current - m.previous }))
    .sort(
      (a, b) =>
        Math.abs(b.change) - Math.abs(a.change) ||
        a.part.localeCompare(b.part) ||
        a.provider.localeCompare(b.provider),
    );
  return {
    movers: all.slice(0, COST_WHY_MAX_MOVERS),
    truncated: Math.max(0, all.length - COST_WHY_MAX_MOVERS),
  };
}

/** Step 4: services whose cost rose first (largest rise first), then the rest by name. */
function orderServices(
  services: ReadonlySet<string>,
  accs: ReadonlyMap<string, CurrencyAcc>,
): string[] {
  const rise = new Map<string, number>();
  for (const acc of accs.values()) {
    for (const m of acc.movers.values()) {
      if (m.service === null) continue;
      rise.set(m.service, Math.max(rise.get(m.service) ?? 0, m.current - m.previous));
    }
  }
  return [...services].sort((a, b) => {
    const ra = Math.max(0, rise.get(a) ?? 0);
    const rb = Math.max(0, rise.get(b) ?? 0);
    return rb - ra || a.localeCompare(b);
  });
}

function provisionalFromOf(range: CostWindow, nowMs: number): string | null {
  const from = dayText(dayMs(dayText(nowMs)) - (COST_PROVISIONAL_DAYS - 1) * DAY_MS);
  return range.toDay >= from ? from : null;
}

export function compareCost(input: CompareCostInput): CostWhy {
  const { accs, services } = accumulate(input);
  const byCurrency: Record<string, CostWhyCurrency> = {};
  for (const c of [...accs.keys()].sort()) {
    const acc = accs.get(c) as CurrencyAcc;
    const change = acc.current - acc.previous;
    const { movers, truncated } = rankMovers(acc);
    byCurrency[c] = {
      current: acc.current,
      previous: acc.previous,
      change,
      changePct: acc.previous === 0 ? null : (change / acc.previous) * 100,
      spikeDay: spikeDayOf(acc, input.previous),
      movers,
      moversTruncated: truncated,
    };
  }
  return {
    target: input.target,
    range: input.range,
    previous: input.previous,
    byCurrency,
    services: orderServices(services, accs),
    provisionalFrom: provisionalFromOf(input.range, input.nowMs),
  };
}
