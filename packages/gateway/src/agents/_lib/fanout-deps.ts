import type { PeerFanoutDeps } from "../../federation/peer-fanout.ts";
import type { KnownNamespaceStore } from "../../index/known-namespace-store.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { sendFederatedOverWire } from "../../ipc/lan-client.ts";
import type { BoxKeypair } from "../../ipc/lan-crypto.ts";
import type { GapNote } from "./findings.ts";

/** Common federation context shared by the cross-colleague agents (ghost / conflicts / huddle). */
export type FanoutCtx = {
  index: LocalIndex;
  selfIdentity: BoxKeypair;
  store: KnownNamespaceStore;
  sendOverWire?: typeof sendFederatedOverWire;
  now?: () => number;
};

/**
 * Builds the `fanOutQuery`/`fanOutExpertise` dependency bundle from an agent context,
 * spreading the optional `sendOverWire`/`now` only when present (exactOptional-safe).
 */
export function buildFanoutDeps(ctx: FanoutCtx): PeerFanoutDeps {
  const deps: {
    index: LocalIndex;
    selfIdentity: BoxKeypair;
    store: KnownNamespaceStore;
    sendOverWire?: typeof sendFederatedOverWire;
    now?: () => number;
  } = {
    index: ctx.index,
    selfIdentity: ctx.selfIdentity,
    store: ctx.store,
  };
  if (ctx.sendOverWire !== undefined) deps.sendOverWire = ctx.sendOverWire;
  if (ctx.now !== undefined) deps.now = ctx.now;
  return deps;
}

/**
 * Pushes the two standard "no federation reach" gap notes when the agent has no
 * namespaces to query or no paired peers. Shared verbatim across the cross-colleague agents.
 */
export function pushFederationReachGaps(
  gaps: GapNote[],
  opts: { namespaceCount: number; peerCount: number },
): void {
  if (opts.namespaceCount === 0) {
    gaps.push({
      category: "missing_connector",
      detail: "no known namespaces — pass --namespace <name>",
    });
  }
  if (opts.peerCount === 0) {
    gaps.push({
      category: "missing_connector",
      detail: "no paired peers — run `nimbus team pair`",
    });
  }
}
