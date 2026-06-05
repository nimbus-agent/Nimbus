# Nimbus Security Invariants

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

The connector registry comment block at `connectors/registry.ts:50–123` is the canonical per-connector dispatch table mapping each logical `action.type` to its `payload.mcpToolId` counterpart (e.g. `email.send` → `gmail_gmail_message_send`, `repo.pr.merge` → `github_github_pr_merge`). This table is the most comprehensive enumeration of the HITL surface outside the executor itself and should be consulted whenever a new connector write tool is added. Comments at `engine/executor.ts:16–17` and `gateway/src/index.ts:62` restate that `HITL_REQUIRED_BACKING` is the sole runtime gate; comments across `mcp-connectors/*/src/server.ts` files (aws, azure, bitbucket, circleci, confluence, gcp, github, github-actions, gitlab, iac, jenkins, jira, kubernetes, linear, notion, obsidian, onedrive, outlook, pagerduty, slack, teams) confirm that connector-side write tools rely entirely on the structural gate in `executor.ts` rather than any per-connector guard. The comment at `mcp-connectors/obsidian/src/server.ts:11–16` specifically notes that `assertHitlRequired()` is not used in that codebase and that the defense lives in `executor.ts` — clarifying that MCP connectors are not responsible for gating their own HITL writes.

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

**Phase 6 Slice 1 additions (2026-06-05):** `federation.discover`, `federation.namespace.grant`, `federation.namespace.publish`, `federation.namespace.revoke`, and `federation.peers` joined the allowlist (62 → 67). `federation.pair` is deliberately absent (CLI-only, transmits an out-of-band pairing code — same class as `lan.pair`). `federation.query` and `federation.expertise` are over-the-wire answering methods routed through `query-gate.ts` (I17) and are never renderer-callable.

### Migrated rationale (2026-05-28)

The comment at `ui/src-tauri/src/gateway_bridge.rs:152` notes the `NO_TIMEOUT_METHODS` sub-list (currently 4 entries: `data.export`, `data.import`, `llm.pullModel`, `updater.applyUpdate`) and its size assertion. Comments at `vscode-extension/src/extension.ts:248,260,490,515,520` document that the VS Code extension proxies IPC over the domain socket directly and does **not** go through the Tauri bridge, so ALLOWED_METHODS is irrelevant for the VS Code surface — but those files still assert that any write-class method must be HITL-gated before any client calls it. The comment at `vscode-extension/src/chat/webview/render.ts:88` notes that the VS Code webview renderer sanitizes HTML from tool results using DOMPurify before display, a defense-in-depth complement to I11. The comment at `ui/src/components/PendingUpdates.tsx:9` confirms that the update prompt only calls `updater.checkNow` (read-only) — the `applyUpdate` action requires a separate user confirmation step to prevent accidental one-click updates.

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

**Defense:** every SQLite query uses bound parameters via the typed `dbRun` / `dbExec` wrappers in `packages/gateway/src/db/write.ts`. Identifier-class values that cannot be parameter-bound (table/column names from a finite allowlist) go through `escapeIdentifier` with a null-byte / empty-name guard.

**Wired at:** `db/write.ts`, `db/repair.ts` (`escapeIdentifier`), `people/person-store.ts` (per-field parameter binding after S5-F5 fix).

**Anti-pattern:** template-literal SQL on caller-supplied data (``db.run(`UPDATE ... SET ${field} = ${value}`)``). S5-F5 was a `sets.join()` template in `patchPerson` that built SQL from caller-supplied field names.

**How to comply:** read S5-F5 before adding any new SQL. Identifier-shaped inputs go through `escapeIdentifier`; everything else binds. There is no "internal callers are trusted" carve-out.

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

- `packages/gateway/src/ipc/http-server.ts` — POST routes dispatch through `dispatchWriteRoute` (and not the readonly handler).
- `packages/gateway/src/ipc/http-write-routes.ts` — owns `WRITE_ROUTE_ALLOWLIST` (compile-time, currently a single entry: `"POST /v1/deployments"`).

**Test:** `packages/gateway/src/security-invariants.test.ts` — three sub-asserts:

1. `http-server.ts` imports `dispatchWriteRoute` from `./http-write-routes.ts`.
2. `http-server.ts` opens at most one writable `Database` handle (the write-surface handle).
3. `WRITE_ROUTE_ALLOWLIST.length === 1` and contains exactly `"POST /v1/deployments"`.

**Anti-patterns:**

