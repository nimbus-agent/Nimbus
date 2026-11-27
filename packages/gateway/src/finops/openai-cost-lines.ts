// Phase 7 (the Cost Pack, slice 6): OpenAI's organization costs as cost lines. Pure (static D48: no network, no
// connector, no model import).
//
// Source: `GET /v1/organization/costs` with `group_by[]=project_id&group_by[]=line_item`, daily buckets —
// documentation-verified only (no live response was seen): a page's `data[]` buckets carry `start_time` (Unix
// seconds) and `results[]` of `{ amount: { value: <number>, currency: "usd" }, line_item, project_id,
// quantity, quantity_unit, ... }`. The API names no organization (one per admin key), so the account is the fixed
// `"openai"`. Owner ruling 3: the grain is the model and the project; no per-key or per-user rows.
//
// The buckets of ALL a month's pages are mapped together, so rows of one day and grain on two pages are summed
// (the `cost_line_grain` unique index). A malformed row, a bucket outside the month or after `lastDay` is
// DROPPED and counted, never thrown.
import {
  type CostBucketVendor,
  type CostMapResult,
  costText,
  isRecord,
  mapCostBuckets,
  nullableId,
} from "./cost-bucket-map.ts";
import type { CostLine } from "./cost-line.ts";

export type { CostDropReason, CostMapResult } from "./cost-bucket-map.ts";

export const OPENAI_COST_SOURCE = "openai_billing";
export const OPENAI_COST_PROVIDER = "openai";
export const OPENAI_COST_ACCOUNT = "openai";

const MAX_TEXT = 256;
/** `line_item` prefixes that name a cost kind before the model (`fine-tuning, <model>, training`). */
const NON_MODEL_PREFIXES: ReadonlySet<string> = new Set(["fine-tuning"]);

const text = costText;

/** The model a `line_item` names: the first comma-separated part, or the second after a cost-kind prefix. */
export function openaiLineItemModel(lineItem: string): string | null {
  const parts = lineItem.split(", ").map((p) => p.trim());
  const first = parts[0] ?? "";
  const model = NON_MODEL_PREFIXES.has(first) ? (parts[1] ?? "") : first;
  return model === "" || model.length > MAX_TEXT ? null : model;
}

function lineOf(day: string, month: string, r: Record<string, unknown>): CostLine | null {
  const amount = isRecord(r["amount"]) ? r["amount"] : null;
  const value = amount?.["value"];
  const currency = text(amount?.["currency"]);
  const lineItem = text(r["line_item"]);
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    currency === null ||
    lineItem === null
  ) {
    return null;
  }
  const project = nullableId(r["project_id"]);
  if (!project.ok) return null;
  const unit = text(r["quantity_unit"]);
  return {
    source: OPENAI_COST_SOURCE,
    provider: OPENAI_COST_PROVIDER,
    billingAccountId: OPENAI_COST_ACCOUNT,
    billingPeriod: month,
    chargeDay: day,
    subAccountId: project.value,
    subAccountName: null,
    serviceName: "openai",
    serviceCategory: null,
    regionId: null,
    resourceId: null,
    resourceName: null,
    skuId: lineItem,
    chargeCategory: value < 0 ? "credit" : "usage",
    billedCost: value,
    effectiveCost: value,
    currency: currency.toUpperCase(),
    tags: unit === null ? {} : { unit },
    repo: null,
    workflow: null,
    model: openaiLineItemModel(lineItem),
    importId: `${OPENAI_COST_SOURCE}:${OPENAI_COST_ACCOUNT}:${month}`,
  };
}

/** The UTC day a bucket starts on, from its Unix-seconds `start_time`, or null. */
function bucketDay(b: Record<string, unknown>): string | null {
  const t = b["start_time"];
  if (typeof t !== "number" || !Number.isFinite(t)) return null;
  return new Date(t * 1000).toISOString().slice(0, 10);
}

const OPENAI_VENDOR: CostBucketVendor = { dayOf: bucketDay, lineOf };

/** The cost lines of every bucket of one month (`YYYY-MM`), up to `lastDay` (`YYYY-MM-DD`). */
export function openaiCostLines(
  buckets: readonly unknown[],
  month: string,
  lastDay = "9999-12-31",
): CostMapResult {
  return mapCostBuckets(OPENAI_VENDOR, buckets, month, lastDay);
}
