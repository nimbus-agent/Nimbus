import { describe, expect, test } from "bun:test";
import { assembleStatusInputs, buildStatus, type StatusReaders } from "./admin-status-rpc.ts";

const readers: StatusReaders = {
  policyState: () => ({
    org: "acme",
    version: 1,
    signatureValid: true,
    pendingRestart: false,
    source: "peer",
  }),
  peers: () => [{ peerId: "peer:aa", reachable: true }],
  connectors: () => [{ id: "github", enabled: true, blockedByPolicy: false, health: "ok" }],
  namespaces: () => [],
  audit: () => ({ chainLength: 1, lastHash: "h", appendRate1h: 0 }),
  hitl: () => ({ pendingApprovals: 0, pendingQuorum: 0 }),
  identity: () => ({ operatorValid: true }),
  syncFreshnessMs: () => 0,
};

describe("assembleStatusInputs / buildStatus", () => {
  test("pulls each field from its reader", () => {
    const i = assembleStatusInputs(readers);
    expect(i.policy.org).toBe("acme");
    expect(i.peers[0]?.peerId).toBe("peer:aa");
  });
  test("buildStatus produces a GatewayStatus", () => {
    const s = buildStatus(readers);
    expect(s.connectors[0]?.id).toBe("github");
    expect(s.audit.chainLength).toBe(1);
  });
});
