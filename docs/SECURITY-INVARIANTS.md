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

---

## I2 — HITL frozen-set membership

**Defense:** `HITL_REQUIRED` in `packages/gateway/src/engine/executor.ts` is a frozen façade over a module-private `Set` (`HITL_REQUIRED_BACKING`). The façade exposes `has`, iteration, and `forEach` but no mutators; an attempt to call `.add` on the cast type is a no-op or throws.

**Wired at:** `executor.ts` `ToolExecutor.gate()` — every action passes `HITL_REQUIRED.has(action.type)` before dispatch; covered by the "every HITL_REQUIRED action type triggers the consent channel" test in `engine.test.ts`.

**Anti-pattern:** mutating `HITL_REQUIRED` at runtime, declaring a new "destructive" action without adding it to `HITL_REQUIRED_BACKING`, or routing destructive work around `ToolExecutor` entirely. S1-F1 / S1-F7 / C6 all stemmed from destructive RPCs (`data.delete`, `connector.remove`, `connector.reindex`) that bypassed the executor.

**How to comply:** every new IPC method that mutates state outside the index, deletes data, or reaches the network on the user's behalf is added to `HITL_REQUIRED_BACKING` *and* dispatched through `ToolExecutor`. There is no "trusted caller" exception.

---

## I3 — HITL gate consults `action.type`, not `payload.mcpToolId`

**Defense:** the executor calls `HITL_REQUIRED.has(action.type)` exactly. `HITL_REQUIRED_BACKING` stores **logical action types** (`file.move`, `email.send`, `repo.pr.merge`, …) — not connector-specific MCP tool ids (`filesystem_move_file`, `gmail_gmail_message_send`). The dispatcher uses `payload.mcpToolId` as a routing-only hint to pick the right MCP tool inside the matched action class.

**Wired at:** `executor.ts` `ToolExecutor.gate()` — `HITL_REQUIRED.has(action.type)`. The earlier fix `ae27fe9` resolved `mcpToolId ?? action.type` and looked it up in `HITL_REQUIRED`; that opened a *new* bypass (since the set holds action types, not MCP ids, every `mcpToolId`-bearing action skipped the gate). Reverted in `2c9ff06`.

**Anti-pattern:** any code that gates on `payload.mcpToolId`, `resolvedToolId`, or any other dispatch hint. The chain-C4 risk (planner emits `{ type: "files.list", payload: { mcpToolId: "github_repo_pr_merge" } }`) is *not* closed at the executor layer; it is mitigated by trusting the planner to emit the correct `action.type` and by the `<tool_output>` envelope (I11) on the LLM-facing path.

**How to comply:** when adding a new destructive action class, add the **logical type string** to `HITL_REQUIRED_BACKING`. Do not add MCP tool ids to that set; do not gate on `mcpToolId` anywhere.

---

## I4 — `hitlStatus` is consent-output-only

**Defense:** the `hitlStatus` field on audit rows (`approved` / `rejected` / `not_required`) is set exclusively by the consent gate in `executor.ts` after the user responds. `not_required` is the correct value when the action is not in `HITL_REQUIRED`; `approved` may only appear after a real consent decision.

**Wired at:** `executor.ts` `ToolExecutor.gate()` — the assignment block inside the consent-handling try/catch is the only production assignment site outside test fixtures.

**Anti-pattern:** writing `hitlStatus: "approved"` at any non-test call site. S1-F5 / chain C6 (`data.delete` hardcoding the field) created a forged audit trail that survived `nimbus audit verify`.

**How to comply:** new RPC handlers that record audit rows must let `ToolExecutor` populate `hitlStatus`; never set it inline.

---

## I5 — LAN method allowlist is intrinsic to the LAN server

**Defense:** `checkLanMethodAllowed(method, peer)` in `packages/gateway/src/ipc/lan-rpc.ts` enforces both the namespace deny-list (`vault.*`, `consent.*`, `audit.*`, `data.*`, `updater.*`, `lan.*`, `profile.*`) and the per-peer write grant.

**Wired at:** `lan-server.ts` `LanServer.handleEncryptedMessage()` — called *before* `this.opts.onMessage`, so the gate cannot be bypassed by upstream wiring.

**Anti-pattern:** moving the allowlist check into the dispatcher, the IPC server, or any caller — anywhere outside the LAN server itself. S1-F2 / S3-F1 / chains C3 and C5 were a dead-code defense: the function existed but was never called from `LanServer` in production. **Also:** exposing `index.*` write methods (`index.reembed`, `index.reembedCancel`, …) over LAN without an explicit `FORBIDDEN_OVER_LAN` entry — the namespace is intentionally LAN-allowed for read paths (`index.search` / `index.query` / `index.getItem`), so any new write surface needs a full-method-name entry.

**How to comply:** when adding a new LAN-reachable method, update `WRITE_METHODS` and/or `FORBIDDEN_OVER_LAN` in `lan-rpc.ts`. Do not add a second enforcement path; extend the existing one.

---

## I6 — LAN bind defaults to loopback

