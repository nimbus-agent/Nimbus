import type { Database } from "bun:sqlite";
import { CONNECTOR_SERVICE_IDS } from "../../connectors/connector-catalog.ts";
import { getAllConnectorHealth } from "../../connectors/health.ts";
import { delegatedApprovalBroker } from "../../engine/delegated-approval-broker.ts";
import type { buildIdentityBoot } from "../../identity/identity-boot.ts";
import { isOperatorValid } from "../../identity/verifier.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { StatusReaders } from "../../ipc/admin-status-rpc.ts";
import type { PolicyGate } from "../../policy/policy-gate.ts";

/**
 * Build the observability snapshot readers (Task 15). Each accessor is cheap + synchronous so the
 * snapshot can be assembled on every admin.status / GET /v1/admin/status / GET /metrics call.
 *
 * REAL: policyState (policyGate.status), connectors (CONNECTOR_SERVICE_IDS × isConnectorAllowed +
 * live mesh health), audit (audit_log COUNT + latest row_hash + 1h append rate), hitl.pendingApprovals
 * (delegatedApprovalBroker), peers (localIndex.listLanPeers), identity.operatorValid (isOperatorValid
 * when identity wired).
 * STUBBED: hitl.pendingQuorum = 0 (quorumCoordinator has no public pending-count accessor),
 * namespaces = [] (no cheap subscriber-count accessor), syncFreshnessMs derived best-effort from the
 * most-recent connector lastSuccessfulSync (0 when none).
 */
export function buildStatusReaders(deps: {
  db: Database;
  policyGate: PolicyGate;
  localIndex: LocalIndex;
  isConnectorAllowed: (serviceId: string) => boolean;
  identityBoot?: ReturnType<typeof buildIdentityBoot>;
}): StatusReaders {
  const { db, policyGate, localIndex, isConnectorAllowed, identityBoot } = deps;
  return {
    policyState: () => policyGate.status(),
    peers: () =>
      localIndex.listLanPeers().map((p) => ({
        peerId: p.peer_id,
        reachable: p.last_seen_at !== null,
        ...(p.last_seen_at === null ? {} : { lastSeenMs: Date.parse(p.last_seen_at) }),
      })),
    connectors: () => {
      const health = new Map(getAllConnectorHealth(db).map((h) => [h.connectorId, h]));
      return [...CONNECTOR_SERVICE_IDS].map((id) => {
        const allowed = isConnectorAllowed(id);
        return {
          id,
          enabled: allowed,
          blockedByPolicy: !allowed,
          health: health.get(id)?.state ?? "unknown",
        };
      });
    },
    namespaces: () => [], // STUB: no cheap subscriber-count accessor on NamespaceStore.
    audit: () => {
      const total = db.query(`SELECT COUNT(*) AS n FROM audit_log`).get() as { n: number } | null;
      const last = db.query(`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`).get() as {
        row_hash: string | null;
      } | null;
      const since = Date.now() - 3_600_000;
      const rate = db
        .query(`SELECT COUNT(*) AS n FROM audit_log WHERE timestamp >= ?`)
        .get(since) as { n: number } | null;
      return {
        chainLength: total?.n ?? 0,
        lastHash: last?.row_hash ?? "",
        appendRate1h: rate?.n ?? 0,
      };
    },
    hitl: () => ({
      pendingApprovals: delegatedApprovalBroker.listPending().length,
      pendingQuorum: 0, // STUB: quorumCoordinator exposes no public pending-count accessor.
    }),
    identity: () => {
      const store = identityBoot?.store;
      const issuer = identityBoot?.issuer;
      if (store === undefined || issuer === undefined) return { operatorValid: true };
      return {
        operatorValid: isOperatorValid(store, issuer, Date.now(), identityBoot?.graceSeconds ?? 0),
      };
    },
    syncFreshnessMs: () => {
      let newest = 0;
      for (const h of getAllConnectorHealth(db)) {
        const t = h.lastSuccessfulSync?.getTime() ?? 0;
        if (t > newest) newest = t;
      }
      return newest === 0 ? 0 : Math.max(0, Date.now() - newest);
    },
  };
}
