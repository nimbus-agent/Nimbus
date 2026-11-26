import { type CostChangeContext, selectCostChangeContext } from "../agents/_lib/cost-why-query.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "../config/nimbus-toml.ts";
import { DAY_MS } from "../finops/cost-item-contract.ts";
import { type CostRulesCheck, checkCostRules } from "../finops/cost-rules-check.ts";
import { gatherCostViewInput } from "../finops/cost-view-input.ts";
import {
  type CostFreshness,
  type CostViewResult,
  type CostWindow,
  costFreshness,
} from "../finops/cost-views.ts";
import {
  type CostWhy,
  compareCost,
  previousRange,
  resolveCostTarget,
  rulesInForce,
} from "../finops/cost-why.ts";
import type { ServiceConfig } from "../metrics/dora-config.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import {
  type CostViewsRpcCtx,
  CostViewsRpcError,
  config,
  params,
  requireOwner,
  windowOf,
} from "./cost-views-rpc.ts";

/**
 * `cost.why` and `cost.rulesCheck` (Phase 7, the Cost Pack, slice 2). Reads of the local index only: no network,
 * no model, no egress row. Served only to a connection whose DECLARED kind is `cli` or `ui`; the `cost` namespace
 * is LAN-forbidden (I5) and neither is on the renderer allowlist (I7). A demo gateway answers from its seeded lines.
 *
 * Static rule D48 keeps `finops/` free of deploys, pull requests and owners, so this layer joins the two halves:
 * `finops/cost-why.ts` computes the comparison, `agents/_lib/cost-why-query.ts` reads the change context for the
 * services it names, and the two cross only here, as plain data.
 */

/** Context is read for at most this many of the target's services. */
export const COST_WHY_MAX_CONTEXT_SERVICES = 3;
const TARGET_MAX_LENGTH = 64;

export interface CostWhyEmpty {
  readonly empty: true;
  readonly range: CostWindow;
  readonly previous: CostWindow;
  readonly context: [];
}

export type CostWhyResult = CostWhy & {
  readonly empty: false;
  readonly freshness: CostFreshness[];
  readonly excludedSources: CostViewResult["excludedSources"];
  readonly notes: string[];
  readonly context: CostChangeContext[];
};

function targetParam(p: Record<string, unknown>): string {
  const t = p["target"];
  if (typeof t !== "string" || t.length === 0 || t.length > TARGET_MAX_LENGTH) {
    throw new CostViewsRpcError(
      -32602,
      `cost.why: target must be a product or service name of 1 to ${String(TARGET_MAX_LENGTH)} characters`,
    );
  }
  return t;
}

function serviceConfigs(ctx: CostViewsRpcCtx): ReadonlyMap<string, ServiceConfig> {
  return ctx.configDir === undefined
    ? new Map()
    : loadNimbusServiceConfigsFromConfigDir(ctx.configDir);
}

const dayMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

/** The earliest spike day of any currency: the deploys near it are listed first. */
function earliestSpike(why: CostWhy): string | null {
  const days = Object.values(why.byCurrency)
    .map((c) => c.spikeDay)
    .filter((d): d is string => d !== null)
    .sort(codeUnitCompare);
  return days[0] ?? null;
}

function unknownTarget(
  name: string,
  known: { products: string[]; services: string[] },
  configError: string | null,
): never {
  const list = (xs: string[]): string => (xs.length === 0 ? "none" : xs.join(", "));
  const refused = configError === null ? "" : ` (the [cost] config was refused: ${configError})`;
  throw new CostViewsRpcError(
    -32602,
    `cost.why: no product or service named "${name}" in this range or the one before (products: ${list(known.products)}; services: ${list(known.services)})${refused}`,
  );
}

export function handleCostWhy(raw: unknown, ctx: CostViewsRpcCtx): CostWhyResult | CostWhyEmpty {
  requireOwner(ctx, "cost.why");
  const p = params(raw ?? {}, "cost.why", ["target", "period"]);
  const name = targetParam(p);
  const nowMs = (ctx.now ?? Date.now)();
  const range = windowOf({ period: p["period"] ?? "14d" }, "cost.why", nowMs);
  const previous = previousRange(range);
  const cfg = config(ctx);
  // ONE gather over both periods, so one source rule (authoritative, or raw lines over Vantage) applies to both:
  // two gathers could count Vantage before and FOCUS now and report the switch as a change.
  const both = gatherCostViewInput(
    ctx.db,
    cfg,
    {
      fromDay: previous.fromDay,
      toDay: range.toDay,
      label: `${previous.label} and ${range.label}`,
    },
    nowMs,
  );
  if (both.empty) return { empty: true, range, previous, context: [] };
  const rules = rulesInForce(cfg.rules, cfg.error);
  const target = resolveCostTarget(both.lines, rules, name);
  if (target.kind === "unknown") unknownTarget(name, target.known, cfg.error);
  const why = compareCost({ lines: both.lines, rules, target, range, previous, nowMs });
  const spike = earliestSpike(why);
  const spikeDayMs = spike === null ? null : dayMs(spike);
  const context = selectCostChangeContext(ctx.db, {
    serviceIds: why.services.slice(0, COST_WHY_MAX_CONTEXT_SERVICES),
    services: serviceConfigs(ctx),
    // A spike on the first day of the period still reaches the deploy the day before it.
    fromMs: Math.min(dayMs(range.fromDay), spikeDayMs === null ? Infinity : spikeDayMs - DAY_MS),
    toMs: dayMs(range.toDay) + DAY_MS,
    spikeDayMs,
  });
  return {
    ...why,
    empty: false,
    freshness: costFreshness(both),
    excludedSources: [...both.excludedSources],
    notes: [...both.notes],
    context,
  };
}

export function handleCostRulesCheck(
  raw: unknown,
  ctx: CostViewsRpcCtx,
): CostRulesCheck & { readonly empty: boolean; readonly freshness: CostFreshness[] } {
  requireOwner(ctx, "cost.rulesCheck");
  const p = params(raw, "cost.rulesCheck", ["period"]);
  const nowMs = (ctx.now ?? Date.now)();
  const range = windowOf(p, "cost.rulesCheck", nowMs);
  const input = gatherCostViewInput(ctx.db, config(ctx), range, nowMs);
  return { ...checkCostRules(input), empty: input.empty, freshness: costFreshness(input) };
}
