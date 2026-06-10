import type { LocalIndex } from "../index/local-index.ts";
import { sendFederatedOverWire } from "../ipc/lan-client.ts";
import type { BoxKeypair } from "../ipc/lan-crypto.ts";
import type { RemoteApprovalOutcome } from "./delegated-approval.ts";
import type { DelegationStore } from "./delegation-store.ts";

export interface DelegatedRequestRemoteDeps {
  readonly store: DelegationStore;
  readonly index: LocalIndex;
  readonly selfIdentity: BoxKeypair;
  readonly now?: () => number;
  readonly sendOverWire?: typeof sendFederatedOverWire;
}

/**
 * Build the owner-side `requestRemote` the executor gate uses (I20): for a HITL action it looks up
 * the active in-scope delegate, finds that peer's paired LAN address, and asks them to approve OVER
 * THE WIRE via `federation.requestApproval`. The responding peer id is the delegate's (so the gate's
 * own active-delegate + identity checks decide whether to honor it). No active delegate, no paired
 * address, or any wire error resolves to `{ kind: "timeout" }` → the gate falls back to the local
 * owner prompt (D10). The wire is never trusted to grant the approval on its own.
 */
export function buildDelegatedRequestRemote(
  deps: DelegatedRequestRemoteDeps,
): (actionType: string) => Promise<RemoteApprovalOutcome> {
  return async (actionType: string): Promise<RemoteApprovalOutcome> => {
    const now = (deps.now ?? Date.now)();
    const service = actionType.split(".")[0] ?? "";
    const delegate = deps.store.activeDelegateePeer(actionType, service, now);
    if (delegate === undefined) return { kind: "timeout" };
    const row = deps.index.listLanPeers().find((r) => r.peer_id === delegate);
    if (row?.host_ip == null || row.host_port === null) {
      return { kind: "timeout" };
    }
    try {
      const send = deps.sendOverWire ?? sendFederatedOverWire;
      const res = (await send(
        row.host_ip,
        row.host_port,
        deps.selfIdentity,
        row.peer_pubkey,
        "federation.requestApproval",
        { actionType },
      )) as { approved?: unknown } | null;
      const approved = res?.approved;
      return typeof approved === "boolean"
        ? { kind: "answered", peerId: delegate, approved }
        : { kind: "timeout" };
    } catch {
      return { kind: "timeout" };
    }
  };
}