**Defense:** `DEFAULT_NIMBUS_LAN_TOML.bind = "127.0.0.1"`. Wide-area exposure is an explicit opt-in (`[lan] bind = "0.0.0.0"`), not the default.

**Wired at:** `packages/gateway/src/config/nimbus-toml.ts` (default), enforced by `_test-suite.yml` config defaults test.

**Anti-pattern:** changing the default to `"0.0.0.0"`, or auto-binding to all interfaces when an env var is set. S3-F7 / chain C3 was a `0.0.0.0` default that turned LAN access into unintended internet exposure on public Wi-Fi.

**How to comply:** new transports default to loopback. Public-interface binding requires both an explicit user config value *and* a startup log line announcing the binding.

---

## I7 — Tauri allowlist sync

**Defense:** `ALLOWED_METHODS` in `packages/ui/src-tauri/src/gateway_bridge.rs` is the union of every IPC method the renderer is permitted to call. Every entry must (a) have a gateway handler and (b) be classified as read-only or HITL-gated. `extension.install`, `connector.addMcp`, and any other code-execution-class surface is **not** in the renderer-callable allowlist; those are reachable only via Rust-native dialogs that prevent renderer-controlled paths.

**Wired at:** `gateway_bridge.rs` `ALLOWED_METHODS` array; cross-checked by the Rust-side allowlist test (G9).

**Anti-pattern:** adding a write/RCE-class method to the allowlist without a corresponding HITL gate, or shipping an entry whose gateway handler does not exist (`connector.startAuth` had no handler — S4-F2). S7-F2 / chain C1 (`extension.install` allowlisted with no HITL) was the chain that turned a renderer XSS into full credential exfiltration.

**How to comply:** when adding to `ALLOWED_METHODS`, verify the gateway handler exists, route any write through `HITL_REQUIRED`, and update the allowlist test that asserts every entry resolves to a real handler.

---

## I8 — Tauri renderer Content Security Policy is restrictive

**Defense:** `tauri.conf.json` sets `"csp": "default-src 'self'; script-src 'self'"` (or stricter). Inline scripts and remote origins are blocked.

**Wired at:** `packages/ui/src-tauri/tauri.conf.json`.

**Anti-pattern:** `"csp": null` (S4-F4 / chain C1 entry point — allowed prompt-injected content from any indexed connector to execute as renderer-trust-level script). Loosening to `'unsafe-inline'` for convenience is the same regression in disguise.

**How to comply:** new renderer features that need a wider CSP must add the *minimum* directive needed and document the rationale. `unsafe-inline` and `unsafe-eval` are forbidden.

---

## I9 — SQL parameter binding only

**Defense:** every SQLite query uses bound parameters via the typed `dbRun` / `dbExec` wrappers in `packages/gateway/src/db/write.ts`. Identifier-class values that cannot be parameter-bound (table/column names from a finite allowlist) go through `escapeIdentifier` with a null-byte / empty-name guard.

**Wired at:** `db/write.ts`, `db/repair.ts` (`escapeIdentifier`), `people/person-store.ts` (per-field parameter binding after S5-F5 fix).

**Anti-pattern:** template-literal SQL on caller-supplied data (``db.run(`UPDATE ... SET ${field} = ${value}`)``). S5-F5 was a `sets.join()` template in `patchPerson` that built SQL from caller-supplied field names.

**How to comply:** read S5-F5 before adding any new SQL. Identifier-shaped inputs go through `escapeIdentifier`; everything else binds. There is no "internal callers are trusted" carve-out.

---

## I10 — Constant-time comparison for security-sensitive byte strings

**Defense:** every comparison of a hash, signature, MAC, pairing code, or bearer token uses the canonical helpers exported from `packages/gateway/src/util/timing-safe-compare.ts` — never `===` or `!==`, and never a locally-defined `timingSafeEqual` / `constantTimeStringEqual` outside that module.

**Wired at:** `packages/gateway/src/util/timing-safe-compare.ts` (canonical module — single source of truth). Call sites: `extensions/verify-extensions.ts` + `updater/updater.ts` consume `sha256HexEqualConstantTime`; `ipc/lan-pairing.ts` + `ipc/http-auth.ts` consume `constantTimeStringEqual`.

**Anti-pattern:** `if (computed === expected)` for any value that an attacker can probe by timing. S6-F10 / S7-F8 were short-circuit equality on hashes. Redefining a local `timingSafeEqual` or `constantTimeStringEqual` outside `util/timing-safe-compare.ts` is the same anti-pattern — it creates a parallel, untested code path that future changes may regress silently.

**How to comply:** import `sha256HexEqualConstantTime` (for SHA-256 hex strings) or `constantTimeStringEqual` (for arbitrary same-length strings including bearer tokens and pairing codes) from `util/timing-safe-compare.ts`. Never roll a local timing-safe helper; the module's length-mismatch burn cycle and Buffer coercion cover the edge cases.

---

## I11 — Tool-result envelope on the LLM-facing path

