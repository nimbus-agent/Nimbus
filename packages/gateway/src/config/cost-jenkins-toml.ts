/**
 * `[cost.jenkins]` - the Jenkins build-minutes cost source (Phase 7, the Cost Pack, slice 10; owner rulings
 * 2026-11-28, D4). Read by `cost-toml.ts`, which refuses the whole cost config on any error here.
 *
 * ```toml
 * [cost.jenkins]
 * rate_per_minute = 0.008            # the owner's price of one build minute; unset = lines are unpriced
 * currency = "USD"                   # ISO 4217, default USD
 * agent_rates = { "linux-big" = 0.02, "built-in" = 0.0 }   # per agent name (`builtOn`); "built-in" is the controller
 * agent_cost = { "linux-big" = { provider = "aws", resource = "i-0abc*" } }   # priced from the cloud machine (slice 15)
 * ```
 *
 * `agent_cost` (slice 15, owner ruling D4 part B): a build on a mapped agent is stored as minutes only (never priced);
 * the money stays on the cloud line (a FOCUS `ResourceId` or resource name matching `resource`), and the cost views
 * split that line across the day's builds at read time (`finops/cost-agent-split.ts`). Table order is the priority
 * when two agents match one machine.
 *
 * The table's presence turns the sync on (Jenkins has one base, the Jenkins connector's `jenkins.base_url`).
 * `label_rates` is deliberately absent: a build's JSON exposes `builtOn` (AbstractBuild.getBuiltOnStr, "the name of
 * the agent it was built on; null or "" if built by the built-in node", https://javadoc.jenkins.io/hudson/model/AbstractBuild.html)
 * but no node label, which lives on the node (`/computer/<name>/api/json`), so a label rate cannot be applied.
 */
import { codeUnitCompare } from "../util/code-unit-compare.ts";

export interface NimbusCostJenkinsConfig {
  /** True when `[cost.jenkins]` exists. */
  readonly enabled: boolean;
  /** Null: no default rate, so every line is stored unpriced with its minutes. */
  readonly ratePerMinute: number | null;
  readonly currency: string;
  /** Agent name (or `built-in`) → rate per minute, sorted by name. */
  readonly agentRates: readonly (readonly [string, number])[];
  /** Slice 15: agents priced from their cloud machine's cost, in config order (the first wins a shared machine). */
  readonly agentCost: readonly JenkinsAgentCost[];
}

export const COST_JENKINS_AGENT_COST_PROVIDERS = ["aws", "azure", "gcp"] as const;
export interface JenkinsAgentCost {
  readonly agent: string;
  readonly provider: (typeof COST_JENKINS_AGENT_COST_PROVIDERS)[number];
  /** A glob (`*`, `?`) on the cloud line's resource id or resource name. */
  readonly resource: string;
}

export const DEFAULT_COST_JENKINS_CONFIG: NimbusCostJenkinsConfig = Object.freeze({
  enabled: false,
  ratePerMinute: null,
  currency: "USD",
  agentRates: Object.freeze([]) as readonly (readonly [string, number])[],
  agentCost: Object.freeze([]) as readonly JenkinsAgentCost[],
});

/** A sanity bound on a per-minute price, so a typo of a monthly figure is refused, not billed. */
export const COST_JENKINS_MAX_RATE = 1000;
export const COST_JENKINS_MAX_AGENT_RATES = 500;
export const COST_JENKINS_MAX_AGENT_COST = 100;
export const COST_JENKINS_MAX_RESOURCE_GLOB = 200;
/** The agent key of the built-in node (a build with an empty `builtOn`). */
export const JENKINS_BUILT_IN_AGENT = "built-in";

export class CostJenkinsConfigError extends Error {}

function rate(v: unknown, what: string): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > COST_JENKINS_MAX_RATE) {
    throw new CostJenkinsConfigError(
      `${what} must be a number from 0 to ${String(COST_JENKINS_MAX_RATE)} (a price per minute)`,
    );
  }
  return v;
}

