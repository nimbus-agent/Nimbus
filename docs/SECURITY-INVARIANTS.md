# Nimbus Security Invariants

**Current ceiling:** invariants I1–I30 (static rules D10–D22). Note: I28 is reserved for the MCP-server owner-sink and is unimplemented — no wiring, no section below, no enforcement test. The I27→I29 gap is documented intent, reconciled if and when that work lands.

Canonical list of structural defenses Nimbus relies on. Each invariant names the defense, points to the production wiring that makes it active (not just defined), and lists the anti-pattern that would regress it. The B1 internal audit (Phase 4, 2026-04-25) found that several of these defenses *existed* in the codebase but had **zero production callers** — the most common root cause of High-severity findings. This file exists so that gap is impossible to re-introduce silently.

**The rule:** every invariant below has at least one enforcement test in [`packages/gateway/src/security-invariants.test.ts`](../packages/gateway/src/security-invariants.test.ts). If you change the wiring, the test must be updated in the same commit; if you remove the defense, the test must fail.

Companion files:

- [`SECURITY.md`](./SECURITY.md) — public-facing security model and reporting policy
- [`architecture.md`](./architecture.md) §Security Model — threat-to-mitigation table
- [`CLAUDE.md`](../CLAUDE.md) / [`GEMINI.md`](../GEMINI.md) — compact summary table for AI assistants

---

## I1 — Child-process environment scoping

**Defense:** `extensionProcessEnv()` in `packages/gateway/src/extensions/spawn-env.ts` returns a curated, audited set of env vars; gateway-private secrets (LLM provider API keys, OAuth client secrets, updater overrides) are stripped before any child process inherits them.

**Wired at:** all 30+ MCP / extension spawn sites in `packages/gateway/src/connectors/lazy-mesh/` (every `spawn()` call sets `env: extensionProcessEnv(...)`). Spawn sites are distributed across `mesh.ts` (filesystem MCP in the constructor), `connector-spawns.ts` (16 per-connector spawns), `phase3-config.ts` (8 phase-3 server-config builders), and `user-mcp.ts` (`ensureUserMcpClient`).

**Anti-pattern:** `spawn(..., { env: { ...process.env, EXTRA: ... } })`. Any literal `{ ...process.env }` spread inside `packages/gateway/src/connectors/` re-introduces the S2-F1 / S7-F1 / S8-F1 leak that powered chains C1, C2, and C3.

**How to comply:** when adding a new MCP child spawn, import `extensionProcessEnv` and pass the connector-specific extras as the argument. Never spread `process.env` into a child env directly.

### Migrated rationale (2026-05-28)

Inline comments at `connectors/lazy-mesh/connector-spawns.ts:29–53` and `phase3-config.ts:14` note that the `ctx.sandboxCwd` thread-through is load-bearing: a regression that drops it leaves phase-3 servers unwrapped and silently fails the I15 enforcement test, which also validates I1 indirectly. The comment at `extensions/spawn-env.ts:3` clarifies that `extensionProcessEnv` is the module that owns the allowlist — not `connector-spawns.ts` or any individual spawn site.

---

## I2 — HITL frozen-set membership

**Defense:** `HITL_REQUIRED` in `packages/gateway/src/engine/executor.ts` is a frozen façade over a module-private `Set` (`HITL_REQUIRED_BACKING`). The façade exposes `has`, iteration, and `forEach` but no mutators; an attempt to call `.add` on the cast type is a no-op or throws.

**Wired at:** `executor.ts` `ToolExecutor.gate()` — every action passes `HITL_REQUIRED.has(action.type)` before dispatch; covered by the "every HITL_REQUIRED action type triggers the consent channel" test in `engine.test.ts`.

**Anti-pattern:** mutating `HITL_REQUIRED` at runtime, declaring a new "destructive" action without adding it to `HITL_REQUIRED_BACKING`, or routing destructive work around `ToolExecutor` entirely. S1-F1 / S1-F7 / C6 all stemmed from destructive RPCs (`data.delete`, `connector.remove`, `connector.reindex`) that bypassed the executor.

**How to comply:** every new IPC method that mutates state outside the index, deletes data, or reaches the network on the user's behalf is added to `HITL_REQUIRED_BACKING` *and* dispatched through `ToolExecutor`. There is no "trusted caller" exception.

**T2 PR 3 additions (2026-05-20):** `extension.autoUpdate` (forward version bump) and `extension.downgrade` (revert to a cached `_prev/<v>/`) joined the frozen set. The RPC handler in `extensions/auto-update-rpc.ts` builds the `PlannedAction` and gates it through a per-client `ToolExecutor` constructed by the IPC dispatcher.

### Migrated rationale (2026-05-28)

The connector registry comment block at `connectors/registry.ts:50–123` is the canonical per-connector dispatch table mapping each logical `action.type` to its `payload.mcpToolId` counterpart (e.g. `email.send` → `gmail_gmail_message_send`, `repo.pr.merge` → `github_github_pr_merge`). This table is the most comprehensive enumeration of the HITL surface outside the executor itself and should be consulted whenever a new connector write tool is added. Comments at `engine/executor.ts:16–17` and `gateway/src/gateway-main.ts` restate that `HITL_REQUIRED_BACKING` is the sole runtime gate; comments across `mcp-connectors/*/src/server.ts` files (aws, azure, bitbucket, circleci, confluence, gcp, github, github-actions, gitlab, iac, jenkins, jira, kubernetes, linear, notion, obsidian, onedrive, outlook, pagerduty, slack, teams) confirm that connector-side write tools rely entirely on the structural gate in `executor.ts` rather than any per-connector guard. The comment at `mcp-connectors/obsidian/src/server.ts:11–16` specifically notes that `assertHitlRequired()` is not used in that codebase and that the defense lives in `executor.ts` — clarifying that MCP connectors are not responsible for gating their own HITL writes.

---

## I3 — HITL gate consults `action.type`, not `payload.mcpToolId`

**Defense:** the executor calls `HITL_REQUIRED.has(action.type)` exactly. `HITL_REQUIRED_BACKING` stores **logical action types** (`file.move`, `email.send`, `repo.pr.merge`, …) — not connector-specific MCP tool ids (`filesystem_move_file`, `gmail_gmail_message_send`). The dispatcher uses `payload.mcpToolId` as a routing-only hint to pick the right MCP tool inside the matched action class.

**Wired at:** `executor.ts` `ToolExecutor.gate()` — `HITL_REQUIRED.has(action.type)`. The earlier fix `ae27fe9` resolved `mcpToolId ?? action.type` and looked it up in `HITL_REQUIRED`; that opened a *new* bypass (since the set holds action types, not MCP ids, every `mcpToolId`-bearing action skipped the gate). Reverted in `2c9ff06`.

**Anti-pattern:** any code that gates on `payload.mcpToolId`, `resolvedToolId`, or any other dispatch hint. The chain-C4 risk (planner emits `{ type: "files.list", payload: { mcpToolId: "github_repo_pr_merge" } }`) is *not* closed at the executor layer; it is mitigated by trusting the planner to emit the correct `action.type` and by the `<tool_output>` envelope (I11) on the LLM-facing path.

**How to comply:** when adding a new destructive action class, add the **logical type string** to `HITL_REQUIRED_BACKING`. Do not add MCP tool ids to that set; do not gate on `mcpToolId` anywhere.

### Migrated rationale (2026-05-28)

No unique narrative beyond the connector dispatch table documented under I2 above. The I3 anti-pattern (gating on `mcpToolId`) is already fully covered by the existing section. No additional subsection needed.

---

## I4 — `hitlStatus` is consent-output-only

**Defense:** the `hitlStatus` field on audit rows (`approved` / `rejected` / `not_required`) is set exclusively by the consent gate in `executor.ts` after the user responds. `not_required` is the correct value when the action is not in `HITL_REQUIRED`; `approved` may only appear after a real consent decision.

**Wired at:** `executor.ts` `ToolExecutor.gate()` — the assignment block inside the consent-handling try/catch is the only production assignment site outside test fixtures.

**Anti-pattern:** writing `hitlStatus: "approved"` at any non-test call site. S1-F5 / chain C6 (`data.delete` hardcoding the field) created a forged audit trail that survived `nimbus audit verify`.

**How to comply:** new RPC handlers that record audit rows must let `ToolExecutor` populate `hitlStatus`; never set it inline.

### Migrated rationale (2026-05-28)

Comments at `ipc/consent.ts:29`, `ipc/data-rpc.ts:23`, and `ipc/server/vault-dispatch.ts:22,101` all reinforce the same constraint: only the consent gate in `executor.ts` may write `hitlStatus: "approved"`. The comment at `engine/audit-payload-safety.test.ts:14` flags a test that verifies no audit row is written with `hitlStatus: "approved"` outside a real consent round-trip. The comment at `ipc/server/dispatchers.ts:284` notes that the `consent.respond` dispatcher is the only production path that supplies the `approved` status back to the executor.

---

## I5 — LAN method allowlist is intrinsic to the LAN server

**Defense:** `checkLanMethodAllowed(method, peer)` in `packages/gateway/src/ipc/lan-rpc.ts` enforces both the namespace deny-list (`vault.*`, `consent.*`, `audit.*`, `data.*`, `updater.*`, `lan.*`, `profile.*`) and the per-peer write grant.

**Wired at:** `lan-server.ts` `LanServer.handleEncryptedMessage()` — called *before* `this.opts.onMessage`, so the gate cannot be bypassed by upstream wiring.

**Anti-pattern:** moving the allowlist check into the dispatcher, the IPC server, or any caller — anywhere outside the LAN server itself. S1-F2 / S3-F1 / chains C3 and C5 were a dead-code defense: the function existed but was never called from `LanServer` in production. **Also:** exposing `index.*` write methods (`index.reembed`, `index.reembedCancel`, …) over LAN without an explicit `FORBIDDEN_OVER_LAN` entry — the namespace is intentionally LAN-allowed for read paths (`index.search` / `index.query` / `index.getItem`), so any new write surface needs a full-method-name entry.

**How to comply:** when adding a new LAN-reachable method, update `WRITE_METHODS` and/or `FORBIDDEN_OVER_LAN` in `lan-rpc.ts`. Do not add a second enforcement path; extend the existing one.

### Migrated rationale (2026-05-28)

The comment at `ipc/lan-rpc.ts:17` documents the `FORBIDDEN_OVER_LAN` set inline: `"security"` is listed as "exfiltration-class — credential locations must not leak to LAN peers"; `"connector.addMcp"` as "arbitrary command execution over network"; `"extension.checkForUpdates"` and `"extension.update"` as CLI-only per T2 PR 3; `"index.reembed"` and `"index.reembedCancel"` as write-class index methods per T6 PR 3; `"extension.install"`, `"extension.enable"`, `"extension.disable"`, and `"extension.remove"` as CLI-only extension management (install is RCE-class; enable/disable/remove fully forbidden matching `connector.addMcp`, not merely write-gated). The comment at `ipc/lan-server.ts:160` confirms that the `checkLanMethodAllowed` call occurs before `onMessage`, making it structurally impossible for a caller to bypass by passing through a different dispatcher. The comment at `ipc/reindex-rpc.ts:8` and `ipc/reindex-rpc.test.ts:56` call out that `connector.reindex` is in `FORBIDDEN_OVER_LAN`.

---

## I6 — LAN bind defaults to loopback

**Defense:** `DEFAULT_NIMBUS_LAN_TOML.bind = "127.0.0.1"`. Wide-area exposure is an explicit opt-in (`[lan] bind = "0.0.0.0"`), not the default.

**Wired at:** `packages/gateway/src/config/nimbus-toml.ts` (default), enforced by `_test-suite.yml` config defaults test.

**Anti-pattern:** changing the default to `"0.0.0.0"`, or auto-binding to all interfaces when an env var is set. S3-F7 / chain C3 was a `0.0.0.0` default that turned LAN access into unintended internet exposure on public Wi-Fi.

**How to comply:** new transports default to loopback. Public-interface binding requires both an explicit user config value *and* a startup log line announcing the binding.

### Migrated rationale (2026-05-28)

No inline comments were mapped to I6 in the triage. No additional subsection needed.

---

## I7 — Tauri allowlist sync

**Defense:** `ALLOWED_METHODS` in `packages/ui/src-tauri/src/gateway_bridge.rs` is the union of every IPC method the renderer is permitted to call. Every entry must (a) have a gateway handler and (b) be classified as read-only or HITL-gated. `extension.install`, `connector.addMcp`, and any other code-execution-class surface is **not** in the renderer-callable allowlist; those are reachable only via Rust-native dialogs that prevent renderer-controlled paths.

**Wired at:** `gateway_bridge.rs` `ALLOWED_METHODS` array; cross-checked by the Rust-side allowlist test (G9).

**Anti-pattern:** adding a write/RCE-class method to the allowlist without a corresponding HITL gate, or shipping an entry whose gateway handler does not exist (`connector.startAuth` had no handler — S4-F2). S7-F2 / chain C1 (`extension.install` allowlisted with no HITL) was the chain that turned a renderer XSS into full credential exfiltration.

**How to comply:** when adding to `ALLOWED_METHODS`, verify the gateway handler exists, route any write through `HITL_REQUIRED`, and update the allowlist test that asserts every entry resolves to a real handler.

**T2 PR 3 additions (2026-05-20):** `extension.checkForUpdates` (read-only cache surface) and `extension.update` (HITL-gated via `extension.autoUpdate` / `extension.downgrade`) joined the allowlist, bumping `allowlist_exact_size` from 60 to 62. `extension.install` stays absent — the marketplace install flow continues to use the Rust-native file picker so chain C1 cannot be reintroduced via the auto-update surface.