- Opening a second writable `Database` handle in `http-server.ts` outside the server-context wiring.
- Adding a new POST/PUT/DELETE handler that bypasses `dispatchWriteRoute`.
- Adding entries to `WRITE_ROUTE_ALLOWLIST` without bumping the count assertion in `security-invariants.test.ts`.

**Why:** before Task 3b the HTTP server's read-only invariant was per-server (`SQLITE_OPEN_READONLY` on the single handle). This PR introduced a narrow write surface (post-deploy annotation) — per-route allowlisting + bearer auth + per-token rate limiting is the structural defense against a same-host process spoofing deploys. Same rigor as Tauri `ALLOWED_METHODS` (I7).

**Audit cross-reference:** S2 disposition from the plan review — every rejection at the HTTP write boundary writes a `deployment.annotation_rejected` audit row via `appendAuditEntry`, making brute-force probes tamper-evident on the BLAKE3 chain.

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

The comment block at `connectors/lazy-mesh/wrap-server-spec.ts:1–36` documents the "why" of the wrapper-shim in detail: `@mastra/mcp@1.7.0`'s `MCPClient` uses `StdioClientTransport` which calls `child_process.spawn`-equivalent machinery with no public hook for intercepting the fork; `wrapServerSpec` works around this by rewriting `ServerSpec.command` to point at `sandbox-wrapper.ts` under `process.execPath`. It also documents the env contract: `NIMBUS_SANDBOX_MANIFEST_JSON` and `NIMBUS_SANDBOX_CWD` are consumed and stripped by the wrapper so a re-exec cannot re-enter the wrapper. The comment at `connectors/lazy-mesh/connector-spawns.ts:49–53` warns specifically that `ctx.sandboxCwd` thread-through is load-bearing — dropping it leaves phase-3 servers unwrapped and silently fails the I15 test. The comment at `platform/sandbox/sandbox-runner.ts:8` notes that the env parameter passed to `SandboxRunner.spawn` must be the output of `extensionProcessEnv(...)` (I1), coupling I1 and I15. The comments at `connectors/lazy-mesh/mesh.test.ts:191,248,396`, `connector-spawns.test.ts:9,208,209,251,365`, and `phase3-config.test.ts:12` confirm the test suite structure for I15 coverage. The comment at `platform/sandbox/seccomp-filter.ts:2` notes the seccomp BPF filter is AUDIT_ARCH_X86_64-guarded and should not be loaded on non-x86-64 Linux. The comment at `connectors/lazy-mesh/first-party-manifests.ts:10,12` explains that `FIRST_PARTY_MANIFESTS` is the static registry of per-service sandbox permission declarations that `manifestForFirstParty(serviceId)` resolves at spawn time. The comment at `connectors/lazy-mesh/slot.ts:43` documents the `MeshSpawnContext.sandboxCwd` field as the working-directory anchor for every I15-wrapped spawn.

---

## I16 — Verified-publisher signature

**Statement:** **I16 — Verified-publisher signature.** Every installed extension whose `nimbus.extension.json` declares a `publisher` field carries an Ed25519 signature over the canonicalized manifest (with the `signature` field stripped). The signature is verified at TWO sites — install time AND every Gateway startup — before the extension is allowed to spawn. Extensions without a `publisher` field are treated as pre-T2 unsigned and surface as `(unverified)` in CLI output; the signature pass is a no-op for them.

**Wired at:**

