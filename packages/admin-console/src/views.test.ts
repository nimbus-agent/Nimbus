import { describe, expect, test } from "bun:test";
import type { GatewayStatus } from "./render.ts";
import {
  renderAudit,
  renderConnectors,
  renderNamespaces,
  renderPolicy,
  renderUsers,
} from "./views.ts";

const base: GatewayStatus = {
  policy: { org: "acme", version: 2, signatureValid: true, pendingRestart: false, source: "peer" },
  peers: [],
  connectors: [
    { id: "github", enabled: true, blockedByPolicy: false, health: "ok" },
    { id: "slack", enabled: false, blockedByPolicy: true, health: "ok" },
  ],
  namespaces: [{ name: "project:zurich", subscribers: 3 }],
  audit: { chainLength: 12, lastHash: "<h>", appendRate1h: 4 },
  hitl: { pendingApprovals: 0, pendingQuorum: 0 },
  identity: { operatorValid: true, externalId: "alice@acme" },
  syncFreshnessMs: 1000,
};

describe("views", () => {
  test("renderConnectors shows ids, blocked-by-policy, and escapes", () => {
    const h = renderConnectors([
      ...base.connectors,
      { id: "<x>", enabled: true, blockedByPolicy: false, health: "ok" },
    ]);
    expect(h).toContain("github");
    expect(h).toContain("blocked by policy");
    expect(h).not.toContain("<x>"); // escaped
    expect(h).toContain("&lt;x&gt;");
  });

  test("renderAudit escapes lastHash and shows chain length", () => {
    const h = renderAudit(base.audit);
    expect(h).toContain("12");
    expect(h).not.toContain("<h>"); // escaped to &lt;h&gt;
    expect(h).toContain("&lt;h&gt;");
  });

  test("renderNamespaces lists names; empty => message", () => {
    expect(renderNamespaces(base.namespaces)).toContain("project:zurich");
    expect(renderNamespaces([])).toMatch(/no shared namespaces/i);
  });

  test("renderUsers shows operator + escaped externalId", () => {
    const h = renderUsers(base.identity);
    expect(h).toContain("alice@acme");
    expect(h).toContain("valid");
    expect(renderUsers({ operatorValid: false })).toContain("invalid");
  });

  test("renderPolicy read-only on peer; anchor gets an editor", () => {
    const peer = renderPolicy(base);
    expect(peer).not.toContain("policy-editor");
    expect(peer).toContain("read-only");
    expect(peer).toContain("acme");
    expect(renderPolicy(base, { isAnchor: true })).toContain("policy-editor");
  });
});
