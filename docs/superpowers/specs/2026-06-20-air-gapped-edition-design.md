# Air-Gapped / Regulated Edition (Strict Offline Profile) — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Track 2 Commercial — Phase 12 Enterprise ("Clean room" AI deployment mode, `docs/roadmap.md:1515`). Reuses the S1 egress-ledger primitive *when it exists* but does not depend on it.
**Scope:** `packages/gateway` only (config + connector mesh + boot wiring + one new invariant). No new connector, no UI, no SDK change, no schema migration.

- `packages/gateway/src/config/nimbus-toml.ts` — new `[air_gap]` section parser (mirrors the existing `[llm]` parser at lines 189–263).
- `packages/gateway/src/connectors/connector-catalog.ts` — add a `LOCAL_ONLY_CONNECTOR_SERVICES` set + `isCloudConnectorService()` helper (sits beside `GOOGLE_CONNECTOR_SERVICES` / `MICROSOFT_CONNECTOR_SERVICES` at lines 99–110).
- `packages/gateway/src/connectors/lazy-mesh/mesh.ts` — boot-time rejection in `LazyConnectorMesh` (new invariant **I32** wiring site; the constructor already accepts an injected `isConnectorAllowed` predicate at line 70/84).
- `packages/gateway/src/platform/assemble.ts` — feed `[air_gap]` into the LLM registry (line 899), the auto-update daemon (line 933, currently hardcoded `enforceAirGap: false`), the embedding runtime (force local), the mesh predicate (line 872), and LAN federation (skip `LanServer` start).
- `packages/gateway/src/security-invariants.test.ts` + `scripts/structure-audit/check-nimbus-invariants.ts` — the I32 enforcement test + static complement.
- `docs/SECURITY-INVARIANTS.md` + `CLAUDE.md` + `GEMINI.md` — the I32 row (invariant triple rule).

## Motivation / Goal

Ship a single, boot-verifiable **strict offline profile** for defense / healthcare / finance deployments: one flag (`[air_gap] strict = true`) that makes outbound cloud egress *structurally impossible*, not merely discouraged. In strict mode the gateway runs Ollama/llama.cpp only, local MiniLM embeddings only, no cloud connector child process ever spawns, no LAN federation peer is reachable, and the auto-update daemon never starts. If any cloud connector or remote LLM is *configured* while strict mode is on, the gateway must **fail loudly at boot** rather than silently degrade — so an operator cannot accidentally believe they are air-gapped when a connector is quietly live.

This is a **packaging + lockdown profile**, not a feature: it composes the already-shipped local-first primitives behind one fail-closed switch and adds exactly one new structural invariant.

## Where this fits (roadmap home + not-already-shipped evidence)

**Already shipped (verified in-tree — reuse, do not rebuild):**

- **`enforce_air_gap` LLM enforcement.** Parsed in `nimbus-toml.ts` (`NimbusLlmToml.enforceAirGap`, default `false`, lines 196/208/237–241) and enforced in `llm/router.ts`: `firstAvailable()` skips any non-local provider when `enforceAirGap` is set (`if (this.config.enforceAirGap && !LOCAL_PROVIDER_IDS.has(id)) continue;`, line 72), `findPreferred()` does the same (line 200), and `fitPromptOrFallback()` throws rather than falling back to remote on context overflow (line 124). Wired into the registry at `assemble.ts:899`.
- **Local embeddings with MiniLM fallback.** `embedding/create-embedding-runtime.ts`: when `provider !== "openai"` and no OpenAI key is present, falls through to `createLazyEmbeddingRuntime` (the local MiniLM-L6-v2 worker), lines 119–142.
- **A connector filtering chokepoint.** `isConnectorAllowed(serviceId)` (I22 org-policy `connectorAllow`) is already injected into the mesh constructor (`mesh.ts:70/84`) and enforced in **two** places: the mesh dispatcher drops disallowed connector tools (`dropDisallowedConnectorTools`, `mesh.ts:437`) **and** the sync scheduler refuses to register a blocked connector (`assemble.ts:414`). This is the exact seam air-gap needs — we do not invent a new filter, we compose a stricter predicate into the same seam.
- **Auto-update air-gap awareness.** `extensions/auto-update.ts` `start()` returns early when `enforceAirGap` is true (line 115). Boot currently hardcodes `enforceAirGap: false` (`assemble.ts:933`) — strict mode must override this.

