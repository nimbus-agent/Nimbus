import type { ViewChild, ViewNode } from "./view-tree.ts";
import { h } from "./view-tree.ts";

export interface PolicyState {
  org?: string;
  version?: number;
  signatureValid: boolean;
  pendingRestart: boolean;
  source: "anchor" | "peer" | "none";
}
export interface GatewayStatus {
  policy: PolicyState;
  peers: { peerId: string; reachable: boolean }[];
  connectors: { id: string; enabled: boolean; blockedByPolicy: boolean; health: string }[];
  namespaces: { name: string; subscribers: number }[];
  audit: { chainLength: number; lastHash: string; appendRate1h: number };
  hitl: { pendingApprovals: number; pendingQuorum: number };
  identity: { operatorValid: boolean; externalId?: string };
  syncFreshnessMs: number;
}

export function renderPolicyBanner(p: PolicyState): ViewNode {
  if (p.source === "none" || !p.signatureValid) {
    return h("div", { class: "banner banner-warn" }, "⚠ ungoverned — no valid org policy applied");
  }
  // `org` and `version` come from the /v1/admin/status JSON, which `client.ts`
  // shape-checks but does not validate per field — `version` is only TYPED
  // number. Both are text children, so whatever they hold renders as text.
  const restart: ViewChild[] = p.pendingRestart
    ? [" · ", h("span", { class: "warn" }, "restart pending")]
    : [];
  return h(
    "div",
    { class: "banner" },
    "policy ",
    h("b", {}, p.org ?? ""),
    ` v${String(p.version ?? 0)} ✓ signed`,
    ...restart,
  );
}

export function card(label: string, value: string): ViewNode {
  return h(
    "div",
    { class: "card" },
    h("div", { class: "card-v" }, value),
    h("div", { class: "card-l" }, label),
  );
}

export function renderOverview(s: GatewayStatus): ViewChild[] {
  const reachable = s.peers.filter((p) => p.reachable).length;
  const blocked = s.connectors.filter((c) => c.blockedByPolicy).length;
  return [
    renderPolicyBanner(s.policy),
    h(
      "div",
      { class: "cards" },
      card("peers reachable", `${reachable}/${s.peers.length}`),
      card("connectors", `${s.connectors.length} (${blocked} blocked)`),
      card("audit chain", `${s.audit.chainLength}`),
      card("HITL pending", `${s.hitl.pendingApprovals + s.hitl.pendingQuorum}`),
      card("sync age", `${Math.round(s.syncFreshnessMs / 1000)}s`),
      card("operator", s.identity.operatorValid ? "valid ✓" : "invalid ✗"),
    ),
  ];
}
