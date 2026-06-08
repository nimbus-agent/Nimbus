// Pure view functions for the admin console. Mirror render.ts: every dynamic
// value is passed through esc() for XSS-safety. No gateway-source imports.
import type { GatewayStatus } from "./render.ts";
import { esc, renderPolicyBanner } from "./render.ts";

export function renderConnectors(connectors: GatewayStatus["connectors"]): string {
  const rows = connectors
    .map((c) => {
      const blocked = c.blockedByPolicy ? "blocked by policy" : "";
      return [
        "<tr>",
        `<td>${esc(c.id)}</td>`,
        `<td>${c.enabled ? "yes" : "no"}</td>`,
        `<td>${esc(blocked)}</td>`,
        `<td>${esc(c.health)}</td>`,
        "</tr>",
      ].join("");
    })
    .join("");
  return [
    "<h2>Connectors</h2>",
    '<table class="grid">',
    "<thead><tr><th>connector</th><th>enabled</th><th>policy</th><th>health</th></tr></thead>",
    `<tbody>${rows}</tbody>`,
    "</table>",
  ].join("");
}

export function renderAudit(audit: GatewayStatus["audit"]): string {
  return [
    "<h2>Audit chain</h2>",
    '<div class="cards">',
    `<div class="card"><div class="card-v">${esc(String(audit.chainLength))}</div><div class="card-l">chain length</div></div>`,
    `<div class="card"><div class="card-v">${esc(String(audit.appendRate1h))}</div><div class="card-l">appends / 1h</div></div>`,
    "</div>",
    `<p>last hash: <code>${esc(audit.lastHash)}</code></p>`,
  ].join("");
}

export function renderNamespaces(namespaces: GatewayStatus["namespaces"]): string {
  if (namespaces.length === 0) {
    return ["<h2>Namespaces</h2>", "<p>no shared namespaces</p>"].join("");
  }
  const rows = namespaces
    .map((n) => `<tr><td>${esc(n.name)}</td><td>${esc(String(n.subscribers))}</td></tr>`)
    .join("");
  return [
    "<h2>Namespaces</h2>",
    '<table class="grid">',
    "<thead><tr><th>namespace</th><th>subscribers</th></tr></thead>",
    `<tbody>${rows}</tbody>`,
    "</table>",
  ].join("");
}

export function renderUsers(identity: GatewayStatus["identity"]): string {
  const status = identity.operatorValid ? "valid ✓" : "invalid ✗";
  const ext =
    identity.externalId === undefined
      ? ""
      : `<p>external id: <code>${esc(identity.externalId)}</code></p>`;
  return ["<h2>Users</h2>", `<p>operator: <b>${esc(status)}</b></p>`, ext].join("");
}

export function renderPolicy(status: GatewayStatus, opts?: { isAnchor?: boolean }): string {
  const p = status.policy;
  const rows = [
    ["org", p.org ?? "—"],
    ["version", String(p.version ?? 0)],
    ["source", p.source],
    ["signature valid", p.signatureValid ? "yes" : "no"],
    ["pending restart", p.pendingRestart ? "yes" : "no"],
  ]
    .map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`)
    .join("");
  const summary = [
    "<h2>Policy</h2>",
    renderPolicyBanner(p),
    '<table class="grid">',
    "<thead><tr><th>field</th><th>value</th></tr></thead>",
    `<tbody>${rows}</tbody>`,
    "</table>",
  ];
  if (opts?.isAnchor === true) {
    summary.push(
      "<h3>Edit org policy</h3>",
      '<textarea id="policy-editor" rows="12" cols="80"></textarea>',
      '<div><button id="policy-save">Save policy</button></div>',
      '<p id="policy-save-status"></p>',
    );
  } else {
    summary.push("<p><i>read-only on this peer</i></p>");
  }
  return summary.join("");
}
