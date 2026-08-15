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

  /**
   * `policy.version` is the one interpolation in this renderer that esc() did
   * not cover, and this string is assigned to `innerHTML` in main.ts — so it was
   * a live DOM-XSS sink. Sonar flagged exactly this flow and it was closed as a
   * false positive on the grounds that "every dynamic value reaching innerHTML
   * is HTML-escaped via esc()", which was true of `policy.org` beside it and not
   * of `policy.version`.
   *
   * The cast is the point: `version` is TYPED number, but `client.ts` only
   * shape-checks the response (`"data" in body`) and never validates the field,
   * so the type is an assumption about a remote JSON document, not a guarantee.
   */
  test("policy banner escapes version — the DOM-XSS sink, not just org", () => {
    const payload = '<img src=x onerror="alert(1)">';
    const html = renderPolicyBanner({
      ...status.policy,
      version: payload as unknown as number,
    });
    expect(html).not.toContain("<img");
    expect(html).not.toContain('onerror="');
    expect(html).toContain("&lt;img");
  });

  test("policy banner escapes org too — the half that was already covered", () => {
    const html = renderPolicyBanner({ ...status.policy, org: "<script>x</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  test("a numeric version still renders as a plain number", () => {
    expect(renderPolicyBanner({ ...status.policy, version: 7 })).toContain("v7");
  });
});