**Phase 6 Slice 1 additions (2026-06-05):** `federation.discover`, `federation.namespace.grant`, `federation.namespace.publish`, `federation.namespace.revoke`, and `federation.peers` joined the allowlist (62 → 67). `federation.pair` is deliberately absent (CLI-only, transmits an out-of-band pairing code — same class as `lan.pair`). `federation.query` and `federation.expertise` are over-the-wire answering methods routed through `query-gate.ts` (I17) and are never renderer-callable. `federation.consentRespond` (the owner's local consent-decision reply for the over-the-wire federation flow) also joined the allowlist (67 → 68); `federation.consentRequest` remains a notification delivered to the renderer, not a renderer-callable method.

**Phase 6 Slice 3 additions (2026-06-05):** the six identity/SCIM read+login methods — `identity.login`, `identity.status`, `identity.logout`, `identity.listBindings`, `scim.status`, `scim.listUsers` — joined the allowlist (68 → 74). The credential-mutating `identity.bind` / `identity.unbind` and `scim.setToken` / `scim.deprovision` stay CLI-only (same class as `vault.*`). The size assertion is checked by the `I7` / `I18` describe blocks in `packages/gateway/src/security-invariants.test.ts`, which grep the `.rs` source for `ALLOWED_METHODS.len(), N`.

**Phase 6 Slice 2 additions (2026-06-07):** five renderer-safe team-vault / quorum-HITL read+respond methods — `federation.approvalRespond`, `federation.quorumRespond`, `hitl.listDelegations`, `hitl.pendingQueue`, `teamvault.list` — joined the allowlist (74 → 79). The respond methods carry no secret bytes and force the responder peer id from the NaCl-authenticated session (I17/R1, I21); the secret/RCE-class methods (`teamvault.put` / `teamvault.delete` / `teamvault.grant` / `teamvault.revoke`, `hitl.delegate`, `federation.invoke` / `federation.askInvoke`) stay renderer-FORBIDDEN (same class as `vault.*`).

**Phase 6 Slice 4 additions (2026-06-07):** three read-only org-policy / admin / team-audit methods — `admin.status`, `policy.show`, `team.auditMerged` — joined the allowlist (79 → 82). The privileged policy-mutating methods (`policy.sign` / `policy.trust` / `policy.refetch`) and `team.purge` stay CLI-only (`policy.sign` signs with the Vault-only anchor key — secret-bearing, same class as `vault.*`).

**Phase 6 Slice 5 additions (2026-06-09):** the read-only `chatops.status` joined the allowlist (82 → 83). The operational `chatops.start` / `chatops.stop` / `chatops.test` stay off the renderer surface (CLI-only).

**Phase 6 Slices 6–8 additions (83 → 94, the current `allowlist_exact_size`):** the read-only cross-colleague / tribal-knowledge / data-warehouse query surfaces (Slices 6a–7), the additional identity/federation read methods, and the read-only share surfaces (`share.verify` / `share.list` / `share.get` / `share.pubkey`, Slice 8) joined the allowlist, bringing it to 94. The secret/RCE/owner-HITL-class methods stay CLI-only: the share write/owner-action chokepoints (`share.create` / `share.prune` / `share.approvalRespond`, the I27 outbound-publish gate) and the tribal capture write path stay off the renderer surface (same class as `vault.*`). 94 is the value asserted by `allowlist_exact_size` in `gateway_bridge.rs` and by the `I7` / `I18` describe blocks in `security-invariants.test.ts`.

### Migrated rationale (2026-05-28)

The comment at `ui/src-tauri/src/gateway_bridge.rs:167` notes the `NO_TIMEOUT_METHODS` sub-list (currently 5 entries: `data.export`, `data.import`, `identity.login`, `llm.pullModel`, `updater.applyUpdate`) and its size assertion. The VS Code / Open VSX extension (now the standalone repo [nimbus-agent/nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode)) proxies IPC over the domain socket directly and does **not** go through the Tauri bridge, so ALLOWED_METHODS is irrelevant for the VS Code surface — but any write-class method is still HITL-gated in the Gateway executor before any client (that extension included) can call it. That extension's webview renderer also sanitizes HTML from tool results with DOMPurify before display, a defense-in-depth complement to I11. The comment at `ui/src/components/PendingUpdates.tsx:9` confirms that the update prompt only calls `updater.checkNow` (read-only) — the `applyUpdate` action requires a separate user confirmation step to prevent accidental one-click updates.

---

## I8 — Tauri renderer Content Security Policy is restrictive

**Defense:** `tauri.conf.json` sets `"csp": "default-src 'self'; script-src 'self'"` (or stricter). Inline scripts and remote origins are blocked.

**Wired at:** `packages/ui/src-tauri/tauri.conf.json`.

**Anti-pattern:** `"csp": null` (S4-F4 / chain C1 entry point — allowed prompt-injected content from any indexed connector to execute as renderer-trust-level script). Loosening to `'unsafe-inline'` for convenience is the same regression in disguise.

**How to comply:** new renderer features that need a wider CSP must add the *minimum* directive needed and document the rationale. `unsafe-inline` and `unsafe-eval` are forbidden.

### Migrated rationale (2026-05-28)

No inline comments were mapped to I8 specifically in the triage. No additional subsection needed.

---

## I9 — SQL parameter binding only

**Defense:** every non-identifier value reaching SQLite is a bound parameter, never interpolated — on reads as well as writes. SQLite **writes** additionally go through the typed `dbRun` / `dbExec` / `dbStmtRun` wrappers in `packages/gateway/src/db/write.ts` (that confinement is the separate static check **D12**); reads bind through `db.query(sql).all(...params)` and friends without those wrappers, which is expected and not a gap. Identifier-class values that cannot be parameter-bound (table/column names from a finite allowlist) go through the canonical `escapeIdentifier` export, also in `db/write.ts` — every caller imports it rather than defining its own copy.

**Wired at:** `db/write.ts` (canonical `escapeIdentifier` definition, alongside `dbRun`/`dbExec`/`dbStmtRun`), `db/repair.ts` (imports `escapeIdentifier`; also applies its own null-byte / empty-name guard, `isUnsafeSqlIdentifier`, before escaping — repair-specific because its table names come from a live `PRAGMA foreign_key_check` scan rather than a fixed allowlist), `connectors/reindex.ts` and `search/vec-store.ts` (both import `escapeIdentifier` for the dim-derived `vec_items_<dims>` table name — I9 applies unconditionally even though `dims` is constrained to `SUPPORTED_EMBEDDING_DIMS`), `people/person-store.ts` (per-field parameter binding after S5-F5 fix).

**Anti-pattern:** template-literal SQL on caller-supplied data (``db.run(`UPDATE ... SET ${field} = ${value}`)``). S5-F5 was a `sets.join()` template in `patchPerson` that built SQL from caller-supplied field names. A second anti-pattern specific to this defense: redefining a local `escapeIdentifier` instead of importing the canonical one from `db/write.ts` — two independent copies is exactly the drift that produces a subtly-different third copy later.

**How to comply:** read S5-F5 before adding any new SQL. Identifier-shaped inputs go through the imported `escapeIdentifier`; everything else binds. There is no "internal callers are trusted" carve-out.

### Migrated rationale (2026-05-28)

The comment at `search/vec-store.ts:16` documents that the virtual-table identifier for `vec_items_384` / `vec_items_1536` is constructed via `escapeIdentifier` rather than a template literal, because the table name is computed from a dim constant — a concrete example of the identifier-binding rule for non-string inputs. The comment at `test/integration/db/disk-full-propagation.test.ts:296` confirms that the integration test covers the `SQLITE_FULL` → `DiskFullError` propagation path through `dbRun`.

---

## I10 — Constant-time comparison for security-sensitive byte strings

**Defense:** every comparison of a hash, signature, MAC, pairing code, or bearer token uses the canonical helpers exported from `packages/gateway/src/util/timing-safe-compare.ts` — never `===` or `!==`, and never a locally-defined `timingSafeEqual` / `constantTimeStringEqual` outside that module.

**Wired at:** `packages/gateway/src/util/timing-safe-compare.ts` (canonical module — single source of truth). Call sites: `extensions/verify-extensions.ts` + `updater/updater.ts` consume `sha256HexEqualConstantTime`; `ipc/lan-pairing.ts` + `ipc/http-auth.ts` consume `constantTimeStringEqual`.

**Anti-pattern:** `if (computed === expected)` for any value that an attacker can probe by timing. S6-F10 / S7-F8 were short-circuit equality on hashes. Redefining a local `timingSafeEqual` or `constantTimeStringEqual` outside `util/timing-safe-compare.ts` is the same anti-pattern — it creates a parallel, untested code path that future changes may regress silently.

**How to comply:** import `sha256HexEqualConstantTime` (for SHA-256 hex strings) or `constantTimeStringEqual` (for arbitrary same-length strings including bearer tokens and pairing codes) from `util/timing-safe-compare.ts`. Never roll a local timing-safe helper; the module's length-mismatch burn cycle and Buffer coercion cover the edge cases.

### Migrated rationale (2026-05-28)

The comments at `util/timing-safe-compare.ts:4–11` and `30–33` document two non-obvious implementation details: (a) `sha256HexEqualConstantTime` returns `false` on invalid hex rather than throwing, because `Buffer.from(hex)` silently drops invalid characters and produces a shorter buffer — the length check catches malformed inputs before reaching `timingSafeEqual`; (b) `constantTimeStringEqual` performs a burn cycle (`timingSafeEqual(aBuf, aBuf)`) on length mismatch so timing observers cannot infer which input was longer or where the inputs diverged. The comment at `util/timing-safe-compare.ts:32` (also triage row for `security-invariants.test.ts:78`) confirms the module is the single canonical source. The comment at `ipc/http-auth.ts:8` notes that `http_api.deployment_token` is a system-level vault key outside `CONNECTOR_VAULT_SECRET_KEYS` by design (§4 of the design doc), and that `constantTimeStringEqual` is used specifically to prevent prefix-difference latency leakage on bearer token comparison. The comment at `extensions/auto-update-apply.ts:4` is an explicit carve-out: `hexEqualIgnoreCase` in that file uses `===` because the hashes compared are public bytes from a manifest — the constant-time requirement only applies to secret-bearing values that an attacker can probe through timing.

---

## I11 — Tool-result envelope on the LLM-facing path

**Defense:** every tool result that flows into an LLM context is wrapped in a textual `<tool_output service="..." tool="...">…</tool_output>` envelope by `wrapToolOutput` in `packages/gateway/src/engine/tool-output-envelope.ts`. Literal `</tool_output>` substrings inside the body are escaped to `<\/tool_output>` so attacker-controlled content cannot terminate the envelope and re-enter "instruction mode".

**Wired at:** the agent's tool wrapper in `packages/gateway/src/engine/agent.ts` (`wrapToolForLlm`) and the lazy-mesh dispatcher in `packages/gateway/src/connectors/lazy-mesh/mesh.ts` (`listTools`). The planner-side `ConnectorDispatcher` returns the bare result on its own path (gated by HITL); the envelope is applied at the LLM-facing boundary only.

**Audit-write complement (Phase 5 T6 PR 2, V29 `tool_call_log`):** at both wiring sites above, the envelope string is also written to `tool_call_log` via `writeToolCallLog` from `packages/gateway/src/db/tool-call-log.ts` (best-effort — internal try/catch swallows `DiskFullError` and constraint violations so an audit-write failure can never break the LLM-facing path). Forensic completeness is best-effort; functional correctness is mandatory. The read surface is `audit.toolCalls` IPC (read-only, IPC-only — NOT LAN-callable per `I5`, NOT in Tauri `ALLOWED_METHODS` per `I7`, NOT exposed via the read-only HTTP API — same exfiltration-class posture as `vault.*`).

**Anti-pattern:** building a new agent surface that calls a tool and feeds the raw result to the LLM. S8-F3 / chain C4 documented exactly this (no envelope present despite the doc claim) — the prompt-injection defense was a soft barrier (LLM-SDK message typing) only. A second-order anti-pattern is wiring `wrapToolOutput` without also calling `writeToolCallLog` — the envelope still works, but the forensic record needed to reconstruct what the LLM saw is silently lost.

**How to comply:** any new LLM-facing tool result goes through `wrapToolOutput` AND `writeToolCallLog` at the same site. The HITL gate is the structural defense for destructive actions; the envelope raises the bar against prompt injection on read-only and conversational paths; the audit-write closes the forensic-reconstruction gap after the fact.

### Migrated rationale (2026-05-28)

The comment at `engine/tool-output-envelope.ts:1–6` provides the B1-audit citation (S8-F3 / chain C4) and explicitly notes that the bare result still flows through the planner path (`ConnectorDispatcher → ToolExecutor`) where HITL is the defense — the envelope is only for the LLM-facing path. The comment at `engine/agent.ts:440` and `446` document the two wiring sites in `agent.ts`: `wrapToolForLlm` (lines 28–41) for Mastra-registered tools, and `mesh.ts:397` for MCP tools exposed via Mastra. The comments at `index/tool-call-log-v29-sql.ts:3,9` document that `tool_call_log` is write-only from the two I11 wiring sites and read-only from `audit.toolCalls` IPC (CLI-only, FORBIDDEN_OVER_LAN per I5, absent from Tauri allowlist per I7). The comment at `test/integration/deployment/i11-envelope.test.ts:2,6` describes the integration test that verifies the envelope is correctly applied on the LLM-facing path without double-wrapping on the planner path. The comment at `agents/_lib/synthesize.ts:42` notes that the synthesis layer receives already-wrapped tool results and must not re-wrap them.

---

## I12 — DPAPI optional entropy on Windows vault entries

**Defense:** the Windows vault implementation (`packages/gateway/src/vault/win32.ts`) loads a per-install entropy blob from `<configDir>/vault/.entropy` (created on first use) and passes it as `pOptionalEntropy` to every `CryptProtectData` / `CryptUnprotectData` call. Other same-uid processes cannot decrypt Nimbus vault blobs without also reading the entropy file.

**Wired at:** `vault/win32.ts` `protect` / `unprotect` paths; legacy entries without entropy are migrated on first read.

**Anti-pattern:** dropping the entropy parameter "for compatibility", or storing the entropy alongside the ciphertext in a way that defeats it. S2-F4 was the original gap (no entropy, any same-uid process could decrypt).

**How to comply:** the entropy blob lives only at `<configDir>/vault/.entropy`; do not mirror it into config files, logs, or IPC responses.

### Migrated rationale (2026-05-28)

No inline comments were mapped to I12 specifically in the triage. No additional subsection needed.

---

## I13 — HTTP write routes go through `WRITE_ROUTE_ALLOWLIST` + bearer auth

**Statement:** HTTP write routes go through a compile-time allowlist + bearer auth; the readonly DB handle never executes writes.

**Wired at:**

- `packages/gateway/src/ipc/http-server.ts` — every write method (POST/PATCH/DELETE) dispatches through `dispatchWriteRoute` (and not the readonly handler). SCIM GET roster reads go through the bearer-checked `dispatchScimRead` read path (reads never write).
- `packages/gateway/src/ipc/http-write-routes.ts` — owns `WRITE_ROUTE_ALLOWLIST` (compile-time, twelve entries: `"POST /v1/deployments"` + the three `/scim/v2/Users` provisioning routes + `"PUT /v1/admin/policy"` (Slice 4 admin console) + `"POST /v1/messaging/teams/events"` (Slice 5 ChatOps Teams inbound) + the two web-clipper routes `"POST /v1/clips"` and `"POST /v1/clips/pair/confirm"` (Slice 9) + the four research-brief routes `"POST /v1/briefs"`, `"POST /v1/briefs/{id}/sources"`, `"POST /v1/briefs/{id}/run"`, `"POST /v1/briefs/{id}/save"` (S1)). `dispatchWriteRoute` selects the per-route bearer token (deployment uses `http_api.deployment_token`; SCIM uses `identity.scim.bearer`; admin-policy uses the admin token) and audit action type; the Teams inbound route authenticates with a Bot Framework JWT validated in-route, not a static bearer, and the clip + brief routes authenticate with a labeled clipper token verified in-route (`POST /v1/clips/pair/confirm` is additionally gated by the I30 owner-opened pairing window).

**Test:** `packages/gateway/src/security-invariants.test.ts` — three sub-asserts:

1. `http-server.ts` imports `dispatchWriteRoute` from `./http-write-routes.ts`.
2. `http-server.ts` opens at most one writable `Database` handle (the write-surface handle, shared by the deployment and SCIM surfaces).
3. `WRITE_ROUTE_ALLOWLIST.length === 12` and contains exactly `"POST /v1/deployments"`, `"POST /scim/v2/Users"`, `"PATCH /scim/v2/Users/{id}"`, `"DELETE /scim/v2/Users/{id}"`, `"PUT /v1/admin/policy"`, `"POST /v1/messaging/teams/events"`, `"POST /v1/clips"`, `"POST /v1/clips/pair/confirm"`, `"POST /v1/briefs"`, `"POST /v1/briefs/{id}/sources"`, `"POST /v1/briefs/{id}/run"`, `"POST /v1/briefs/{id}/save"`.

**Anti-patterns:**

- Opening a second writable `Database` handle in `http-server.ts` outside the server-context wiring.
- Adding a new POST/PUT/DELETE handler that bypasses `dispatchWriteRoute` (e.g. a parallel SCIM dispatcher with its own bearer check — the original Slice 3 implementation did this and was folded into `dispatchWriteRoute`).
- Adding entries to `WRITE_ROUTE_ALLOWLIST` without bumping the count assertion in `security-invariants.test.ts`.

**Why:** before Task 3b the HTTP server's read-only invariant was per-server (`SQLITE_OPEN_READONLY` on the single handle). T4 introduced a narrow write surface (post-deploy annotation), Phase 6 Slice 3 added SCIM provisioning, Slice 4 (Task 18b) added `PUT /v1/admin/policy` (the admin console's signed anchor-policy install — own bearer; the route never parses TOML, deferring to a `policy/`-resident author closure so D16 holds), and Slice 5 added `POST /v1/messaging/teams/events` (the ChatOps Teams inbound webhook, authenticated by a Bot Framework JWT validated in-route against the identity JWKS-cache + RS256 verifier — fail-closed, not a static bearer). All flow through the same `dispatchWriteRoute` pipeline (per-route allowlist + bearer/JWT auth + per-token rate limiting + audit-on-rejection), the structural defense against a same-host process spoofing deploys, provisioning operators, policy bundles, or bot activities. Same rigor as Tauri `ALLOWED_METHODS` (I7).

**Audit cross-reference:** S2 disposition from the plan review — every rejection at the HTTP write boundary writes an audit row via `appendAuditEntry` (`deployment.annotation_rejected` for the deploy route, `scim.provision_rejected` for SCIM), making brute-force probes tamper-evident on the BLAKE3 chain.

### Migrated rationale (2026-05-28)

The comment at `ipc/http-write-routes.ts:2–8` states that the file is the single source of truth for which POST paths `startReadOnlyHttpServer` is permitted to accept, and that the count assertion in `security-invariants.test.ts` must be bumped in the same commit as any new allowlist entry. The comment at `ipc/http-server.ts:323` notes the exact assertion location. The comment at `ipc/http-routes.ts:5,13` documents `READ_ONLY_HTTP_ROUTES` as the parallel source-of-truth for OpenAPI drift detection. The comment at `ipc/http-write-routes.test.ts:15` confirms the test asserts that `dispatchWriteRoute` is the only handler for POST paths. The comment at `ipc/deployment-rpc.ts:5` notes this handler is NOT in the renderer allowlist. The comment at `cli/src/commands/deploy-annotate.ts:14` calls out that the CLI uses the HTTP write surface (not IPC) for the annotate operation — the only CLI command that does so. The comment at `ipc/preflight-rpc.ts:5` and `ipc/people-rpc.test.ts:8` note their respective methods are read-only and do not go through `dispatchWriteRoute`.

---

## I14 — All SQLite write paths route through `dbRun` / `dbExec` / `dbStmtRun`

