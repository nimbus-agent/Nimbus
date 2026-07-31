export class LanError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "LanError";
    this.rpcCode = rpcCode;
  }
}

const FORBIDDEN_OVER_LAN = new Set([
  "vault",
  "updater",
  "lan",
  "profile",
  "filesystem", // Stage 2a — local-only blame-root registration, never over LAN (I5 defense-in-depth)
  "chatops", // Slice 5 — local/Tauri-read-only bot lifecycle; never answerable over the wire
  "tribal", // Slice 6c — local/Tauri-read-only knowledge extraction + owner-HITL capture; never over the wire
  // Slice 8 — share: create is the I27 owner-HITL outbound chokepoint; prune deletes local
  // share_records rows; approvalRespond is the LOCAL owner answering a publish-approval prompt.
  // All three are local/CLI-only (full-method forbid) — admitting approvalRespond over the wire
  // would let a remote peer approve an outbound publish, defeating the LOCAL-owner gate (I27).
  // The reads (share.verify/list/get/pubkey) stay admitted by default-allow.
  "share.create",
  "share.prune",
  "share.approvalRespond",
  "audit", // exfiltration-class namespace
  "data", // exfiltration-class namespace
  "security", // exfiltration-class — credential locations must not leak to LAN peers
  "connector.addMcp", // full method — arbitrary command execution over network
  "extension.sync", // T2 PR 2 — CLI-only sync of publisher pubkeys via vault writes
  "extension.checkForUpdates", // T2 PR 3 — CLI-only auto-update detection
  "extension.update", // T2 PR 3 — CLI-only auto-update apply (HITL-gated)
  // Extension management is local/CLI-only — never reachable over the LAN channel (I5
  // defense-in-depth). extension.install is RCE-class (arbitrary code); enable/disable/remove
  // are also fully forbidden here, not merely write-gated, matching connector.addMcp.
  "extension.install",
  "extension.enable",
  "extension.disable",
  "extension.remove",
  "index.reembed", // T6 PR 3 — write-class index method (writes embedding_chunk + vec_items_*)
  "index.reembedCancel", // T6 PR 3 — paired cancel for the long-running reembed job
  // Glossary on-demand passes are write-class and local-only: refresh spends the
  // owner's local model, rebuild TRUNCATES both glossary tables and deletes every
  // projected item. The denylist is default-allow, so omitting this would leave a
  // paired peer able to wipe the glossary. The read-only `agents.glossary` stays
  // admitted, like every other agent.
  "glossary",
  // Zero-config onboarding — `nimbus init`'s local demo hint (a file:line from
  // THIS machine's index). A paired peer has no use for it, so it is local/CLI-only
  // rather than riding the `index.*` default-allow for reads (I5 defense-in-depth).
  "index.demoSymbol",
  // Federation: management methods are local/Tauri-only. Only federation.query /
  // federation.expertise are answerable over the wire (I17 + I5).
  "federation.discover",
  "federation.pair",
  "federation.peers",
  "federation.namespace.publish",
  "federation.namespace.grant",
  "federation.namespace.revoke",
  "federation.consentRespond", // local/Tauri-only owner action — never answerable over the wire
  "federation.ask", // local-only asker entrypoint (sends over the wire to a peer); not answerable
  "federation.askExpertise", // local-only asker entrypoint; not answerable
  "federation.askInvoke", // local-only asker entrypoint (Slice 2 team-vault invoke); not answerable
  "federation.shareForward", // local-only asker entrypoint (sends a share over the wire); not answerable
  // NOTE: federation.purge (Slice 4 GDPR serve) is deliberately NOT forbidden here — like
  // federation.query/expertise/invoke it is an ANSWERING method (a paired peer asks this gateway to
  // erase a user's contributions). It is HITL-gated inside the handler (the local operator must
  // approve via the consent broker before anything is deleted), so it is safe over the wire.
  // Team Vault + multi-user/quorum HITL (Slice 2). The management surfaces are local/CLI/Tauri-only;
  // only the wire methods federation.invoke / federation.quorumRespond / federation.approvalRespond /
  // federation.requestApproval are answerable over the wire (federation.invoke gated by I19 RBAC +
  // quorum; federation.requestApproval is the delegate answering an owner's routed HITL approval —
  // it forces the owner peerId from the authenticated session (I17/R1), audits its own decision, and
  // returns only { approved }, never secret material; the owner re-checks delegate authority via I20).
  "team", // team.auditMerged — local-only asker entrypoint (fans out federation.auditExport); not answerable over LAN
  "teamvault", // teamvault.put/delete/grant/revoke/list — secret + RBAC management, never over LAN
  "hitl", // hitl.delegate/revokeDelegation/listDelegations/pendingQueue — local owner control only
  // Identity & SCIM (Slice 3): all management/read methods are local/CLI/Tauri-only — never over LAN.
  "identity.login",
  "identity.status",
  "identity.logout",
  "identity.bind",
  "identity.unbind",
  "identity.listBindings",
  "scim.status",
  "scim.setToken",
  "scim.listUsers",
  "scim.deprovision",
]);

const WRITE_METHODS = new Set([
  "engine.ask",
  "engine.askStream",
  "connector.sync",
  "connector.remove",
  "connector.addMcp",
  "connector.setConfig",
  "connector.setInterval",
  "watcher.create",
  "watcher.update",
  "watcher.delete",
  "workflow.run",
  "workflow.save",
  "workflow.delete",
  "extension.enable",
  "extension.remove",
  "data.import",
]);

export interface LanPeerContext {
  peerId: string;
  writeAllowed: boolean;
}

export function checkLanMethodAllowed(method: string, peer: LanPeerContext): void {
  const ns = method.split(".")[0] ?? "";
  if (FORBIDDEN_OVER_LAN.has(ns) || FORBIDDEN_OVER_LAN.has(method)) {
    throw new LanError(-32601, `ERR_METHOD_NOT_ALLOWED: ${method} is not callable over LAN`);
  }
  if (WRITE_METHODS.has(method) && !peer.writeAllowed) {
    throw new LanError(
      -32603,
      `ERR_LAN_WRITE_FORBIDDEN: peer ${peer.peerId} lacks write permission for ${method}`,
    );
  }
}
