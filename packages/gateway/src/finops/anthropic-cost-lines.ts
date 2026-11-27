// Phase 7 (the Cost Pack, slice 6): Anthropic's organization cost report as cost lines. Pure (static D48).
//
// Source: the legacy `GET /v1/organizations/cost_report` (owner ruling 2) with
// `group_by[]=workspace_id&group_by[]=description`, daily buckets — documentation-verified only. A page's
// `data[]` buckets carry `starting_at`/`ending_at` (RFC 3339) and `results[]` of `{ amount: <decimal string in
// lowest units, cents: "123.45" is $1.23>, currency: "USD", workspace_id (null = the default workspace),
// description, model (null for non-token costs), cost_type, token_type, service_tier, ... }`. Priority Tier
// costs are not in this report (the docs say so). One organization per admin key: the account is `"anthropic"`.
//
// The buckets of ALL a month's pages are mapped together, so rows of one day and grain are summed. A malformed
// row, a bucket outside the month or after `lastDay` is DROPPED and counted, never thrown.
import {
  type CostBucketVendor,
  type CostMapResult,
  costText,
  mapCostBuckets,
  nullableId,
} from "./cost-bucket-map.ts";
import type { CostLine } from "./cost-line.ts";

export const ANTHROPIC_COST_SOURCE = "anthropic_billing";
export const ANTHROPIC_COST_PROVIDER = "anthropic";
export const ANTHROPIC_COST_ACCOUNT = "anthropic";

const CENTS_RE = /^(-?)(\d{1,15})(?:\.(\d{1,12}))?$/;

const text = costText;

/**
 * A decimal string in cents as dollars, by moving the decimal point on the STRING (never `cents / 100`, which
 * adds floating-point noise): `"12345.678"` is `123.45678`, `"5"` is `0.05`, `"-0.5"` is `-0.005`. Null when the
 * value is not a plain decimal.
 */
export function centsToDollars(s: string): number | null {
  const m = CENTS_RE.exec(s.trim());
  if (m === null) return null;
  const [, sign = "", whole = "", frac = ""] = m;
  const padded = whole.padStart(3, "0");
  const dollars = `${padded.slice(0, -2)}.${padded.slice(-2)}${frac}`;
  const n = Number(`${sign}${dollars}`);
  return Number.isFinite(n) ? (Object.is(n, -0) ? 0 : n) : null;
}

/** The UTC day a bucket starts on, from its RFC 3339 `starting_at`, or null. */
function bucketDay(b: Record<string, unknown>): string | null {
  const s = b["starting_at"];
  if (typeof s !== "string") return null;
  const t = Date.parse(s);
  return Number.isFinite(t) ? new Date(t).toISOString().slice(0, 10) : null;
}

function lineOf(day: string, month: string, r: Record<string, unknown>): CostLine | null {
  const amount = typeof r["amount"] === "string" ? centsToDollars(r["amount"]) : null;
  const currency = text(r["currency"]);
  const description = text(r["description"]);
  if (amount === null || currency === null || description === null) return null;
  const workspace = nullableId(r["workspace_id"]);
  if (!workspace.ok) return null;
  const costType = text(r["cost_type"]);
  const tier = text(r["service_tier"]);
  return {
    source: ANTHROPIC_COST_SOURCE,
    provider: ANTHROPIC_COST_PROVIDER,
    billingAccountId: ANTHROPIC_COST_ACCOUNT,
    billingPeriod: month,
    chargeDay: day,
    subAccountId: workspace.value,
    subAccountName: null,
    serviceName: "anthropic",
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: description,
    chargeCategory: amount < 0 ? "credit" : "usage",
    billedCost: amount,
    effectiveCost: amount,
    currency: currency.toUpperCase(),
    // Constant per description, so they never split a grain.
    tags: {
      ...(costType === null ? {} : { cost_type: costType }),
      ...(tier === null ? {} : { service_tier: tier }),
    },
    repo: null,
    workflow: null,
    model: text(r["model"]),
    importId: `${ANTHROPIC_COST_SOURCE}:${ANTHROPIC_COST_ACCOUNT}:${month}`,
  };
}

const ANTHROPIC_VENDOR: CostBucketVendor = { dayOf: bucketDay, lineOf };

/** The cost lines of every bucket of one month (`YYYY-MM`), up to `lastDay` (`YYYY-MM-DD`). */
export function anthropicCostLines(
  buckets: readonly unknown[],
  month: string,
  lastDay = "9999-12-31",
): CostMapResult {
  return mapCostBuckets(ANTHROPIC_VENDOR, buckets, month, lastDay);
}
