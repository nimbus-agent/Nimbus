// deprovision.ts
import type { Database } from "bun:sqlite";
import { appendFederationAudit } from "../federation/federation-audit.ts";
import type { NamespaceStore } from "../federation/namespace-store.ts";
import type { IdentityStore } from "./identity-store.ts";

interface NsNameRow {
  name: string;
}

export interface DeprovisionCtx {
  readonly db: Database;
  readonly store: NamespaceStore;
  readonly identity: IdentityStore;
  readonly nowMs: number;
}

/**
 * Mark the SCIM user inactive, then revoke every active federation grant for every peer bound to
 * that identity. Returns the peer ids whose grants were revoked. Audited per (namespace, peer).
 *
 * ATOMIC (review P1): the whole cascade — scim_user.active, every NamespaceStore.revoke, each audit
 * append, and identity_binding.revoked_at — runs inside a single `db.transaction(...)`. If any write
 * throws mid-cascade the transaction rolls back, so a deprovision is all-or-nothing (never a partial
 * state where some grants are revoked and others survive). `db.transaction` is allowed by D12 (it
 * matches neither `db.run(` nor `db.exec(`); the inner mutations still route through `dbRun` (I14).
 */
export function deprovisionUser(ctx: DeprovisionCtx, externalId: string): string[] {
  const peerIds = ctx.identity.activePeerIdsFor(externalId);
  const namespaces = ctx.db
    .query<NsNameRow, []>(`SELECT name FROM federation_namespaces`)
    .all()
    .map((r) => r.name);
  ctx.db.transaction(() => {
    ctx.identity.setScimActive(externalId, false, ctx.nowMs);
    for (const peerId of peerIds) {
      for (const ns of namespaces) {
        if (ctx.store.getActiveGrant(ns, peerId) === undefined) continue;
        ctx.store.revoke(ns, peerId, ctx.nowMs);
        appendFederationAudit(ctx.db, {
          peerId,
          namespace: ns,
          purpose: `scim-deprovision:${externalId}`,
          decision: "no_grant",
          method: "federation.query",
          timestamp: ctx.nowMs,
        });
      }
      ctx.identity.revokeBinding(peerId, ctx.nowMs);
    }
  })();
  return peerIds;
}
