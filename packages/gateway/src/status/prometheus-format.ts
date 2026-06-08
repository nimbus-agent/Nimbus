import type { GatewayStatus } from "./types.ts";

function esc(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** Render a GatewayStatus as Prometheus text exposition (v0.0.4). */
export function formatPrometheus(s: GatewayStatus): string {
  const L: string[] = [];
  const gauge = (name: string, help: string) => {
    L.push(`# HELP ${name} ${help}`, `# TYPE ${name} gauge`);
  };

  gauge("nimbus_policy_signature_valid", "1 if the active org policy signature is valid");
  L.push(`nimbus_policy_signature_valid ${s.policy.signatureValid ? 1 : 0}`);

  gauge("nimbus_peer_reachable", "1 if a federated peer is reachable");
  for (const p of s.peers)
    L.push(`nimbus_peer_reachable{peer="${esc(p.peerId)}"} ${p.reachable ? 1 : 0}`);

  gauge("nimbus_connector_enabled", "1 if a connector is enabled (not blocked by policy)");
  for (const c of s.connectors)
    L.push(
      `nimbus_connector_enabled{connector="${esc(c.id)}"} ${c.enabled && !c.blockedByPolicy ? 1 : 0}`,
    );

  gauge("nimbus_audit_chain_length", "number of entries in the local audit chain");
  L.push(`nimbus_audit_chain_length ${s.audit.chainLength}`);

  gauge("nimbus_hitl_pending", "pending HITL approvals + quorum requests");
  L.push(`nimbus_hitl_pending ${s.hitl.pendingApprovals + s.hitl.pendingQuorum}`);

  gauge("nimbus_sync_freshness_ms", "ms since the last successful sync");
  L.push(`nimbus_sync_freshness_ms ${s.syncFreshnessMs}`);

  return `${L.join("\n")}\n`;
}
