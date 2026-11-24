// The production site each static rule confines something TO, and the scan-is-meaningful floor.

import type { FileEntry } from "./_shared.ts";

/**
 * The production site each static rule below confines something TO.
 *
 * Every check in `run()` has the same shape — scan `files`, report what is out of place — so
 * every one of them reports "clean" when `files` is empty or has lost the package it polices.
 * There is no floor anywhere in this file, which means a single upstream breakage (a moved
 * package, a widened exclusion in `iterateGlob`, a glob that stops matching after a layout
 * change) would silently turn D10 through D22 into fourteen no-ops that exit 0 — and this
 * auditor runs BEFORE the test suite specifically so it fails first.
 *
 * A raw file count would catch the empty case but not the interesting one: a scan that still
 * finds a thousand files while the gateway subtree it is policing has dropped out. So the floor
 * is the anchors themselves. If the file a rule confines `connectors.dispatch` to is not in the
 * scanned set, that rule is not enforcing anything, whatever it reports.
 */
export const RULE_ANCHORS: readonly string[] = [
  "packages/gateway/src/briefing/briefing-runner.ts", // D45 — the briefing delivers locally only
  // D42(i) (the read-only drift check, OR-DRIFT-1): the one caller of the method and the one builder.
  "packages/gateway/src/iac-drift/drift-runner.ts",
  "packages/gateway/src/engine/run-ask.ts",
  "packages/gateway/src/agents/_lib/briefing-build.ts", // D45
  // D46(a) (incident-forbidden-import / incident-no-network, Phase 10 IC3) -- anchored on BOTH halves of its
  // scope, as D45 is: the assembler under `incident/` and the render under `agents/_lib/`. Either moving out of
  // the scan (a move, a glob change) would leave half the rule passing over nothing.
  "packages/gateway/src/incident/assemble.ts",
  "packages/gateway/src/agents/_lib/incident-render.ts",
  "packages/gateway/src/incident/remediation.ts", // D46(c) -- the one builder of an engine-proposed action; the D46(a) carve-out
  "packages/gateway/src/incident/finding-store.ts", // D46(f) -- the one writer of the IC8 finding and baseline tables
  "packages/gateway/src/investigation/investigation-live.ts", // D46(h) -- the one live investigation read (owner ruling 9)
  "packages/gateway/src/runbook/runbook-run.ts", // D46(g) -- the one builder of a runbook step (IC6)
  "packages/gateway/src/incident-update/update-send.ts", // D46(e) -- the owner's incident update post, a linked owner action (IC9b)
  "packages/gateway/src/finops/cost-series.ts", // D48 — FinOps cost code is inert
  "packages/gateway/src/automation/workflow-import.ts", // D50 - the only way a workflow enters from outside
  "packages/gateway/src/memory/episodic-store.ts", // D52 - the only reader and writer of the episodic memory tables
  "packages/gateway/src/toolgen/toolgen-model-door.ts", // D51 - the model's only door to a saved generated tool
  "packages/gateway/src/ipc/lan-legacy.ts", // D47 — the only home of the v1 static-box LAN path
  "packages/gateway/src/platform/sandbox/write-grant-check.ts", // D10 user-write — a file the rule reads and then permits
  "packages/gateway/src/engine/executor.ts", // D22 — connectors.dispatch chokepoint
  "packages/gateway/src/ipc/agents-rpc.ts", // D22(d) — agent emitter confinement
  "packages/gateway/src/db/write.ts", // D12 — bound-param SQL writes
  "packages/gateway/src/federation/query-gate.ts", // D13
  "packages/gateway/src/federation/invoke-gate.ts", // D15, D20
  "packages/gateway/src/federation/preflight-gate.ts", // D18
  "packages/gateway/src/federation/free-busy-gate.ts", // D13(b) - the only answer to a peer's free/busy request
  "packages/gateway/src/identity/verifier.ts", // D14
  "packages/gateway/src/policy/policy-gate.ts", // D16
  "packages/gateway/src/chatops/reply-dispatcher.ts", // D17
  "packages/gateway/src/tribal/tribal-write-gate.ts", // D19
  "packages/gateway/src/connectors/connector-write-registry.ts", // D20
  "packages/gateway/src/share/share-gate.ts", // D21
  "packages/gateway/src/share/share-forward.ts", // D21 second emit path
  // graph-entity-flat-coowned. Anchored on a file the rule SCANS, not on relationship-graph.ts:
  // that file is the rule's own skip target (GRAPH_ENTITY_FLAT_DEFINITION_SITE), so its presence
  // in the scanned set proves nothing about whether the rule can see anything. ownership-pass.ts
  // is one of the two converted co-owned writers and is scanned normally.
  "packages/gateway/src/ownership/ownership-pass.ts",
  // D23 — anchored on the confined-spawn primitive's own home, a file the rule SCANS (it is on the
  // allow-list, so it is read and then permitted) rather than on some file the rule skips. Without
  // an anchor of its own, D23 would report clean while scanning nothing the moment
  // `iterateSourceFiles()` stopped loading `exec/`, and the D10–D22 anchors would still be present
  // to make the run look healthy.
  "packages/gateway/src/exec/exec-run.ts",
  // D22(f) — anchored on one of the three embedding-appender construction sites, a file the
  // rule SCANS (it is on the allow-list, so it is read and then permitted) rather than the
  // definition file the rule also permits. Same shape as the D23 anchor above.
  "packages/gateway/src/embedding/create-routing-runtime.ts",
  // D17-chatops-unwrapped-post — anchored on `chatops-boot.ts`, the ONE file that legitimately
  // contains a `buildLedgeredChatPosts(..., buildConnectorPost(...), ...)` call and so the one
  // file whose content this rule must actually parse to enforce anything. The reply-dispatcher.ts
  // anchor above is for the OLDER, separate D17-chatops-reply-surface rule (literal
  // slack_chat_post/teams_chat_post tool-id references) — that rule allow-lists
  // reply-dispatcher.ts, so its presence in the scanned set proves nothing about whether THIS
  // rule (the unwrapped-`buildConnectorPost` check) can see anything, since reply-dispatcher.ts
  // never calls buildConnectorPost. Without an anchor of its own, D17-chatops-unwrapped-post would
  // report clean while scanning nothing the moment `iterateSourceFiles()` stopped loading
  // `chatops/` — the exact inert-guard failure mode D22(f)/D23 exist to catch.
  "packages/gateway/src/chatops/chatops-boot.ts",
  // D26(a) (I35) — anchored on the actuation primitive's own home, a file the rule SCANS (it is
  // on the allow-list, so it is read and then permitted) rather than on cu-gate.ts, the other
  // allowed caller. Same shape as the D23 anchor above. D26(b) has no anchor: its confined
  // directory, `computer-use/cu-lanes/`, now holds the raw-CDP driver, so
  // there is no allowed file on disk to point at — see the rule's own comment.
  "packages/gateway/src/computer-use/cu-actuate.ts",
  // D22(g) — anchored on the ONE production construction site, a file the rule SCANS (it is on
  // both allow-lists, so it is read and then permitted) rather than `vlm/ollama-vlm.ts`, which the
  // constructor rule skips as its own definition and whose presence would therefore prove nothing.
  // Same shape as the D23 and D22(f) anchors above.
  "packages/gateway/src/multimodal/build-media-pass-deps.ts",
  // D28 — anchored on the ONE production file allowed to wear the `fleet` ClientKind, a file the
  // rule SCANS (it is on the allow-list, so it is read and then permitted). NOT client-kind.ts:
  // that file DEFINES the union, and its presence in the scanned set would prove nothing about
  // whether the rule can see the invoker. Same shape as the D23 and D22(f)/(g) anchors above —
  // without an anchor of its own, D28 would report clean while scanning nothing the moment
  // `iterateSourceFiles()` stopped reaching `fleet/`.
  "packages/gateway/src/fleet/fleet-invoker.ts",
  // D28 — second anchor, on `push-runner.ts`: the file that USED to wear the `push` ClientKind
  // (`kind: "push"`) before the push re-based on incident records (Phase 10 IC3). It is still scanned, and
  // now permitted nothing, so the literal cannot quietly return there and D28 cannot go blind to the file.
  "packages/gateway/src/oncall-push/push-runner.ts",
  // D29 (a)/(b)/(c)/(d) — anchored on `toolgen-broker.ts`, a file all four rules SCAN (it names
  // none of `nimbus/fetch`, `buildGeneratedManifest`'s definition, a `toolgen.` vault-key template,
  // or a forbidden saved-tool identifier, so it is read and then reported clean) rather than on any
  // of the DEFINITION/allow-listed sites the rules themselves skip (`toolgen-types.ts`,
  // `toolgen-stub.ts`'s own file is scanned but for a different check, `toolgen-credentials.ts`,
  // `toolgen-saved-store.ts`). Without an anchor of its own, all four D29 rules would report clean
  // while scanning nothing the moment `iterateSourceFiles()` stopped reaching `toolgen/` — the same
  // inert-guard failure mode D23/D28 exist to catch.
  "packages/gateway/src/toolgen/toolgen-broker.ts",
  // D30 — anchored on the embedding worker, the entry point whose absence would be least visible
  // (a separate Bun `Worker` realm with its own connection, and the one that WRITES the vectors)
  // and a file the rule SCANS: it carries a real value-import of `Database`, so the rule has to
  // read it and check the init is there. Not `platform/sqlite-runtime.ts`, which the rule permits
  // by virtue of defining `ensureFullSqlite` and whose presence would therefore prove nothing.
  // Same shape as the D23/D28/D29 anchors above.
  "packages/gateway/src/embedding/embedding-worker.ts",
  // D31 — anchored on one of the six real listen sites, a file the rule SCANS: it carries a real
  // `Bun.serve(` call AND names `registerListener`, so the rule has to read it and confirm the
  // registration is there rather than reporting clean on an empty scan. Not
  // `locality/listener-registry.ts`, which the rule does not exempt by name (D31 has no
  // definition-file allow-list at all, unlike D22(f)/(g) and D29) but which contains no listen
  // call of its own and so would prove nothing about whether the rule can see one. Same shape as
  // the D23/D28/D29/D30 anchors above.
  "packages/gateway/src/ipc/http-server.ts",
  // D32(e)(f)(g) — anchored on capture-gate.ts, which (f) and (g) SCAN (it sits under mcp-sink/ and is
  // not capture-validate.ts) and (e) reads then permits. Without it, both rules would report clean
  // while scanning nothing the moment iterateSourceFiles() stopped loading mcp-sink/.
  "packages/gateway/src/mcp-sink/capture-gate.ts",
  // D32(b)(d) allow-list the revoke and purge verbs' module by exact path; it moving out of the scan
  // would leave those two allowances reading nothing.
  "packages/gateway/src/mcp-sink/capture-gate/owner-verbs.ts",
  "packages/gateway/src/extensions/approve-run.ts", // D33(b)(c) — scanned; the run-grant store's main caller
  // D34(a)(b)(c) — anchored on the RPC path, which (a) and (b) SCAN (it names neither the table nor
  // the grant entry point) and (c) reads then permits.
  "packages/gateway/src/ipc/migration-rpc.ts",
  // D36 — anchored on the pack RPC, which the rule SCANS (it is not allow-listed) and which sits
  // one call from the store's write half without naming it.
  "packages/gateway/src/ipc/pack-rpc.ts",
  // D37 — anchored on the trust feed module, which the rule SCANS (it is not allow-listed) and which
  // reaches the feed floor only through the store.
  "packages/gateway/src/extensions/trust/trust-feed.ts",
  // D38 — anchored on the eval role, which every clause SCANS: it sits under extensions/eval/ (so
  // (c)(d)(e) read it) and is allow-listed by neither (a) nor (b).
  "packages/gateway/src/extensions/eval/eval-role.ts",
  // D39 — the door itself: clauses (c) and (d) read ONLY this file, so a rule that cannot find it
  // would report clean while checking neither.
  "packages/gateway/src/engine/connector-write-agent-tools.ts",
  // D40 — the before-state module defines the literal and the runner, and (c) reads
  // connectors/registry.ts by name (engine/executor.ts is anchored above, for D22).
  "packages/gateway/src/engine/before-state.ts",
  "packages/gateway/src/connectors/registry.ts",
  // D41 — the consent coordinator (which must carry the text and never judge it); engine/executor.ts
  // is anchored above, for D22. D39(e) — the act door's wiring site, `buildActDeps`.
  "packages/gateway/src/ipc/capture-rpc.ts",
  "packages/gateway/src/ipc/consent.ts",
  // D42 — the prepare step (the injection and the `.write.prepare` spelling live there) and the
  // prepare-tool set (which must stay frozen); engine/executor.ts and connectors/registry.ts are
  // anchored above.
  "packages/gateway/src/engine/prepare-step.ts",
  "packages/gateway/src/connectors/connector-writes/prepare-tools.ts",
  // D44 — the check itself, the only store, and the one file that builds a provenance: each rule
  // reads these by name, and a rule that cannot find them would report clean while checking nothing.
  "packages/gateway/src/engine/standing-rule-step.ts",
  "packages/gateway/src/standing/standing-rule-store.ts",
  "packages/gateway/src/automation/workflow-write-step.ts",
  // D24 (work_snapshot-confined, Phase 10 MB1) — the only store and the only capability that names
  // its writer; either moving would leave the rule passing over nothing.
  "packages/gateway/src/index/work-snapshot-store.ts",
  // D24 (chat-read-marker-confined, Phase 10 MB4) — the only store of the marker table; it moving out
  // of the scan would leave the rule passing over nothing (sync-capabilities.ts is anchored above).
  "packages/gateway/src/index/chat-read-marker-store.ts",
  "packages/gateway/src/sync/sync-capabilities.ts",
  // D46(b) (item-history-confined, Phase 10 IC1) — the only writer, its one caller and the retention
  // module; any of them moving out of the scan would leave the rule passing over nothing.
  "packages/gateway/src/index/item-history.ts",
  "packages/gateway/src/index/item-store.ts",
  "packages/gateway/src/index/item-history-retention.ts",
  // D46(d) (incident-record-confined, Phase 10 IC3) -- the only writer of the record tables.
  "packages/gateway/src/incident/incident-store.ts",
  // D46(e) (incident-link-minted-in-incident, Phase 10 IC4) -- the only constructor of a link and the one
  // module that declares and validates it; either moving out of the scan would leave the rule passing over nothing.
  "packages/gateway/src/incident/incident-link-mint.ts",
  "packages/gateway/src/engine/incident-link.ts",
  // D49(b) (door-approval-confined, Phase 28 AD3a-1) — the only store of the per-door approval table;
  // it moving out of the scan would leave the rule passing over nothing.
  "packages/gateway/src/connectors/connector-writes/door-approval-store.ts",
  // D49(a), (c)-(f) (Phase 28 AD3a-2a) -- every site the clauses read by name; any of them moving out
  // of the scan would leave a clause passing over nothing (ipc/capture-rpc.ts is anchored above).
  "packages/gateway/src/connectors/connector-writes/agent-door-runtime.ts",
  "packages/gateway/src/engine/outside-origin.ts",
  "packages/gateway/src/mcp-sink/capture-gate.ts",
  "packages/gateway/src/mcp-sink/capture-act.ts",
  "packages/gateway/src/mcp-sink/capture-store.ts",
  "packages/gateway/src/mcp-sink/capture-types.ts",
  "packages/gateway/src/ipc/approvals-rpc.ts",
  "packages/gateway/src/ipc/connector-rpc-handlers/agent-writes.ts",
  // D49(g), (h) (Phase 28 AD5a) -- the sites the new clauses read by name.
  "packages/gateway/src/engine/types.ts",
  "packages/gateway/src/engine/user-mcp-call-block.ts",
  "packages/gateway/src/connectors/lazy-mesh/mesh/user-mcp-layer.ts",
  "packages/gateway/src/ipc/connector-rpc.ts",
  "packages/gateway/src/ipc/connector-rpc-handlers/model-writes.ts",
  "packages/gateway/src/ipc/connector-rpc-handlers/removal.ts",
  "packages/gateway/src/ipc/connector-rpc-handlers/config.ts",
];

/** Fail loudly when the scanned set cannot support the rules about to run. */
export function assertScanIsMeaningful(files: readonly FileEntry[]): string[] {
  const present = new Set(files.map((f) => f.relPath));
  return RULE_ANCHORS.filter((a) => !present.has(a));
}
