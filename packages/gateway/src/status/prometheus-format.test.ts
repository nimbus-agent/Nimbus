import { describe, expect, test } from "bun:test";
import { formatPrometheus } from "./prometheus-format.ts";
import type { GatewayStatus } from "./types.ts";

const status: GatewayStatus = {
  policy: { org: "acme", version: 1, signatureValid: true, pendingRestart: false, source: "peer" },
  peers: [
    { peerId: "peer:aa", reachable: true },
    { peerId: "peer:bb", reachable: false },
  ],
  connectors: [{ id: "github", enabled: true, blockedByPolicy: false, health: "ok" }],
  namespaces: [],
  audit: { chainLength: 42, lastHash: "x", appendRate1h: 3 },
  hitl: { pendingApprovals: 2, pendingQuorum: 1 },
  identity: { operatorValid: true },
  syncFreshnessMs: 1000,
};

describe("formatPrometheus", () => {
  test("emits HELP/TYPE + labeled samples", () => {
    const out = formatPrometheus(status);
    expect(out).toContain("# TYPE nimbus_policy_signature_valid gauge");
    expect(out).toContain("nimbus_policy_signature_valid 1");
    expect(out).toContain('nimbus_peer_reachable{peer="peer:aa"} 1');
    expect(out).toContain('nimbus_peer_reachable{peer="peer:bb"} 0');
    expect(out).toContain("nimbus_audit_chain_length 42");
    expect(out).toContain("nimbus_hitl_pending 3"); // approvals + quorum
    expect(out.endsWith("\n")).toBe(true);
  });

  test("escapes label values with backslashes and quotes", () => {
    const s: GatewayStatus = { ...status, peers: [{ peerId: 'pe"er\\x', reachable: true }] };
    const out = formatPrometheus(s);
    expect(out).toContain('nimbus_peer_reachable{peer="pe\\"er\\\\x"} 1');
  });

  test("escapes newlines in label values", () => {
    const s: GatewayStatus = { ...status, peers: [{ peerId: "pe\ner", reachable: true }] };
    const out = formatPrometheus(s);
    expect(out).toContain('nimbus_peer_reachable{peer="pe\\ner"} 1');
    // the metric line must not be split by the raw newline:
    expect(
      out.split("\n").some((line) => line.startsWith('nimbus_peer_reachable{peer="pe\\ner"}')),
    ).toBe(true);
  });
});