**NOT shipped (this is the gap this spec designs):**

- No `[air_gap]` profile that *binds all of the above together* from one flag. Today an operator must independently set `[llm].enforce_air_gap`, configure no cloud connectors, set `[embedding].provider`, not start federation, and trust the auto-update env var — with no boot-time assertion that the combination is actually airtight.
- No **structural** boot-time rejection of cloud connectors. `isConnectorAllowed` defaults to permit-all (`mesh.ts:94`), and is only ever tightened by *signed org policy* (I22). There is no air-gap-driven, fail-closed denial.
- No fail-loud guard: configuring a cloud connector + `enforce_air_gap=true` today just means the LLM is local while the connector's *sync* still runs (egress!). The connector tool surface is hidden from the LLM by policy but the connector child process and its network calls are not prevented by `enforce_air_gap` at all.

**Explicitly out of scope (separate roadmap work, do not build here):** the egress ledger (`nimbus egress`, Phase 8 / S1, `roadmap.md:1132`), `nimbus prove` (S1 / P22, `roadmap.md:1028`), boot-time *network-syscall* zero-egress attestation, and the auditor-grade signed export (M7 / P12.5). This profile makes egress structurally impossible by construction; *proving* it to a third party is the ledger's job and lands later. The spec notes the seam where the ledger plugs in.

## Approaches considered

### Approach A — Reuse the `isConnectorAllowed` (I22) seam with a stricter predicate; no new invariant

Compose air-gap into the existing policy allowlist: when `[air_gap].strict`, wrap `isConnectorAllowed` so it additionally returns `false` for every cloud connector. Plus set `enforceAirGap=true` on the LLM router + auto-update + embeddings + skip federation.

- **Pro:** smallest diff; the filter seam is already enforced in both the mesh dispatcher and the sync scheduler, so cloud sync is already prevented through it.
- **Con (fatal):** I22's `isConnectorAllowed` is a *tool-visibility / sync-registration* filter, not a *spawn* gate. A cloud connector can still be spawned on demand via `ensureXRunning()` paths, and the predicate defaulting to permit-all means a future refactor that bypasses the dispatcher would silently re-open egress. No structural test asserts "no cloud child process spawns in strict mode." For a defense/healthcare claim, "we filter the tools" is not strong enough — the guarantee must be at the spawn boundary, fail-closed, and test-pinned.

### Approach B — Boot-time hard rejection at mesh build + fail-loud config validation, with a new invariant I32 (recommended)

Add a strict-mode gate **at the connector mesh** that (1) refuses to spawn any cloud connector (the predicate is evaluated before any child process), and (2) at boot, if any cloud connector is *configured* (has connector config/credentials) while strict mode is on, the gateway **aborts startup with a clear error** rather than starting degraded. Wire `enforceAirGap=true` through the LLM registry, auto-update, and embeddings, and skip the `LanServer` start. Pin the spawn-rejection as new invariant **I32** (production wiring + docs row + `security-invariants.test.ts` + static complement), reusing the *same injected predicate seam* as A so the diff stays small.

- **Pro:** structural + fail-closed + fail-loud; the guarantee lives at the spawn boundary and is regression-locked by a test and a static audit; reuses the existing predicate injection point (no new plumbing through the mesh).
- **Con:** one new invariant to carry (I32) and a fail-loud boot path that must be cross-platform.

### Approach C — Separate build artifact (compile cloud connectors out)

Produce a distinct `nimbus-airgapped` binary where cloud connector spawn modules are tree-shaken out at build time.

