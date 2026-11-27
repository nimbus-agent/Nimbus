// Phase 7 (the Cost Pack, slice 6): Anthropic's organization cost report as cost lines (service
// `anthropic_billing`).
//
// The legacy, stable `GET https://api.anthropic.com/v1/organizations/cost_report` (owner ruling 2; the newer
// analytics endpoint is a beta) with the dedicated admin key `anthropic_billing.admin_key` (owner ruling 1) as
// `x-api-key`: daily buckets for the month, grouped by workspace and description (owner ruling 3), 31 buckets a
// page (the documented maximum), following `next_page`. It is not available to individual Console accounts, the
// claude.ai Team plan or Claude Platform on AWS, and it leaves out Priority Tier costs (the docs say so).
// Documentation-verified only. The shared syncable (`ai-cost-sync.ts`) does the rest.
import {
  ANTHROPIC_COST_ACCOUNT,
  ANTHROPIC_COST_PROVIDER,
  anthropicCostLines,
} from "../finops/anthropic-cost-lines.ts";
import { COST_SYNC_CURSOR_PREFIXES } from "../finops/cost-source-gaps.ts";
import type { Syncable } from "../sync/types.ts";
import {
  type AiCostSyncableOptions,
  type AiCostVendor,
  createAiCostSyncable,
} from "./ai-cost-sync.ts";

export const ANTHROPIC_COST_ORIGIN = "https://api.anthropic.com";
/** The API version the cost report is read with (a dated version the legacy report has always accepted). */
const ANTHROPIC_VERSION = "2023-06-01";

export const ANTHROPIC_COST_VENDOR: AiCostVendor = {
  serviceId: "anthropic_billing",
  limiter: "anthropic_billing",
  provider: ANTHROPIC_COST_PROVIDER,
  account: ANTHROPIC_COST_ACCOUNT,
  cursorPrefix: COST_SYNC_CURSOR_PREFIXES.anthropic_billing,
  headers: (key) => ({
    "x-api-key": key,
    "anthropic-version": ANTHROPIC_VERSION,
    Accept: "application/json",
  }),
  pageUrl: (month, endDay, page) => {
    const u = new URL(`${ANTHROPIC_COST_ORIGIN}/v1/organizations/cost_report`);
    u.searchParams.set("starting_at", `${month}-01T00:00:00Z`);
    u.searchParams.set("ending_at", `${endDay}T00:00:00Z`);
    u.searchParams.set("bucket_width", "1d");
    u.searchParams.set("limit", "31");
    u.searchParams.append("group_by[]", "workspace_id");
    u.searchParams.append("group_by[]", "description");
    if (page !== null) u.searchParams.set("page", page);
    return u.toString();
  },
  map: anthropicCostLines,
  gaps: {
    access:
      "Anthropic refused the key: it must be an Admin API key of a Claude Console organization (a workspace key cannot read costs)",
    missing:
      "Anthropic has no cost report for this key: it is not available to individual Console accounts, the claude.ai Team plan or Claude Platform on AWS",
    refused: "Anthropic refused the cost request (400 Bad Request)",
  },
};

export function createAnthropicCostSyncable(options: AiCostSyncableOptions = {}): Syncable {
  return createAiCostSyncable(ANTHROPIC_COST_VENDOR, options);
}
