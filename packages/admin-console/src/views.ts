// Pure view functions for the admin console. Mirror render.ts: every view
// returns a `ViewNode` tree whose dynamic values are text children, never
// markup (see view-tree.ts). No gateway-source imports.
import type { GatewayStatus } from "./render.ts";
import { card, renderPolicyBanner } from "./render.ts";
import type { ViewChild, ViewNode } from "./view-tree.ts";
import { h } from "./view-tree.ts";

function grid(headers: readonly string[], rows: readonly (readonly string[])[]): ViewNode {
  return h(
    "table",
    { class: "grid" },
    h("thead", {}, h("tr", {}, ...headers.map((t) => h("th", {}, t)))),
    h("tbody", {}, ...rows.map((r) => h("tr", {}, ...r.map((cell) => h("td", {}, cell))))),
  );
}

export function renderConnectors(connectors: GatewayStatus["connectors"]): ViewChild[] {
  const rows = connectors.map((c) => [
    c.id,
    c.enabled ? "yes" : "no",
    c.blockedByPolicy ? "blocked by policy" : "",
    c.health,
  ]);
  return [h("h2", {}, "Connectors"), grid(["connector", "enabled", "policy", "health"], rows)];
}

export function renderAudit(audit: GatewayStatus["audit"]): ViewChild[] {
  return [
    h("h2", {}, "Audit chain"),
    h(
      "div",
      { class: "cards" },
      card("chain length", String(audit.chainLength)),
      card("appends / 1h", String(audit.appendRate1h)),
    ),
    h("p", {}, "last hash: ", h("code", {}, audit.lastHash)),
  ];
}

export function renderNamespaces(namespaces: GatewayStatus["namespaces"]): ViewChild[] {
  if (namespaces.length === 0) {
    return [h("h2", {}, "Namespaces"), h("p", {}, "no shared namespaces")];
  }
  const rows = namespaces.map((n) => [n.name, String(n.subscribers)]);
  return [h("h2", {}, "Namespaces"), grid(["namespace", "subscribers"], rows)];
}

export function renderUsers(identity: GatewayStatus["identity"]): ViewChild[] {
  const status = identity.operatorValid ? "valid ✓" : "invalid ✗";
  const out: ViewChild[] = [h("h2", {}, "Users"), h("p", {}, "operator: ", h("b", {}, status))];
  if (identity.externalId !== undefined) {
    out.push(h("p", {}, "external id: ", h("code", {}, identity.externalId)));
  }
  return out;
}

export function renderPolicy(status: GatewayStatus, opts?: { isAnchor?: boolean }): ViewChild[] {
  const p = status.policy;
  const rows = [
    ["org", p.org ?? "—"],
    ["version", String(p.version ?? 0)],
    ["source", p.source],
    ["signature valid", p.signatureValid ? "yes" : "no"],
    ["pending restart", p.pendingRestart ? "yes" : "no"],
  ];
  const out: ViewChild[] = [
    h("h2", {}, "Policy"),
    renderPolicyBanner(p),
    grid(["field", "value"], rows),
  ];
  if (opts?.isAnchor === true) {
    out.push(
      h("h3", {}, "Edit org policy"),
      h("textarea", { id: "policy-editor", rows: "12", cols: "80" }),
      h("div", {}, h("button", { id: "policy-save" }, "Save policy")),
      h("p", { id: "policy-save-status" }),
    );
  } else {
    out.push(h("p", {}, h("i", {}, "read-only on this peer")));
  }
  return out;
}