- **Pro:** strongest possible guarantee (the code literally isn't present).
- **Con:** violates **Platform equality** spirit by forking the distribution into a second binary to maintain across 3 OSes; large packaging/CI change; can't be toggled or audited at runtime; the grounding constraint says "config-only, no new feature code / second binary." Over-engineered for the threat model — a runtime fail-closed gate with a static audit gives ~equivalent assurance at a fraction of the surface.

**Recommendation: Approach B.** It is the only option that makes egress *structurally impossible at the spawn boundary* (not just tool-hidden), *fails loud* when the config is internally inconsistent, and is *regression-locked* by the invariant triple rule — exactly what a regulated buyer's auditor needs. It reuses the already-injected `isConnectorAllowed` predicate seam (so the mesh plumbing is unchanged) and stays config-only (no second binary, no schema migration). A is too weak for the compliance claim; C over-forks the distribution.

## Design (recommended)

### Architecture & components

1. **`[air_gap]` config section** — `packages/gateway/src/config/nimbus-toml.ts`
   New `NimbusAirGapToml = { strict: boolean }` (default `{ strict: false }`), parsed exactly like the existing `[llm]` section (`forEachSectionEntry(source, "[air_gap]", …)`, mirroring lines 257–263) with a `loadNimbusAirGapFromConfigDir(configDir)` loader. One key only (`strict`); YAGNI — no per-connector allow/deny list, no "soft" mode. Strict is the only mode that earns the regulated claim.

2. **Cloud-vs-local connector classification** — `packages/gateway/src/connectors/connector-catalog.ts`
   Add `LOCAL_ONLY_CONNECTOR_SERVICES: ReadonlySet<string>` = connectors that read only local artifacts and make **no** outbound network call: `filesystem` (the built-in fs server, always allowed), `localdb`, `dataprofile`, `storybook`, `great_expectations` (each documented "no live credentials" in `OAUTH_UNSUPPORTED_DETAILS`, lines 306–317). Add `isCloudConnectorService(id): boolean = !LOCAL_ONLY_CONNECTOR_SERVICES.has(id)`. **Conservative default: every connector not explicitly local-only is treated as cloud** (fail-closed classification). `imap`/`protonmail`/`fastmail` are cloud (they reach a mail host, even if LAN-local — strict mode rejects them; a Bridge on `127.0.0.1` is still "off the air-gapped node" semantically). **Mail-bridge socket policy (resolved):** in strict mode mail connectors stay classified `cloud` and are blocked; the profile additionally prevents the mail connector from binding/connecting a socket to any non-`localhost` mail bridge. This block is overridable **only** by an enterprise-wide signed org policy (I22) — never by a plain `[air_gap]` key — so an on-prem-mail SCIF can opt a vetted bridge back in without weakening the default fail-closed posture.

3. **Boot-time mesh rejection (I32 wiring site)** — `packages/gateway/src/connectors/lazy-mesh/mesh.ts`
   The constructor already takes `isConnectorAllowed`. In strict mode, `assemble.ts` composes the predicate so `isConnectorAllowed(id)` returns `false` for every `isCloudConnectorService(id)`. **Additionally**, harden the spawn path: each `ensureXRunning()` / spawn helper consults a single private `assertConnectorSpawnable(serviceId)` guard that throws in strict mode for cloud ids *before any child process is created* — this is the I32 structural site (the predicate alone is advisory; the spawn guard is the invariant). The `filesystem` built-in server (constructor, `mesh.ts:106`) is exempt (local-only, the data dir itself).

4. **Fail-loud boot validation** — `packages/gateway/src/platform/assemble.ts`
   Before building the mesh, if `[air_gap].strict` is true, scan the configured connectors (the same source the sync scheduler reads) and **abort startup with a precise error** if any *cloud* connector has configuration/credentials present: `air-gap strict mode is enabled but cloud connector(s) are configured: <ids>. Remove them or disable strict mode.` This is the "no silent degradation" guarantee. Likewise abort if `[llm].enforce_air_gap` resolves false under strict mode is *not* an error — strict mode simply **forces** `enforceAirGap=true` (overrides the `[llm]` value), forces the embedding provider to local, forces auto-update `enforceAirGap: true` (replacing the hardcoded `false` at `assemble.ts:933`), and skips the `LanServer`/federation start. Strict mode is the master switch; sub-flags are derived, not separately trusted.

5. **Egress-ledger seam (forward-compat note, not built here).** When S1's egress ledger lands, strict mode's boot record (the list of rejected cloud connectors + "remote LLM disabled" + "federation disabled") is the natural first ledger entry. We emit these as **audit-log** rows now (existing audit chain) so the eventual ledger has a source; no ledger code in this spec.

### Data flow

```text
boot (assemble.ts)
  └─ load [air_gap] → strict?
       ├─ no  → unchanged behavior (default false; zero impact on existing installs)
       └─ yes → 1. scan configured connectors; if any cloud connector configured → ABORT (fail-loud)
                2. force enforceAirGap=true into LlmRegistry  (local providers only — router.ts:72)
                3. force embedding provider = local            (MiniLM worker — create-embedding-runtime.ts:142)
                4. force auto-update enforceAirGap=true         (daemon never starts — auto-update.ts:115)
                5. skip LanServer / federation start            (I6 loopback already default; strict = no bind at all)
                6. compose isConnectorAllowed so cloud ids → false (mesh + sync seam, mesh.ts:437 / assemble.ts:414)
                7. mesh spawn guard rejects cloud ids before any child process (I32)
                8. audit-log the strict-mode boot record (rejected ids; substrate for future egress ledger)
runtime
  └─ LLM task → router selects ollama/llamacpp only (no remote provider survives the air-gap skip)
  └─ agent asks for a cloud tool → tool absent from dispatcher (filtered) AND spawn guard would throw (I32)
  └─ sync scheduler → cloud connector never registered (assemble.ts:414)
```text

### IPC / CLI surface

Per the grounding constraint (*config-only; no new CLI flags or IPC methods*), the **primary** surface is the `[air_gap]` TOML section — no new RPC, no new `nimbus` subcommand. Two read-only touch points reuse existing surfaces:

- **`admin.status`** (existing `StatusReaders`, `assemble.ts:493`): the `connectors[]` snapshot already reports `enabled` per connector via `isConnectorAllowed`; in strict mode cloud connectors surface as `enabled: false`. Add a single boolean `airGap.strict` to the status payload so operators/the UI can display the lock state. No new method.
- **Boot log + audit row**: the strict-mode boot record (above) is written to the existing audit chain and stderr log. No new IPC.

(If a `nimbus airgap status` CLI verb is later wanted, it reads `admin.status` — out of scope here.)

### Security: check against the 7 Non-Negotiables

1. **Local-first** — *strengthened.* Strict mode makes cloud a *forbidden* connector, not just an optional one. Egress is impossible at the spawn boundary (I32), not discouraged.
2. **HITL is structural** — *untouched.* `engine/executor.ts gate()` is not modified. Air-gap filters the tool surface *upstream* of the HITL gate; it never bypasses or weakens consent for the local operations that remain. Local connectors keep their normal HITL gating.
3. **No plaintext credentials** — *preserved + improved.* A rejected cloud connector's Vault keys are **never consulted** (the connector never spawns, so `vault.get()` for its secret keys is never called). Test asserts this. The fail-loud boot message lists connector **ids only**, never secret values.
4. **MCP as connector standard** — *preserved.* No protocol change. Air-gap filters *which* MCP servers start; the engine still never calls cloud APIs directly. Local connectors remain ordinary MCP servers.
5. **Platform equality** — *preserved.* Config-driven; the spawn guard and fail-loud abort are platform-agnostic TypeScript with no OS-specific path. Test runs on the Ubuntu PR gate and the 3-OS push matrix.
6. **AGPL-3.0 core / MIT SDK** — *unchanged.* All new code lives in `packages/gateway` (AGPL). No license field touched.
7. **No `any`** — config parse uses the existing `parseBool` helper (returns `boolean | undefined`); connector classification is over the typed `ConnectorServiceId` union; external data stays `unknown`. No `any`.

**Invariant impact.**

- **Reuses I22** seam (`isConnectorAllowed` injection) for the dispatcher + sync filter — no change to the I22 gate itself.
- **Reuses I6** (LAN loopback default) — strict mode goes further: no LAN bind at all.
- **New invariant I32** — *"In `[air_gap] strict` mode, no cloud-connector MCP child process is spawned: the mesh spawn path rejects every `isCloudConnectorService(id)` before a child process is created, and boot aborts fail-loud if a cloud connector is configured. Only `LOCAL_ONLY_CONNECTOR_SERVICES` (+ the built-in filesystem server) may run."* Wiring: `connectors/lazy-mesh/mesh.ts` (`assertConnectorSpawnable`). Test: `security-invariants.test.ts`. Static complement **D25**: `scripts/structure-audit/check-nimbus-invariants.ts` (assert the spawn helpers route through the guard; assert no spawn helper bypasses it). **I28 is reserved** for the unmerged MCP-server owner-sink (`dev/asafgolombek/phase7-mcp-gateway-server`); this profile claims **I32** to avoid the collision.
- **Schema:** **none.** Config-only; `[air_gap]` lives in `nimbus.toml`. No table, no migration — this work consumes **no migration number** (the schema ceiling remains free for the next data-bearing feature).

> **Numbering note:** I28 is reserved for the MCP-server owner-sink (branch `dev/asafgolombek/phase7-mcp-gateway-server`). The I32/D25-style numbers here follow the *proposed* global sequence in `2026-06-20-superpowers-specs-consolidated-review.md` §1 — these family ideas are mutually exclusive, so the actual number is the next-free at this spec's own merge time, reconciled by build order.

**Fail-closed / fail-loud behavior.** Default `strict=false` ⇒ zero behavior change for every existing install. When `strict=true`: (a) a configured cloud connector aborts boot with a precise, secret-free message (fail-loud); (b) the conservative classification treats any unknown/new connector as cloud (fail-closed — a connector added later is rejected until explicitly added to `LOCAL_ONLY_CONNECTOR_SERVICES`); (c) the spawn guard throws on a cloud id even if a future caller bypasses the dispatcher filter.

### Testing

- **Invariant test (`security-invariants.test.ts`, I32):** build a mesh in strict mode; assert (i) attempting to spawn a cloud connector (e.g. `github`) throws / spawns no child process and `vault.get()` is never called for its keys; (ii) a local-only connector (`localdb`, `dataprofile`) + the filesystem server still start; (iii) the cloud connector's tools are absent from `listToolsForDispatcher()`.
- **Config test (`nimbus-toml.test.ts` / a new `nimbus-toml-air-gap.test.ts`):** `[air_gap] strict = true|false`, default, and malformed-value (defaults to `false`) parsing — mirrors the existing `nimbus-toml-llm.test.ts` shape.
- **Integration test (real SQLite + real Bun subprocess + temp dir):** boot the gateway with `[air_gap] strict = true` and a configured cloud connector ⇒ assert startup **aborts** with the fail-loud message and **no** connector child process is spawned. Boot with strict + only local connectors ⇒ assert it starts and the LLM router reports only local providers available.
- **Static-audit test (`check-nimbus-invariants.test.ts`):** assert every cloud spawn helper in `connector-spawns.ts` routes through `assertConnectorSpawnable` (the I32 static complement D25) — fails first, before the runtime suite.
- **Coverage:** all new files (config parser branch, classification helper, spawn guard) must clear the **≥80% line + branch / file** floor (baseline is `{}`; new files start at zero — verify under the Linux-authoritative coverage-floor, not just locally). The classification set and config parser are pure functions → trivially testable to 100%.
- **No Vault leak test:** assert the fail-loud boot message and the audit-log boot record contain connector ids only, never any value from the Vault.

## Non-goals (YAGNI — cut anything not essential)

- **No egress ledger / `nimbus prove` / network-syscall attestation** — S1 / Phase 8 / P22 (`roadmap.md:1028,1132`). This profile makes egress impossible by construction; *proving* it externally is separate.
- **No `nimbus airgap` CLI verb or `airgap.*` IPC namespace** — config-only per the grounding constraint; status is read via the existing `admin.status`.
- **No "soft" / "warn-only" air-gap mode, no per-connector air-gap allow-list, no profile templating (`nimbus profile create`)** — one boolean (`strict`) is the whole surface. Granularity is the org-policy `connectorAllow` (I22) job.
- **No second build artifact / tree-shaken binary** (Approach C rejected).
- **No new schema / table / migration** — this work consumes no migration number; the schema ceiling stays free.
- **No connector "phone-home" audit of every connector's source** in this slice — the conservative fail-closed classification (unknown ⇒ cloud) already protects against a connector that secretly makes a network call. A documented audit of which "local-only" connectors are *truly* network-silent is a one-time verification task folded into the implementation PR's review, not new runtime code.

## Open questions

1. **Mail connectors via a local Bridge** (`protonmail` uses a `127.0.0.1` Bridge; `imap`/`fastmail` could point at a LAN host). **Resolved:** strict mode keeps them classified `cloud` (blocked) and the profile prevents any socket bind/connect to a non-`localhost` mail bridge. The only override is an enterprise-wide **signed org policy (I22)** — not a plain `[air_gap]` key — so an on-prem-mail buyer can vet a specific bridge back in without softening the default. A non-signed `[air_gap]` mail allow-list is explicitly **not** offered.
2. **Should strict mode also hard-disable the local HTTP write surface (I13)** beyond the existing read-only default? The HTTP API is already read-only except the sanctioned `POST /v1/deployments` carve-out; strict mode could refuse to bind the HTTP server entirely. Proposed: leave I13 as-is (it's local-loopback and HITL-gated); revisit if a buyer requires zero listening sockets.
3. **Exact connector-configured detection at boot** — does "configured" mean "has a row in the connector store" or "has Vault credentials present"? Proposed: presence in the connector config the sync scheduler already enumerates (the same list `assemble.ts` registers), so the check reuses an existing read with no new Vault access.
4. **Federation hard-off vs. LAN-loopback-only** — strict mode skips `LanServer` start entirely (no bind). Confirm no regulated buyer wants intra-SCIF peer federation between two air-gapped Nimbus nodes (if so, that's a *separate* "sovereign mesh within the air-gap" profile, not this one).

## Acceptance criteria

- [ ] `[air_gap] strict = true|false` parses in `nimbus-toml.ts` (default `false`); malformed value defaults to `false`; covered by a config test ≥80%/file.
- [ ] `LOCAL_ONLY_CONNECTOR_SERVICES` + `isCloudConnectorService()` exist in `connector-catalog.ts`; every connector not explicitly local-only classifies as cloud (fail-closed); covered to 100%.
- [ ] With `strict=false` (default): **zero** behavior change — existing tests unchanged, no new boot path taken.
- [ ] With `strict=true`: the LLM router exposes only local providers (no remote even if a key is set), embeddings use the local MiniLM worker, the auto-update daemon does not start, and `LanServer`/federation does not bind.
- [ ] With `strict=true` + a configured **cloud** connector: the gateway **aborts startup** with a precise, secret-free message and **no** cloud connector child process is spawned.
- [ ] With `strict=true` + only **local-only** connectors: the gateway starts; `localdb`/`dataprofile`/`storybook`/`great_expectations` + the filesystem server run normally with HITL intact.
- [ ] With `strict=true`: mail connectors (`imap`/`protonmail`/`fastmail`) are classified `cloud` and blocked, and no socket binds/connects to a non-`localhost` mail bridge — overridable only by a signed org policy (I22), never by an `[air_gap]` key.
- [ ] **I32** (static complement **D25**) is wired (`mesh.ts assertConnectorSpawnable`), documented (`docs/SECURITY-INVARIANTS.md` + `CLAUDE.md` + `GEMINI.md` row), tested (`security-invariants.test.ts`), and statically enforced (`check-nimbus-invariants.ts`) — all in the same commit (invariant triple rule). I28 left reserved.
- [ ] No `any`; `bun run preflight:fast` (types + lint + static invariants) is green; the static-audit drift test passes.
- [ ] A no-Vault-leak test proves the boot abort message + audit boot record carry connector ids only.
- [ ] `admin.status` reports `airGap.strict` and cloud connectors as `enabled: false` in strict mode.

### Recommended first sub-slice (if decomposed)

If the implementation is staged, ship **Sub-slice 1 = config + classification + LLM/embedding/auto-update/federation forcing + fail-loud boot abort** (no new invariant yet — this already delivers the operator-visible guarantee), then **Sub-slice 2 = the I32 spawn-guard structural invariant (static complement D25) + static audit + security-invariants test** (the auditor-grade regression lock). Both are small; a single PR is feasible, but Sub-slice 1 is the shippable MVP and Sub-slice 2 is the hardening that earns the regulated claim.