- `packages/gateway/src/extensions/install-from-local.ts` `completeExtensionInstallAfterCopy` — after copying the source directory into the extensions root, the function parses the on-disk manifest, and if the manifest carries `publisher` it calls `resolvePublisherKey(...)` (priority chain: `--publisher-key` file → vault cache → registry fetch) followed by `verifyManifestSignature(...)`. On success, the resolved pubkey is written to the vault under `extension.publisher_key.<id>` and an `extension.signature_verified` audit row is appended. On any failure the install is refused and an `extension.signature_failed` row is appended.
- `packages/gateway/src/extensions/verify-extensions.ts` `verifyExtensionsBestEffort` — when called with `{ vault }` (production wiring in `platform/assemble.ts:assembleGateway`), the signature pass iterates every enabled extension whose on-disk manifest carries `publisher`, reads the cached pubkey from `extension.publisher_key.<id>`, and calls `verifyManifestSignature(...)`. On any failure (missing vault key, invalid signature, malformed signature) the row is flipped `enabled = 0` via `setExtensionEnabled(db, id, false)`, the structured reason is recorded in the in-memory `SignatureDisabledRegistry` singleton (parallel to PR 1's `PreT2DisabledRegistry`), and the running extension child process is stopped via the mesh. One batched `extension.startup_verification` audit row is appended per Gateway run.
- `packages/gateway/src/extensions/hard-disable.ts` `SignatureDisabledRegistry` — the singleton that tracks `extension_id → SignatureDisableReason`. Reset at the top of every signature pass. Consumed by `nimbus extension list` / `nimbus extension info` for the `(unverified)` / disabled-reason badge and by `diag.snapshot` for `signature_disabled_count`.
- `packages/sdk/src/crypto/verify-signature.ts` (MIT) — the primitive `verifyManifestSignature(manifest, resolvedPubkey)` lives here so connector authors can sign their own manifests without an AGPL dep. Gateway imports through the thin re-export shim at `packages/gateway/src/extensions/verify-signature.ts`.

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

**2. Entry in this file** — a new `## I18 — Sub-agent tool scope enforcement` section (the next free number after the current `I17`) naming the defense, the wiring site (`sub-agent.ts:dispatchToolCall`), the anti-pattern (any code that bypasses `dispatchToolCall`, or any mutable scope container), and the compliance recipe (always frozen sets; never call `tools[id].invoke()` directly).

**3. Enforcement test** — in `packages/gateway/src/security-invariants.test.ts`:

```typescript
test("I18 — sub-agent dispatcher checks frozen tool scope", () => {
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
| `packages/client/src/stream-events.ts:38` | I2 | Client stream event for hitlBatch notification shape |
| `packages/client/src/stream-events.ts:39` | I2 | hitlBatch carries consolidated action list for user approval |
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
| `packages/gateway/src/index.ts:62` | I2 | Gateway entrypoint confirms HITL_REQUIRED is wired before first IPC request |
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
| `packages/vscode-extension/src/chat/webview/render.ts:88` | I7 | VS Code webview uses DOMPurify to sanitize tool results before display (defense-in-depth for I11) |
| `packages/vscode-extension/src/extension.ts:248` | I7 | VS Code extension proxies IPC directly over domain socket (not via Tauri bridge); ALLOWED_METHODS is irrelevant for this surface |
| `packages/vscode-extension/src/extension.ts:260` | I7 | VS Code extension confirms write-class methods are still HITL-gated regardless of IPC surface |
| `packages/vscode-extension/src/extension.ts:490` | I7 | VS Code extension IPC channel does not expose vault.* methods |
| `packages/vscode-extension/src/extension.ts:515` | I7 | VS Code extension sends only allowlisted read-only methods without gateway auth bypass |
| `packages/vscode-extension/src/extension.ts:520` | I7 | VS Code extension IPC session lifecycle respects disconnect on deactivate |
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
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts:3` | I15 | Module docblock: why MCPClient internals require the wrapper-shim approach |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts:29` | I15 | Env contract: NIMBUS_SANDBOX_MANIFEST_JSON and NIMBUS_SANDBOX_CWD are consumed and stripped by wrapper |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts:33` | I15 | SANDBOX_WRAPPER_PATH exported for I15 enforcement test |
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
| `packages/sdk/src/crypto/canonical-json.ts:4` | I16 | Canonical JSON strips signature field before serialization for Ed25519 signing |
| `packages/sdk/src/crypto/canonical-json.ts:56` | I16 | Field order is deterministic (sorted by key); encoding is UTF-8 without BOM |
| `packages/sdk/src/crypto/verify-signature.ts:4` | I16 | SDK primitive for verifyManifestSignature; MIT-licensed for connector author use |
| `scripts/structure-audit/check-nimbus-invariants.ts:6` | I1/I14/I15 | Static audit entry point: D1 (I1 spawn rule), D10 (I15 wrapServerSpec rule), D12 (I14 dbRun rule) |
| `scripts/structure-audit/check-nimbus-invariants.ts:66` | I14 | D12 rule: direct db.run/db.exec outside DB_RUN_EXEC_ALLOW_LIST causes exit 1 |
| `scripts/structure-audit/check-nimbus-invariants.ts:72` | I1 | D1 rule: spawn under connectors/ without extensionProcessEnv causes exit 1 |
| `scripts/structure-audit/check-nimbus-invariants.ts:73` | I15 | D10 rule: ServerSpec under connectors/lazy-mesh/ without wrapServerSpec causes exit 1 |
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
