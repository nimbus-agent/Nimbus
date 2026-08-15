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

export function esc(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function renderPolicyBanner(p: PolicyState): string {
  if (p.source === "none" || !p.signatureValid) {
    return `<div class="banner banner-warn">⚠ ungoverned — no valid org policy applied</div>`;
  }
  const restart = p.pendingRestart ? ' · <span class="warn">restart pending</span>' : "";
  // `p.version` is escaped for the same reason `p.org` beside it is: both come
  // from the /v1/admin/status JSON, which `client.ts` shape-checks but does not
  // validate per field — `version` is only TYPED number, never proven to be one.
  // This string is assigned to `innerHTML` in main.ts, so an unescaped value
  // here is a DOM-XSS sink. It was the one interpolation in this renderer that
  // esc() did not cover; every other dynamic value goes through `card()`, which
  // escapes. `restart` is a locally-built constant, deliberately raw HTML.
  return `<div class="banner">policy <b>${esc(p.org ?? "")}</b> v${esc(String(p.version ?? 0))} ✓ signed${restart}</div>`;
}

export function renderOverview(s: GatewayStatus): string {
  const reachable = s.peers.filter((p) => p.reachable).length;
  const blocked = s.connectors.filter((c) => c.blockedByPolicy).length;
  const card = (label: string, value: string) =>
    `<div class="card"><div class="card-v">${esc(value)}</div><div class="card-l">${esc(label)}</div></div>`;
  return [
    renderPolicyBanner(s.policy),
    `<div class="cards">`,
    card("peers reachable", `${reachable}/${s.peers.length}`),
    card("connectors", `${s.connectors.length} (${blocked} blocked)`),
    card("audit chain", `${s.audit.chainLength}`),
    card("HITL pending", `${s.hitl.pendingApprovals + s.hitl.pendingQuorum}`),
    card("sync age", `${Math.round(s.syncFreshnessMs / 1000)}s`),
    card("operator", s.identity.operatorValid ? "valid ✓" : "invalid ✗"),
    `</div>`,
  ].join("");
}
