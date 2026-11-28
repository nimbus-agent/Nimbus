// Phase 7 (the Cost Pack, slice 15; owner ruling D4 part B): Jenkins agents priced from their cloud machine cost.
//
// Money is stored ONCE, on the cloud line. A Jenkins build on an agent mapped by `[cost.jenkins] agent_cost` is a
// quantity-only line (rate key `cloud:<agent>`, never priced). At READ time this splits the machine's cloud cost
// for each day across that day's builds, by minutes, so a `[[cost.rule]]` allocates each share to the build's
// product, and shows the part no build used as the machine's `idle` line. Stored rows never change.
//
// For one machine-day with cloud cost C and build minutes m_i (M = sum of m_i, a day = 1440 minutes):
//   M <= 1440: build i gets m_i / 1440 x C, and idle is (1 - M / 1440) x C, tagged `idle = "true"`.
//   M  > 1440 (concurrent builds): build i gets m_i / M x C, and idle is 0.
// Each currency of the matched cloud cost is split alone; money in equals money out per currency.
//
// Confined by static rule D48 (no network, no connector, no model). Pure.
import type { JenkinsAgentCost } from "../config/cost-jenkins-toml.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { type CostLine, setTag, tagOf } from "./cost-line.ts";
import { COST_RATE_KEY_CLOUD_PREFIX, COST_RATE_KEY_TAG } from "./cost-rate-price.ts";
import { globMatches } from "./cost-rules.ts";
import { JENKINS_COST_SOURCE } from "./jenkins-build-lines.ts";

/** Minutes in the day a machine is billed for. */
export const COST_AGENT_DAY_MINUTES = 1440;
export const COST_IDLE_TAG = "idle";

export interface AgentSplitResult {
  readonly lines: readonly CostLine[];
  /** Stated gaps and warnings for the view's notes. */
  readonly notes: readonly string[];
}

const agentOf = (l: CostLine): string | null => {
  if (l.source !== JENKINS_COST_SOURCE) return null;
  const key = tagOf(l.tags, COST_RATE_KEY_TAG);
  return key?.startsWith(COST_RATE_KEY_CLOUD_PREFIX) === true
    ? key.slice(COST_RATE_KEY_CLOUD_PREFIX.length)
    : null;
};

const machineMatches = (l: CostLine, m: JenkinsAgentCost): boolean =>
  l.source !== JENKINS_COST_SOURCE &&
  l.provider === m.provider &&
  ((l.resourceId !== null && globMatches(m.resource, l.resourceId)) ||
    (l.resourceName !== null && globMatches(m.resource, l.resourceName)));

type Builds = { lines: CostLine[]; minutes: number };

function buildsByAgentDay(lines: readonly CostLine[]): Map<string, Builds> {
  const out = new Map<string, Builds>();
  for (const l of lines) {
    const agent = agentOf(l);
    if (agent === null) continue;
    const k = JSON.stringify([agent, l.chargeDay]);
    const b = out.get(k) ?? { lines: [], minutes: 0 };
    b.lines.push(l);
    b.minutes += l.consumedQuantity ?? 0;
    out.set(k, b);
  }
  return out;
}

/** The pieces one cloud line is split into for one agent-day (builds, then idle). */
function pieces(cloud: CostLine, builds: Builds): CostLine[] {
  const total = builds.minutes;
  const denominator = Math.max(total, COST_AGENT_DAY_MINUTES);
  const out: CostLine[] = builds.lines.map((b): CostLine => {
    const f = (b.consumedQuantity ?? 0) / denominator;
    return {
      ...b,
      currency: cloud.currency,
      billedCost: cloud.billedCost * f,
      effectiveCost: cloud.effectiveCost === null ? null : cloud.effectiveCost * f,
      priced: true,
    };
  });
  const idleFraction = Math.max(0, 1 - total / COST_AGENT_DAY_MINUTES);
  if (idleFraction > 0) {
    const tags: Record<string, string> = {};
    for (const [k, v] of Object.entries(cloud.tags)) setTag(tags, k, v);
    setTag(tags, COST_IDLE_TAG, "true");
    out.push({
      ...cloud,
      tags,
      billedCost: cloud.billedCost * idleFraction,
      effectiveCost: cloud.effectiveCost === null ? null : cloud.effectiveCost * idleFraction,
    });
  }
  return out;
}

/** Two agents whose globs match one machine line: the first in config order owns it. */
function overlapNotes(lines: readonly CostLine[], mapping: readonly JenkinsAgentCost[]): string[] {
  const pairs = new Set<string>();
  for (const l of lines) {
    const hits = mapping.filter((m) => machineMatches(l, m));
    for (let i = 1; i < hits.length; i++) {
      pairs.add(
        `Jenkins agent_cost: ${String(hits[i]?.agent)} matches a machine already matched by ${String(hits[0]?.agent)} (${l.resourceId ?? l.resourceName ?? "?"}); the machine is split once, for ${String(hits[0]?.agent)}, the first in config order`,
      );
    }
  }
  return [...pairs].sort(codeUnitCompare);
}

/**
 * The cost lines with each mapped agent's machine cost split over its builds. Quantity-only Jenkins lines whose
 * machine cost was found are replaced by their priced shares; a machine-day with no builds is left whole; a build
 * whose machine has no cost line that day stays as it is (minutes, unpriced), with a note.
 */
export function splitAgentMachineCost(
  lines: readonly CostLine[],
  agentCost: readonly JenkinsAgentCost[],
): AgentSplitResult {
  const builds = buildsByAgentDay(lines);
  if (builds.size === 0 || agentCost.length === 0) return { lines, notes: [] };
  const out: CostLine[] = [];
  const claimed = new Set<string>();
  for (const l of lines) {
    if (agentOf(l) !== null) continue;
    const owner = agentCost.find(
      (m) => machineMatches(l, m) && builds.has(JSON.stringify([m.agent, l.chargeDay])),
    );
    const b =
      owner === undefined ? undefined : builds.get(JSON.stringify([owner.agent, l.chargeDay]));
    if (owner === undefined || b === undefined || b.minutes <= 0) {
      out.push(l);
      continue;
    }
    claimed.add(JSON.stringify([owner.agent, l.chargeDay]));
    out.push(...pieces(l, b));
  }
  // The Jenkins lines whose machine cost was not found stay (minutes only), so their minutes are never lost.
  const unmatched = new Map<string, number>();
  for (const l of lines) {
    const agent = agentOf(l);
    if (agent === null) continue;
    const k = JSON.stringify([agent, l.chargeDay]);
    const b = builds.get(k);
    if (claimed.has(k) && (b?.minutes ?? 0) > 0) continue;
    out.push(l);
    unmatched.set(agent, (unmatched.get(agent) ?? 0) + 1);
  }
  const notes = overlapNotes(lines, agentCost);
  for (const agent of [...unmatched.keys()].sort(codeUnitCompare)) {
    const m = agentCost.find((e) => e.agent === agent);
    if (m === undefined) continue;
    const noResourceId = lines.some(
      (l) => l.provider === m.provider && l.resourceId === null && l.resourceName === null,
    );
    notes.push(
      `Jenkins agent ${agent}: no ${m.provider} cost line matched "${m.resource}" on ${String(unmatched.get(agent))} day-lines of its builds, so those minutes stay unpriced` +
        (noResourceId
          ? `; some ${m.provider} lines carry no resource id (AWS Cost Explorer lines never do), so a machine can only be found in an export`
          : ""),
    );
  }
  return { lines: out, notes };
}
