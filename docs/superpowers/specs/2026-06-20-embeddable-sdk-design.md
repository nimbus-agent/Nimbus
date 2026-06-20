# Embeddable SDK — "powered by Nimbus" — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Track 2 — Scale & Surface, Phase 12 "Enterprise" (commercial-license carve-out; see `docs/roadmap.md` line 46/48). This is a *packaging + distribution* slice of the existing "embed Nimbus in a product" commercial path, **not** a new engineering track and **not** a new product line.
**Scope:** `packages/client` (MIT — the embeddable binding lives here), `packages/sdk` (MIT — types reused, no engine added), `packages/gateway` (AGPL — a new headless/embeddable *boot mode* + a managed-spawn helper, source stays AGPL and stays a separate process), `packages/docs` (an embedding guide). **No new connector, no new schema, no new invariant if Option B is chosen.**

---

## Motivation / Goal

Let a third-party application ship a local Nimbus agent — branded "powered by Nimbus" — so the host product gets a private-context, HITL-gated, local-first agent without building one. The make-or-break constraint is the license + architecture boundary: `@nimbus-dev/sdk` and `@nimbus-dev/client` are **MIT** and import **nothing** from the gateway; `packages/gateway` is **AGPL-3.0-only** and `private: true` (`packages/gateway/package.json:5,4`). "Embed the engine" must not smuggle AGPL gateway internals into an MIT distributable.

### The make-or-break question (lead): what is actually MIT-embeddable?

Three things are true in-tree today, and they decide the whole design:

1. **The MIT surface is not an engine.** `@nimbus-dev/sdk` (`packages/sdk/src/index.ts`) exports connector-authoring scaffolding only — `NimbusExtensionServer`, crypto (JWT/Ed25519), `data-profile` parsers, JMAP helpers, brief *types*. There is **no cognitive loop, no planner, no executor, no HITL gate, no MCP dispatch** in the SDK. `@nimbus-dev/client` (`packages/client/src/nimbus-client.ts`) is a thin JSON-RPC 2.0 wrapper that `NimbusClient.open({ socketPath })` connects to — it **requires a running Gateway process** and calls `agent.invoke` / `index.queryItems` / `engine.cancelStream` over a socket. It is a *remote control*, not a motor.

