import { describe, expect, test } from "bun:test";
import { buildGatewayStatus, type StatusInputs } from "./gateway-status.ts";

const inputs: StatusInputs = {
  policy: { org: "acme", version: 1, signatureValid: true, pendingRestart: false, source: "peer" },
  peers: [{ peerId: "peer:aa", reachable: true, lastSeenMs: 100 }],
  connectors: [
    { id: "github", enabled: true, blockedByPolicy: false, health: "ok", lastSyncMs: 50 },
  ],
  namespaces: [{ name: "project:zurich", subscribers: 2, lastPropagateMs: 10 }],
  audit: { chainLength: 8431, lastHash: "ab", appendRate1h: 12 },
  hitl: { pendingApprovals: 2, pendingQuorum: 1 },
  identity: { operatorValid: true, externalId: "alice@acme" },
  syncFreshnessMs: 30000,
};

describe("buildGatewayStatus", () => {
  test("assembles the snapshot verbatim from inputs", () => {
    const s = buildGatewayStatus(inputs);
    expect(s.policy.org).toBe("acme");
    expect(s.connectors[0]?.blockedByPolicy).toBe(false);
    expect(s.audit.chainLength).toBe(8431);
    expect(s.hitl.pendingApprovals).toBe(2);
    expect(s.peers[0]?.peerId).toBe("peer:aa");
    expect(s.identity.externalId).toBe("alice@acme");
    expect(s.syncFreshnessMs).toBe(30000);
  });
});
