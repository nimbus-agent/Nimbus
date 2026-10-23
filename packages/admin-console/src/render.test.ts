import { describe, expect, test } from "bun:test";
import type { GatewayStatus } from "./render.ts";
import { renderOverview, renderPolicyBanner } from "./render.ts";
import { elementsOf, textOf } from "./view-tree.ts";

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
  test("overview shows peer + connector-blocked counts", () => {
    const text = textOf(renderOverview(status));
    expect(text).toContain("1/1"); // peers reachable
    expect(text).toContain("1 blocked"); // slack blocked by policy
    expect(text).toContain("2"); // hitl pending
  });
  test("policy banner flags ungoverned", () => {
    expect(
      textOf(renderPolicyBanner({ ...status.policy, source: "none", signatureValid: false })),
    ).toContain("ungoverned");
    expect(textOf(renderPolicyBanner(status.policy))).toContain("acme");
  });

  /**
   * `policy.version` was once the one interpolation the old string renderer
   * forgot to escape, and that string was assigned to `innerHTML` — a live
   * DOM-XSS sink. Views now build a tree whose dynamic values are text children,
   * so a payload in ANY field stays text: it shows up verbatim in the text
   * content and never as an element.
   *
   * The cast is the point: `version` is TYPED number, but `client.ts` only
   * shape-checks the response and never validates the field.
   */
  test("a markup payload in version stays text, never an element", () => {
    const payload = '<img src=x onerror="alert(1)">';
    const tree = renderPolicyBanner({ ...status.policy, version: payload as unknown as number });
    expect(textOf(tree)).toContain(payload);
    expect(elementsOf(tree).map((e) => e.tag)).toEqual(["div", "b"]);
  });

  test("a markup payload in org stays text, never an element", () => {
    const tree = renderPolicyBanner({ ...status.policy, org: "<script>x</script>" });
    expect(textOf(tree)).toContain("<script>x</script>");
    expect(elementsOf(tree).map((e) => e.tag)).toEqual(["div", "b"]);
  });

  test("a markup payload in a peer id never becomes an element", () => {
    const tree = renderOverview({ ...status, peers: [{ peerId: "<script>", reachable: true }] });
    expect(elementsOf(tree).some((e) => (e.tag as string) === "script")).toBe(false);
  });

  test("a numeric version still renders as a plain number", () => {
    expect(textOf(renderPolicyBanner({ ...status.policy, version: 7 }))).toContain("v7");
  });

  test("a pending restart adds the warn span", () => {
    const tree = renderPolicyBanner({ ...status.policy, pendingRestart: true });
    expect(textOf(tree)).toContain("restart pending");
    expect(elementsOf(tree).some((e) => e.attrs.class === "warn")).toBe(true);
  });
});
