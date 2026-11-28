// Phase 7 (the Cost Pack, slice 8; owner rulings 2026-11-28): GitLab.com compute minutes as DAILY cost lines.
// Pure (static D48: no network, no connector, no model import).
//
// GitLab.com reports, per project, a MONTH-TO-DATE total of compute minutes (GraphQL
// `ciMinutesProjectMonthlyUsage`, `minutes`: the runner cost factor already applied; documentation-verified only).
// There is no per-day figure, so each daily sync stores the DELTA (owner ruling 6): today's month-to-date total
// minus what the month's earlier days already hold, on the observed day. A missed sync's minutes land on the next
// synced day. These minutes are "observed per day, not metered per day", and the docs say so.
//
// The intake replaces the whole month, so this returns the month's COMPLETE line set for the account: every stored
// line is re-supplied unchanged, except the observed day's (recomputed) and those a drop lowered. A drop (a
// restatement: the total fell below what earlier days hold) lowers the latest earlier days, walking back, never
// below 0, and is returned as a note. Lines are keyed by GitLab's stable project id (the path is the sub-account name
// and the `repo`), so a renamed project keeps its history. A stored project missing from the fetch (deleted, or moved
// out of the group) keeps its stored lines and gets no new one; one moved between two LISTED groups in a month is
// counted in both for that month (a stated bound).
// A second sync on the same day replaces that day's line (100 then 150
// is 150, never 250), because `earlier` counts only the days before the observed day.
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { type CostLine, setTag } from "./cost-line.ts";
import {
  COST_RATE_KEY_DEFAULT,
  COST_RATE_KEY_TAG,
  type CostRates,
  pricedFields,
  rateForKey,
} from "./cost-rate-price.ts";

export const GITLAB_COST_SOURCE = "gitlab_billing";
export const GITLAB_COST_PROVIDER = "gitlab";
export const GITLAB_COST_SERVICE = "GitLab CI";
export const GITLAB_COST_SKU = "compute_minutes";
export const GITLAB_DEPLOYMENT_TAG = "gitlab_deployment";

export interface GitlabProjectMinutes {
  /** GitLab's stable project id (GraphQL global id): the line's sub-account, so a rename never splits it. */
  readonly projectId: string;
  /** The project's path now: the sub-account name and the `repo`. */
  readonly projectFullPath: string;
  /** The project's month-to-date compute minutes. */
  readonly minutes: number;
}

export interface GitlabMinutesInput {
  /** The configured group path: the billing account. */
  readonly account: string;
  /** `YYYY-MM` */
  readonly month: string;
  /** The UTC day the totals were observed on: today, or the month's last day for a closed month. */
  readonly observedDay: string;
  readonly fetched: readonly GitlabProjectMinutes[];
  /** This source's stored lines of (provider, account, month). */
  readonly stored: readonly CostLine[];
  readonly rates: CostRates;
}

export interface GitlabMinutesResult {
  readonly lines: readonly CostLine[];
  /** Projects whose total fell below what earlier days hold, and by how much was lowered. */
  readonly restated: readonly { readonly project: string; readonly minutes: number }[];
}

/** The day a sync of `month` observes at `todayDay`: today in the current month, else the month's last day. */
export function gitlabObservedDay(month: string, todayDay: string): string {
  if (todayDay.slice(0, 7) === month) return todayDay;
  const [y, m] = month.split("-").map(Number);
  const last = new Date(Date.UTC(y ?? 1970, m ?? 1, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

function minutesLine(
  input: GitlabMinutesInput,
  project: { readonly id: string; readonly path: string },
  day: string,
  q: number,
): CostLine {
  const tags: Record<string, string> = {};
  setTag(tags, COST_RATE_KEY_TAG, COST_RATE_KEY_DEFAULT);
  setTag(tags, GITLAB_DEPLOYMENT_TAG, "gitlab.com");
  return {
    source: GITLAB_COST_SOURCE,
    provider: GITLAB_COST_PROVIDER,
    billingAccountId: input.account,
    billingPeriod: input.month,
    chargeDay: day,
    subAccountId: project.id,
    subAccountName: project.path,
    serviceName: GITLAB_COST_SERVICE,
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: GITLAB_COST_SKU,
    chargeCategory: "usage",
    ...pricedFields(q, rateForKey(input.rates, COST_RATE_KEY_DEFAULT)),
    currency: input.rates.currency,
    tags,
    repo: project.path,
    workflow: null,
    model: null,
    importId: `${GITLAB_COST_SOURCE}:${input.account}:${input.month}`,
    consumedQuantity: q,
    consumedUnit: "minute",
  };
}

/** Lower the latest earlier lines by `excess` minutes, never below 0; a line lowered to 0 is dropped. */
function walkBack(
  input: GitlabMinutesInput,
  earlier: readonly CostLine[],
  excess: number,
): CostLine[] {
  const sorted = [...earlier].sort((a, b) => codeUnitCompare(b.chargeDay, a.chargeDay));
  let left = excess;
  const out: CostLine[] = [];
  for (const l of sorted) {
    const q = l.consumedQuantity ?? 0;
    if (left <= 0 || q <= 0) {
      out.push(l);
      continue;
    }
    const lowered = Math.max(0, q - left);
    left -= q - lowered;
    if (lowered > 0) {
      out.push({
        ...l,
        ...pricedFields(lowered, rateForKey(input.rates, COST_RATE_KEY_DEFAULT)),
        currency: input.rates.currency,
        consumedQuantity: lowered,
      });
    }
  }
  return out;
}

/** The month's complete line set for the account (see the file header). */
export function gitlabMinutesLines(input: GitlabMinutesInput): GitlabMinutesResult {
  const storedBy = new Map<string, CostLine[]>();
  for (const l of input.stored) {
    const p = l.subAccountId ?? "";
    storedBy.set(p, [...(storedBy.get(p) ?? []), l]);
  }
  const fetchedBy = new Map<string, { path: string; minutes: number }>();
  for (const f of input.fetched) {
    const prior = fetchedBy.get(f.projectId)?.minutes ?? 0;
    fetchedBy.set(f.projectId, { path: f.projectFullPath, minutes: prior + f.minutes });
  }
  const lines: CostLine[] = [];
  const restated: { project: string; minutes: number }[] = [];
  for (const project of new Set([...storedBy.keys(), ...fetchedBy.keys()])) {
    const stored = storedBy.get(project) ?? [];
    const fetched = fetchedBy.get(project);
    if (fetched === undefined) {
      lines.push(...stored);
      continue;
    }
    const earlier = stored.filter((l) => l.chargeDay < input.observedDay);
    const later = stored.filter((l) => l.chargeDay > input.observedDay);
    const held = earlier.reduce((s, l) => s + (l.consumedQuantity ?? 0), 0);
    // Below a millionth of a minute a difference is float noise, never usage or a restatement.
    const raw = fetched.minutes - held;
    const delta = Math.abs(raw) < 1e-6 ? 0 : raw;
    lines.push(...later);
    if (delta >= 0) {
      lines.push(...earlier);
      if (delta > 0) {
        lines.push(
          minutesLine(input, { id: project, path: fetched.path }, input.observedDay, delta),
        );
      }
    } else {
      lines.push(...walkBack(input, earlier, -delta));
      restated.push({ project: fetched.path, minutes: -delta });
    }
  }
  return { lines, restated };
}
