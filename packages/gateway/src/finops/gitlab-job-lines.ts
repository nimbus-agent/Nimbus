// Phase 7 (the Cost Pack, slice 8; owner rulings 2026-11-28): self-managed GitLab job durations as cost lines.
// Pure (static D48: no network, no connector, no model import).
//
// A self-managed instance has no usage API (the hosted-runner usage query is GitLab Dedicated only and the runner
// usage queries need ClickHouse), so the sync lists each project's jobs (`GET /projects/:id/jobs`;
// documentation-verified only) and this sums their `duration` per UTC day of `finished_at`, project and runner.
// The docs give `duration` as a decimal and state no unit; GitLab returns seconds, and the docs say the unit is
// not stated. These are WALL-CLOCK minutes on the owner's own runners, priced by the owner's rates: the runner's
// `runner_rates` entry, else `rate_per_minute`, else unpriced.
//
// A job is DROPPED and counted, never thrown: no runner (it never ran, or the token cannot see the runner), not
// finished, a duration that is not a finite non-negative number, or a day outside the month or after `lastDay`.
import { type CostLine, costLineGrainHash, setTag, tagOf } from "./cost-line.ts";
import {
  COST_RATE_KEY_TAG,
  type CostRates,
  pricedFields,
  rateForKey,
  rateKeyForRunner,
} from "./cost-rate-price.ts";
import {
  GITLAB_COST_PROVIDER,
  GITLAB_COST_SERVICE,
  GITLAB_COST_SKU,
  GITLAB_COST_SOURCE,
  GITLAB_DEPLOYMENT_TAG,
} from "./gitlab-minutes-lines.ts";

export type GitlabJobDropReason = "no_runner" | "unfinished" | "bad_duration" | "outside_month";

export interface GitlabProjectJobs {
  readonly projectFullPath: string;
  readonly jobs: readonly unknown[];
}

export interface GitlabJobLinesResult {
  readonly lines: readonly CostLine[];
  readonly jobs: number;
  readonly dropped: Readonly<Record<GitlabJobDropReason, number>>;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const MAX_TEXT = 255;
const text = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT ? v : null;

/** The UTC day of an ISO date-time with a zone, or null. */
function finishedDay(v: unknown): string | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:?\d{2})$/i.test(v))
    return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

type Parsed = { line: CostLine; seconds: number };

function parseJob(
  raw: unknown,
  project: string,
  account: string,
  month: string,
  lastDay: string,
  rates: CostRates,
): Parsed | GitlabJobDropReason {
  if (!isRecord(raw)) return "bad_duration";
  const runner = isRecord(raw["runner"]) ? raw["runner"] : null;
  const runnerId = runner === null ? null : runner["id"];
  if (runner === null || (typeof runnerId !== "number" && typeof runnerId !== "string")) {
    return "no_runner";
  }
  const day = finishedDay(raw["finished_at"]);
  if (day === null) return "unfinished";
  const seconds = raw["duration"];
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0)
    return "bad_duration";
  if (day.slice(0, 7) !== month || day > lastDay) return "outside_month";
  const description = text(runner["description"]);
  const tags: Record<string, string> = {};
  setTag(tags, COST_RATE_KEY_TAG, rateKeyForRunner(description));
  setTag(tags, GITLAB_DEPLOYMENT_TAG, "self-managed");
  const runnerType = text(runner["runner_type"]);
  if (runnerType !== null) setTag(tags, "runner_type", runnerType);
  const line: CostLine = {
    source: GITLAB_COST_SOURCE,
    provider: GITLAB_COST_PROVIDER,
    billingAccountId: account,
    billingPeriod: month,
    chargeDay: day,
    subAccountId: project,
    subAccountName: null,
    serviceName: GITLAB_COST_SERVICE,
    serviceCategory: null,
    regionId: null,
    resourceId: String(runnerId).slice(0, MAX_TEXT),
    resourceName: description,
    skuId: GITLAB_COST_SKU,
    chargeCategory: "usage",
    billedCost: 0,
    effectiveCost: null,
    currency: rates.currency,
    tags,
    repo: project,
    workflow: null,
    model: null,
    importId: `${GITLAB_COST_SOURCE}:${account}:${month}`,
    consumedQuantity: 0,
    consumedUnit: "minute",
    priced: false,
  };
  return { line, seconds };
}

/**
 * The cost lines of one account's projects' jobs for `month` (`YYYY-MM`), up to `lastDay` (`YYYY-MM-DD`): one per
 * (day, project, runner), minutes summed unrounded, then priced once by the line's rate key.
 */
export function gitlabJobLines(
  account: string,
  month: string,
  projects: readonly GitlabProjectJobs[],
  rates: CostRates,
  lastDay = "9999-12-31",
): GitlabJobLinesResult {
  const dropped: Record<GitlabJobDropReason, number> = {
    no_runner: 0,
    unfinished: 0,
    bad_duration: 0,
    outside_month: 0,
  };
  const merged = new Map<string, { line: CostLine; seconds: number }>();
  let jobs = 0;
  for (const p of projects) {
    for (const raw of p.jobs) {
      jobs++;
      const r = parseJob(raw, p.projectFullPath, account, month, lastDay, rates);
      if (typeof r === "string") {
        dropped[r]++;
        continue;
      }
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
  return { lines, jobs, dropped };
}
