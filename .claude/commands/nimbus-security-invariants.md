---
name: nimbus-security-invariants
description: >
  The Nimbus invariant triple rule + security-defense lifecycle: production wiring + docs
  entry + enforcement test. Use when adding, modifying, or auditing a structural security
  defense — HITL action types, extension integrity checks, Vault redaction, ALLOWED_METHODS
  entries, any new gating mechanism — or asking "is this defense real?" / why the
  security-invariants test fails. Consult before claiming a defense is active — the B1 audit
  found three defenses defined in code but never wired in production.
---

# Nimbus Security Invariants

## The Invariant Triple Rule

Every structural security defense in Nimbus must exist as **three things simultaneously** or it is not considered real:

1. **Production wiring site** — an actual call site in production code, not just a function definition.
2. **Entry in `docs/SECURITY-INVARIANTS.md`** — names the defense, its invariant ID (format `I<N>`), and the production wiring file and line.
3. **Assertion in `packages/gateway/src/security-invariants.test.ts`** — fails if the wiring is removed.

If any one of the three is missing, **do not claim the defense is active**. Search for all three before marking work done.

## The B1 Audit Lesson

The Phase 4 internal audit found three defenses (`extensionProcessEnv`, `checkLanMethodAllowed`, the `<tool_output>` envelope) that were **defined in code but had zero production callers**. The triple rule exists to prevent that failure mode. When adding a new defense, do all three of:

- `grep` for the function name across `packages/gateway/src/` to confirm it has at least one production caller.
- Add the `I<N>` row to `docs/SECURITY-INVARIANTS.md` with the wiring file:line.
- Add a test in `security-invariants.test.ts` that fails if the wiring is removed (e.g., asserts a specific source file imports/calls the defense).

## HITL Invariants

`HITL_REQUIRED` in `packages/gateway/src/engine/executor.ts` is a **module-level `ReadonlySet` frozen with `Object.freeze`**. Rules:

- Never populated from config files, IPC calls, or extension APIs at runtime.
- New action types are added by editing the static source declaration only.
- The corresponding test asserts that **every action type in the set triggers the consent channel** in `ToolExecutor.execute()`.
- The gate consults `action.type` only — **not** `payload.mcpToolId` or `resolvedToolId` (the set holds logical types, not MCP ids — invariant `I3`).
- `hitlStatus` is set only by the consent gate (invariant `I4`). Hardcoding `hitlStatus: "approved"` in any handler is a regression.

## Extension Integrity Invariants

Manifest SHA-256 is verified **once, at Gateway startup**, via `verifyExtensionsBestEffort` (wired from `platform/assemble.ts`). It hashes every enabled extension and compares against the stored `manifest_hash`/`entry_hash`, hard-disabling any mismatch. For `publisher` extensions it also runs the Ed25519 signature pass (`I16`).

When a connector is later spawned, the verified manifest is reduced to a `SandboxPolicy` (`policyFromManifest`) and serialized into the `NIMBUS_SANDBOX_POLICY_JSON` env var by `wrapServerSpec()` (see `I15` below) — there is **no** separate re-verification step immediately before spawn in production. (`verifyOneExtensionStrict` exists in `verify-extensions.ts` but currently has test-only callers.)

When auditing, confirm the startup call site exists and that the per-extension hash check is reached; deleting it breaks the invariant.

## Vault Invariants

**No code path may** write a credential value to disk in plaintext, include it in a log line, or return it in an IPC response.

- The Pino logger `redact` config covers `*.token`, `*.secret`, and `oauth.*` patterns.
- When adding a new credential type, verify the field name matches one of these patterns or **add it explicitly to the redact list**.
- The structured logger redaction is enforced by a unit test that pipes a known-secret payload through the logger and asserts the secret never appears in output.

## ALLOWED_METHODS Invariant

The Rust bridge in `packages/ui/src-tauri/src/gateway_bridge.rs` maintains a **compile-time `ALLOWED_METHODS: &[&str]` array**. A `cargo test allowlist_exact_size` assertion verifies the count.

When adding new IPC methods accessible from the UI:

- Add them to `ALLOWED_METHODS` **alphabetically**.
- **Update the count assertion** in the test.
- Never expose `vault.*`, raw `db.*` writes, `config.set`, `index.rebuild`/`index.querySql`, or `lan.*` pairing methods through this surface — these are RCE-class or pairing-class and must remain Gateway-only. NOTE `updater.*` is deliberately NOT in that set: four methods (`applyUpdate`, `checkNow`, `getStatus`, `rollback`) are renderer-exposed on purpose so the desktop app can drive its own update flow — see `nimbus-tauri-allowlist`.

## I15 — Sandbox Invariant

Every connector child process under `packages/gateway/src/connectors/lazy-mesh/` is executed inside a per-OS sandbox. The architecture is **Option A wrapper-shim**:

