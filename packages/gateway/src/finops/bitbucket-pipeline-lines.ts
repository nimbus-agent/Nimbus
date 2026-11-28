// Phase 7 (the Cost Pack, slice 9; owner rulings 2026-11-28): Bitbucket Pipelines minutes as cost lines.
// Pure (static D48: no network, no connector, no model import).
//
// The sync lists each repository's pipelines (`GET /2.0/repositories/{workspace}/{repo}/pipelines`; documentation-
// verified against Atlassian's OpenAPI spec) and this sums each pipeline's `build_seconds_used` per UTC day of
// `completed_on`, per repository. Bitbucket returns seconds, never money: the minutes are priced by the owner's rate
// (`[cost.bitbucket] rate_per_minute`, or a `size_rates` entry), else stored unpriced.
//
// Stated bounds (the docs repeat them): the documented pipeline object has no step size and no runner field, so a
// line's `rate_key` is `size:<n>x` only when the listing itself carries a `size` and `default` otherwise, and the
// `self_hosted` counter stays 0 (a pipeline on a self-hosted runner cannot be told apart, so its seconds are
// counted); whether `build_seconds_used` already includes Bitbucket's size multiplier is unverified.
//
// A pipeline is DROPPED and counted, never thrown: not finished (`completed_on` null), seconds that are not a finite
// non-negative number (a record with no `uuid` is counted here too), or a day outside the month or after `lastDay`.
// A repeated `uuid` (the same pipeline on two pages) is counted once.
import { type CostLine, costLineGrainHash, setTag, tagOf } from "./cost-line.ts";
import {
  COST_RATE_KEY_TAG,
  type CostRates,
  pricedFields,
  rateForKey,
  rateKeyFor,
} from "./cost-rate-price.ts";

export const BITBUCKET_COST_SOURCE = "bitbucket_billing";
export const BITBUCKET_COST_PROVIDER = "bitbucket";
export const BITBUCKET_COST_SERVICE = "Bitbucket Pipelines";
export const BITBUCKET_COST_SKU = "pipeline_minutes";

export type BitbucketPipelineDropReason =
  | "unfinished"
  | "bad_seconds"
  | "outside_month"
  | "self_hosted";

export interface BitbucketRepoPipelines {
  /** Bitbucket's stable repository uuid: the line's sub-account, so a rename never splits it. */
  readonly repoUuid: string;
  /** `workspace/slug` now: the sub-account name and the `repo`. */
  readonly fullName: string;
  readonly pipelines: readonly unknown[];
}

export interface BitbucketPipelineLinesResult {
  readonly lines: readonly CostLine[];
  /** Distinct pipelines seen (a repeated uuid counts once). */
  readonly pipelines: number;
  readonly dropped: Readonly<Record<BitbucketPipelineDropReason, number>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const SIZE_RE = /^(?:1|2|4|8|16|24|32)x$/;

/** The UTC day of an ISO date-time with a zone, or null. */
function completedDay(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(v))
    return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

type Parsed = { line: CostLine; seconds: number; uuid: string };

function parsePipeline(
  raw: unknown,
  repo: BitbucketRepoPipelines,
  account: string,
  month: string,
  lastDay: string,
  rates: CostRates,
): Parsed | BitbucketPipelineDropReason {
  if (!isRecord(raw)) return "bad_seconds";
  const uuid = raw["uuid"];
  const seconds = raw["build_seconds_used"];
  if (typeof uuid !== "string" || uuid === "") return "bad_seconds";
  const day = completedDay(raw["completed_on"]);
  if (day === null) return "unfinished";
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return "bad_seconds";
  if (day.slice(0, 7) !== month || day > lastDay) return "outside_month";
  const size = typeof raw["size"] === "string" && SIZE_RE.test(raw["size"]) ? raw["size"] : null;
  const tags: Record<string, string> = {};
  setTag(tags, COST_RATE_KEY_TAG, rateKeyFor("size", size));
  const line: CostLine = {
    source: BITBUCKET_COST_SOURCE,
    provider: BITBUCKET_COST_PROVIDER,
    billingAccountId: account,
    billingPeriod: month,
    chargeDay: day,
    subAccountId: repo.repoUuid,
    subAccountName: repo.fullName,
    serviceName: BITBUCKET_COST_SERVICE,
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: BITBUCKET_COST_SKU,
    chargeCategory: "usage",
    billedCost: 0,
    effectiveCost: null,
    currency: rates.currency,
    tags,
    repo: repo.fullName,
    workflow: null,
    model: null,
    importId: `${BITBUCKET_COST_SOURCE}:${account}:${month}`,
    consumedQuantity: 0,
    consumedUnit: "minute",
    priced: false,
  };
  return { line, seconds, uuid };
}

/**
 * The cost lines of one workspace's repositories' pipelines for `month` (`YYYY-MM`), up to `lastDay`
 * (`YYYY-MM-DD`): one per (day, repository, rate key), minutes summed unrounded, then priced once by the line's key.
 */
export function bitbucketPipelineLines(
  account: string,
  month: string,
  repos: readonly BitbucketRepoPipelines[],
  rates: CostRates,
  lastDay = "9999-12-31",
): BitbucketPipelineLinesResult {
  const dropped: Record<BitbucketPipelineDropReason, number> = {
    unfinished: 0,
    bad_seconds: 0,
    outside_month: 0,
    self_hosted: 0,
  };
  const merged = new Map<string, { line: CostLine; seconds: number }>();
  const seen = new Set<string>();
  for (const repo of repos) {
    for (const raw of repo.pipelines) {
      const r = parsePipeline(raw, repo, account, month, lastDay, rates);
      if (typeof r === "string") {
        dropped[r]++;
        continue;
      }
      if (seen.has(r.uuid)) continue;
      seen.add(r.uuid);
      const key = `${r.line.chargeDay}|${costLineGrainHash(r.line)}`;
      const prior = merged.get(key);
      merged.set(key, { line: prior?.line ?? r.line, seconds: (prior?.seconds ?? 0) + r.seconds });
    }
  }
  const lines = [...merged.values()].map(({ line, seconds }): CostLine => {
    const minutes = seconds / 60;
    const key = tagOf(line.tags, COST_RATE_KEY_TAG) ?? "";
    return { ...line, ...pricedFields(minutes, rateForKey(rates, key)), consumedQuantity: minutes };
  });
  return { lines, pipelines: seen.size, dropped };
}