2. **The engine is AGPL and deeply coupled to AGPL infrastructure.** `createNimbusEngineAgent` (`packages/gateway/src/engine/agent.ts`) is wired in `packages/gateway/src/index.ts` against `createPlatformServices()` — Vault, the SQLite local index, the MCP connector mesh, the sandbox runner, the platform abstraction layer (`packages/gateway/src/platform/`). The HITL structural gate lives in `engine/executor.ts` `gate()` (Non-Negotiable #2, invariant **I2**). None of this is relicensable to MIT, and none of it is extractable as a small library — it is the gateway.

3. **The roadmap already answers the "standalone MIT engine" temptation: don't.** `docs/roadmap.md:48` states BYO-Index OEM is "deliberately *not* pursued as [a wedge]… and the latter is already the existing 'embed Nimbus in a product' commercial-license path." A standalone MIT engine would be a ~10k-LOC re-implementation that *forks the HITL/Vault/MCP invariants into a second codebase* — directly endangering Non-Negotiable #2 (HITL structural) because the gate would have to be re-proven in code the AGPL invariant tests don't cover.

**Conclusion that frames every approach below:** "MIT-embeddable" can only honestly mean *the MIT `@nimbus-dev/client` binding embeds the AGPL gateway as a separate, spawned process and talks to it over the local socket.* The host app links MIT code; it ships (or fetches) the AGPL gateway binary as a standalone executable that runs in its own process under AGPL terms. There is **no** license-clean, invariant-safe path to an in-process MIT engine.

---

## Where this fits (roadmap home + not-already-shipped evidence)

- **Roadmap home:** Phase 12 Enterprise / commercial-license carve-out (`docs/roadmap.md:43,46,48`). The grounding pass confirmed "not-started": no design doc for an embeddable SDK exists; `@nimbus-dev/client` v0.2.3 assumes a running gateway and is not a managed-embed binding.
- **Not already shipped (verified):** `packages/client/src/index.ts` exports `NimbusClient`, `IPCClient`, `MockClient`, `discoverSocketPath` — all assume an *already-running* gateway the caller located. There is **no** "spawn + supervise a managed gateway" API, **no** "powered by Nimbus" attribution/lifecycle contract, and **no** embedding guide in `packages/docs`. So the gap is a thin **managed-spawn lifecycle binding** on the existing MIT client + an AGPL **embeddable boot mode** on the existing gateway, plus docs — not a new engine.

---

## Approaches considered

### Approach A — Standalone MIT engine (REJECTED)

Re-implement the cognitive loop, MCP dispatch, Vault integration, and HITL gate as new MIT code under `packages/sdk` (or a new `packages/engine-lite`).

- **Trade-offs:** Cleanest *story* ("pure MIT engine") but catastrophic in practice. ~10k-LOC re-implementation; **forks Non-Negotiable #2** — the HITL gate would be re-authored in MIT code the AGPL `security-invariants.test.ts` does not cover, so I2/I3/I4 would have a second, unverified home (the exact failure mode the B1 audit warns about: a defense defined but not the canonical wired one). Vault, sandbox, PAL, and MCP mesh would all need MIT twins, duplicating I1/I3/I10/I12/I15. Permanent divergence risk between two engines. Violates "reuse > rebuild."
- **Verdict:** Rejected. It trades a licensing footnote for a structural-security and maintenance liability.

### Approach B — MIT managed-spawn binding + AGPL embeddable boot mode (RECOMMENDED)

Extend the existing MIT `@nimbus-dev/client` with a `ManagedGateway` lifecycle helper that *spawns and supervises* the AGPL `nimbus-gateway` binary as a child process, then drives it via the existing `NimbusClient` over the local socket. Add a small AGPL **embeddable boot mode** to the gateway (`--embedded` / config flag) that runs headless, binds loopback-only, picks an ephemeral socket, and writes its state file for discovery. The host app links **only MIT**; the AGPL binary runs in its **own process** under AGPL.

- **Trade-offs:** License-clean (MIT links to a separate-process executable; classic "aggregation," not a derivative work — the MIT binding never imports AGPL source). **Zero invariant fork** — I1–I27 stay in their one canonical AGPL home and keep their existing tests. The host must ship/fetch the gateway binary (size + AGPL-distribution obligation). Slightly higher integration surface than a library (process supervision, health). This is the only path that preserves all 7 Non-Negotiables without duplicating any of them.
- **Verdict:** Recommended.

### Approach C — Documentation-only: bless the existing client as the embed path

Write only an embedding guide; tell integrators to spawn the gateway themselves and use `NimbusClient.open({ socketPath })` as-is.

- **Trade-offs:** Zero code, ships in a day, fully license-clean. But it pushes process supervision, ephemeral-socket selection, version-compat checks, crash recovery, and graceful shutdown onto every integrator — each of whom will reinvent it (often insecurely, e.g. binding non-loopback, leaking the socket path, or skipping the I6 default). The value of an *embeddable SDK* is precisely a hardened, correct-by-default lifecycle. Doc-only abdicates that.
- **Verdict:** Good as the **v0 fallback** and the docs deliverable inside B, but insufficient as the product.

**Recommendation: Approach B**, with Approach C's embedding guide folded in as a deliverable. B is the only option that (1) keeps the MIT/AGPL boundary honest by linking MIT code to a *separate-process* AGPL binary, (2) does not fork any of I1–I27 (Non-Negotiable #2 in particular stays single-homed and tested), and (3) gives integrators a correct-by-default, loopback-only, supervised lifecycle instead of a footgun. Scope v1 to **single-user, host-supplied connectors, all three platforms via the existing compiled binary** — defer team/federation, marketplace, and bundled-connector delivery.

---

## Design (recommended)

### Architecture & components

**MIT side — `packages/client` (extends existing exports):**
- `packages/client/src/managed-gateway.ts` (NEW) — `ManagedGateway` class:
  - `ManagedGateway.start(opts: ManagedGatewayOptions): Promise<ManagedGateway>` — resolves the `nimbus-gateway` binary path (host-supplied via `opts.binaryPath`; **no auto-download in v1** — YAGNI/security), spawns it in **embedded boot mode** with `extensionProcessEnv`-style minimal env, waits for the gateway state file (reuses `readGatewayState`/`gatewayStatePath` from `packages/client/src/discovery.ts`), then opens a `NimbusClient` against the discovered `socketPath`.
  - Exposes `.client: NimbusClient` (the existing typed wrapper — `agentInvoke`, `askStream`, `subscribeHitl`, `queryItems`).
  - `.stop(): Promise<void>` — graceful `client.close()` then SIGTERM the child, with a SIGKILL fallback timeout.
  - `.health(): "starting" | "ready" | "exited"` and an `onExit` callback for crash supervision.
  - `ManagedGatewayOptions`: `{ binaryPath: string; configDir?: string; dataDir?: string; logSink?: (line: string) => void }`. All paths default via `getNimbusPaths`/`getNimbusPaths`-style helpers (`packages/client/src/paths.ts`) so the host can sandbox Nimbus's data to its own app dir.
  - **No new dependency** — uses `node:child_process` (already available under Bun/Node) and the existing transport.
- `packages/client/src/index.ts` — add `export { ManagedGateway, type ManagedGatewayOptions } from "./managed-gateway.js"`.
- Attribution helper: `export const POWERED_BY_NIMBUS = { name, version, url } as const` (a tiny constant the host renders; the "powered by Nimbus" brand is a licensing/marketing artifact, not enforced in code).

**AGPL side — `packages/gateway` (additive, source stays AGPL):**
- `packages/gateway/src/index.ts` — add an **embedded boot mode** branch (env `NIMBUS_EMBEDDED=1` or `--embedded` argv). In embedded mode the existing `main()` path:
  - binds the IPC socket on an **ephemeral path** under `dataDir` and **loopback only** (reuses the I6 default in `config/nimbus-toml.ts` — bind defaults to `127.0.0.1`; embedded mode asserts it and refuses any non-loopback `[lan]` bind, fail-closed),
  - **disables the HTTP write surface by default** (I13: `WRITE_ROUTE_ALLOWLIST` gated; embedded mode defaults the surface off unless the host opts in with a bearer token),
  - **disables LAN federation/discovery by default** (no mDNS, no `LanServer`) — single-user v1,
  - writes the gateway state file (`writeGatewayStateFile` already in `index.ts`) so the MIT `ManagedGateway` can discover the socket,
  - keeps **the entire engine, HITL gate, Vault, MCP mesh, sandbox unchanged** — embedded mode is a *configuration profile*, not a code fork.
- No change to `engine/executor.ts`, `vault/*`, or any invariant wiring. The compiled binary from `compile-gateway.ts` is reused as-is (it already produces a single `nimbus-gateway[.exe]` per platform with the `vec0` sidecar — `packages/gateway/compile-gateway.ts:91-109`), satisfying Non-Negotiable #5 (platform equality) for free.

**Reused MIT types — `packages/sdk`:** no engine added. The embedding guide references `NimbusItem`, `HitlRequest`, brief types from `packages/sdk/src/index.ts` for typing host glue. SDK stays connector-authoring scaffolding.

### Data flow

1. Host app calls `ManagedGateway.start({ binaryPath, dataDir })` (MIT).
2. `ManagedGateway` spawns `nimbus-gateway --embedded` (AGPL, **separate process**) with a minimal, secret-free env.
3. The gateway boots headless, binds a loopback ephemeral socket, writes its state file.
4. `ManagedGateway` reads the state file, `NimbusClient.open({ socketPath })`, returns control to the host.
5. Host drives agent turns via `mg.client.agentInvoke(...)` / `askStream(...)`; **HITL prompts surface over the existing `agent.hitlBatch` notification** (`subscribeHitl` in `nimbus-client.ts:52`) — the host renders the consent UI but **cannot bypass the gate**; approval/denial round-trips to the AGPL executor `gate()`.
6. All connector calls, Vault access, and writes happen **inside the AGPL gateway process**, sandboxed per-connector (I15). Nimbus-indexed data never crosses into the host's process except as explicit `agentInvoke`/`queryItems` results the user (via HITL) authorized.
7. `ManagedGateway.stop()` closes the client and terminates the child.

### IPC / CLI surface

- **No new IPC methods.** v1 reuses the shipped surface: `agent.invoke`, `agent.hitlBatch` (notification), `engine.cancelStream`, `engine.getSessionTranscript`, `index.queryItems`, `audit.list` (all already on `NimbusClient`).
- **MIT API (new):** `ManagedGateway.start/stop/health`, `.client`. No new socket method, no new Tauri allowlist entry (embedded mode has no renderer; I7 untouched).
- **Gateway CLI (new flag only):** `nimbus-gateway --embedded` (a boot-mode flag, not a new subcommand). Optionally `nimbus gateway --embedded` mirrored in the CLI for manual testing. No new `nimbus <cmd>` user surface in v1.

### Security: explicit check against the 7 Non-Negotiables

1. **Local-first** — ✅ Preserved and *strengthened*. The gateway is the source of truth; the host app is just another local client over loopback IPC. Embedded mode **disables LAN bind and federation by default**, and **disables the HTTP write surface by default**, so the host product cannot turn Nimbus into an egress relay. Nimbus-indexed data leaves the gateway only as explicit, HITL-authorized query/agent results.
2. **HITL is structural** — ✅ **Untouched and single-homed.** The gate stays in AGPL `engine/executor.ts` `gate()` (I2/I3/I4). The MIT binding only *relays* `agent.hitlBatch` prompts and the user's reply — it has no "proceed without HITL" mode, and cannot have one, because the gate is in a different process the host doesn't link. This is the decisive reason to reject Approach A.
3. **No plaintext credentials** — ✅ Vault stays the AGPL gateway's OS-native store (DPAPI/Keychain/libsecret via `packages/gateway/src/platform/`). The MIT binding never sees a secret; the spawn env is minimal and secret-free (mirrors I1 `extensionProcessEnv` scoping). The host's own credential store is irrelevant to Nimbus.
4. **MCP as connector standard** — ✅ All cloud access stays in-gateway via the MCP mesh; the host calls the engine, never a cloud API. Connectors stay sandboxed (I15).
5. **Platform equality** — ✅ Reuses the existing per-platform compiled binary (`compile-gateway.ts` already emits win/mac/linux). The MIT spawn helper is platform-agnostic Bun/Node `child_process`.
6. **AGPL-3.0 core / MIT sdk** — ✅ **The whole point.** MIT `@nimbus-dev/client` links to a *separate-process* AGPL executable (mere aggregation; the MIT code imports no AGPL source). License fields unchanged. The host's AGPL-distribution obligation for the bundled binary is documented in the embedding guide.
7. **No `any`** — ✅ `ManagedGateway` and options are fully typed; external data (state file, child stdio) typed as `unknown` and validated, matching existing `nimbus-client.ts` patterns.

### Licensing obligations (READ FIRST — the embedding guide must LEAD with this)

This is the single most load-bearing constraint of the whole design, and it is **the embedder's obligation, not Nimbus's**. The architecture is deliberately a **mere aggregation**, not a derivative work:

- The host application links **only MIT** code: `@nimbus-dev/client` (the `ManagedGateway` binding) and `@nimbus-dev/sdk` (types). These import **no AGPL source** and may be statically linked, bundled, or shipped in a closed-source host with no copyleft reach.
- The host **also ships and runs the AGPL `nimbus-gateway` binary as a SEPARATE process**. That binary is **AGPL-3.0-only**. Because the MIT binding talks to it solely over a local socket (IPC, separate address space, separate process), this is classic **aggregation** — the AGPL terms do **not** reach into the host's MIT/proprietary code.
- **But** the AGPL copyleft *does* attach to the `nimbus-gateway` binary itself. Under **AGPL §13** (and §6, the "Conveying Non-Source Forms" terms), an embedder who **distributes or makes the bundled gateway available to users — including over a network** — **MUST provide the gateway's corresponding source**, or a valid **written offer** to supply it, to those users. Running an *unmodified* upstream release means the embedder can point users at the upstream source; running a *modified* gateway means the embedder must publish *their* corresponding source under AGPL.
- The "powered by Nimbus" attribution is a marketing/brand artifact and is **separate from** this AGPL source-availability duty — satisfying one does **not** satisfy the other.
- **The embedding guide MUST open with this obligation, before any code sample**, so an integrator cannot ship the binary without first understanding the AGPL §13 source-availability duty. The guide states plainly: *if you distribute or expose the `nimbus-gateway` binary to users, you must give those users the gateway's corresponding source or a written offer per AGPL §13.* The commercial-license carve-out (`docs/roadmap.md:46`) is the *only* path that relaxes this duty for the bundled AGPL binary.

**Invariant impact:** **No new invariant required** under Approach B — every gating mechanism stays in its existing AGPL home with its existing test. Embedded mode is a *config profile* that asserts the I6 loopback default and the I13 write-surface-off default; it does not add a new gate. **I28 is reserved** (unmerged MCP-gateway-server branch) — embedded mode is unrelated to it and must not collide. **Schema:** no migration — embedded mode uses the same V43 index; **V44 is not needed**. (If a future v2 ever runs a reduced-schema embedded variant, that would trigger V44, but that is explicitly out of scope.)

**Fail-closed behavior:** if the binary path is missing/unresolvable → `start()` rejects (no silent fallback). If the gateway state file doesn't appear within a timeout → `start()` rejects and the child is killed. If a non-loopback bind is configured in embedded mode → the gateway refuses to boot. If the host tries to enable the HTTP write surface without a bearer token → I13 rejects. Crash of the child → `health()` reports `"exited"` and `onExit` fires; no zombie, no auto-restart-with-stale-state.

### Testing

- **Integration (real subprocess, the canonical layer here):** `packages/client/src/managed-gateway.test.ts` spawns a **mock gateway stub** (a tiny script that writes a state file + serves the JSON-RPC handshake on a loopback socket, in the spirit of the E2E-CLI "real subprocess + mock MCP" rule) and asserts `start()→ready→agentInvoke→stop()` and the crash/`onExit` path. No real cloud, no real LLM.
- **HITL layer:** assert that `subscribeHitl` relays a `agent.hitlBatch` prompt and that there is **no API path** in `ManagedGateway` to auto-approve — a negative test proving the binding exposes no bypass (Non-Negotiable #2).
- **Vault layer:** assert the spawn env handed to the child contains no secret keys (mirror the I1 env-scoping assertion).
- **Gateway embedded-mode:** a gateway-side test that `NIMBUS_EMBEDDED=1` boots loopback-only, leaves the HTTP write surface off, and refuses a non-loopback bind (fail-closed).
- **Coverage:** every new file (`managed-gateway.ts`, the embedded-mode branch) must clear the ≥80% line+branch floor per file (`baseline.json` is `{}` — new files start at the floor). Reuse `MockClient` (`packages/client/src/mock-client.ts`) where a full subprocess is unnecessary.

---

## Non-goals (YAGNI — cut hard)

- **No standalone MIT engine** (Approach A) — ever, for the license + invariant-fork reasons above.
- **No binary auto-download / bundler** in v1 — host supplies `binaryPath`. (Removes a supply-chain + signing surface; can be a v2.)
- **No team/federation/quorum/SSO** in embedded v1 — single-user. LAN/discovery/HTTP-write default **off**.
- **No marketplace / third-party extension install** in embedded v1 — host supplies connectors via config; I16 publisher-verification only matters if/when a marketplace is added (v2).
- **No Tauri/CLI/VS Code UI** shipped with the embed — the host owns the UX; the binding is engine-access only.
- **No new IPC methods, no V44 migration, no new invariant.**
- **No Sovereign-Mesh / Share (I27) integration** — out of scope for v1.

## Open questions

1. **Binary delivery for v1:** host-supplied path only (recommended), or a documented "fetch the signed release asset" recipe? Auto-download is a v2 supply-chain decision.
2. **AGPL distribution obligation messaging — RESOLVED.** Settled by the "Licensing obligations" subsection above: the embedding guide **LEADS** with the AGPL §13 duty — an embedder who distributes or exposes (incl. over a network) the bundled `nimbus-gateway` binary MUST provide that binary's corresponding source, or a written offer per AGPL §13, to its users (the MIT binding remains mere aggregation and is unaffected; the commercial-license carve-out per `docs/roadmap.md:46` is the only relaxation of this duty for the AGPL binary). Final maintainer wording to be confirmed at doc-write time, but the obligation and its lead placement are fixed.
3. **Commercial-license interaction:** is the *MIT managed-spawn binding* freely usable while the *bundled AGPL binary* is what the commercial license relaxes? (Likely yes — the binding is already MIT.) Confirm so the go-to-market is unambiguous.
4. **Mirror the `--embedded` flag into the `nimbus` CLI** for manual integrator testing, or keep it gateway-binary-only?
5. **Health/restart policy:** v1 surfaces `onExit` and lets the host decide; should we offer an opt-in supervised auto-restart, or is that always the host's job? (Lean: host's job, YAGNI.)

## Acceptance criteria

- [ ] `ManagedGateway.start({ binaryPath })` spawns the AGPL gateway as a **separate process**, discovers the loopback socket via the state file, and returns a working `NimbusClient`; `stop()` cleanly terminates it. (integration test, real subprocess)
- [ ] The MIT binding imports **no** AGPL source — verified by the existing dependency-rule check (client→sdk only); `packages/client/package.json` gains no gateway dependency.
- [ ] Embedded boot mode binds **loopback only**, leaves the **HTTP write surface off**, and **disables LAN/federation** by default; a non-loopback bind in embedded mode **fails closed**. (gateway test)
- [ ] HITL prompts relay over `agent.hitlBatch`; there is **no** `ManagedGateway` API that auto-approves a gate. (negative HITL test)
- [ ] The child spawn env contains **no secret keys**. (Vault/I1-style env-scoping test)
- [ ] No new IPC method, no Tauri allowlist change, **no new invariant**, **no V44 migration** — I1–I27 stay single-homed; `security-invariants.test.ts` and the static structure audit are untouched.
- [ ] New files clear the **≥80% per-file line+branch** coverage floor.
- [ ] `packages/docs` gains an "Embed Nimbus (powered by Nimbus)" guide that **LEADS with the AGPL §13 source-availability obligation** (before any code sample): the embedder ships+runs the AGPL `nimbus-gateway` binary as a separate process and MUST provide its corresponding source or a written offer per AGPL §13, while the MIT `@nimbus-dev/client` binding is mere aggregation. The guide then covers the spawn lifecycle, the loopback/no-egress defaults, and the HITL relay contract.
- [ ] `bun run preflight:fast` passes (types/lint/static rules); the new test suites pass.
