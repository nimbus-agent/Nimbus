import type { ExtensionRow } from "../automation/extension-store.ts";
import type { ExtensionRunGrantRow } from "./run-grant-store.ts";

/** `"running"` means the lazy mesh holds a live client for the extension right now. */
export type ExtensionRunState = "disabled" | "no_grant" | "grant_stale" | "running" | "ready";

export type ExtensionRunGrantSummary = {
  serviceId: string;
  approvedAt: number;
  modelAccess: boolean;
};

/**
 * Compares the row to the grant only — no re-hashing, so `extension list` stays cheap. A grant for
 * a different version or tree digest is stale: the owner approved other code. The runtime
 * additionally re-verifies the live bytes before every spawn.
 *
 * `running` (the mesh's `isExtensionRunning`) is consulted LAST: a disabled, ungranted or stale
 * extension reports that even if a client the mesh has not torn down yet is still mapped.
 */
export function extensionRunState(
  row: Pick<ExtensionRow, "enabled" | "version" | "tree_digest">,
  grant: ExtensionRunGrantRow | null,
  running = false,
): ExtensionRunState {
  if (row.enabled !== 1) return "disabled";
  if (grant === null) return "no_grant";
  if (grant.version !== row.version || grant.tree_digest !== row.tree_digest) return "grant_stale";
  return running ? "running" : "ready";
}

export function extensionRunFields(
  row: ExtensionRow,
  grant: ExtensionRunGrantRow | null,
  running: boolean,
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
    runState: extensionRunState(row, grant, running),
  };
}
