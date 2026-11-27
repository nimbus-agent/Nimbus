// Phase 7 (the Cost Pack, slice 6): OpenAI's organization costs as cost lines (service `openai_billing`).
//
// `GET https://api.openai.com/v1/organization/costs` with the dedicated admin key `openai_billing.admin_key`
// (owner ruling 1) as a Bearer token: daily buckets for the month, grouped by project and line item (owner
// ruling 3), up to 180 buckets a page, following `next_page`. `group_by` is a repeated key, as OpenAI's own
// cookbook sends it. Documentation-verified only. The shared syncable (`ai-cost-sync.ts`) does the rest.

import { COST_SYNC_CURSOR_PREFIXES } from "../finops/cost-source-gaps.ts";
import {
  OPENAI_COST_ACCOUNT,
  OPENAI_COST_PROVIDER,
  openaiCostLines,
} from "../finops/openai-cost-lines.ts";
import type { Syncable } from "../sync/types.ts";
import {
  type AiCostSyncableOptions,
  type AiCostVendor,
  createAiCostSyncable,
} from "./ai-cost-sync.ts";

export const OPENAI_COST_ORIGIN = "https://api.openai.com";

const unixSeconds = (day: string): number => Date.parse(`${day}T00:00:00Z`) / 1000;

export const OPENAI_COST_VENDOR: AiCostVendor = {
  serviceId: "openai_billing",
  limiter: "openai_billing",
  provider: OPENAI_COST_PROVIDER,
  account: OPENAI_COST_ACCOUNT,
  cursorPrefix: COST_SYNC_CURSOR_PREFIXES.openai_billing,
  headers: (key) => ({ Authorization: `Bearer ${key}`, Accept: "application/json" }),
  pageUrl: (month, endDay, page) => {
    const u = new URL(`${OPENAI_COST_ORIGIN}/v1/organization/costs`);
    u.searchParams.set("start_time", String(unixSeconds(`${month}-01`)));
    u.searchParams.set("end_time", String(unixSeconds(endDay)));
    u.searchParams.set("bucket_width", "1d");
    u.searchParams.set("limit", "180");
    u.searchParams.append("group_by", "project_id");
    u.searchParams.append("group_by", "line_item");
    if (page !== null) u.searchParams.set("page", page);
    return u.toString();
  },
  map: openaiCostLines,
  gaps: {
    access:
      "OpenAI refused the key: it must be an organization admin key (an ordinary API key cannot read costs)",
    missing: "OpenAI has no cost report for this key's organization",
    refused: "OpenAI refused the cost request (400 Bad Request)",
  },
};

export function createOpenaiCostSyncable(options: AiCostSyncableOptions = {}): Syncable {
  return createAiCostSyncable(OPENAI_COST_VENDOR, options);
}
