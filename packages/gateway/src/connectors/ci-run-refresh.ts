/**
 * CI writers skip any run at or below their cursor. A run first synced while still running would
 * therefore stay `conclusion: "running"` forever — and preflight would let that row hide an older
 * failure. A previously seen run is re-written only when its stored canonical conclusion is
 * `running` and the provider's EXISTING fetch returned it again; this never makes a request.
 * Runs normalised to `running` that never finish (GitLab `manual`/`scheduled`, GitHub
 * `waiting`/`requested`) are re-written on every sync while they stay in the fetched page: write
 * churn only, no extra request.
 */
import { itemPrimaryKey } from "../index/item-key.ts";
import type { SyncContext } from "../sync/types.ts";
import { asRecord } from "./unknown-record.ts";

export function storedRunIsUnfinished(
  itemMetadata: SyncContext["itemMetadata"],
  service: string,
  externalId: string,
): boolean {
  const json = itemMetadata(itemPrimaryKey(service, externalId));
  if (json === null) {
    return false;
  }
  try {
    return asRecord(JSON.parse(json) as unknown)?.["conclusion"] === "running";
  } catch {
    return false;
  }
}
