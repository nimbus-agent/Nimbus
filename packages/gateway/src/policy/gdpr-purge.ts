import type { GdprPurgeStore } from "./gdpr-purge-store.ts";

export interface PurgeDeps {
  readonly store: GdprPurgeStore;
  readonly resolvePeer: (externalId: string) => string | undefined;
  readonly revokeAllGrants: (peerId: string) => void;
  readonly deleteLocalContributions: (peerId: string) => number;
  readonly knownPeers: () => readonly string[];
  readonly newJobId: () => string;
  readonly nowMs: () => number;
}

export interface PurgeStartResult {
  jobId: string;
  localDeleted: number;
}

/**
 * Begin a GDPR purge: local revoke + delete now; remote requests durable + retried.
 *
 * Synchronous: every dep it calls is. An unknown user still fails CLOSED, as a throw — the
 * `team.purge` handler that reaches this through `PolicyRpcCtx.purge` is `async`, so its caller
 * sees the same rejection it did when this function was `async` too.
 */
export function startPurge(deps: PurgeDeps, externalId: string): PurgeStartResult {
  const peerId = deps.resolvePeer(externalId);
  if (peerId === undefined) throw new Error(`gdpr purge: unknown user ${externalId}`);
  deps.revokeAllGrants(peerId);
  const localDeleted = deps.deleteLocalContributions(peerId);
  const jobId = deps.newJobId();
  deps.store.openJob({ jobId, externalId, peers: deps.knownPeers(), openedAt: deps.nowMs() });
  return { jobId, localDeleted };
}
