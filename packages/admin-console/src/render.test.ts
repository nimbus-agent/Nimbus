import { describe, expect, test } from "bun:test";
import type { GatewayStatus } from "./render.ts";
import { renderOverview, renderPolicyBanner } from "./render.ts";

const status: GatewayStatus = {
  policy: { org: "acme", version: 1, signatureValid: true, pendingRestart: false, source: "peer" },
  peers: [{ peerId: "peer:aa", reachable: true }],
  connectors: [
    { id: "github", enabled: true, blockedByPolicy: false, health: "ok" },
    { id: "slack", enabled: false, blockedByPolicy: true, health: "ok" },
  ],
  namespaces: [],
  audit: { chainLength: 9, lastHash: "h", appendRate1h: 1 },
  hitl: { pendingApprovals: 2, pendingQuorum: 0 },
  identity: { operatorValid: true },
  syncFreshnessMs: 30000,
};

describe("render", () => {
  test("overview shows peer + connector-blocked counts and escapes text", () => {
    const html = renderOverview(status);
    expect(html).toContain("1/1"); // peers reachable
    expect(html).toContain("1 blocked"); // slack blocked by policy
    expect(html).toContain("2"); // hitl pending
  });
  test("policy banner flags ungoverned", () => {
    expect(
      renderPolicyBanner({ ...status.policy, source: "none", signatureValid: false }),
    ).toContain("ungoverned");
    expect(renderPolicyBanner(status.policy)).toContain("acme");
  });
  test("esc escapes HTML special chars (XSS-safety)", () => {
    const html = renderOverview({ ...status, peers: [{ peerId: "<script>", reachable: true }] });
    expect(html).not.toContain("<script>");
  });
});
