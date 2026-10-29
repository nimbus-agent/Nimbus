import type { ExtensionRow } from "../automation/extension-store.ts";
import type { ExtensionRunGrantRow } from "./run-grant-store.ts";
import { type TrustBlock, unacknowledged } from "./trust/trust-blocks.ts";

/**
 * `"pack"`: a starter pack, which has no code and never runs (it is never granted `extension.run`).
 * `"running"` means the lazy mesh holds a live client for the extension right now. `"blocked"`
 * (I48): a revocation or takedown applies that the run grant did not acknowledge.
 */
export type ExtensionRunState =
  | "pack"
  | "disabled"
  | "blocked"
  | "no_grant"
  | "grant_stale"
  | "running"
  | "ready";

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
 * `running` (the mesh's `isExtensionRunning`) is consulted LAST: a disabled, blocked, ungranted or
 * stale extension reports that even if a client the mesh has not torn down yet is still mapped.
 * `blocked` comes right after `disabled`: no approval state matters while a block is unacknowledged.
 * `pack` comes FIRST: a starter pack has no code, so no other state applies to it, and a code
 * extension that an update turned into a pack shows `pack`, never `grant_stale`.
 */
export function extensionRunState(
  row: Pick<ExtensionRow, "enabled" | "version" | "tree_digest" | "kind">,
  grant: ExtensionRunGrantRow | null,
  running = false,
  blocks: readonly TrustBlock[] = [],
): ExtensionRunState {
  if (row.kind === "starter-pack") return "pack";
  if (row.enabled !== 1) return "disabled";
  if (unacknowledged(blocks, grant?.trust_ack_json).length > 0) return "blocked";
  if (grant === null) return "no_grant";
  if (grant.version !== row.version || grant.tree_digest !== row.tree_digest) return "grant_stale";
  return running ? "running" : "ready";
}

export function extensionRunFields(
  row: ExtensionRow,
  grant: ExtensionRunGrantRow | null,
  running: boolean,
  blocks: readonly TrustBlock[] = [],
): {
  runGrant: ExtensionRunGrantSummary | null;
  runState: ExtensionRunState;
  /** The blocks the grant has not acknowledged (I48); `[]` when none. */
  blockedBy: TrustBlock[];
} {
  return {
    runGrant:
      grant === null
        ? null
        : {
            serviceId: grant.service_id,
            approvedAt: grant.approved_at,
            modelAccess: grant.model_access === 1,
          },
    runState: extensionRunState(row, grant, running, blocks),
    blockedBy: row.enabled === 1 ? unacknowledged(blocks, grant?.trust_ack_json) : [],
  };
}