**Defense:** every tool result that flows into an LLM context is wrapped in a textual `<tool_output service="..." tool="...">…</tool_output>` envelope by `wrapToolOutput` in `packages/gateway/src/engine/tool-output-envelope.ts`. Literal `</tool_output>` substrings inside the body are escaped to `<\/tool_output>` so attacker-controlled content cannot terminate the envelope and re-enter "instruction mode".

**Wired at:** the agent's tool wrapper in `packages/gateway/src/engine/agent.ts` (`wrapToolForLlm`) and the lazy-mesh dispatcher in `packages/gateway/src/connectors/lazy-mesh/mesh.ts` (`listTools`). The planner-side `ConnectorDispatcher` returns the bare result on its own path (gated by HITL); the envelope is applied at the LLM-facing boundary only.

**Audit-write complement (Phase 5 T6 PR 2, V29 `tool_call_log`):** at both wiring sites above, the envelope string is also written to `tool_call_log` via `writeToolCallLog` from `packages/gateway/src/db/tool-call-log.ts` (best-effort — internal try/catch swallows `DiskFullError` and constraint violations so an audit-write failure can never break the LLM-facing path). Forensic completeness is best-effort; functional correctness is mandatory. The read surface is `audit.toolCalls` IPC (read-only, IPC-only — NOT LAN-callable per `I5`, NOT in Tauri `ALLOWED_METHODS` per `I7`, NOT exposed via the read-only HTTP API — same exfiltration-class posture as `vault.*`).

**Anti-pattern:** building a new agent surface that calls a tool and feeds the raw result to the LLM. S8-F3 / chain C4 documented exactly this (no envelope present despite the doc claim) — the prompt-injection defense was a soft barrier (LLM-SDK message typing) only. A second-order anti-pattern is wiring `wrapToolOutput` without also calling `writeToolCallLog` — the envelope still works, but the forensic record needed to reconstruct what the LLM saw is silently lost.

**How to comply:** any new LLM-facing tool result goes through `wrapToolOutput` AND `writeToolCallLog` at the same site. The HITL gate is the structural defense for destructive actions; the envelope raises the bar against prompt injection on read-only and conversational paths; the audit-write closes the forensic-reconstruction gap after the fact.

---

## I12 — DPAPI optional entropy on Windows vault entries

**Defense:** the Windows vault implementation (`packages/gateway/src/vault/win32.ts`) loads a per-install entropy blob from `<configDir>/vault/.entropy` (created on first use) and passes it as `pOptionalEntropy` to every `CryptProtectData` / `CryptUnprotectData` call. Other same-uid processes cannot decrypt Nimbus vault blobs without also reading the entropy file.

**Wired at:** `vault/win32.ts` `protect` / `unprotect` paths; legacy entries without entropy are migrated on first read.

**Anti-pattern:** dropping the entropy parameter "for compatibility", or storing the entropy alongside the ciphertext in a way that defeats it. S2-F4 was the original gap (no entropy, any same-uid process could decrypt).

**How to comply:** the entropy blob lives only at `<configDir>/vault/.entropy`; do not mirror it into config files, logs, or IPC responses.

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

---

## I14 — All SQLite write paths route through `dbRun` / `dbExec` / `dbStmtRun`

**Defense:** `dbRun`, `dbExec`, and `dbStmtRun` in `packages/gateway/src/db/write.ts` are the only production paths that invoke `bun:sqlite`'s `Database.run` / `Database.exec` / `Statement.run`. The wrappers translate `SQLITE_FULL` (extended error code 13) into the typed `DiskFullError` and set the `_diskSpaceWarning` flag, so a full disk surfaces as a typed exception rather than a swallowed write.

**Wired at:** `packages/gateway/src/db/write.ts` (`dbRun`, `dbExec`, `dbStmtRun`). Enforced statically by D12 in `scripts/structure-audit/check-nimbus-invariants.ts` — exits 1 on any direct `db.run(` / `db.exec(` outside `DB_RUN_EXEC_ALLOW_LIST` (one entry: the wrapper file itself).

**Anti-pattern:** direct `db.run(` / `db.exec(` / prepared-statement `stmt.run(` in any production file under `packages/gateway/src/` outside `db/write.ts`. Reverting to direct calls means SQLITE_FULL is swallowed silently and the audit chain, sync state, and embeddings can end up half-written without surfacing a typed error to the gateway.

**How to comply:** every new SQL write uses `dbRun(db, sql, params?)`, `dbExec(db, sql)`, or `dbStmtRun(stmt, ...params)`. `bun run audit:invariants` fails fast on regressions; the runtime test in `security-invariants.test.ts` spot-checks three representative subsystems and the allow-list constant.

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

**2. Entry in this file** — a new `## I13 — Sub-agent tool scope enforcement` section naming the defense, the wiring site (`sub-agent.ts:dispatchToolCall`), the anti-pattern (any code that bypasses `dispatchToolCall`, or any mutable scope container), and the compliance recipe (always frozen sets; never call `tools[id].invoke()` directly).

**3. Enforcement test** — in `packages/gateway/src/security-invariants.test.ts`:

```typescript
test("I13 — sub-agent dispatcher checks frozen tool scope", () => {
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