**Defense:** `dbRun`, `dbExec`, and `dbStmtRun` in `packages/gateway/src/db/write.ts` are the only production paths that invoke `bun:sqlite`'s `Database.run` / `Database.exec` / `Statement.run`. The wrappers translate `SQLITE_FULL` (extended error code 13) into the typed `DiskFullError` and set the `_diskSpaceWarning` flag, so a full disk surfaces as a typed exception rather than a swallowed write.

**Wired at:** `packages/gateway/src/db/write.ts` (`dbRun`, `dbExec`, `dbStmtRun`). Enforced statically by D12 in `scripts/structure-audit/check-nimbus-invariants.ts` — exits 1 on any direct `db.run(` / `db.exec(` outside `DB_RUN_EXEC_ALLOW_LIST` (one entry: the wrapper file itself).

**Anti-pattern:** direct `db.run(` / `db.exec(` / prepared-statement `stmt.run(` in any production file under `packages/gateway/src/` outside `db/write.ts`. Reverting to direct calls means SQLITE_FULL is swallowed silently and the audit chain, sync state, and embeddings can end up half-written without surfacing a typed error to the gateway.

**How to comply:** every new SQL write uses `dbRun(db, sql, params?)`, `dbExec(db, sql)`, or `dbStmtRun(stmt, ...params)`. `bun run audit:invariants` fails fast on regressions; the runtime test in `security-invariants.test.ts` spot-checks three representative subsystems and the allow-list constant.

### Migrated rationale (2026-05-28)

The comments at `ipc/server/options.ts:78,84` document the two database handles opened by the IPC server: the first `SQLITE_OPEN_READONLY` handle for query-only paths, and the second writable handle (added for the HTTP write surface in T4 PR 3b) that flows only through `dispatchWriteRoute`. This is the precise description of the "at most one writable handle" sub-assertion in the I13/I14 enforcement test. The comment at `automation/extension-store.ts:40` notes that extension auto-update state writes go through `dbRun` (I14 compliance). The comment at `perf/surfaces/bench-sqlite-contention.ts:43` documents that the bench harness uses `dbRun` even for perf measurements to avoid bypassing the `SQLITE_FULL` detection path.

---

## I15 — Sandbox runner intrinsic to every extension spawn

**Statement:** **I15 — Sandbox runner intrinsic to every extension spawn.** Every connector spawn under `packages/gateway/src/connectors/lazy-mesh/` flows through `wrapServerSpec(...)` from `connectors/lazy-mesh/wrap-server-spec.ts`, which rewrites the `ServerSpec.command` to invoke `platform/sandbox/sandbox-wrapper.ts`. The wrapper reads the manifest from `NIMBUS_SANDBOX_MANIFEST_JSON` env, calls `createSandboxRunner()`, and invokes `runner.spawn(originalCmd, originalArgs, opts)`. The `SandboxRunner.spawn` site at `platform/sandbox/sandbox-wrapper.ts` is the single sandbox-execution boundary for every extension child process.

**Wired at:**

- `packages/gateway/src/connectors/lazy-mesh/mesh.ts`, `connector-spawns.ts`, `phase3-config.ts`, `user-mcp.ts` — every `ServerSpec` literal is routed through `wrapServerSpec(...)` before reaching MCPClient. No `ServerSpec` constructed under `connectors/lazy-mesh/` escapes the wrapper.
- `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` — defines `wrapServerSpec`, the Option A wrapper-shim layer: it rewrites the `ServerSpec.command` to invoke `bun packages/gateway/src/platform/sandbox/sandbox-wrapper.ts`, preserving the original command/args as wrapper arguments and serializing the per-connector sandbox manifest into the `NIMBUS_SANDBOX_MANIFEST_JSON` env var.
- `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts` — the wrapper process. Parses `NIMBUS_SANDBOX_MANIFEST_JSON`, calls `createSandboxRunner()`, and invokes `runner.spawn(originalCmd, originalArgs, opts)`. This is the **single sandbox-execution boundary** — every extension child process passes through this exact call site, regardless of which lazy-mesh source file authored the original `ServerSpec`.
- `packages/gateway/src/platform/sandbox/sandbox-runner.ts` — defines the `SandboxRunner` interface and the platform dispatcher that selects `linux.ts` / `darwin.ts` / `win32.ts` based on the host OS.

**Anti-pattern:** constructing an MCPClient `ServerSpec` literal under `connectors/lazy-mesh/` without routing it through `wrapServerSpec(...)`. Bypassing the wrapper means the child process is spawned with the raw command/args and **no sandbox is applied** — landlock/seccomp on Linux, seatbelt on macOS, Job Objects on Windows are all skipped. Caught by both the runtime I15 test in `security-invariants.test.ts` (greps each lazy-mesh file for `wrapServerSpec(`) and the static `D10` rule in `scripts/structure-audit/check-nimbus-invariants.ts` (exits 1 on any `ServerSpec` literal that does not pass through the wrapper).

**Why Option A (wrapper-shim) rather than direct `runner.spawn` calls at every site:** the wrapper-shim is the single sandbox boundary. If we instead asked every spawn site to call `runner.spawn` directly, a future contributor could add a new spawn that forgot the wrapping and the runtime test would have to grow with every new call site. The wrapper-shim collapses N lazy-mesh spawn sites into one boundary (`sandbox-wrapper.ts:runner.spawn(...)`) — so the invariant is "any `ServerSpec` constructed in lazy-mesh is wrapped" rather than "every spawn site individually applies a sandbox". One boundary, one test pattern, one anti-pattern to catch.

**Enforcement test:** `packages/gateway/src/security-invariants.test.ts` — asserts every lazy-mesh source file imports and calls `wrapServerSpec`, and asserts `sandbox-wrapper.ts` calls `runner.spawn(`. Static-audit complement at `D10` in `scripts/structure-audit/check-nimbus-invariants.ts` runs before the test suite (same pattern as `I1` and `I14`).

**Audit cross-reference:** Phase 5 T2 PR 1 — sandbox + marketplace v2 sequencing. The wrapper-shim architecture is the Task 13 amendment to the original Task 16/17 plan ("every spawn under `connectors/` reaches `sandboxRunner.spawn`"); Option A was chosen to keep the invariant single-pointed instead of N-pointed.

### Migrated rationale (2026-05-28)

The comment block at `connectors/lazy-mesh/wrap-server-spec.ts:1–25` documents the "why" of the wrapper-shim in detail: `@mastra/mcp@1.7.0`'s `MCPClient` uses `StdioClientTransport` which calls `child_process.spawn`-equivalent machinery with no public hook for intercepting the fork; `wrapServerSpec` works around this by rewriting `ServerSpec.command` to re-execute the gateway executable itself in its `__nimbus-sandbox` role (via `selfSpawn`), with the original command and arguments following the sentinel. It previously pointed at `sandbox-wrapper.ts` under `process.execPath`, which does not exist inside a `--compile` binary. It also documents the env contract: `NIMBUS_SANDBOX_MANIFEST_JSON` and `NIMBUS_SANDBOX_CWD` are consumed and stripped by the wrapper so a re-exec cannot re-enter the wrapper. The comment at `connectors/lazy-mesh/connector-spawns.ts:49–53` warns specifically that `ctx.sandboxCwd` thread-through is load-bearing — dropping it leaves phase-3 servers unwrapped and silently fails the I15 test. The comment at `platform/sandbox/sandbox-runner.ts:8` notes that the env parameter passed to `SandboxRunner.spawn` must be the output of `extensionProcessEnv(...)` (I1), coupling I1 and I15. The comments at `connectors/lazy-mesh/mesh.test.ts:191,248,396`, `connector-spawns.test.ts:9,208,209,251,365`, and `phase3-config.test.ts:12` confirm the test suite structure for I15 coverage. The comment at `platform/sandbox/seccomp-filter.ts:2` notes the seccomp BPF filter is AUDIT_ARCH_X86_64-guarded and should not be loaded on non-x86-64 Linux. The comment at `connectors/lazy-mesh/first-party-manifests.ts:10,12` explains that `FIRST_PARTY_MANIFESTS` is the static registry of per-service sandbox permission declarations that `manifestForFirstParty(serviceId)` resolves at spawn time. The comment at `connectors/lazy-mesh/slot.ts:43` documents the `MeshSpawnContext.sandboxCwd` field as the working-directory anchor for every I15-wrapped spawn.

---

## I16 — Verified-publisher signature

**Statement:** **I16 — Verified-publisher signature.** Every installed extension whose `nimbus.extension.json` declares a `publisher` field carries an Ed25519 signature over the canonicalized manifest (with the `signature` field stripped). The signature is verified at TWO sites — install time AND every Gateway startup — before the extension is allowed to spawn. Extensions without a `publisher` field are treated as pre-T2 unsigned and surface as `(unverified)` in CLI output; the signature pass is a no-op for them.

**Wired at:**

