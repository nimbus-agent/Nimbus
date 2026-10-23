import { describe, expect, test } from "bun:test";
import type { GatewayStatus } from "./render.ts";
import { elementsOf, textOf } from "./view-tree.ts";
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
  test("renderConnectors shows ids, blocked-by-policy, and keeps markup as text", () => {
    const tree = renderConnectors([
      ...base.connectors,
      { id: "<x>", enabled: true, blockedByPolicy: false, health: "ok" },
    ]);
    const text = textOf(tree);
    expect(text).toContain("github");
    expect(text).toContain("blocked by policy");
    expect(text).toContain("<x>");
    expect(elementsOf(tree).some((e) => (e.tag as string) === "x")).toBe(false);
    expect(elementsOf(tree).filter((e) => e.tag === "tr")).toHaveLength(4); // header + 3 rows
  });

  test("renderAudit shows lastHash as text and the chain length", () => {
    const tree = renderAudit(base.audit);
    expect(textOf(tree)).toContain("12");
    expect(textOf(tree)).toContain("last hash: <h>");
    expect(elementsOf(tree).some((e) => (e.tag as string) === "h")).toBe(false);
  });

  test("renderNamespaces lists names; empty => message", () => {
    expect(textOf(renderNamespaces(base.namespaces))).toContain("project:zurich");
    expect(textOf(renderNamespaces([]))).toMatch(/no shared namespaces/i);
  });

  test("renderUsers shows operator + externalId", () => {
    expect(textOf(renderUsers(base.identity))).toContain("alice@acme");
    expect(textOf(renderUsers(base.identity))).toContain("valid");
    const noExt = renderUsers({ operatorValid: false });
    expect(textOf(noExt)).toContain("invalid");
    expect(elementsOf(noExt).some((e) => e.tag === "code")).toBe(false);
  });

  test("renderPolicy read-only on peer; anchor gets an editor", () => {
    const peer = renderPolicy(base);
    expect(elementsOf(peer).some((e) => e.attrs.id === "policy-editor")).toBe(false);
    expect(textOf(peer)).toContain("read-only");
    expect(textOf(peer)).toContain("acme");
    const anchor = elementsOf(renderPolicy(base, { isAnchor: true }));
    expect(anchor.some((e) => e.tag === "textarea" && e.attrs.id === "policy-editor")).toBe(true);
    expect(anchor.some((e) => e.tag === "button" && e.attrs.id === "policy-save")).toBe(true);
  });
});
