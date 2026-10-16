import type { ExtensionRow } from "../automation/extension-store.ts";
import type { ExtensionRunGrantRow } from "./run-grant-store.ts";

/** PR 2's states. `"running"` joins with the runtime (extension-runtime PR 3). */
export type ExtensionRunState = "disabled" | "no_grant" | "grant_stale" | "ready";

export type ExtensionRunGrantSummary = {
  serviceId: string;
  approvedAt: number;
  modelAccess: boolean;
};

/**
 * Compares the row to the grant only — no re-hashing, so `extension list` stays cheap. A grant for
 * a different version or tree digest is stale: the owner approved other code. The runtime (PR 3)
 * additionally re-verifies the live bytes before every spawn.
 */
export function extensionRunState(
  row: Pick<ExtensionRow, "enabled" | "version" | "tree_digest">,
  grant: ExtensionRunGrantRow | null,
): ExtensionRunState {
  if (row.enabled !== 1) return "disabled";
  if (grant === null) return "no_grant";
  if (grant.version !== row.version || grant.tree_digest !== row.tree_digest) return "grant_stale";
  return "ready";
}

export function extensionRunFields(
  row: ExtensionRow,
  grant: ExtensionRunGrantRow | null,
): { runGrant: ExtensionRunGrantSummary | null; runState: ExtensionRunState } {
  return {
    runGrant:
      grant === null
        ? null
        : {
            serviceId: grant.service_id,
            approvedAt: grant.approved_at,
            modelAccess: grant.model_access === 1,
          },
    runState: extensionRunState(row, grant),
  };
}
