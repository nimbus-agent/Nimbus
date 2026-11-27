// Phase 7 (the Cost Pack, slice 5): GitHub's billing usage report as cost lines. Pure (static D48: no network,
// no connector, no model import).
//
// Source: `GET /organizations/{org}/settings/billing/usage` — documentation-verified only (no live response was
// seen when this was written): `usageItems[]` of `date`, `product`, `sku`, `quantity`, `unitType`,
// `pricePerUnit`, `grossAmount`, `discountAmount`, `netAmount`, `organizationName` and an optional
// `repositoryName`. There is no workflow field and no currency field (GitHub bills in US dollars).
//
// One line per (day, product, SKU, repository): rows of the same grain are summed, so the stored unique key
// (`cost_line_grain`) never collides. A row that is malformed, outside the requested month, or names another
// organization is DROPPED and counted, never thrown: one odd row must not stop a month's sync. The
// organization comes from the request, never from `organizationName`.
import { type CostLine, costLineGrainHash } from "./cost-line.ts";

export const GITHUB_BILLING_SOURCE = "github_billing";
export const GITHUB_BILLING_PROVIDER = "github";

export type GithubBillingDropReason = "malformed" | "outside_month" | "other_org";

export interface GithubBillingMapResult {
  readonly lines: readonly CostLine[];
  readonly dropped: Readonly<Record<GithubBillingDropReason, number>>;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;
const MAX_TEXT = 256;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const text = (v: unknown): string | null =>
  typeof v === "string" && v.length > 0 && v.length <= MAX_TEXT ? v : null;

const finite = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;

/** The UTC day of an ISO date or date-time (`2026-11-20` or `2026-11-20T00:00:00Z`), or null. */
function utcDay(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const m = DAY_RE.exec(v);
  if (m === null) return null;
  // A date, or a date-time with no zone, is the date as written (never read in the machine's zone).
  if (v.length === 10 || !/(?:Z|[+-]\d{2}:?\d{2})$/i.test(v)) {
    const d = v.slice(0, 10);
    return Number.isFinite(Date.parse(`${d}T00:00:00Z`)) ? d : null;
  }
  const t = Date.parse(v);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

type Parsed = { day: string; line: CostLine };

function parseItem(
  raw: unknown,
  org: string,
  month: string,
  lastDay: string,
): Parsed | GithubBillingDropReason {
  if (!isRecord(raw)) return "malformed";
  const day = utcDay(raw["date"]);
  const product = text(raw["product"]);
  const sku = text(raw["sku"]);
  const net = finite(raw["netAmount"]);
  const unit = text(raw["unitType"]);
  if (day === null || product === null || sku === null || net === null) return "malformed";
  const named = raw["organizationName"];
  if (typeof named === "string" && named.toLowerCase() !== org) return "other_org";
  if (day.slice(0, 7) !== month || day > lastDay) return "outside_month";
  const repo = raw["repositoryName"];
  const line: CostLine = {
    source: GITHUB_BILLING_SOURCE,
    provider: GITHUB_BILLING_PROVIDER,
    billingAccountId: org,
    billingPeriod: month,
    chargeDay: day,
    subAccountId: null,
    subAccountName: null,
    serviceName: product,
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: sku,
    chargeCategory: "usage",
    billedCost: net,
    effectiveCost: net,
    currency: "USD",
    // Only values constant per SKU: a tag is part of the grain, so a per-row value would split it.
    tags: unit === null ? {} : { unit_type: unit },
    repo: text(repo),
    workflow: null,
    model: null,
    importId: `${GITHUB_BILLING_SOURCE}:${org}:${month}`,
  };
  return { day, line };
}

/**
 * The cost lines of one organization's usage report for `month` (`YYYY-MM`). A row dated after `lastDay`
 * (`YYYY-MM-DD`, default: no limit) is dropped as outside the month: the sync replaces days up to today only.
 */
export function githubBillingLines(
  org: string,
  month: string,
  usageItems: unknown,
  lastDay = "9999-12-31",
): GithubBillingMapResult {
  const account = org.toLowerCase();
  const dropped: Record<GithubBillingDropReason, number> = {
    malformed: 0,
    outside_month: 0,
    other_org: 0,
  };
  const merged = new Map<string, CostLine>();
  for (const raw of Array.isArray(usageItems) ? (usageItems as unknown[]) : []) {
    const p = parseItem(raw, account, month, lastDay);
    if (typeof p === "string") {
      dropped[p]++;
      continue;
    }
    const key = `${p.day}|${costLineGrainHash(p.line)}`;
    const prior = merged.get(key);
    merged.set(
      key,
      prior === undefined
        ? p.line
        : {
            ...prior,
            billedCost: prior.billedCost + p.line.billedCost,
            effectiveCost: (prior.effectiveCost ?? 0) + (p.line.effectiveCost ?? 0),
          },
    );
  }
  return { lines: [...merged.values()], dropped };
}