function readAgentRates(v: unknown): readonly (readonly [string, number])[] {
  if (v === undefined) return Object.freeze([]);
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new CostJenkinsConfigError(
      '[cost.jenkins].agent_rates must be a table such as { "linux-big" = 0.02 }',
    );
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > COST_JENKINS_MAX_AGENT_RATES) {
    throw new CostJenkinsConfigError(
      `[cost.jenkins].agent_rates: at most ${String(COST_JENKINS_MAX_AGENT_RATES)} agents`,
    );
  }
  const out = entries.map(([agent, r]): readonly [string, number] => {
    if (agent.trim() === "" || agent.length > 200) {
      throw new CostJenkinsConfigError(
        `[cost.jenkins].agent_rates: ${JSON.stringify(agent).slice(0, 64)} is not an agent name`,
      );
    }
    return Object.freeze([agent, rate(r, `[cost.jenkins].agent_rates.${agent}`)]);
  });
  out.sort((a, b) => codeUnitCompare(a[0], b[0]));
  return Object.freeze(out);
}

function agentCostEntry(agent: string, v: unknown): JenkinsAgentCost {
  const where = `[cost.jenkins].agent_cost.${agent}`;
  if (agent.trim() === "" || agent.length > 200) {
    throw new CostJenkinsConfigError(
      `[cost.jenkins].agent_cost: ${JSON.stringify(agent).slice(0, 64)} is not an agent name`,
    );
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new CostJenkinsConfigError(
      `${where} must be a table such as { provider = "aws", resource = "i-0abc*" }`,
    );
  }
  const t = v as Record<string, unknown>;
  for (const k of Object.keys(t)) {
    if (k !== "provider" && k !== "resource") {
      throw new CostJenkinsConfigError(`${where}: unknown key "${k}"`);
    }
  }
  const provider = COST_JENKINS_AGENT_COST_PROVIDERS.find((p) => p === t["provider"]);
  if (provider === undefined) {
    throw new CostJenkinsConfigError(`${where}.provider must be "aws", "azure" or "gcp"`);
  }
  const resource = t["resource"];
  if (
    typeof resource !== "string" ||
    resource.trim() === "" ||
    resource.length > COST_JENKINS_MAX_RESOURCE_GLOB
  ) {
    throw new CostJenkinsConfigError(
      `${where}.resource must be a glob of 1 to ${String(COST_JENKINS_MAX_RESOURCE_GLOB)} characters`,
    );
  }
  return Object.freeze({ agent, provider, resource });
}

function readAgentCost(v: unknown): readonly JenkinsAgentCost[] {
  if (v === undefined) return Object.freeze([]);
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new CostJenkinsConfigError(
      '[cost.jenkins].agent_cost must be a table such as { "linux-big" = { provider = "aws", resource = "i-0abc*" } }',
    );
  }
  const entries = Object.entries(v as Record<string, unknown>);
  if (entries.length > COST_JENKINS_MAX_AGENT_COST) {
    throw new CostJenkinsConfigError(
      `[cost.jenkins].agent_cost: at most ${String(COST_JENKINS_MAX_AGENT_COST)} agents`,
    );
  }
  return Object.freeze(entries.map(([agent, e]) => agentCostEntry(agent, e)));
}

/** `[cost.jenkins]` from its parsed table. Throws {@link CostJenkinsConfigError}. */
export function readCostJenkinsTable(t: Record<string, unknown>): NimbusCostJenkinsConfig {
  for (const k of Object.keys(t)) {
    if (!["rate_per_minute", "currency", "agent_rates", "agent_cost"].includes(k)) {
      throw new CostJenkinsConfigError(`[cost.jenkins]: unknown key "${k}"`);
    }
  }
  const currency = t["currency"] ?? "USD";
  if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency)) {
    throw new CostJenkinsConfigError(
      "[cost.jenkins].currency must be a three-letter ISO 4217 code such as USD",
    );
  }
  return Object.freeze({
    enabled: true,
    ratePerMinute:
      t["rate_per_minute"] === undefined
        ? null
        : rate(t["rate_per_minute"], "[cost.jenkins].rate_per_minute"),
    currency,
    agentRates: readAgentRates(t["agent_rates"]),
    agentCost: readAgentCost(t["agent_cost"]),
  });
}
