// Phase 7 (the Cost Pack, slice 10; owner rulings 2026-11-28, D4): Jenkins builds as cost lines. Pure (static D48:
// no network, no connector, no model import).
//
// The sync lists each job's builds (`GET <job>/api/json?tree=builds[number,timestamp,duration,builtOn,result,building]`)
// and this sums each finished build's wall-clock minutes per UTC day, per job and agent. Jenkins reports
// milliseconds, never money: `duration` and `timestamp` are both in ms, minutes = `duration / 60_000`, and the
// charge day is the UTC day the build ENDED (`timestamp + duration`). The minutes are priced by the owner's rate
// (`[cost.jenkins] rate_per_minute`, or an `agent_rates` entry), else stored unpriced.
//
// A line's `rate_key` is `agent:<builtOn>`, `agent:built-in` for a PRESENT empty `builtOn` (the built-in node), and
// `default` (resource `unknown`) when `builtOn` is missing or not a string, so a rate added later re-prices the
// stored lines. Stated bounds: a Pipeline (`WorkflowRun`) build has no `builtOn` in the JSON API: Jenkins names no
// agent for it, so it is priced at `rate_per_minute`; wall-clock minutes, not agent-billed minutes; Jenkins has no stable job id, so the job's full name is the sub-account.
//
// A build is DROPPED and counted, never thrown: still running or with no duration (`unfinished`), a `number`,
// `duration` or `timestamp` that is not a finite non-negative number (`bad_duration`), or an end day outside the
// month or after `lastDay` (`outside_month`). A repeated (job, number) is counted once.
import { type CostLine, costLineGrainHash, setTag, tagOf } from "./cost-line.ts";
import {
  COST_RATE_KEY_TAG,
  type CostRates,
  pricedFields,
  rateForKey,
  rateKeyFor,
} from "./cost-rate-price.ts";

export const JENKINS_COST_SOURCE = "jenkins_billing";
export const JENKINS_COST_PROVIDER = "jenkins";
export const JENKINS_COST_SERVICE = "Jenkins builds";
export const JENKINS_COST_SKU = "build_minutes";
/** The agent key of a build whose `builtOn` is present and empty (the built-in node). */
export const JENKINS_BUILT_IN = "built-in";

export type JenkinsBuildDropReason = "unfinished" | "bad_duration" | "outside_month";

export interface JenkinsJobBuilds {
  /** The job's full name (`folder/job`): the sub-account and the `repo`. */
  readonly fullName: string;
  readonly builds: readonly unknown[];
}

export interface JenkinsBuildLinesResult {
  readonly lines: readonly CostLine[];
  /** Distinct builds counted or dropped by reason (a repeated (job, number) counts once). */
  readonly builds: number;
  readonly dropped: Readonly<Record<JenkinsBuildDropReason, number>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const finiteNonNegative = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v) && v >= 0;

type Parsed = { line: CostLine; minutes: number; id: string };

function parseBuild(
  raw: unknown,
  job: JenkinsJobBuilds,
  account: string,
  month: string,
  lastDay: string,
  rates: CostRates,
): Parsed | JenkinsBuildDropReason {
  if (!isRecord(raw)) return "bad_duration";
  if (raw["building"] === true || raw["duration"] === undefined || raw["duration"] === null) {
    return "unfinished";
  }
  const { number, timestamp, duration } = raw;
  if (!finiteNonNegative(number) || !finiteNonNegative(timestamp) || !finiteNonNegative(duration)) {
    return "bad_duration";
  }
  const end = new Date(timestamp + duration);
  if (Number.isNaN(end.getTime())) return "bad_duration";
  const day = end.toISOString().slice(0, 10);
  if (day.slice(0, 7) !== month || day > lastDay) return "outside_month";
  // Present and empty: the built-in node. Missing or not a string (a Pipeline build): no agent is named.
  const builtOn = typeof raw["builtOn"] === "string" ? raw["builtOn"].trim() : null;
  const agent = builtOn === "" ? JENKINS_BUILT_IN : builtOn;
  const tags: Record<string, string> = {};
  setTag(tags, COST_RATE_KEY_TAG, rateKeyFor("agent", agent));
  const line: CostLine = {
    source: JENKINS_COST_SOURCE,
    provider: JENKINS_COST_PROVIDER,
    billingAccountId: account,
    billingPeriod: month,
    chargeDay: day,
    subAccountId: job.fullName,
    subAccountName: job.fullName,
    serviceName: JENKINS_COST_SERVICE,
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: agent ?? "unknown",
    skuId: JENKINS_COST_SKU,
    chargeCategory: "usage",
    billedCost: 0,
    effectiveCost: null,
    currency: rates.currency,
    tags,
    repo: job.fullName,
    workflow: null,
    model: null,
    importId: `${JENKINS_COST_SOURCE}:${account}:${month}`,
    consumedQuantity: 0,
    consumedUnit: "minute",
    priced: false,
  };
  return { line, minutes: duration / 60_000, id: `${job.fullName}\u0000${String(number)}` };
}

/**
 * The cost lines of one Jenkins base's jobs for `month` (`YYYY-MM`), up to `lastDay` (`YYYY-MM-DD`): one per (day,
 * job, agent), minutes summed unrounded, then priced once by the line's rate key.
 */
export function jenkinsBuildLines(
  account: string,
  month: string,
  jobs: readonly JenkinsJobBuilds[],
  rates: CostRates,
  lastDay = "9999-12-31",
): JenkinsBuildLinesResult {
  const dropped: Record<JenkinsBuildDropReason, number> = {
    unfinished: 0,
    bad_duration: 0,
    outside_month: 0,
  };
  const merged = new Map<string, { line: CostLine; minutes: number }>();
  const seen = new Set<string>();
  for (const job of jobs) {
    for (const raw of job.builds) {
      const r = parseBuild(raw, job, account, month, lastDay, rates);
      if (typeof r === "string") {
        dropped[r]++;
        continue;
      }
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      const key = `${r.line.chargeDay}|${costLineGrainHash(r.line)}`;
      const prior = merged.get(key);
      merged.set(key, { line: prior?.line ?? r.line, minutes: (prior?.minutes ?? 0) + r.minutes });
    }
  }
  const lines = [...merged.values()].map(({ line, minutes }): CostLine => {
    const key = tagOf(line.tags, COST_RATE_KEY_TAG) ?? "";
    return { ...line, ...pricedFields(minutes, rateForKey(rates, key)), consumedQuantity: minutes };
  });
  return { lines, builds: seen.size, dropped };
}