- `packages/gateway/src/extensions/install-from-local.ts` `completeExtensionInstallAfterCopy` — after copying the source directory into the extensions root, the function parses the on-disk manifest, and if the manifest carries `publisher` it calls `resolvePublisherKey(...)` (priority chain: `--publisher-key` file → vault cache → registry fetch) followed by `verifyManifestSignature(...)`. On success, the resolved pubkey is written to the vault under `extension.publisher_key.<id>` and an `extension.signature_verified` audit row is appended. On any failure the install is refused and an `extension.signature_failed` row is appended.
- `packages/gateway/src/extensions/verify-extensions.ts` `verifyExtensionsBestEffort` — when called with `{ vault }` (production wiring in `platform/assemble.ts:assembleGateway`), the signature pass iterates every enabled extension whose on-disk manifest carries `publisher`, reads the cached pubkey from `extension.publisher_key.<id>`, and calls `verifyManifestSignature(...)`. On any failure (missing vault key, invalid signature, malformed signature) the row is flipped `enabled = 0` via `setExtensionEnabled(db, id, false)`, the structured reason is recorded in the in-memory `SignatureDisabledRegistry` singleton (parallel to PR 1's `PreT2DisabledRegistry`), and the running extension child process is stopped via the mesh. One batched `extension.startup_verification` audit row is appended per Gateway run.
- `packages/gateway/src/extensions/hard-disable.ts` `SignatureDisabledRegistry` — the singleton that tracks `extension_id → SignatureDisableReason`. Reset at the top of every signature pass. Consumed by `nimbus extension list` / `nimbus extension info` for the `(unverified)` / disabled-reason badge and by `diag.snapshot` for `signature_disabled_count`.
- The primitive `verifyManifestSignature(manifest, resolvedPubkey)` lives in the external **`@nimbus-dev/sdk`** package (`crypto/verify-signature.ts`, MIT) so connector authors can sign their own manifests without an AGPL dep. Gateway imports through the thin re-export shim at `packages/gateway/src/extensions/verify-signature.ts`.

**Anti-pattern:** adding a new install path that copies an extension into place without calling `verifyManifestSignature(...)` on a signed manifest; adding a new startup verification path that calls `verifyExtensionsBestEffort` without passing `{ vault }` (the signature pass is gated on `signatureOpts !== undefined`); storing the publisher pubkey anywhere other than the `extension.publisher_key.<id>` vault namespace (the D11 audit allow-list enforces the namespace, and any second cache would race with the canonical one).

**Enforcement test:** `packages/gateway/src/security-invariants.test.ts` carries three assertions:

1. **Static grep** — both `install-from-local.ts` and `verify-extensions.ts` contain `verifyManifestSignature(`.
2. **Behavioral #1** — a signed extension with no cached vault key is hard-disabled at startup with reason `publisher_key_missing`.
3. **Behavioral #2** — a manifest tampered after signing (with the `manifest_hash` column re-stamped so PR 1's SHA-256 sweep doesn't catch the row first) is hard-disabled at startup with reason `signature_failed`.

The behavioral pair catches the "wired but doesn't actually disable" failure mode that pure source-grep can't see (the gap that motivated the I16 enforcement triple shape).

**Audit cross-reference:** Phase 5 T2 PR 2 — verified publisher (Ed25519-signed manifests). The spec was originally locked at OpenPGP / `openpgp.js` in the parent T2 sequencing doc; the brainstorm round on 2026-05-17 switched to Ed25519 + embedded signature to keep the crypto stack uniform with the updater (Phase 4 WS4) and LAN pairing (NaCl box), drop the `openpgp.js` (~250 KB) dependency, and sidestep the OpenPGP v4/v5 fingerprint debate.

### Migrated rationale (2026-05-28)

The comments at `extensions/install-from-local.ts:120,404,556,558` document the install-time verification flow: verification fires only when `manifest.publisher !== undefined`; it requires both `vault` and `fetcher` to be wired (throwing if missing); the priority chain for resolving the publisher key is `--publisher-key` file → vault cache → registry fetch; on success the resolved pubkey is written to vault under `extension.publisher_key.<id>`. The comments at `extensions/verify-extensions.ts:162,402,421,468` document the startup-verification pass: it is a no-op when `signatureOpts === undefined` (unsigned extensions skip silently); failures flip `enabled = 0`, record the reason in `SignatureDisabledRegistry`, and optionally stop the running child via `mesh.stopExtensionClient`. The comment at `extensions/verify-signature.ts:6` clarifies that the canonical primitive lives in `@nimbus-dev/sdk` (MIT-licensed) so connector authors can sign their own manifests without an AGPL dependency; the gateway re-exports through a thin shim. The comment at `extensions/auto-update-orchestrate.ts:50` documents that the auto-update orchestrator re-runs signature verification on the newly downloaded version before activating it — a third verification site beyond the documented two. The comment at `extensions/auto-update-rpc.ts:24` confirms that the auto-update RPC uses `extension.autoUpdate` / `extension.downgrade` action types (HITL-gated per I2). The comments at `sdk/src/crypto/canonical-json.ts:4,56` and `sdk/src/crypto/verify-signature.ts:4` document the canonical JSON serialization used as the signing input: the `signature` field is stripped before serialization, field order is deterministic (sorted by key), and the encoding is UTF-8 without BOM. The comment at `test/e2e/scenarios/dependency-lifecycle.e2e.test.ts:43` confirms that the E2E test suite exercises I16 through the full install → startup → verify lifecycle. The comment at `scripts/package-linux-installers.ts:339` notes that the installer build signs first-party manifests with the release keypair.

---

## I17 — Federated answering is intrinsic to the query gate

**Statement:** `answerFederatedQuery` in `federation/query-gate.ts` is the ONLY function that answers an inbound `federation.query`; it is the ONLY federation module that imports the item-list read path (`item-list-query`). It enforces grant + role + consent + the namespace's declared filter, returns only the leak-proof `FederatedItem` shape (never `metadata`/`author_id`/`external_id`), and audits every outcome into the Blake3 chain. Over the LAN wire only `federation.query` and `federation.expertise` are admitted (I5); all management methods (`federation.namespace.publish/grant/revoke`, `federation.pair`, `federation.peers`, `federation.discover`) are local/Tauri-only.

**Wired at:**

- `packages/gateway/src/federation/query-gate.ts` `answerFederatedQuery` — the sole function that reads index items in response to a peer query. Enforces the grant table, role check, consent gate, namespace filter, and the `FederatedItem` projection.
- `packages/gateway/src/ipc/lan-rpc.ts` `FORBIDDEN_OVER_LAN` — the management methods (`federation.namespace.publish`, `federation.namespace.grant`, `federation.namespace.revoke`, `federation.pair`, `federation.peers`, `federation.discover`) **and** the local-only owner/asker methods (`federation.consentRespond`, `federation.ask`, `federation.askExpertise`) are listed here, leaving only `federation.query` and `federation.expertise` admitted over the wire (I5). `federation.consentRespond` is the owner's local consent-decision reply; `federation.ask`/`federation.askExpertise` are local asker entrypoints that *send* a query over the wire but are never *answered* over it.
- Enforced statically by **D13** in `scripts/structure-audit/check-nimbus-invariants.ts` — any federation module other than `query-gate.ts` that imports `item-list-query` causes `audit:invariants` to exit 1.
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I17` describe block.

**Anti-pattern:** a federation module other than `query-gate.ts` that imports `item-list-query` (or otherwise reads index items to answer a peer), bypassing the gate's declared-filter / consent / audit chain. Note: `peer-pairing.ts` legitimately imports `LocalIndex` for the lan_peers registry — that is NOT an item-answer path and is not blocked. `expertise.ts` reads a content-free `COUNT(*)` and returns only a rank — also fine.

**How to comply:** any new path that answers a peer's data request must be routed through `answerFederatedQuery` in `query-gate.ts`, never by adding a second item-read import in another federation module.

**Over-the-wire path (Slice 1 follow-up, delivered 2026-06-05):** the over-the-wire answering path is now live. `buildFederationLanServer` in `federation/federation-server.ts` constructs a `LanServer` that is started at gateway boot from `platform/assemble.ts` (gated on `[federation].enabled`, transport from `[lan]`). Its `onMessage` handler routes inbound `federation.query` / `federation.expertise` through `query-gate.ts`. Critically, the answering `peerId` is **forced** from the NaCl-authenticated session (`const forced = { ...body, peerId: peer.peerId }` — R1): a body-supplied `peerId` field is silently overwritten and cannot impersonate another peer. A regression that drops this override will fail the I17/R1 test in `security-invariants.test.ts`.

---

## I18 — IdP ID-token validation is intrinsic to the identity verifier; raw tokens are Vault-only

**Statement:** `identity/verifier.ts` (`IdTokenVerifier.validateIdToken`) is the ONLY module that validates an IdP ID token — RS256 signature via Bun WebCrypto, plus `iss`/`aud`/`exp`/`nbf` checks against the configured issuer and client. Raw tokens (`identity.oidc.id_token`, `identity.oidc.refresh_token`, `identity.scim.bearer`) live ONLY in the Vault, never on an IPC/wire shape, a DB column, a log line, or config. The federation query gate consults the pure, synchronous `isOperatorValid()` before answering a peer whenever identity is enabled, so a deprovisioned or expired operator session fails federation closed.

**Wired at:**

- `packages/gateway/src/identity/verifier.ts` `IdTokenVerifier.validateIdToken` — the sole ID-token validation path (RS256 only). `isOperatorValid()` in the same file is the federation gate's single, no-network operator-validity question.
- `packages/gateway/src/federation/query-gate.ts` — `answerFederatedQuery` consults `isOperatorValid()` before answering when identity is enabled.
- `packages/gateway/src/identity/identity-vault.ts` — the only module that constructs the `identity.oidc.*` / `identity.scim.bearer` Vault keys; tokens never leave the Vault.
- Enforced statically by **D14** in `scripts/structure-audit/check-nimbus-invariants.ts` — any file outside `packages/gateway/src/identity/` (and not a `.test.ts`) that references an identity token Vault-key string literal causes `audit:invariants` to exit 1.
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I18` describe block (Tauri allowlist surface for the identity/scim read+login methods, size assertion 94, and the query-gate `isOperatorValid` consult).

**Anti-pattern:** validating an ID token anywhere other than `verifier.ts`; placing a token field on an IPC/wire/notification shape or a DB column; reading `identity.oidc.*` / `identity.scim.bearer` outside `identity/`; a federation answer path that skips the `isOperatorValid()` consult when identity is enabled. Note: the renderer-callable surface exposes only the read/login methods (`identity.login`/`status`/`logout`/`listBindings`, `scim.status`/`listUsers`); the credential-mutating methods (`identity.bind`/`unbind`, `scim.setToken`/`deprovision`) stay CLI-only and out of the Tauri allowlist (I7).

**How to comply:** route every ID-token check through `IdTokenVerifier.validateIdToken`; keep raw tokens in the Vault via `identity-vault.ts`; have any new peer-answer path consult `isOperatorValid()` when identity is enabled.

---

## I19 — team-vault secret injection is intrinsic to the invoke gate; leak-proof and fail-closed

**Statement:** A team-scoped credential is consumed ONLY through `federation/invoke-gate.ts` (`answerFederatedInvoke`): identity (I18) → live RBAC grant check → quorum (if configured) → run the tool. The gate is **principal-polymorphic** — the principal is either an inbound **peer** (the federated path) or the **local operator** (a single gateway whose own `[connectors.<name>] credential = "team"` warehouse/BI sync sources its secret from Team Vault); both reach the identical fail-closed secret chokepoint. The secret bytes are never in the gate's scope — they are read from the OS Vault under the `teamvault.<entry>.<connectorKey>` keyspace and injected into an EPHEMERAL connector subprocess's env by `teamvault/team-tool-invoke.ts` (`invokeTeamTool` for a single call, `invokeTeamToolList` for a paginated `_list` drain over one `teamvault/connector-session.ts` session) + `teamvault/team-tool-spawn.ts`, which reuse the existing per-service spawners (so `extensionProcessEnv` (I1) and `wrapServerSpec` (I15) still apply). The gate returns only the leak-proof result (`{ ok, result }` for a peer; the drained items for a local-operator list); the secret is never returned, logged, or placed on any outbound payload or indexed row. The path is **fail-closed**: a missing team secret, an OAuth-only/unknown service, or a missing grant aborts BEFORE any spawn — it never falls through to the operator's own local credential.

**Wired at:**

- `packages/gateway/src/federation/invoke-gate.ts` `answerFederatedInvoke` — the sole consumption path; consulted by `federation.invoke` in `ipc/federation-rpc.ts`.
- `packages/gateway/src/teamvault/team-tool-invoke.ts` — fail-closed secret resolution (`invokeTeamTool` + the paginated `invokeTeamToolList`); the secret value never enters this scope or the return.
- `packages/gateway/src/teamvault/connector-session.ts` — the spawn-once / N-calls primitive (`withConnectorSession`) that binds the secret to a single ephemeral connector session for the whole drain.
- `packages/gateway/src/teamvault/team-vault-view.ts` — read-only Vault overlay scoping reads to one entry's keyspace; never falls through to the operator's key, never writes.
- `packages/gateway/src/teamvault/team-vault-keys.ts` — the ONLY module that composes the `teamvault.` Vault-key prefix.
- Enforced statically by **D15** in `scripts/structure-audit/check-nimbus-invariants.ts` — any file outside `team-vault-keys.ts` (non-test) that composes the `"teamvault."` key prefix literal causes `audit:invariants` to exit 1.
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I19` describe block (gate routing + fail-closed-before-spawn).

**Anti-pattern:** reading a team secret into the gate/IPC scope or returning it; running a team tool with the operator's own credential when the team secret is absent; composing a `teamvault.` key outside `team-vault-keys.ts`; a team-tool path that bypasses `answerFederatedInvoke`.

**How to comply:** add team-tool execution only behind `answerFederatedInvoke`; resolve team secrets only via the read-only view; keep the `teamvault.` prefix in `team-vault-keys.ts`; fail closed on any missing input.

---

## I20 — a delegated HITL approval is honored only from a live, in-scope, identity-valid delegate

**Statement:** When a HITL action is routed to a delegate, `engine/delegated-approval.ts` (`resolveDelegatedApproval`) honors the remote answer ONLY when the answering peer is (a) a live, in-scope delegate per the `DelegationStore` and (b) identity-valid (I18). A forged peer id, an invalid operator identity, or a timeout/offline delegate all return `fallback_to_owner`, which routes back to the local owner consent prompt. The wire is never trusted; the executor gate (`engine/executor.ts`) consults this before falling back, preserving I2/I3/I4.

**Wired at:**

- `packages/gateway/src/engine/delegated-approval.ts` `resolveDelegatedApproval` — the authority check.
- `packages/gateway/src/engine/executor.ts` `gate()` — tries delegation before the local prompt; honors only `approved`/`rejected`, else falls back.
- `packages/gateway/src/engine/delegation-store.ts` — live-checked, time-boxed, revocable delegations.
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I20` describe block (forged peer / invalid identity / timeout all fall back).

**Anti-pattern:** honoring a remote approval based on a body-supplied peer id, without an active-delegate check, or without the identity-valid check; treating a timeout as an approval.

**How to comply:** every delegated approval goes through `resolveDelegatedApproval`; never trust a wire-supplied responder identity for the authority decision.

---

## I21 — quorum counts only DISTINCT authenticated peers; a denial fails closed

**Statement:** `engine/quorum/quorum-coordinator.ts` (`QuorumCoordinator`) resolves `approved` only after N **distinct** peer ids approve within the window — a `Set` dedupes, so the same peer voting twice cannot satisfy a 2-of-N quorum. A single explicit denial aborts immediately (`denied`), and window expiry yields `failed`. The responder peer id is the NaCl-authenticated session id forced by the LAN transport (I17/R1) — never trusted from the request body — so a remote peer cannot impersonate a second approver.

**Wired at:**

- `packages/gateway/src/engine/quorum/quorum-coordinator.ts` — distinct-peer `Set`, deny-aborts, window timeout.
- `packages/gateway/src/ipc/federation-rpc.ts` `federation.quorumRespond` — feeds the coordinator with the transport-forced authenticated peer id.
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I21` describe block (a peer approving twice does not satisfy a 2-of-N quorum).

**Anti-pattern:** counting approvals by request count rather than distinct peer id; trusting a body-supplied responder id for quorum; treating a timeout or a partial set as approval.

**How to comply:** count distinct authenticated peers only; force the responder id from the authenticated session; fail closed on denial or timeout.

---

## I22 — org policy applied only from a signature-verified bundle, resolved monotonic-stricter

**Statement:** An org policy bundle (`nimbus.policy.toml` + detached Ed25519 signature) is applied ONLY after its signature verifies against the locally-pinned anchor pubkey, and it can only **tighten** the local baseline — never loosen it. Resolution is **monotonic-stricter**: retention takes `max(baseline, policy)`, the required-HITL set is a union (policy adds, never removes), and quorum takes the stricter approver count + the shorter window. A tampered, unsigned, or wrong-key bundle is rejected and the gate falls back to the last-valid policy or the local baseline — **fail-closed** (an unverified policy never relaxes a control). Enforcement sites read the resolved `EnforcedPolicy` from `policy/policy-gate.ts`; no site outside `policy/` re-parses the raw policy TOML (which would bypass both the signature check and the stricter-resolution).

**Wired at:**

- `packages/gateway/src/policy/policy-signing.ts` — `signPolicy` / `verifyPolicy`: detached Ed25519 over the canonical policy bytes.
- `packages/gateway/src/policy/policy-gate.ts` — `verifyCandidate` (verify-then-parse; returns `null` on bad signature), `computeEnforced` (pure monotonic-stricter resolution), and `PolicyGate.rehydrate` (a persisted copy that fails verification leaves the gate ungoverned → baseline; fail-closed).
- `packages/gateway/src/policy/policy-store.ts` — pinned anchor pubkey + persisted last-valid bundle.
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I22` describe block: (a) a tampered policy is rejected and the gate falls back to baseline retention; (b) a valid policy below baseline cannot weaken HITL/quorum/retention.
- Enforced statically by **D16** in `scripts/structure-audit/check-nimbus-invariants.ts` — any file outside `packages/gateway/src/policy/` (and not a `.test.ts`) that imports/uses `parsePolicyToml` causes `audit:invariants` to exit 1, forcing enforcement to read `EnforcedPolicy` via `policy-gate.ts`.

**Anti-pattern:** applying a policy whose signature was not checked (or checked against a non-pinned key); resolving policy values by overwrite rather than stricter-wins (letting a policy *lower* retention, *shorten* nothing while *removing* a required-HITL action, or *reduce* a quorum); re-parsing the raw `nimbus.policy.toml` at an enforcement site (bypasses verification + resolution); treating a missing/invalid bundle as "no constraints" instead of falling back to the last-valid/baseline floor.

**How to comply:** apply policy only through `verifyCandidate` + `PolicyGate`; read controls only via `PolicyGate.enforced()` (the `EnforcedPolicy` view); keep `parsePolicyToml` confined to `policy/`; ensure every resolution is monotonic-stricter and every failure path falls back to the local baseline.

---

## I23 — ChatOps operational posts are bounded to server-derived destinations

**Statement:** ChatOps operational (non-HITL) posts go only through `chatops/reply-dispatcher.ts` to a server-derived `ReplyTarget` — either the originating message's channel (`kind: "originating"`) or a policy-declared `notify` channel for a namespace (`kind: "namespaceNotify"`). The destination is NEVER a caller-supplied raw channel. Arbitrary-destination posting (e.g. to an attacker-controlled channel) remains reachable only via the HITL-gated `*.message.post` action types (I2). No other chatops module may reference the connector post tools (`slack_chat_post` / `teams_chat_post`) directly. Static **D17**.

**Wired at:**

- `packages/gateway/src/chatops/reply-dispatcher.ts` `ReplyDispatcher.send()` — the sole operational post path; takes a `ReplyTarget` (server-derived, not caller-supplied) and posts only to the channel it names.
- Enforced statically by **D17** in `scripts/structure-audit/check-nimbus-invariants.ts` — any file outside `packages/gateway/src/chatops/reply-dispatcher.ts` and `packages/gateway/src/chatops/transport/` (excluding `.test.ts` files) that references `slack_chat_post` or `teams_chat_post` causes `audit:invariants` to exit 1.
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I23` describe block: (a) `ReplyDispatcher.send` signature takes a `ReplyTarget` (not a raw channel); (b) no chatops module outside `reply-dispatcher`/`transport/` references the connector post tools.

**Anti-pattern:** accepting a destination channel as a command/tool argument on the operational path; importing `slack_chat_post` or `teams_chat_post` outside `reply-dispatcher.ts` or `transport/`; introducing a second "fast-path" post helper that bypasses `ReplyDispatcher.send`.

**How to comply:** all chatops post calls go through `ReplyDispatcher.send(target, text)` where `target` is a server-derived `ReplyTarget`. Arbitrary-destination posts (channel id from a user command) must be routed through the HITL-gated `*.message.post` action type (I2) instead.

---

## I24 — a federated preflight executes only behind the LOCAL owner's HITL gate

**Statement:** An inbound `federation.preflight` (blast-radius preflight) request executes only behind the LOCAL owner's HITL approval, never on the caller's say-so. The command that runs is resolved ONLY from the downstream owner's local `nimbus.toml` (`[federation.preflight."<ns>"]`) — the caller-supplied request never selects or supplies the command, and a missing local command fails closed (`not_configured`). The request is validated (git-ref allowlist + bounded `changedSurface` symbols) BEFORE the HITL prompt is raised; an ungranted peer or identity-invalid operator gets an opaque `no_grant`. The configured command runs inside the per-OS sandbox (`createSandboxRunner`, I15) with the validated params passed as env vars only (never shell-interpolated, never as filesystem paths); a hard timeout kills it. The result is leak-proof (`{ passed, summary }`, no paths/bodies). Static **D18**.

**Wired at:**

- `packages/gateway/src/federation/preflight-gate.ts` `answerFederatedPreflight()` — the SOLE path from an inbound `federation.preflight` to a sandbox spawn: identity (I18) → request validation → peer grant → resolve-LOCAL-command → `PreflightConsentBroker` approval → `runPreflightCommand` (sandbox). Every outcome is audited.
- `packages/gateway/src/federation/preflight-runner.ts` `runPreflightCommand()` — the only sandbox-spawn site for a preflight; builds a manifest granting only the locally-configured `cwd`, passes validated params as env, enforces the hard timeout.
- Enforced statically by **D18** in `scripts/structure-audit/check-nimbus-invariants.ts` — any file outside `preflight-gate.ts` / `preflight-runner.ts` (excluding `.test.ts`) that references `runPreflightCommand` causes `audit:invariants` to exit 1.
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I24` describe block: the gate never calls `runCommand` before approval resolves, ignores a caller-supplied `command` field (only the configured command runs), fails closed when no command is configured, and rejects an invalid ref / oversized surface before HITL; plus a `D18` presence assertion.

**Anti-pattern:** reading a command (or any part of one) from the inbound request; spawning the preflight command outside `runPreflightCommand`; running before the `PreflightConsentBroker` approval resolves; passing request params as shell arguments or filesystem paths; returning file contents/paths in the result.

**How to comply:** route every inbound preflight through `answerFederatedPreflight`; resolve the command only via the local-config `resolveCommand` dep; gate the spawn behind `requestApproval`; run via `runPreflightCommand`; keep the result shape `{ passed, summary }`.

---

## I25 — a tribal-knowledge KB capture writes only the config destination, behind the owner's HITL gate

**Statement:** Capturing a repeated-question Q&A into a shared knowledge base writes ONLY to the destination pinned in the local owner's `nimbus.toml` (`[tribal.notion].database_id` / `[tribal.confluence].space_key` + `parent_page_id`), and only after the LOCAL owner approves it at the executor HITL gate. The caller (CLI `--target` or an in-chat trigger) supplies at most a KB *selector* (`notion` | `confluence`) — never the destination database/space/parent. An unconfigured target fails closed (`not_configured`) before any action is submitted; a rejected HITL leaves the cluster uncaptured. The write reaches the connector mesh only via the HITL-gated `notion.knowledge.write` / `confluence.knowledge.write` action types, whose tool ids (`notion_kb_append` / `confluence_kb_append`) are confined to the write-gate + the two connector definition sites. Static **D19**.

**Wired at:**

- `packages/gateway/src/tribal/tribal-write-gate.ts` `captureToKnowledgeBase()` — the SOLE path from a capture trigger to a KB write: resolve the target (explicit selector, else the sole configured KB, else `not_configured`/`target_ambiguous`) → resolve the destination from `cfg.notion`/`cfg.confluence` ONLY → synthesize a draft → submit a `PlannedAction` (`*.knowledge.write`, payload carries the config destination + `mcpToolId`) through the executor HITL gate (I2) → on approval + a returned `pageRef`, `markCaptured`. The destination is never read from caller input. The `notion_kb_append`/`confluence_kb_append` literals appear only here (gateway side).
- `packages/gateway/src/ipc/server/dispatchers.ts` `tryDispatchTribalRpc()` — builds the capture executor PER-CALL with the initiating client's consent channel (the local owner who ran `nimbus tribal capture`), so the HITL prompt reaches the operator who triggered it.
- `packages/gateway/src/engine/executor.ts` — `notion.knowledge.write` / `confluence.knowledge.write` are members of `HITL_REQUIRED_BACKING` (I2), so the gate always fires before the connector dispatch.
- Enforced statically by **D19** in `scripts/structure-audit/check-nimbus-invariants.ts` — any file outside `tribal-write-gate.ts` / the two connector `server.ts` (excluding `.test.ts`) that references `notion_kb_append`/`confluence_kb_append` causes `audit:invariants` to exit 1.
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I25` describe block: the submitted action's destination is the config `databaseId` (never a caller value), an unconfigured target fails closed without submitting, a rejected HITL leaves the cluster `pending`, plus a `D19` presence assertion.

**Anti-pattern:** reading the destination database/space/parent from caller input; calling `notion_kb_append`/`confluence_kb_append` from anywhere but the write-gate; writing before the owner's HITL approval resolves; marking a cluster captured without a returned `pageRef`.

**How to comply:** route every capture through `captureToKnowledgeBase`; resolve the destination only from `cfg.notion`/`cfg.confluence`; submit through the executor gate; keep the result leak-proof (`{ ok, pageRef }` / a coarse error code).

---

## I26 — connector writes (warehouse/BI ∪ GitOps/ML) execute only behind the local HITL gate; the federated invoke gate rejects them

**Statement:** Connector write actions — warehouse/BI (Snowflake tag/comment set, Tableau / Power BI refresh, Looker datagroup/schedule trigger, Monte Carlo / Bigeye incident-issue acknowledge/resolve) **and** GitOps/ML (ArgoCD app sync/rollback, Flux kustomization/helmrelease reconcile, MLflow model promote/transition-stage) — execute ONLY behind the LOCAL owner's executor HITL gate (I2): their action types are all members of `HITL_REQUIRED_BACKING`. The federated peer invoke gate (`answerFederatedInvoke`) is fail-closed against any write-classified tool id via the injected `isWriteForbiddenToolId` predicate (the union `isConnectorWriteToolId`): a peer's `federation.invoke` for a connector write is rejected with a `write_forbidden` audit decision before any connector dispatch, so a teammate can never trigger a connector write over the wire. The write tool ids themselves are confined to the two single-source-of-truth modules (`connectors/warehouse-write-tools.ts`, `connectors/gitops-ml-write-tools.ts`), the connector definition `server.ts` files, and the gateway transport/dispatch sites. Static **D20**.

**Wired at:**

- `packages/gateway/src/connectors/warehouse-write-tools.ts` + `packages/gateway/src/connectors/gitops-ml-write-tools.ts` — the per-group SSoTs (`WAREHOUSE_BI_WRITES` / `GITOPS_ML_WRITES`, each a `ConnectorWrite` `{ actionType, toolId, service }`), their tool-id sets, and the `isWarehouseWriteToolId` / `isGitopsMlWriteToolId` predicates. Kept in drift-sync with `HITL_REQUIRED_BACKING` in `executor.ts` (asserted in `connector-write-registry.test.ts`).
- `packages/gateway/src/connectors/connector-write-registry.ts` — the union: `CONNECTOR_WRITES`, the `isConnectorWriteToolId(toolId)` predicate, and `connectorWriteByActionType(type)`.
- `packages/gateway/src/engine/executor.ts` — every connector write `actionType` is a member of `HITL_REQUIRED_BACKING` (I2), so the local executor gate always fires before connector dispatch.
- `packages/gateway/src/ipc/federation-rpc.ts` `"federation.invoke"` — injects `isWriteForbiddenToolId: isConnectorWriteToolId` into the `answerFederatedInvoke` ctx, so the gate rejects connector writes asked for by a peer.
- `packages/gateway/src/federation/invoke-gate.ts` `answerFederatedInvoke()` — consults `ctx.isWriteForbiddenToolId?.(q.toolId)`; on a match it records a `write_forbidden` audit decision and returns fail-closed without invoking the tool.
- Enforced statically by **D20** in `scripts/structure-audit/check-nimbus-invariants.ts` — any file outside the SSoT / connector / transport-dispatch allow-list (excluding `.test.ts`) that references a connector write tool id causes `audit:invariants` to exit 1 (`D20-connector-write`); additionally `invoke-gate.ts` must reference `isWriteForbiddenToolId` or the check fails (`D20-invoke-gate-predicate`).
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I26` describe block: federation-rpc wires `isWriteForbiddenToolId`/`isConnectorWriteToolId`, the invoke gate consults the predicate and emits `write_forbidden`, every `CONNECTOR_WRITES` action type is HITL-gated, plus a `D20` presence assertion. A functional rejection of a GitOps write id via the real `isConnectorWriteToolId` lives in `federation/invoke-gate.test.ts`.

**Anti-pattern:** exposing a connector write over `federation.invoke` without the predicate; calling a connector write tool id from anywhere but the SSoT / connector / transport-dispatch sites; adding a connector write action type to a connector without adding it to `HITL_REQUIRED_BACKING` + the matching group SSoT.

**How to comply:** keep the group SSoTs (`WAREHOUSE_BI_WRITES` / `GITOPS_ML_WRITES`) and `HITL_REQUIRED_BACKING` in sync; route every connector write through the local executor gate; pass `isWriteForbiddenToolId: isConnectorWriteToolId` to any federated invoke ctx; never name a write tool id outside the allow-listed sites.

---

## I27 — an outbound share leaves the machine only through the share-gate, behind the owner's HITL approval of the exact redacted bytes

**Statement:** This is the one subsystem in Nimbus that deliberately emits indexed data *outward*; every other invariant keeps data local. An outbound share therefore leaves the machine only through `share/share-gate.ts` `createShare()` (for origin shares) or `share/share-forward.ts` `forwardShare()` (for re-forwarding a received share to a peer) — both paths require the LOCAL owner's approval of the exact redacted/forwarded preview bytes via the `share.publish` HITL action (a member of the I2 `HITL_REQUIRED_BACKING` frozen set — no `--yes` skip). For origin shares: default + caller redaction is applied (secrets + the share PII families), the body is signed with the Vault-only `share.signing.privkey` Ed25519 seed, the share is persisted to `share_records` (V41), and the applied redaction-set is audit-logged. For forwarded shares (Wave 8d): the origin's `body`+`sig` are carried byte-identical (verifiable against the origin's pubkey at any hop), and the forwarder appends its own hop record — `{ gatewayLabel, pubkey, sig }` where `sig` covers `contentHash ++ the hop's own label+pubkey ++ JSON(prior-chain)` — to the advisory `forwarding.chain` (incrementing `forwarding.hops`); the forwarder signs with its **own** Ed25519 share-signing key obtained via `ensureShareKeypair(vault)` (no new Vault key). A rejected or timed-out approval signs nothing, persists no share row, and emits nothing — it writes ONLY a `rejected` audit-log entry (fail-closed). Receiving a forwarded share is inert: the inbound share is sig-verified then stored in `share_inbox` (V43) and never auto-merged into the index, auto-executed, or embedded — this is a tested property (the `receiveForwardedShare — inert inbound` block in `share-forward.test.ts` + a real-wire e2e), not a new invariant.

**Replay is the one path where a share's contents cause local execution, and it is gated three ways.** `share.replay` (owner-initiated — never automatic) runs the tool calls a share names against the owner's live, credentialed connector mesh, so the file is untrusted input in the strongest sense: it can arrive as a pasted URL or via `federation.shareForward`. (1) Verification **gates** execution — `verifyShareFromBytes` must pass or the RPC fails closed with `ERR_UNVERIFIED_SHARE` before any outbound call, with an explicit `allowUnsigned` opt-out for a share you produced yourself. Verification was previously computed and then ignored. (2) Only tools whose trailing `_`-segment is a recognized READ verb execute (`share/read-tool-registry.ts`); the list classifies by **name**, so a verb earns a place only when every tool that can carry it is known to be a read — `preview` was removed because `iac_pulumi_preview` shells out to `pulumi preview --cwd <caller-supplied directory>`, which evaluates the stack program in that directory. (3) Steps are capped (`MAX_REPLAY_STEPS`), with the excess reported rather than silently dropped, so one file cannot drive unbounded outbound calls on the owner's credentials. Enforcement: the classifier assertion in the I27 block of `security-invariants.test.ts`, plus the fail-closed and cap behaviours in `ipc/share-rpc.test.ts` and `share/recipe-runner.test.ts`. **No new invariant — these harden the I27 subsystem.** No other code path emits a share to a file sink, the config-pinned HTTP sink, or a federation peer. **No new invariant — count stays I1–I27.** Static **D21** (extended in Wave 8d).

**Wired at:**

- `packages/gateway/src/share/share-gate.ts` — `createShare()`: the chokepoint for origin shares that runs collect → redact → owner-HITL preview approval → sign → persist → audit. Returns `{ status: "rejected" }` (no side effects) on a denied/timed-out approval.
- `packages/gateway/src/share/share-forward.ts` — `forwardShare()`: the chokepoint for re-forwarding; routes the envelope through the owner's `share.publish` HITL gate first (fail-closed on deny), then builds the forwarding hop (signs over `contentHash ++ the hop's own label+pubkey ++ JSON(prior-chain)` with the local gateway's Ed25519 share key via `share/share-forwarding.ts` `appendForwardingHop`), appends to `forwarding.chain`, and either delivers to a reachable peer via `federation.shareReceive` over the LAN channel or queues it in `share_inbox` for the deferred-reveal drain.
- `packages/gateway/src/engine/executor.ts` — `"share.publish"` is a member of `HITL_REQUIRED_BACKING` (I2), so the action type cannot be emitted without the executor gate firing — for both `createShare` and `forwardShare`.
- `packages/gateway/src/share/share-keypair.ts` — `ensureShareKeypair()` is the sole reader/writer of the Vault-only `share.signing.privkey` / `share.signing.pubkey`. `share-forward.ts` calls only `ensureShareKeypair` — it never names the `share.signing.privkey` literal directly (D21 confined).
- `packages/gateway/src/ipc/share-rpc.ts` — the single wiring file that constructs the `createShare` and `forwardShare` deps (routing `requestApproval` to the fail-closed `shareConsent` broker) and performs the post-gate sink emit (file / SSRF-safe HTTP POST to the config-pinned `[share.http_sink]` / `federation.shareReceive` peer call).
- `packages/gateway/src/platform/assemble.ts` — supplies `shareConsent.request` as both `createShare`'s and `forwardShare`'s `requestApproval` at boot, binding the owner-HITL broker to the gate so it cannot silently become an always-true stub.
- `federation.shareForward` is added to `FORBIDDEN_OVER_LAN` (local-only asker-side trigger — same class as `share.create`); `federation.shareReceive` is answerable over the LAN wire (NOT forbidden; `checkLanMethodAllowed` via I5 is the gate).
- Enforced statically by **D21** (extended in Wave 8d) in `scripts/structure-audit/check-nimbus-invariants.ts` — confines the `share.publish` action-type literal to executor + share-gate (`D21-share-publish`), the `share.signing.privkey` Vault-key literal to share-keypair.ts (`D21-share-signing-privkey`), the `createShare` call site to share-gate.ts + share-rpc.ts (`D21-createshare-callsite`), the `forwardShare` call site to share-forward.ts + share-rpc.ts (`D21-forwardshare-callsite`), and asserts assemble.ts wires `shareConsent.request` (`D21-share-consent-broker`).
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I27` describe block (`share.publish` ∈ `HITL_REQUIRED`) plus the `FORBIDDEN_OVER_LAN` test asserting `share.create` + `share.prune` + `federation.shareForward` are not LAN-callable. The receiving-is-inert property is proven separately by the `receiveForwardedShare — inert inbound` block in `packages/gateway/src/share/share-forward.test.ts` (its `ReceiveShareDeps` surface is structurally only `{ now, storeReceived }` — no executor/index/embedding dep exists to call) plus the real-NaCl-wire e2e in `packages/gateway/test/e2e/share-forward-e2e.test.ts`.

**Anti-pattern:** emitting a share (file write / HTTP POST / federation forward) from anywhere but the share-rpc wiring after the gate; calling `createShare` or `forwardShare` outside their respective gate + share-rpc; reading `share.signing.privkey` outside share-keypair.ts; naming `share.publish` outside executor + share-gate; replacing the `shareConsent` broker with an always-true approval; auto-merging or auto-executing an inbound forwarded share on receive.

**How to comply:** route every outbound share through `createShare` (origin) or `forwardShare` (re-forward); keep the emit confined to share-rpc.ts after a successful gate result; read the signing key only via `ensureShareKeypair`; never make `requestApproval` resolve true without explicit owner approval of the redacted/forwarded preview; on receive, store to `share_inbox` only.

---

## I29 — egress-ledger completeness over the executor chokepoint

**Statement:** Every gated CONNECTOR action that can reach `connectors.dispatch` appends one `egress_ledger` row to the BLAKE3-chained append-only ledger BEFORE dispatch is called — so a 0-row window from a wired, dispatch-capable executor is structurally impossible. A denied action appends a `blocked` row (and never dispatches); an append failure aborts the action entirely (fail-closed — dispatch never runs). Gate-only executors (vault, teamvault, reindex, data, auto-update, connector.auth, egress.prune) pair with a rejecting dispatcher and perform local mutations, not egress — they are wired with the named `NULL_EGRESS_SINK` and intentionally emit no egress row; this is a documented exclusion, not a gap in coverage. The ledger is tamper-evident (BLAKE3 chain, timing-safe verify per I10), and the sole mutation (`egress.prune` — a continuing-tombstone retention edit) is gated by the owner's HITL approval (I2 frozen set member). Marker rows (`prune`/`boot`/`degraded`) are bookkeeping, not egress, and are excluded from the outbound count — before this exclusion landed, every `egress.prune` tombstone inflated the reported figure. Note: I28 is reserved for the MCP-server owner-sink and is unimplemented — hence the I27→I29 gap.

A second append path exists for MCP-originated agent briefs. An agent brief served to a client that
declared itself `mcp` at connect time is egress — the gateway synthesises from the private index and
hands the result to whatever model the calling client uses — so one `egress_ledger` row with
`source_type='mcp'` is appended before any agent work begins, and a failed append aborts the call.
`D22` is extended, not exempted: rule (c) pins the **caller** of `recordAgentBriefEgress` to
`ipc/agents-rpc.ts`, in the same shape as rule (a) pinning `connectors.dispatch` to `executor.ts`.
A CLI-originated call appends nothing, because a brief rendered locally never leaves the machine.
Briefs whose agents query paired peers (`agents.ghost`, `agents.huddle`) record
`destination='mcp+federation'` rather than plain `mcp`, so outbound peer traffic stays visible
instead of hiding inside a local-looking record.

`mcp` is the NINTH member of `EGRESS_SOURCE_TYPES`, added deliberately here. #1038 froze the union
at eight and prescribed reusing `session` with a reserved `method` for any further class; that
prescription is overridden for this class because it weighed only the marker/non-marker exclusion
and not coverage. `COVERAGE_CLASSES` is by definition the set of egress-bearing source types, and
`THIS_BINARY_COVERAGE` may only claim a granularity for a class whose appender exists — `session`'s
appenders (telemetry, updater, JWKS) do not, so `session` must keep claiming `none`, and filing MCP
briefs there would have recorded them and disclaimed them at once. `mcp` therefore lands in both
lists, claiming `per-call`, in the same commit as its appender. Widening the union is not a chain
break: `verifyEgressChain` recomputes each row's hash from that row's own stored column values.

**Consequence, accepted:** `parseCoverage` rejects a coverage vector carrying an unknown key or
missing a known one, by design, so a `prove` window spanning a pre-`mcp` and a post-`mcp` binary
resolves to `indeterminate` on every class. This is the intended fail-safe direction — do not
relax `parseCoverage` to avoid it.

**Known limits — read before treating this as total coverage.** D22 is a regex over source text matching the literal string `connectors.dispatch`; it is a confinement check on that one string, not a proof that every path to the network is ledgered. Three classes of path pass it today:

- A dispatcher **decorator** that calls `inner.dispatch(action)` under another name (`packages/gateway/src/connectors/connector-write-dispatch.ts` is exactly this — benign today because it is installed *around* the executor and so only ever runs after the gate, but the regex cannot tell the difference between that and a future decorator installed *instead of* it).
- A **façade** that re-exposes execution under another method name (e.g. a `session.call`-shaped wrapper in `teamvault/connector-session.ts`).
- A **raw `tool.execute()`** call on a lazy-mesh tool record, which spells nothing the regex matches.

Rule (c) has the analogous limit, in the opposite direction: it pins the single CALLER of `recordAgentBriefEgress`, so it catches a second file acquiring the appender — but a second entry point that serves a brief WITHOUT calling the appender spells nothing it matches. This document predicted that gap in prose, naming a browser-reachable agent route as the surface that would hit it first. **That surface has now landed, and rule (d) closes the gap ahead of it.**

**Rule (d)** makes the property total in the other direction: no file outside `packages/gateway/src/ipc/agents-rpc.ts` may IMPORT an agent emitter module — `packages/gateway/src/agents/<name>.ts`, excluding `agents/_lib/`. So a new surface cannot reach an `emit*Brief` function at all; it must go through `dispatchAgentsRpc`, which appends before any work. That converts "one caller is pinned" into "the chokepoint is the only door", and it is why `agent-runs/agent-http-invoke.ts` — the HTTP entry point — calls the dispatcher rather than an emitter. It matches BOTH `import … from ".../agents/<name>.ts"` and the dynamic `import(".../agents/<name>.ts")`; a static-only rule would be defeated by that one-character change.

Rule (d) has its own limit, stated because pretending otherwise is the failure this section exists to prevent: **a regex over import specifiers does not follow re-export chains.** An emitter re-exported through `agents/_lib/` could be imported from the excluded path and rule (d) would miss it — verified by planting exactly that re-export, which leaves `audit:invariants` green. That gap is closed by a separate assertion in `packages/gateway/src/security-invariants.test.ts` ("`agents/_lib` re-exports no emitter"), not by the regex. Same answer as everywhere else here: address the capability, do not describe the regex as seeing something it cannot.

**Scope of the `http` coverage class.** Read it the same way as `mcp` below, and more narrowly still. It is `per-call` over exactly one thing: an `agents.*` brief served to a caller verified on the local HTTP API. It is NOT "everything on the HTTP API" — `GET /v1/items`, `GET /v1/people`, `GET /v1/audit` and the rest of the read surface hand index rows to a local process and append **no row**. `GET /v1/agents` and `GET /v1/agents/runs/{id}` append nothing either: the run poll returns a brief whose invocation was already ledgered, and double-counting the read would inflate the count. The class name is the transport; the coverage is agent briefs only.

**Scope of the `mcp` coverage class.** It is `per-call` over exactly one thing: an `agents.*` brief served to a client that declared `kind: "mcp"`. It is NOT "everything an MCP client does". The same MCP server also exposes six read-only index tools (`searchIndex`, `getConnectorStatus`, `getRecentIncidents`, `getRecentPullRequests`, `getRecentDeployments`, `getDoraMetrics`) that hand raw index rows to the same editor model and append **no row at all**, and that same socket's `ask` / `search.query` / `glossary.*` calls append nothing either. The narrowing is recorded in three places on purpose: `THIS_BINARY_COVERAGE` in `packages/gateway/src/egress/egress-coverage.ts` (the machine-readable claim, hashed into the boot marker's `source_id`), `COVERAGE_CLASS_LABELS` in `packages/cli/src/commands/prove.ts` (the human-readable label, a hand-maintained mirror because the CLI cannot import from the gateway), and here. `source_type` strings are permanent in the data, so a class whose appender covers less than its name suggests must say so at the point the claim is made, not only where it is rendered.

None of these are exploited today; the point is that the static check cannot see them, so it must not be described as though it can. Closing them is capability removal (Phase 2 of the I29 security spec), not a stronger regex. Separately: the coverage vector (`packages/gateway/src/egress/egress-coverage.ts`) records exactly three non-`none` classes — `task` at `per-call` (the executor's gated-action append), and `mcp` and `http` both at `per-call` (one appender, `recordAgentBriefEgress`, selected per transport by the total `EGRESS_BEARING_CLIENT_KINDS` map) — with `session`, `sync`, `model` and `peer` all `none` until their appenders land; the vector, not this prose, is the machine-readable claim, and it is carried in the HASHED `source_id` of a per-process boot marker so it cannot be edited without breaking the chain.

**Outstanding debt this change creates.** `EgressCompleteness.tier: "authorized-actions"` (`egress-verify.ts`) is a deprecated additive shim kept only so the published `@nimbus-dev/client@0.15.0`'s `validateEgressCompleteness` does not hard-throw. Its own doc comment states it is true **only** while `task` is the single non-`none` class, and that it must be removed before any phase raises another. Raising `mcp` crosses that line: the binary now observes more than "authorized gated-connector actions". The field is deliberately **not** removed in the same commit — deleting it is a breaking wire change for published-client consumers (including nimbus-vscode), a cross-repo release decision rather than part of wiring an appender. Nothing in the gateway or CLI reads it for a decision. It is now overdue, not merely deprecated. The owner decided to keep it as documented debt rather than break the wire in this branch; it is tracked as [#1057](https://github.com/nimbus-agent/Nimbus/issues/1057).

**Wired at:**

- `packages/gateway/src/engine/executor.ts` `ToolExecutor.gate()` — the egress row is appended (via the injected `EgressSink`, a REQUIRED constructor parameter) after the audit record and before the `if (hitlStatus === "rejected")` return, so both approved and denied decisions are ledgered for any executor wired with a real sink (`makeEgressSink`). Gate-only executors are wired with the named `NULL_EGRESS_SINK` instead — the same append call site runs, but the sink is a documented no-op, so those executors record nothing (see the Statement above). If `EgressSink.append` throws on a wired-for-dispatch executor, `gate()` throws, and `execute()` propagates the error before reaching `connectors.dispatch` (fail-closed).
- `packages/gateway/src/egress/egress-ledger.ts` `makeEgressSink` — the production sink that wraps `appendEgressEntry`. Injected at boot via `platform/assemble.ts`.
- `packages/gateway/src/egress/egress-record.ts` `buildEgressEntry` — builds the `EgressEntry` struct from the gated action (destination = `serviceOf(action.type)`, method = `action.type`, redacted payload summary, hitlStatus, resultStatus).
- `packages/gateway/src/ipc/agents-rpc.ts` `dispatchAgentsRpc` — the MCP brief chokepoint: when `ctx.caller.kind === "mcp"` and the method is a KEY OF `AGENTS_RPC_HANDLERS` (the same map `dispatchByMethod` then resolves against), `recordAgentBriefEgress(ctx.db, …)` runs BEFORE `dispatchByMethod`, so the row exists before any agent work starts. No `try/catch` — a throwing append propagates and no brief is emitted (fail-closed, mirroring `executor.ts` `gate()`). `ctx.caller` is server-derived at connect time (`session.declareKind`), never taken from the RPC params. The gate is membership, never the `agents.` namespace PREFIX: prefix-gating appended a `result_status='authorized'` row for `agents.<anything>`, which then failed `-32601` having done no work — so `nimbus prove` over-counted (the same failure this feature exists to eliminate, pointed the other way) — and it admitted an unbounded, caller-controlled `method` string into a hashed, append-only column whose only mutation path is a HITL-gated prune (`payload_summary` is capped at 256 bytes; `method` is not, and the local socket has no frame-size cap).
- `packages/cli/src/mcp/adapter.ts` `createDeps` / `buildMcpServer` — the client half, fail-closed. A gateway that rejects `session.declareKind` as an unsupported method would serve briefs it cannot attribute, so the eleven agent-classified MCP tools (`peekWhy` + the ten async agents) are NOT registered and reaching one anyway returns an actionable error naming the cause and the fix; the six read-only index tools, which have never been ledgered and never claimed to be, keep working. A stderr warning alone was not sufficient — editor-spawned MCP servers usually discard stderr, so the operator got unrecorded briefs while `nimbus prove` reported a clean scope. A DISCONNECT-class `declareKind` failure is a dead transport, not an old gateway, and deliberately does NOT trigger the degraded mode.
- `packages/gateway/src/agent-runs/agent-http-invoke.ts` `buildAgentHttpInvoker` — the SECOND entry point, and the reason rule (d) exists. It reaches agents through `dispatchAgentsRpc` (never an emitter), builds `caller: {clientId: <verified token label>, kind: "http"}` — server-derived on both fields, since HTTP has no handshake to trust — and injects a `notify` that writes only into the in-memory `AgentRunController`, so a brief requested over HTTP is never broadcast to socket clients. Reached from `POST /v1/agents/{agent}` on the `I13` write allowlist, behind the `agents` token scope. `ClientKind` gained `"http"` but `RECOGNISED` (the set a socket client may DECLARE at handshake) deliberately did not: `http` is constructed by the gateway after it verifies a token, so it is the one kind that is an observation rather than a claim.
- `packages/gateway/src/egress/agent-brief-egress.ts` `recordAgentBriefEgress` — the sole appender for that path, parameterised by transport. `destination` is the source type, or `<source_type>+federation` for the peer-querying agents (`agents.ghost`, `agents.huddle`) — so `mcp`/`mcp+federation` and `http`/`http+federation`; `source_id` is the client id (the verified token label over HTTP); `hitl_status='not_required'` (the agents surface is read-only and reaches no HITL-gated action) and `result_status='authorized'`.
- `packages/gateway/src/egress/egress-source-type.ts` — the 9-member `source_type` union (`task`/`prune`/`session`/`sync`/`model`/`peer`/`mcp`/`boot`/`degraded`), frozen at eight in #1038 and reopened once, deliberately, for `mcp` — see the Statement above and the rewritten header on `EGRESS_SOURCE_TYPES` for the recorded reasoning. Widening it is NOT a chain break — `verifyEgressChain` recomputes each row's hash from that row's own stored `source_type` column, never from the union's current definition, so a ninth TypeScript member changes no stored row and no hash input. It is frozen for two other reasons: a `source_type` value written today is permanent in the data (every row keeps whatever string it was appended with, forever), and `isMarkerSourceType`/`MARKER_SOURCE_TYPES` depend on the set being known and closed — an unreviewed new member could land miscounted on either side of the outbound-egress split. (What WOULD be a chain break: changing `computeEgressRowHash`'s input set, or rewriting a stored row's values.)
- `packages/gateway/src/egress/egress-coverage.ts` + `egress-boot-marker.ts` — the per-process coverage claim: `THIS_BINARY_COVERAGE` states what this binary is built to observe, and `appendBootMarker` writes it (serialized into `source_id`) once per process. `THIS_BINARY_COVERAGE` is a compile-time constant, decoupled from whether a sink actually ends up wired — a build that drops the sink but still runs `assemble.ts`'s marker append still claims `task=per-call` regardless of what it wires. The honest statement is narrower: a *window with no covering boot marker* claims nothing (`indeterminate`), not that an unwired-sink build self-reports nothing. Both `coverageForWindow` marker queries (`egress-verify.ts`) additionally require `source_type = 'boot'`, not `method` alone — a non-marker row cannot vouch for coverage merely by reusing the `egress.boot` method string.
- `platform/assemble.ts` `appendBootMarkerOrWarn` — the boot-marker append is deliberately **non-fatal**, unlike the gated-action append below. `appendEgressEntry` throws on a malformed head `row_hash` (fail-closed against a corrupted chain) or a read-only/locked database; letting either abort `assemblePlatformServices` would take the whole gateway down over a condition the coverage model already has an honest answer for (`indeterminate`), and would also block the only way to diagnose the corruption — `egress.verify`/`nimbus egress verify` are reachable only through a running gateway. `appendBootMarkerOrWarn` catches the failure, logs a warning naming it and stating that proofs will read `indeterminate` until the next successful boot marker, and lets assembly continue.
- `packages/gateway/src/egress/egress-prune.ts` `pruneEgress` — the sole mutation: writes a continuing tombstone that preserves chain integrity. Only reachable after the owner's HITL approval via `"egress.prune"` in `HITL_REQUIRED_BACKING` (I2).
- Enforced statically by **D22** in `scripts/structure-audit/check-nimbus-invariants.ts` — (a) any non-test file other than `engine/executor.ts` that references the literal string `connectors.dispatch` causes `audit:invariants` to exit 1; (b) any non-test file outside `packages/gateway/src/egress/` that references `appendEgressEntry` causes `audit:invariants` to exit 1; (c) any non-test file other than `ipc/agents-rpc.ts` (the single caller) and `egress/agent-brief-egress.ts` (the definition) that references `recordAgentBriefEgress` causes `audit:invariants` to exit 1; **(d)** any non-test file outside `packages/gateway/src/agents/` and other than `ipc/agents-rpc.ts` that IMPORTS an agent emitter module (`packages/gateway/src/agents/<name>.ts`, excluding `agents/_lib/`) causes `audit:invariants` to exit 1, matching both the static `from "…"` and the dynamic `import("…")` form. Per the Known limits above, (a) is a confinement on that literal string, not a totality guarantee over every code path that can reach the network. Rule (c) pins the caller rather than merely permitting an appender, so adding a file to it would satisfy the checker while dissolving the property — it is not an allowlist to extend; the same is true of (d), whose exemption list is two entries and must stay that way.
- Runtime test in `packages/gateway/src/security-invariants.test.ts` — the `I29` describe block: `egress.prune` ∈ `HITL_REQUIRED`, append-before-dispatch ordering, blocked row on deny, abort on append failure, the D22 presence assertion (all four rule names), the rule-(d) both-import-forms assertion, the "`agents/_lib` re-exports no emitter" assertion that closes the one gap rule (d)'s regex structurally cannot see, the D22 comment-scope assertion (does not claim totality; does describe the literal-string mechanism), the required-sink assertion, `NULL_EGRESS_SINK` vs `makeEgressSink` writing to a real ledger, the source scan proving `recordAgentBriefEgress` is named by exactly two production files, the `COVERAGE_CLASSES` ≡ non-marker-source-types identity, and the "every class claiming non-`none` has a landed appender" assertion (`http` + `mcp` + `task`). Behavioural coverage of the appender itself lives in `packages/gateway/src/egress/agent-brief-egress.test.ts` and the `I29` block of `packages/gateway/src/ipc/agents-rpc.test.ts` (CLI and callerless dispatches append nothing; an MCP dispatch appends exactly one row; an HTTP dispatch appends exactly one `source_type=http` row; a failed append emits no brief on either transport), plus `packages/gateway/src/egress/egress-bearing-kinds.test.ts` (the map is total over `ClientKind`) and the `packages/gateway/src/agent-runs/` suites (run-store lifecycle, invoker refusals, and an end-to-end pass over a real HTTP server proving one `http` row per invocation and zero for a refused one).
- `nimbus prove` (`packages/cli/src/commands/prove.ts` and `nimbus egress` reporting) never prints a bare `0 ✓` — every count is printed with its scope, and a window with no covering boot marker prints `indeterminate` and exits 1 rather than reporting a clean zero.

**Anti-pattern:** inserting a `try/catch` around the **gated-action** egress append (`executor.ts` `gate()`) that swallows the error and allows dispatch to proceed — that append must stay hard fail-closed, unchanged from before this phase; calling `connectors.dispatch` from any site other than `executor.ts`; calling `appendEgressEntry` from any file outside `egress/*`; a production boot that wires a no-op or always-succeeding sink (`NULL_EGRESS_SINK` is for the 7 gate-only executors that never dispatch — production executors that do dispatch must inject `makeEgressSink(db)`); wrapping the `recordAgentBriefEgress` call in `dispatchAgentsRpc` in a `try/catch` that serves the brief anyway (including a `try {` opened BEFORE the append with its `catch` after the dispatch — the enforcement test scans from the function header, not from the append, precisely because that shape evaded the narrower window), or moving it after `dispatchByMethod`; gating the append on the `agents.` namespace prefix rather than on membership of the served handler map; deriving the caller kind from RPC params instead of the server-derived `ctx.caller`; serving MCP agent tools against a gateway that cannot attribute them and reporting it only on stderr; adding `"http"` to `RECOGNISED` in `ipc/server/client-kind.ts`, which would let any socket client DECLARE the one transport whose attribution the gateway is supposed to have verified; weakening `EGRESS_BEARING_CLIENT_KINDS` from a total `Record<ClientKind, …>` to a `Partial` or a `Map`, which turns a future transport from a compile error into a silently unledgered surface; importing an `agents/<name>.ts` emitter from any file other than `ipc/agents-rpc.ts`, or re-exporting one through `agents/_lib/` to route around rule (d); casually appending to `EGRESS_SOURCE_TYPES` — a further member needs its reasoning recorded in the header the way `mcp`'s and `http`'s are, and reusing `session` with a reserved `method` remains the right answer for any class whose appender is not landing in the same commit; adding a class to `COVERAGE_CLASSES` without the matching `EGRESS_SOURCE_TYPES` member (or vice versa) — the two lists are separate declarations and the mismatch is silent; raising a `THIS_BINARY_COVERAGE` entry without landing its appender; relaxing `parseCoverage` to tolerate a missing or unknown class so a mixed-binary window stops reading `indeterminate`; describing D22 as closing the decorator/façade/raw-execute classes it cannot see; filtering a boot-marker query on `method` alone without `source_type = 'boot'`. The **boot-marker** append (`appendBootMarkerOrWarn`, `platform/assemble.ts`) is the one deliberate, documented exception to the swallow-and-proceed anti-pattern above — see the `Wired at` bullet — and swallowing there must still never be silent: it must warn, naming the failure.

**How to comply:** `EgressSink` is the only DI seam for the ledger write — inject `makeEgressSink(db)` at boot (or the explicit `NULL_EGRESS_SINK` for an executor that structurally never dispatches). Every new action type that reaches `connectors.dispatch` from `executor.ts` will automatically be ledgered. If you add a new chokepoint around `connectors.dispatch`, you must run it through the existing executor gate (not bypass it) — the D22 static check will catch a new site that spells the literal string, but will not catch a decorator, façade, or raw-execute path, so those require a code-review judgment call, not just a green `audit:invariants`. For a new surface that serves gateway-synthesised content to an outside client, add its append at the surface's single dispatch entry point, before any work, with no `try/catch` — and land the `EGRESS_SOURCE_TYPES` member, the `COVERAGE_CLASSES` entry, the `THIS_BINARY_COVERAGE` granularity, the D22 caller pin, and the enforcement test in the same commit as the appender, exactly as `mcp` did.

---

## I30 — web-clipper token minting is fail-closed behind an owner-opened pairing window

**Statement:** A web-clipper bearer token is minted only behind a live, owner-opened, unexpired, single-use, attempts-remaining pairing window (opened via `nimbus clip pair`). Absent such a window the `POST /v1/clips/pair/confirm` route mints nothing (HTTP 403, fail-closed). The window is strictly in-memory; a gateway restart drops it. Minted tokens live in the Vault map `http_api.web_clipper_tokens` (the key name is historical — it now backs every bearer-authed HTTP surface, not only clips) and are revocable via `nimbus clip revoke`.

Minting now produces a **scoped** token, not a bare credential. `nimbus clip pair` accepts `--scopes <a,b>` drawn from the five-name `ApiScope` vocabulary (`clip`, `briefs`, `agents`, `resolve`, `fetch` — `clips/api-scopes.ts`); the requested set is recorded on the `PairingWindowController` window **at the moment the owner opens it**, and `POST /v1/clips/pair/confirm` reads the scopes back off that window when it mints — **never from the confirming request body**, which carries only the pairing code. A requester that could name its own scopes at confirm time would simply grant itself the set; recording them at `open()` instead makes the granted scopes server-derived, the same rule I23 relies on for reply targets. `nimbus clip scopes <label> --set <a,b>` rewrites an existing label's scopes in place, without minting a new token or re-pairing.

A **legacy bare-string token** — the pre-scopes storage shape, still the form every already-paired browser's entry is in — parses as exactly `clip,briefs` (`LEGACY_SCOPES`) on load, and gains nothing from the scope vocabulary automatically. It is upgraded only by an explicit `nimbus clip scopes` call, never by mere presence in the Vault map.

Enforcement per request is by scope, not just by valid-token: a route with a `{ kind: "clip", scope: … }` entry in `HTTP_ROUTE_AUTH` (`ipc/http-route-auth.ts`) returns 401 for an unrecognised token and 403 `insufficient_scope` for a valid token whose granted set does not include the route's required scope. 403 rather than 401 there is deliberate — the token is valid, so 401 would send an already-paired client into a re-pairing loop that cannot fix a scope gap.

**Wired at:** `packages/gateway/src/clips/pairing-window.ts` (the controller — scopes recorded at `open()`, read back at `confirm()`), `packages/gateway/src/ipc/http-write-routes.ts` (`runClipPairConfirmRoute` mints from `confirmed.scopes`; `scopeRefusal` enforces per-route scope), `packages/gateway/src/ipc/http-route-auth.ts` (`HTTP_ROUTE_AUTH`, `clipScopeFor`, `hasScope` — the route→scope table is the single source of truth every gate reads), `packages/gateway/src/clips/clip-token-store.ts` (mint/verify/revoke/`setApiTokenScopes`, legacy-string parsing).

**Anti-pattern:** minting a token on caller assertion, persisting the pairing window to disk, early-returning out of the multi-token verify (leaks token count), echoing a raw token in audit/CLI output, taking scopes from the `POST /v1/clips/pair/confirm` request body instead of the pairing window, granting a legacy bare-string token more than `clip,briefs`, or naming a scope inline at an enforcement site instead of reading it from `clipScopeFor`.

**How to comply:** every new BEARER-authenticated clipper-token route routes through `verifyApiToken` (constant-time); a new scope-gated route gets an entry in `HTTP_ROUTE_AUTH` and reads its requirement via `clipScopeFor` (or the fail-closed `enforceClipScope` wrapper), never a hardcoded `hasScope(scopes, "…")`. This does NOT cover every clipper-token-adjacent path: `POST /v1/clips/pair/confirm` authenticates with the short-lived pairing CODE, not a bearer token — it is how a token is obtained, so it cannot require one and only mints after `PairingWindowController.confirm` returns a label plus its recorded scopes — and the `clip.scopes` / `clip.status` / `clip.revoke` IPC methods are Vault operations reached over the trusted local socket (`clip-rpc.ts`), not the bearer-authenticated HTTP surface, so neither calls `verifyApiToken`. Do not add bearer auth to the pairing route or the local IPC methods to "match" this rule — that would break pairing / require a bearer token the local operator was never issued.

---

## How a new invariant is added

1. The defense ships with at least one production caller — never an orphan helper function.
2. An entry is added here naming the defense, the wiring site, and the anti-pattern.
3. An assertion is added to [`security-invariants.test.ts`](../packages/gateway/src/security-invariants.test.ts) that fails if the wiring is removed (typically a grep against the production source tree).
4. The compact summary in `CLAUDE.md` and `GEMINI.md` is updated.

## Worked example

Suppose a future change introduces sub-agent tool scope enforcement: every sub-agent constructs a frozen `ReadonlySet<string>` of allowed tool ids and the dispatcher refuses any call outside that scope. Adding it correctly means landing all three artefacts in one commit.

**1. Production wiring site** — in `packages/gateway/src/engine/sub-agent.ts`, the dispatcher consults the scope:

```typescript
function dispatchToolCall(toolId: string, scope: ReadonlySet<string>) {
  if (!scope.has(toolId)) throw new Error(`tool ${toolId} not in scope`);
  return tools[toolId].invoke(...);
}
```

**2. Entry in this file** — a new `## I31 — Sub-agent tool scope enforcement` section (the next free number after the current ceiling `I30`; note `I28` is reserved, not free) naming the defense, the wiring site (`sub-agent.ts:dispatchToolCall`), the anti-pattern (any code that bypasses `dispatchToolCall`, or any mutable scope container), and the compliance recipe (always frozen sets; never call `tools[id].invoke()` directly).

**3. Enforcement test** — in `packages/gateway/src/security-invariants.test.ts`:

```typescript
test("I31 — sub-agent dispatcher checks frozen tool scope", () => {
  const source = readFileSync(
    join(REPO_ROOT, "packages/gateway/src/engine/sub-agent.ts"),
    "utf8"
  );
  expect(source).toMatch(/scope\.has\(toolId\)/);
});
```

If a future refactor renames `dispatchToolCall` or removes the scope check, this test fails — and the invariant entry above must either be updated to match the new wiring site, or deleted in the same commit.

**Why all three** — production wiring without a docs entry produces silent regressions on the next refactor (no audit trail). A docs entry without an enforcement test is an orphan defense (the B1 audit's exact finding for `extensionProcessEnv`, `checkLanMethodAllowed`, and the `<tool_output>` envelope). An enforcement test without a docs entry leaves future contributors guessing at what behaviour the test guards.

## How an invariant is retired

If a future architectural change makes an invariant obsolete (e.g. moving to a different IPC framework supersedes I7), the entry is **deleted in the same commit** as the architectural change — never left in place as documentation drift. The audit trail is the git history of this file.

---

## Migration log (2026-05-28)

Reverse-lookup table for inline comments migrated from source files during the 2026-05-28 cleanup pass. Comments remain in source files until Pass 3 strips them. Each row maps the original comment location to the invariant it supports and a one-line summary.

| Source location | Invariant | Summary |
|---|---|---|
| `packages/cli/src/commands/data.ts:36` | I2 | HITL requirement for data-delete operations routed through executor |
| `packages/cli/src/lib/interactive-ipc-handlers.test.ts:5` | I2 | Test confirms HITL channel fires before destructive operations |
| `packages/cli/src/lib/interactive-ipc-handlers.ts:35` | I2 | Interactive HITL handler must not bypass executor gate |
| `packages/gateway/src/automation/workflow-hitl-preview.ts:2` | I2 | Workflow HITL preview redacts payload before display |
| `packages/gateway/src/connectors/registry.ts:50` | I2 | Per-connector dispatch table: action.type → mcpToolId mapping header |
| `packages/gateway/src/connectors/registry.ts:54` | I2 | Google Drive write tool mappings (file.create, file.delete, file.move, file.rename) |
| `packages/gateway/src/connectors/registry.ts:57` | I2 | Gmail write tool mappings (email.send, email.draft.send, email.draft.create) |
| `packages/gateway/src/connectors/registry.ts:60` | I2 | OneDrive write tool mappings (onedrive.delete, onedrive.move) |
| `packages/gateway/src/connectors/registry.ts:63` | I2 | Outlook write tool mappings (email.send, calendar.event.create/delete) |
| `packages/gateway/src/connectors/registry.ts:68` | I2 | GitHub write tool mappings (repo.pr.merge, repo.pr.close, repo.branch.delete, repo.tag.create, repo.commit.push) |
| `packages/gateway/src/connectors/registry.ts:72` | I2 | GitLab write tool mappings (repo.pr.merge, gitlab.pipeline.retry/cancel) |
| `packages/gateway/src/connectors/registry.ts:74` | I2 | Bitbucket write tool mapping (repo.pr.merge → bitbucket_bitbucket_pr_merge) |
| `packages/gateway/src/connectors/registry.ts:77` | I2 | Slack write tool mappings (slack.message.post, slack_slack_message_post_dm) |
| `packages/gateway/src/connectors/registry.ts:80` | I2 | Teams write tool mappings (teams.message.post, teams.message.postChat) |
| `packages/gateway/src/connectors/registry.ts:84` | I2 | Linear write tool mappings (linear.issue.create/update, linear.comment.create) |
| `packages/gateway/src/connectors/registry.ts:86` | I2 | Obsidian write tool mapping (obsidian.note.append → obsidian_obsidian_append_to_daily_note) |
| `packages/gateway/src/connectors/registry.ts:89` | I2 | Jira write tool mappings (jira.issue.create/update, jira.comment.add) |
| `packages/gateway/src/connectors/registry.ts:93` | I2 | Notion write tool mappings (notion.page.create/update, notion.block.append, notion.comment.create) |
| `packages/gateway/src/connectors/registry.ts:97` | I2 | Confluence write tool mappings (confluence.page.create/update, confluence.comment.add) |
| `packages/gateway/src/connectors/registry.ts:100` | I2 | Jenkins write tool mappings (jenkins.build.trigger/abort) |
| `packages/gateway/src/connectors/registry.ts:103` | I2 | GitHub Actions write tool mappings (github_actions.run.trigger/cancel) |
| `packages/gateway/src/connectors/registry.ts:106` | I2 | CircleCI write tool mappings (circleci.pipeline.trigger, circleci.job.cancel) |
| `packages/gateway/src/connectors/registry.ts:110` | I2 | PagerDuty write tool mappings (pagerduty.incident.acknowledge/resolve/escalate) |
| `packages/gateway/src/connectors/registry.ts:114` | I2 | Kubernetes write tool mappings (kubernetes.rollout.restart, kubernetes.pod.delete, kubernetes.deployment.scale) |
| `packages/gateway/src/connectors/registry.ts:117` | I2 | AWS write tool mappings (aws.ecs.service.update, aws.lambda.invoke, aws.ec2.instance.stop/start) |
| `packages/gateway/src/automation/workflow-hitl-preview.ts:60` | I2 | Azure write tool mappings (azure.app_service.restart, azure.aks.node_pool.scale) |
| `packages/gateway/src/automation/workflow-hitl-preview.ts:68` | I2 | GCP write tool mappings (gcp.cloud_run.deploy, gcp.gke.workload.restart) |
| `packages/gateway/src/engine/agent.ts:440` | I11 | wrapToolForLlm wiring site — first I11 production caller in agent.ts |
| `packages/gateway/src/engine/audit-payload-safety.test.ts:14` | I4 | Test verifies no audit row written with hitlStatus approved outside consent round-trip |
| `packages/gateway/src/engine/executor.ts:16` | I2 | HITL_REQUIRED_BACKING is module-private immutable set |
| `packages/gateway/src/engine/executor.ts:17` | I2 | Source of truth reference to architecture.md §HITL Consent Gate |
| `packages/gateway/src/engine/tool-output-envelope.ts:6` | I11 | S8-F3/chain-C4 citation; envelope applied at LLM boundary only, not planner path |
| `packages/gateway/src/extensions/auto-update-permissions-diff.ts:16` | I2 | Auto-update permissions diff requires HITL for permission scope expansion |
| `packages/gateway/src/extensions/auto-update-types.ts:40` | I2 | extension.autoUpdate action type added to HITL_REQUIRED_BACKING |
| `packages/gateway/src/extensions/auto-update-types.ts:47` | I2 | extension.downgrade action type added to HITL_REQUIRED_BACKING |
| `packages/gateway/src/extensions/permissions-validator.ts:29` | I2 | Permissions validator gates any extension that requests write capabilities |
| `packages/gateway/src/gateway-main.ts:166` | I2 | Gateway entrypoint confirms HITL_REQUIRED is wired before first IPC request — everything above `ipc.start()` is the wiring |
| `packages/gateway/src/ipc/consent.ts:29` | I4 | consent.respond is the only IPC handler that supplies approved status |
| `packages/gateway/src/ipc/data-rpc.ts:23` | I4 | data.delete routes through ToolExecutor; hitlStatus set by gate only |
| `packages/gateway/src/ipc/reindex-rpc.test.ts:56` | I5 | connector.reindex listed in FORBIDDEN_OVER_LAN |
| `packages/gateway/src/ipc/reindex-rpc.ts:8` | I5 | connector.reindex is FORBIDDEN_OVER_LAN (I5) |
| `packages/gateway/src/ipc/server/dispatchers.ts:284` | I4 | consent.respond dispatcher is the sole production hitlStatus supplier |
| `packages/gateway/src/ipc/server/vault-dispatch.ts:22` | I4 | vault dispatch does not set hitlStatus; routes through executor |
| `packages/gateway/src/ipc/server/vault-dispatch.ts:101` | I4 | vault dispatch confirmed non-HITL; hitlStatus: not_required |
| `packages/gateway/src/security-invariants.test.ts:78` | I10 | Test asserts constantTimeStringEqual canonical source is util/timing-safe-compare.ts |
| `packages/gateway/src/watcher/anomaly-detector.ts:2` | I2 | Anomaly detector is read-only; no HITL actions fired from watcher path |
| `packages/gateway/test/e2e/scenarios/hitl-write-ops.test.ts:17` | I2 | E2E test confirms HITL gate fires for file write operations |
| `packages/gateway/test/e2e/scenarios/hitl-write-ops.test.ts:34` | I2 | E2E test confirms rejected actions mark dependent sub-tasks as skipped |
| `packages/mcp-connectors/aws/src/server.ts:2` | I2 | AWS MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/azure/src/server.ts:2` | I2 | Azure MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/bitbucket/src/server.ts:4` | I2 | Bitbucket MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/circleci/src/server.ts:3` | I2 | CircleCI MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/confluence/src/server.ts:4` | I2 | Confluence MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/gcp/src/server.ts:2` | I2 | GCP MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/github/src/server.ts:4` | I2 | GitHub MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/github-actions/src/server.ts:3` | I2 | GitHub Actions MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/gitlab/src/server.ts:4` | I2 | GitLab MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/gitlab/src/server.ts:5` | I2 | GitLab pipeline cancel/retry also rely on executor.ts HITL gate |
| `packages/mcp-connectors/gmail/src/server.ts:4` | I2 | Gmail MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/google-drive/src/server.ts:4` | I2 | Google Drive MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/iac/src/server.ts:2` | I2 | IaC MCP write tools (terraform.apply/destroy, cloudformation.deploy, pulumi.up) rely on executor.ts gate |
| `packages/mcp-connectors/jenkins/src/server.ts:3` | I2 | Jenkins MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/jira/src/server.ts:4` | I2 | Jira MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/kubernetes/src/server.ts:2` | I2 | Kubernetes MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/linear/src/server.ts:4` | I2 | Linear MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/notion/src/server.ts:3` | I2 | Notion MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/obsidian/src/server.ts:11` | I2 | Obsidian HITL gate is in executor.ts; assertHitlRequired() not used in this codebase |
| `packages/mcp-connectors/obsidian/src/server.ts:13` | I2 | Obsidian append_to_daily_note is HITL-gated via obsidian.note.append action type |
| `packages/mcp-connectors/obsidian/src/server.ts:67` | I2 | Path-traversal guard in obsidian_get covers read path (HITL covers write path) |
| `packages/mcp-connectors/obsidian/src/server.ts:369` | I2 | Obsidian daily-note append enforces vault boundary via assertWithinVault before writing |
| `packages/mcp-connectors/onedrive/src/server.ts:4` | I2 | OneDrive MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/outlook/src/server.ts:7` | I2 | Outlook MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/pagerduty/src/server.ts:3` | I2 | PagerDuty MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/slack/src/server.ts:4` | I2 | Slack MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/mcp-connectors/teams/src/server.ts:3` | I2 | Teams MCP write tools rely on executor.ts gate; no per-connector HITL guard |
| `packages/ui/src/components/hitl/StructuredPreview.tsx:6` | I2 | StructuredPreview component renders HITL consent payload safely (XSS-protected) |
| `packages/ui/src/components/PendingUpdates.tsx:9` | I7 | PendingUpdates only calls updater.checkNow (read-only); applyUpdate requires separate user action |
| `packages/ui/src-tauri/src/gateway_bridge.rs:152` | I7 | NO_TIMEOUT_METHODS sub-list (data.export, data.import, llm.pullModel, updater.applyUpdate) and size assertion |
| `packages/cli/src/commands/deploy-annotate.ts:14` | I13 | nimbus deploy annotate is the only CLI command that uses the HTTP write surface (not IPC) |
| `packages/gateway/src/agents/_lib/synthesize.ts:42` | I11 | Synthesis layer receives already-wrapped tool results; must not re-wrap |
| `packages/gateway/src/automation/extension-store.ts:40` | I14 | Extension auto-update state writes go through dbRun (I14 compliant) |
| `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:29` | I15 | wrap() helper routes first-party ServerSpecs through wrapServerSpec for I15 compliance |
| `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:32` | I15 | Every servers: { id: spec } literal in connector-spawns.ts routes through wrap() |
| `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:49` | I15 | ctx.sandboxCwd thread-through is load-bearing; dropping it leaves phase-3 servers unwrapped |
| `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:53` | I15 | buildPhase3Servers returns already-sandboxed specs; ctx.sandboxCwd regression fails I15 test |
| `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:597` | I15 | Additional spawn site in connector-spawns.ts routes through wrapServerSpec |
| `packages/gateway/src/connectors/lazy-mesh/connector-spawns.ts:759` | I15 | Additional spawn site in connector-spawns.ts routes through wrapServerSpec |
| `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts:10` | I15 | FIRST_PARTY_MANIFESTS is the static per-service sandbox permission registry |
| `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts:12` | I15 | manifestForFirstParty(serviceId) resolves sandbox manifest at spawn time |
| `packages/gateway/src/connectors/lazy-mesh/mesh.test.ts:191` | I15 | mesh.test.ts verifies I15 wiring for mesh.ts spawn sites |
| `packages/gateway/src/connectors/lazy-mesh/mesh.test.ts:248` | I15 | mesh.test.ts verifies wrapServerSpec import in mesh.ts |
| `packages/gateway/src/connectors/lazy-mesh/mesh.test.ts:396` | I15 | mesh.test.ts verifies sandbox wrapper env vars are correctly set |
| `packages/gateway/src/connectors/lazy-mesh/mesh.ts:82` | I15 | mesh.ts spawn site routes through wrapServerSpec |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.test.ts:12` | I15 | phase3-config.test.ts verifies I15 wiring for phase3-config.ts spawn sites |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:14` | I15 | Phase-3 wrap() helper routes each Phase-3 ServerSpec through wrapServerSpec |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:137` | I15 | phase3-config AWS spawn site routes through wrap() |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:424` | I15 | phase3-config Azure spawn site routes through wrap() |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:450` | I15 | phase3-config GCP spawn site routes through wrap() |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:503` | I15 | phase3-config IaC spawn site routes through wrap() |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:533` | I15 | phase3-config observability (Grafana/Sentry) spawn site routes through wrap() |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:566` | I15 | phase3-config observability (New Relic/Datadog) spawn site routes through wrap() |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:595` | I15 | phase3-config additional spawn site routes through wrap() |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts:804` | I15 | phase3-config additional spawn site routes through wrap() |
| `packages/gateway/src/connectors/lazy-mesh/slot.ts:27` | I15 | MeshSpawnContext.sandboxCwd is the working-directory anchor for every I15-wrapped spawn |
| `packages/gateway/src/connectors/lazy-mesh/user-mcp.ts:15` | I15 | user-mcp.ts spawn site routes through wrapServerSpec |
| `packages/gateway/src/connectors/lazy-mesh/user-mcp.ts:74` | I15 | user-mcp ensureUserMcpClient uses wrapServerSpec for user-installed MCP servers |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts:6` | I15 | Module docblock: every connector ServerSpec passes through here, so the sandbox is not optional |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts:15` | I15 | The wrapper runs as the `__nimbus-sandbox` role of the gateway executable itself — a compiled binary has no `sandbox-wrapper.ts` path to spawn |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts:21` | I15 | Env contract: NIMBUS_SANDBOX_MANIFEST_JSON and NIMBUS_SANDBOX_CWD are consumed and stripped by wrapper |
| `packages/gateway/src/deployment/types.ts:5` | I13 | DeploymentAnnotateInput types used by the HTTP write surface |
| `packages/gateway/src/engine/agent.ts:446` | I11 | Second I11 wiring site in agent.ts (mesh.ts MCP tool wrapper) |
| `packages/gateway/src/extensions/auto-update-orchestrate.ts:50` | I16 | Auto-update orchestrator re-runs signature verification on new version before activating |
| `packages/gateway/src/extensions/auto-update-rpc.ts:24` | I2 | auto-update RPC uses extension.autoUpdate / extension.downgrade action types (HITL-gated via I2) |
| `packages/gateway/src/extensions/install-from-local.ts:120` | I16 | install-from-local: I16 fires only when manifest.publisher is present |
| `packages/gateway/src/extensions/install-from-local.ts:404` | I16 | install-from-local: requires vault and fetcher to be wired for signed extensions |
| `packages/gateway/src/extensions/install-from-local.ts:556` | I16 | install-from-local: publisher key priority chain (file → vault cache → registry) |
| `packages/gateway/src/extensions/install-from-local.ts:558` | I16 | install-from-local: resolved pubkey written to vault under extension.publisher_key.<id> on success |
| `packages/gateway/src/extensions/verify-extensions.ts:162` | I16 | startup verification is no-op when signatureOpts is undefined (unsigned extensions skip) |
| `packages/gateway/src/extensions/verify-extensions.ts:402` | I16 | VerifyExtensionsSignatureOpts interface; signatureOpts gate description |
| `packages/gateway/src/extensions/verify-extensions.ts:421` | I16 | verifyExtensionsBestEffort docblock: hash verify + Ed25519 second pass; mesh stop on failure |
| `packages/gateway/src/extensions/verify-extensions.ts:420` | I16 | Startup verification failure records reason in SignatureDisabledRegistry and increments signatureHardDisabled |
| `packages/gateway/src/extensions/verify-signature.ts:6` | I16 | Gateway re-export shim for @nimbus-dev/sdk crypto/verify-signature.ts (MIT, license-clean) |
| `packages/gateway/src/index/tool-call-log-v29-sql.ts:3` | I11 | V29 tool_call_log is write-only from I11 wiring sites; read-only from audit.toolCalls |
| `packages/gateway/src/index/tool-call-log-v29-sql.ts:9` | I11 | audit.toolCalls is CLI-only (FORBIDDEN_OVER_LAN per I5, absent from Tauri allowlist per I7) |
| `packages/gateway/src/ipc/automation-rpc.ts:97` | I2 | workflow.run routes destructive workflow steps through ToolExecutor gate |
| `packages/gateway/src/ipc/automation-rpc.ts:99` | I2 | workflow HITL batch consolidation handled by coordinator, not automation-rpc |
| `packages/gateway/src/ipc/automation-rpc.ts:101` | I2 | workflow.rerun routes through same HITL gate as initial run |
| `packages/gateway/src/ipc/automation-rpc.ts:114` | I2 | watcher.create does not trigger HITL; watchers are read-only observers |
| `packages/gateway/src/ipc/automation-rpc.ts:132` | I2 | watcher.delete does not trigger HITL (watcher is gateway-local, not a cloud mutation) |
| `packages/gateway/src/ipc/deployment-rpc.ts:5` | I13 | deployment-rpc handler is NOT in Tauri ALLOWED_METHODS (only reachable via HTTP write surface) |
| `packages/gateway/src/ipc/http-routes.ts:5` | I13 | READ_ONLY_HTTP_ROUTES is source of truth for OpenAPI drift detection |
| `packages/gateway/src/ipc/http-routes.ts:13` | I13 | OpenAPI drift gate compares READ_ONLY_HTTP_ROUTES against v1.yaml at CI time |
| `packages/gateway/src/ipc/http-server.ts:323` | I13/I14 | Location of the count assertion for both WRITE_ROUTE_ALLOWLIST and writable DB handle |
| `packages/gateway/src/ipc/http-write-routes.test.ts:15` | I13 | Test asserts dispatchWriteRoute is the only handler for POST paths |
| `packages/gateway/src/ipc/http-write-routes.ts:2` | I13 | Module is single source of truth for allowed POST paths; count assertion in security-invariants.test.ts |
| `packages/gateway/src/ipc/people-rpc.test.ts:8` | I13 | people.* methods are read-only and do not go through dispatchWriteRoute |
| `packages/gateway/src/ipc/preflight-rpc.ts:5` | I13 | deploy.preflight is read-only; does not use the HTTP write surface |
| `packages/gateway/src/ipc/security-rpc.ts:7` | I7 | security.scan is CLI-only (NOT in Tauri ALLOWED_METHODS, FORBIDDEN_OVER_LAN) |
| `packages/gateway/src/ipc/server/dispatchers.ts:609` | I2 | Extension dispatcher routes extension.update through HITL gate |
| `packages/gateway/src/ipc/http-server.ts:276` | I14 | First DB handle: `readonly: true` for query-only HTTP API paths |
| `packages/gateway/src/ipc/http-server.ts:282` | I14 | Second (writable) DB handle for HTTP write surface only; null when deployment token unset |
| `packages/gateway/src/platform/sandbox/sandbox-runner.ts:8` | I15 | SandboxSpawnOptions.env must be output of extensionProcessEnv() (couples I1 and I15) |
| `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts:5` | I15 | sandbox-wrapper.ts is the single sandbox-execution boundary for all extension children |
| `packages/gateway/src/platform/sandbox/seccomp-filter.ts:2` | I15 | Seccomp BPF filter is AUDIT_ARCH_X86_64-guarded; not loaded on non-x86-64 Linux |
| `packages/gateway/src/search/vec-store.ts:16` | I9 | vec_items_* virtual-table identifier uses escapeIdentifier (not template literal) |
| `packages/gateway/src/util/timing-safe-compare.ts:4` | I10 | S6-F10/S7-F8 citation; sha256HexEqualConstantTime replaces direct !== on hash strings |
| `packages/gateway/src/util/timing-safe-compare.ts:7` | I10 | Returns false (not throws) on length mismatch, non-64-char inputs, or malformed hex |
| `packages/gateway/src/util/timing-safe-compare.ts:11` | I10 | Constant-time guarantee only covers valid-input fast path; invalid hex rejected before timingSafeEqual |
| `packages/gateway/src/util/timing-safe-compare.ts:17` | I10 | constantTimeStringEqual: canonical helper for pairing codes, bearer tokens, opaque strings |
| `packages/gateway/src/util/timing-safe-compare.ts:21` | I10 | Length-mismatch burn cycle: runs timingSafeEqual(aBuf, aBuf) to prevent length-difference timing leak |
| `packages/gateway/test/e2e/scenarios/dependency-lifecycle.e2e.test.ts:43` | I16 | E2E test exercises I16 through full install → startup → verify lifecycle |
| `packages/gateway/test/integration/db/disk-full-propagation.test.ts:296` | I14 | Integration test covers SQLITE_FULL → DiskFullError propagation through dbRun |
| `packages/gateway/test/integration/deployment/i11-envelope.test.ts:2` | I11 | Integration test verifies envelope applied on LLM path without double-wrapping on planner path |
| `packages/gateway/test/integration/deployment/i11-envelope.test.ts:6` | I11 | Integration test structure for I11 coverage |
| `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:9` | I15 | connector-spawns unit tests verify all spawn sites import and call wrapServerSpec |
| `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:208` | I15 | Unit test verifies wrapServerSpec called with correct manifest for a specific spawn |
| `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:209` | I15 | Unit test verifies sandboxCwd is threaded through correctly |
| `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:251` | I15 | Unit test verifies I1 + I15 coupling: extensionProcessEnv used in spawned env |
| `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:365` | I15 | Unit test verifies additional connector-spawns.ts spawn site |
| `packages/github-actions/annotate-action/src/main.ts:173` | I13 | GitHub Action reads bearer token via `getInput("token")` (wired to `secrets.NIMBUS_GATEWAY_TOKEN` in workflow YAML, never `env`) |
| `@nimbus-dev/sdk/crypto/canonical-json.ts:4` (external repo) | I16 | Canonical JSON strips signature field before serialization for Ed25519 signing |
| `@nimbus-dev/sdk/crypto/canonical-json.ts:56` (external repo) | I16 | Field order is deterministic (sorted by key); encoding is UTF-8 without BOM |
| `@nimbus-dev/sdk/crypto/verify-signature.ts:4` (external repo) | I16 | SDK primitive for verifyManifestSignature; MIT-licensed for connector author use |
| `scripts/structure-audit/check-nimbus-invariants.ts:6` | I1/I14/I15 | Static audit entry point: D1 (I1 spawn rule), D10 (I15 wrapServerSpec rule), D12 (I14 dbRun rule) |
| `scripts/structure-audit/check-nimbus-invariants.ts:66` | I14 | D12 rule: direct db.run/db.exec outside DB_RUN_EXEC_ALLOW_LIST causes exit 1 |
| `scripts/structure-audit/check-nimbus-invariants.ts:72` | I1 | D1 rule: spawn under connectors/ without extensionProcessEnv causes exit 1 |
| `scripts/structure-audit/check-nimbus-invariants.ts:73` | I15 | D10 rule: ServerSpec under connectors/lazy-mesh/ without wrapServerSpec causes exit 1 |
| `scripts/structure-audit/check-nimbus-invariants.ts:274` | I22 | D16 rule: `parsePolicyToml` imported outside `packages/gateway/src/policy/` causes exit 1 (enforcement must read EnforcedPolicy via policy-gate.ts) |
| `packages/cli/src/commands/extension-sync.test.ts:85` | I10 | Test verifies extension sync token comparison uses constantTimeStringEqual |
| `packages/gateway/src/agents/impact.test.ts:71` | I10 | impact.test.ts verifies no timing-sensitive comparison uses === |
| `packages/gateway/src/automation/graph-predicate.ts:149` | I2 | countItemsMatchingGraphPredicate does not leak item content or secrets; returns count only |
| `packages/gateway/src/extensions/auto-update-apply.ts:4` | I10 | Explicit carve-out: hexEqualIgnoreCase uses === because hashes are public bytes (not secret) |
| `packages/gateway/src/extensions/spawn-env.ts:3` | I1 | extensionProcessEnv is the module that owns the env allowlist; not individual spawn sites |
| `packages/gateway/src/extensions/verify-extensions.ts:162` | I16 | signatureOpts gate: verification is no-op when undefined (unsigned extensions skip) |
| `packages/gateway/src/ipc/http-auth.ts:8` | I10/I13 | http_api.deployment_token is system-level vault key; constantTimeStringEqual used for bearer token |
| `packages/gateway/src/ipc/lan-rpc.ts:17` | I5 | FORBIDDEN_OVER_LAN inline documentation: security/data/connector.addMcp/extension.*/index.reembed |
| `packages/gateway/src/ipc/lan-server.ts:160` | I5 | checkLanMethodAllowed called before onMessage; bypass by upstream wiring is impossible |
| `packages/gateway/src/perf/surfaces/bench-sqlite-contention.ts:43` | I14 | Perf bench uses dbRun even for measurements to preserve SQLITE_FULL detection |
| `packages/gateway/src/platform/assemble.ts:463` | I10 | Gateway assemble uses sha256HexEqualConstantTime for startup integrity checks |
| `packages/gateway/src/updater/updater.ts:172` | I10 | Updater state machine uses sha256HexEqualConstantTime for Ed25519-verified binary hash |
| `packages/gateway/test/integration/connectors/pipedrive-sync-fake-server.test.ts:305` | I10 | Integration test verifies Pipedrive sync does not log or compare token values directly |
| `packages/gateway/test/unit/connectors/lazy-mesh/connector-spawns.test.ts:10` | I1/I15 | Unit test verifies I1 + I15 coupling in connector-spawns.ts |
