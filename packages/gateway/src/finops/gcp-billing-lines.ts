// Phase 7 (the Cost Pack, slice 13; owner ruling D6): Google Cloud Billing export rows (BigQuery, the standard or
// detailed export) as DAILY cost lines. Pure (static D48: no network, no connector, no model import).
//
// One row is one (day, billing account, project, service, SKU, region, currency, unit, cost type, labels) group
// that the sync's query already summed: `cost`, the SUM of the row's `credits[].amount` (negative: a discount or a
// free-tier credit) and `usage.amount`. The line's `billedCost` and `effectiveCost` are `cost + credits`. Columns
// are read by NAME, never by position. A row that cannot be read (no day, no account, a day outside the month, a
// non-finite amount) is counted, and the caller keeps the month as stored: money is never guessed.
import { type CostChargeCategory, type CostLine, measureUnit, setTag } from "./cost-line.ts";

export const GCP_BILLING_SOURCE = "gcp_billing";
export const GCP_COST_PROVIDER = "gcp";

/** The columns the sync's query selects (its aliases); a reply without all of them is not read. */
export const GCP_ROW_COLUMNS = [
  "usage_day",
  "account_key",
  "project_key",
  "project_label",
  "service_name",
  "sku_key",
  "sku_name",
  "region_key",
  "currency_code",
  "unit_name",
  "cost_kind",
  "labels_json",
  "cost_sum",
  "credits_sum",
  "quantity_sum",
] as const;
export type GcpRowColumn = (typeof GCP_ROW_COLUMNS)[number];
export type GcpRawRow = Readonly<Record<GcpRowColumn, string | null>>;

export interface GcpBillingLinesResult {
  readonly lines: CostLine[];
  /** Rows that could not be read; non-zero means the month must not be written. */
  readonly unreadable: number;
}

const DAY_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/** The export's `cost_type` as a FOCUS charge category (anything unknown is `usage`). */
function categoryOf(costType: string | null): CostChargeCategory {
  switch (costType) {
    case "tax":
      return "tax";
    case "adjustment":
    case "rounding_error":
      return "adjustment";
    default:
      return "usage";
  }
}

function amount(v: string | null): number | null {
  if (v === null || v.trim() === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** The labels JSON (`[{"key":..,"value":..}]`) as tags; null when it is not that shape. */
function labelTags(json: string | null): Record<string, string> | null {
  const tags: Record<string, string> = {};
  if (json === null || json === "") return tags;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  for (const e of parsed as unknown[]) {
    if (typeof e !== "object" || e === null) return null;
    const { key, value } = e as { key?: unknown; value?: unknown };
    if (typeof key !== "string" || key === "") return null;
    setTag(tags, key, typeof value === "string" ? value : "");
  }
  return tags;
}

function oneLine(r: GcpRawRow, month: string): CostLine | null {
  const day = r.usage_day;
  const account = r.account_key?.trim() ?? "";
  const currency = r.currency_code?.trim() ?? "";
  if (day === null || !DAY_RE.test(day) || !day.startsWith(month)) return null;
  if (account === "" || currency === "") return null;
  const cost = amount(r.cost_sum);
  const credits = r.credits_sum === null ? 0 : amount(r.credits_sum);
  const tags = labelTags(r.labels_json);
  if (cost === null || credits === null || tags === null) return null;
  const qty = amount(r.quantity_sum);
  const net = cost + credits;
  const project = r.project_key?.trim() ?? "";
  return {
    source: GCP_BILLING_SOURCE,
    provider: GCP_COST_PROVIDER,
    billingAccountId: account,
    billingPeriod: month,
    chargeDay: day,
    subAccountId: project === "" ? null : project,
    subAccountName: r.project_label?.trim() || null,
    serviceName: r.service_name?.trim() || "Unknown service",
    serviceCategory: null,
    regionId: r.region_key?.trim() || null,
    resourceId: null,
    resourceName: null,
    skuId: r.sku_key?.trim() || r.sku_name?.trim() || null,
    chargeCategory: categoryOf(r.cost_kind),
    billedCost: net,
    effectiveCost: net,
    currency,
    tags,
    repo: null,
    workflow: null,
    model: null,
    importId: `${GCP_BILLING_SOURCE}:${account}:${month}`,
    consumedQuantity: qty,
    consumedUnit: qty === null ? null : measureUnit(r.unit_name),
  };
}

/** Every readable row of `month` as a line, and the count of rows that were not readable. */
export function gcpBillingLines(rows: readonly GcpRawRow[], month: string): GcpBillingLinesResult {
  const lines: CostLine[] = [];
  let unreadable = 0;
  for (const r of rows) {
    const l = oneLine(r, month);
    if (l === null) unreadable++;
    else lines.push(l);
  }
  return { lines, unreadable };
}
