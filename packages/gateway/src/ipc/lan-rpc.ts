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
  // S2 slice 1 — exec: the WHOLE namespace, not selected methods. `exec.run` is RCE-class by
  // definition (it is the arbitrary-code-execution surface, a stronger case than
  // connector.addMcp), and `exec.approvalRespond` is the LOCAL owner answering an execution
  // prompt -- admitting it over the wire would let a paired peer approve arbitrary code running
  // on the owner's machine, defeating the entire I33 gate. There are no read verbs here to
  // preserve, so the namespace forbid costs nothing.
  "exec",
  // S2 slice 2 — computer-use: the WHOLE namespace, matching exec. `computer.act` drives the
  // owner's browser, and `computer.approvalRespond` is the LOCAL owner answering an actuation
  // prompt — admitting it would let a paired peer approve actions on the owner's machine,
  // defeating the entire I35 gate. There are no read verbs here worth preserving.
  "computer",
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
  // index.rebody is a STRONGER case than reembed: reembed only recomputes local embeddings
  // (embedding_chunk + vec_items_*, pure local CPU work). rebody clears a connector's sync
  // watermark and drives an outbound re-sync against the user's connected third-party services
  // (Notion/Confluence/Jira/etc.) — potentially tens of thousands of API requests spent against
  // the OWNER's own credentials and rate-limit quota. A paired LAN peer must never be able to
  // trigger that on the owner's behalf, so both are fully forbidden (I5 defense-in-depth).
  "index.rebody",
  "index.rebodyCancel",
  // Glossary on-demand passes are write-class and local-only: refresh spends the
  // owner's local model, rebuild TRUNCATES both glossary tables and deletes every
  // projected item. The denylist is default-allow, so omitting this would leave a
  // paired peer able to wipe the glossary. The read-only `agents.glossary` stays
  // admitted, like every other agent.
  "glossary",
  // Decisions on-demand passes are the direct analogue of glossary's: refresh spends the
  // owner's local model, rebuild clears decision_record, decision_evidence and the pass
  // watermark — vetoes included, and a veto is permanent by design, so this is the sole
  // recovery path for one. The denylist is default-allow, so omitting this would leave a
  // paired peer able to wipe every stored decision and every veto. The read-only
  // `agents.decisions` stays admitted, like every other agent.
  "decisions",
  // Ownership on-demand passes are the analogue of glossary's and decisions': a refresh
  // clears and re-emits every `owns`/`contains`/`tracks_remote`/`belongs_to` edge the pass
  // owns, wholesale. The denylist is default-allow, so omitting this would leave a paired
  // peer able to churn the owner's ownership graph on demand. The read-only
  // `agents.ownership` stays admitted, like every other agent.
  "ownership",
  // Pre-mortem theme pass (Spine S1) — the direct analogue of decisions'/ownership's on-demand
  // refresh: it writes local `theme` rows and spends the owner's local model budget. It also has
  // NO counterpart in this namespace: the `agents.premortem` brief lives in the separate
  // `agents.*` namespace, unaffected by forbidding this one. (That brief is NOT read-only — it
  // proposes paused watcher rows — but it is excluded from the LAN-reachable surfaces on its own
  // terms, not by this entry.) So forbidding the whole `premortem` namespace costs no legitimate
  // LAN caller anything.
  "premortem",
  // Zero-config onboarding — `nimbus init`'s local demo hint (a file:line from
  // THIS machine's index). A paired peer has no use for it, so it is local/CLI-only
  // rather than riding the `index.*` default-allow for reads (I5 defense-in-depth).
  "index.demoSymbol",
  // Federation: management methods and local asker entrypoints are local/Tauri-only.
  //
  // This is a DENYLIST, so the admitted set is "every served handler minus what is listed here"
  // and it GROWS whenever a handler is added to federation-rpc.ts. Until 2026-08-16 this comment
  // named only the first two answering methods — true when written, wrong by eleven by the time
  // anyone read it again. The real admitted set is thirteen, including invoke, preflight, purge
  // and shareReceive, each with its own gate
  // (see the notes further down). `audit:status-drift` now derives the set and fails if this
  // comment or the I17 section claims a smaller one, because prose was the only place it was
  // written down.
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
  // Web clipper (I30): clip.pair opens the owner-only PairingWindowController window and returns
  // the one-time code in its RPC response. Admitting it over LAN (the denylist is default-allow)
  // would let an already-paired LAN peer call clip.pair itself, read the code back, then POST it
  // to /v1/clips/pair/confirm and mint its own Vault-stored bearer token — never routing through
  // the owner running `nimbus clip pair`, which defeats I30's owner-opened-window requirement.
  // The whole namespace is forbidden (not just clip.pair): clip.status/list/delete are local-CLI
  // surfaces too (the browser extension talks to the bearer-authed HTTP surface, never LAN
  // JSON-RPC), so forbidding the namespace costs no legitimate caller anything.
  "clip",
  // NOTE: egress.prune is deliberately NOT forbidden here — like federation.purge above, it is
  // HITL-gated inside its own handler (handlePrune in egress-rpc.ts calls
  // ctx.requestPruneApproval(beforeTs) and returns { approved: false, prunedCount: 0 } on denial),
  // so a LAN caller only ever triggers an owner consent prompt and can never prune unilaterally.
  // Listing it here would be redundant, not a fix — don't "fix" it by adding it to this set.
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