1. Every `ServerSpec` literal in lazy-mesh (`mesh.ts`, `connector-spawns.ts`, `phase3-config.ts`, `user-mcp.ts`) is constructed and then immediately routed through `wrapServerSpec(...)` from `connectors/lazy-mesh/wrap-server-spec.ts` before being handed to MCPClient.
2. `wrapServerSpec` rewrites `ServerSpec.command` to invoke `bun packages/gateway/src/platform/sandbox/sandbox-wrapper.ts`, preserves the original command/args as wrapper arguments, and serializes the manifest-derived `SandboxPolicy` (`policyFromManifest`) into the `NIMBUS_SANDBOX_POLICY_JSON` env var.
3. The wrapper process reads the policy from env, calls `createSandboxRunner()` (which selects `linux.ts` / `darwin.ts` / `win32.ts`), and invokes `runner.spawn(originalCmd, originalArgs, opts)`. **This is the single sandbox-execution boundary** — every extension child process passes through this exact call site.

The rule a contributor follows is the same as the other "intrinsic" invariants (`I2`/`I5`/`I14`): **never construct an MCPClient `ServerSpec` under `connectors/lazy-mesh/` without immediately routing it through `wrapServerSpec(...)`**. Bypassing the wrapper means landlock/seccomp on Linux, seatbelt on macOS, and Job Objects on Windows are all skipped for that child.

Wiring sites the I15 enforcement test asserts against:

- Each lazy-mesh source file imports `wrapServerSpec` from `./wrap-server-spec.ts` and the source contains at least one `wrapServerSpec(` call.
- `platform/sandbox/sandbox-wrapper.ts` calls `runner.spawn(` against a `SandboxRunner` from `createSandboxRunner()`.

Static-audit complement: `D10` in `scripts/structure-audit/check-nimbus-invariants.ts` exits 1 on any `ServerSpec` literal under `connectors/lazy-mesh/` that does not pass through `wrapServerSpec(...)`. Same enforcement shape as the `D10-spawn` (`I1`) and `D12` (`I14`) static rules — fails before the test suite runs.

**Why Option A:** the wrapper-shim collapses N lazy-mesh spawn sites into one sandbox boundary. If we instead asked every spawn site to call `runner.spawn` directly, the runtime test would have to grow with every new call site, and a future contributor could miss one. With Option A the invariant is "any `ServerSpec` constructed in lazy-mesh is wrapped" rather than "every spawn site individually applies a sandbox" — one boundary, one test pattern, one anti-pattern to catch.

**Anti-pattern:** constructing a `ServerSpec` literal under `connectors/lazy-mesh/` without routing it through `wrapServerSpec(...)`. Caught by both the runtime I15 test in `security-invariants.test.ts` and the static `D10` rule in `check-nimbus-invariants.ts`.

## I29 — Egress Ledger Chokepoint

A recent static+runtime defense (`I28` is reserved for the MCP-server owner-sink on the parked `dev/asafgolombek/phase7-mcp-gateway-server` branch). Same shape as `I15`: every gated action appends exactly one `egress_ledger` row from `engine/executor.ts` `ToolExecutor.gate()` **before** `connectors.dispatch` (a denied gate writes a `result_status='blocked'` row; an append failure aborts the dispatch, fail-closed) — a textbook triple (production wiring + a `SECURITY-INVARIANTS.md` row + the `I29` block in `security-invariants.test.ts`). Static `D22` in `check-nimbus-invariants.ts` confines every `connectors.dispatch` to `executor.ts` and `appendEgressEntry` to `egress/*`, so a bypass fails before the suite runs. Deep dive: the `nimbus-egress` skill.

## I30 — Web-Clipper Token Minting (latest)

The current highest invariant. A web-clipper bearer token is minted **only** behind a live, owner-opened, single-use pairing window (`clips/pairing-window.ts`, opened via `nimbus clip pair`): with no window, `POST /v1/clips/pair/confirm` returns HTTP 403 (fail-closed, no mint); the window is in-memory only (a restart drops it) and minted tokens are Vault-stored + revocable. A runtime triple — production wiring (`clips/pairing-window.ts` + `ipc/http-write-routes.ts` + `clips/clip-token-store.ts`) + the `SECURITY-INVARIANTS.md` I30 row + the no-mint-witness `I30` block in `security-invariants.test.ts`. Unlike `I29`, I30 has **no** static `D`-rule (runtime enforcement only). Deep dive: `docs/SECURITY-INVARIANTS.md` I30 + the web-clip HTTP surface in the `nimbus-http-write-surface` skill.

## When to Create a New Invariant Entry

Add an invariant entry (`I<N>` row in `SECURITY-INVARIANTS.md` + test assertion) when you add:

- A new HITL action type.
- A new credential storage path.
- A new extension verification step.
- A new IPC method gating.
- A new prompt injection defense.

**Do not** add invariant entries for non-security behavior. The invariant table is a load-bearing contract, not a documentation index.

## Workflow Checklist

When introducing or modifying a structural defense:

- [ ] Production wiring site exists and has a real caller (`grep` to confirm).
- [ ] `docs/SECURITY-INVARIANTS.md` has an `I<N>` row naming the defense + wiring file:line.
- [ ] `packages/gateway/src/security-invariants.test.ts` has an assertion that fails if the wiring is removed.
- [ ] If the defense gates an IPC method exposed to the UI, the method is in `ALLOWED_METHODS` and the count assertion is updated.
- [ ] If the defense affects credentials, the field name matches the Pino `redact` patterns or is added explicitly.
- [ ] When changing a wiring site, update both the test and `SECURITY-INVARIANTS.md` in the same commit. When retiring an invariant, delete the row — never leave it as documentation drift.
