---
name: nimbus-sandbox-and-extensions
description: >
  The sandboxed third-party-code path end to end: the per-OS `SandboxRunner` (invariant `I15` /
  static `D10`, `canConfine(policy)`, Linux bwrap + `nimbus-sandbox-helper`, macOS `sandbox-exec`
  SBPL, Windows AppContainer + `nimbus-sandbox-helper.exe`), `wrapServerSpec` /
  `wrapServerSpecInCwd`, scoped child env (`extensionProcessEnv`, `I1`), hidden connector spawns
  (`D25`, `platform/spawn-capture.ts`); owner-registered user MCP servers (`nimbus connector add
  --mcp`, `mcp_*` ids, `--read`/`--net`/`--model`) and invariant `I42` (owner HITL on every
  `mcp_*`/`ext_*` call, no delegate, model offer to the local owner only, `user_mcp_model_access`
  lockoff); and the S3 extension runtime (install gate + tree digest V66, run grants V70
  `extension_run_grant` + the `extension.run` HITL type, invariant `I43` + `D33(a)–(c)`, the lazy
  `mesh:ext:<serviceId>` slot, the verified per-spawn copy, `approve --model`, `[extensions]
  runtime`, run states, `ext_` service ids, `I16` signature verify; the Phase 9.5 registry client, `nimbus registry *`,
  registry-sourced install and updates, invariant `I44`). Use when touching
  `packages/gateway/src/{extensions,platform/sandbox,connectors/lazy-mesh}/`, `nimbus connector add
  --mcp`, `nimbus connector tools|call`, `nimbus extension install|approve|revoke|rehash`, when a
  sandbox test fails on one OS only, or when touching `extensions/registry/` or planning the rest of
  the Phase 9.5 marketplace.
---

# Nimbus — Sandbox, User MCP Servers & the Extension Runtime

## Why This Skill Exists

Three kinds of code run in a Nimbus child process: the bundled first-party connectors, MCP servers the owner registers by hand, and installed extensions. All three reach the OS through **one** sandbox boundary, and the last two additionally need an owner approval for **every** tool call. The defenses stack, and each layer is a separate invariant:

| Layer | Invariant / rule | What it guarantees |
|---|---|---|
| Child env | `I1` / `D10-spawn` | no gateway secret (LLM keys, OAuth client secrets, updater overrides) leaks into a child env |
| OS confinement | `I15` / `D10-wrap-spec` | every lazy-mesh `ServerSpec` is rewritten to re-exec the gateway in its sandbox role |
| Install integrity | `I16` | a `publisher` manifest's Ed25519 signature is verified at install AND every startup |
| Run consent | `I43` / `D33(a)–(c)` | extension code runs only from a re-verified copy, under a live owner run grant |
| Per-call consent | `I42` | every `mcp_*` / `ext_*` action is owner-approved at the executor gate; a delegate never approves |
| Registry provenance | `I44` | registry-sourced code is installed/updated only through the verified chain, from its own source registry; ambiguity refused |

Full rationale: `docs/SECURITY-INVARIANTS.md` (I1, I15, I16, I42, I43, I44). Operator view: `docs/sandbox.md`. Design record: `docs/architecture.md` (Subsystem 4, "Extension run grants", "Extension runtime").

## 1. The Sandbox Runner (I15 / D10)

**Shape.** `connectors/lazy-mesh/wrap-server-spec.ts`'s `wrapServerSpec(...)` rewrites a `ServerSpec.command` to re-exec the gateway binary in its `__nimbus-sandbox` role (`platform/runtime-layout.ts`'s `selfSpawn`), serialising the policy (`policyFromManifest`) into `NIMBUS_SANDBOX_POLICY_JSON` and the cwd into `NIMBUS_SANDBOX_CWD` (`SANDBOX_POLICY_ENV` / `SANDBOX_CWD_ENV` in `platform/sandbox/sandbox-policy.ts`). The wrapper process `platform/sandbox/sandbox-wrapper.ts` strips both, calls `createSandboxRunner()` and `runner.spawn(...)` — the **single** sandbox-execution boundary. `wrapServerSpecInCwd` is the variant the extension runtime uses to pin an exact cwd.

**Why a shim:** `@mastra/mcp`'s `MCPClient` spawns through `StdioClientTransport` with no fork hook, so the command itself is the only interception point. N spawn sites collapse to one boundary.

**`SandboxRunner`** (`platform/sandbox/sandbox-runner.ts`):

| Method | Question it answers | Use it for |
|---|---|---|
| `canConfine(policy)` | can THIS policy be enforced in full? `null` or a reason | admitting a specific execution (exec, terminal lane, toolgen) — **always this one** |
| `isFullyActive()` | is every mechanism this platform offers available? | a startup banner only |
| `degradedReason()` | what is missing or asymmetric | diagnostics only — on Windows it is non-null even when fully confining |
| `spawn(cmd, args, opts)` | — | `opts.releaseGrantsOnExit` ONLY for a per-run-unique policy id (`exec-<id>`, `cu-terminal-<id>`), never a shared one (extension, `toolgen.<toolId>`) |

**Per-OS backends:**

| OS | File | Mechanism | Helper | `canConfine` |
|---|---|---|---|---|
| Linux | `platform/sandbox/linux.ts` | `bwrap` (`buildBwrapArgv`): user/pid/ipc/uts namespaces, `--die-with-parent`, `--unshare-net` for an empty network set; seccomp (`seccomp-filter.ts`, x86-64 only) | `nimbus-sandbox-helper` (`cap_net_admin`, path overridable via `NIMBUS_SANDBOX_HELPER_PATH`) — needed ONLY for per-host network filtering | `null` for a no-network policy even without the helper |
| macOS | `platform/sandbox/darwin.ts` | `/usr/bin/sandbox-exec` with a per-spawn `(deny default)` SBPL profile | none | always `null` |
| Windows | `platform/sandbox/win32.ts` | AppContainer profile per policy id, inheritable ACEs on cwd + declared paths, Job Object kill-on-close | `nimbus-sandbox-helper.exe` beside `process.execPath` (probed with `--check-caps`) — IS the confinement | the helper's reason when missing; the runner refuses to spawn unconfined |

**Network asymmetry** (derive from `docs/sandbox.md` § Platform asymmetry): Linux-with-helper and macOS enforce per host and per port; Linux-without-helper and Windows (`internetClient`, `capabilitiesForPolicy`) are all-or-nothing.

**Working directory.** Every spawn runs in `<sandboxDir>/<leaf>` (`platform/sandbox/sandbox-cwd.ts`'s `sandboxCwdFor`), never `dataDir`/`configDir`. The filesystem MCP's explicit `dataDir` grant is the one stated exception (a grant, not its cwd). `PlatformPaths.sandboxDir` defaults outside data and config, but an override can nest them and nothing refuses that.

**Windows host state.** Distinct SIDs each leave an ACE that outlives the profile. Bounded by release-on-exit (`platform/sandbox/win32-release.ts`) and the boot reap + `--sweep-orphaned-aces` (`platform/sandbox/win32-reap.ts`'s `reapAppContainersAtBoot`); the one-time legacy data-dir revoke writes `SANDBOX_CWD_MIGRATION_MARKER`.

**I1 — child env.** Every `env:` under `connectors/lazy-mesh/` must resolve to `extensionProcessEnv(...)` (`extensions/spawn-env.ts`), directly or via a local bound to it. The regression form is `{ ...process.env, EXTRA }` — never spread `process.env` into a child env.

**D10** (`scripts/structure-audit/check-nimbus-invariants.ts`) has two halves: `D10-spawn` (a spawn call under `connectors/` must name `extensionProcessEnv` within the next few lines) and `D10-wrap-spec` (every `...connectorSpawn(` literal is lexically enclosed by `wrap(`/`wrapServerSpec(`, checked **per site** — a per-file presence check once let one unwrapped connector run with a live OAuth token). `I15_EXEMPT` lists the non-spawn lazy-mesh files.

**D25** — a non-test file under `connectors/` outside `lazy-mesh/` may not reference `Bun.spawn`; use `platform/spawn-capture.ts`, which passes `windowsHide`. The two injected-default seams (`blame-index-sync.ts`, `filesystem-v2-sync.ts`) are exempt and pass `windowsHide: true` themselves, unchecked. Repo-wide: `bun run audit:windows-console` (escape: `// windows-console-ok: <reason>`).

## 2. User MCP Servers (`mcp_*`) and I42

`nimbus connector add --mcp <mcp_id> [--read <path>]... [--net <host[:port]>]... [--model] -- <command>` (IPC `connector.addMcp`, LAN-forbidden, not on the Tauri allowlist). Registration lives in `connectors/user-mcp-registration.ts` (`resolveUserMcpRegistration`), rows in `connectors/user-mcp-store.ts` (`user_mcp_connector`), the spawn in `connectors/lazy-mesh/user-mcp.ts` (`ensureUserMcpClient`).

- **Grants are exactly what the owner approved:** `--read` paths (read-only; there is no write grant), `--net` hosts (no IPv6 literals), its own cwd leaf. Linux/macOS also grant the binary's directory read; Windows does not.
- **Protected roots** (`userMcpProtectedRootsFor`: data, config, sandbox dirs) refuse an overlapping grant in either direction. A leftover leaf on re-register is cleared after approval or the registration refuses `ERR_USER_MCP_SANDBOX_NOT_CLEAN`.
- **Ids:** `USER_MCP_SERVICE_ID_PATTERN`; registration refuses an id that `_`-extends another registered id (so `mcp_a` and `mcp_a_b` never coexist).
- **Network traffic is not ledgered** — it leaves through the approved per-host grant. Only the `mcp_*` action dispatches are (I29, executor chokepoint).
- **Script-mode servers cannot run on Windows** (see Traps); compile the server.

**I42 — the per-call floor**, for both `mcp_*` and `ext_*` (`connectors/owner-code-server.ts`'s `isOwnerCodeServerServiceId`):

1. `engine/executor.ts`'s `gate()` ORs `isUserMcpActionType(action.type)` after the I2 frozen set — derived from `action.type` alone (I3), never `payload.mcpToolId`; not configurable.
2. `tryDelegatedApproval` returns `"fallback"` first: a delegate (I20) never approves.
3. `connectors/registry.ts` refuses `ERR_USER_MCP_ACTION_MISMATCH` unless the resolved tool key equals the one the type names (`userMcpToolKeyForActionType` / `ownerCodeServerToolKeyForActionType`), so a smuggled `mcpToolId` cannot ride another type.
4. Share replay (`share/read-tool-registry.ts`, `ipc/share-rpc.ts`) refuses every owner-code-server key.
5. The consent prompt shows the input **unredacted** (`consentDisplayPayload`); the audit row stays redacted.
6. **Model offer** (`--model` for MCP, `approve --model` for extensions): decided once at the IPC entry by `USER_MCP_OFFER_BY_KIND` (`ipc/server/inline-handlers.ts`) — true only for `cli`/`ui`/undeclared; ChatOps passes a literal `offerUserMcpTools: false`. Calls go through the turn's own executor (`engine/user-mcp-agent-tools.ts`), results wrapped by I11.
7. **Org lockoff:** `[policy.capabilities.ai_v2] user_mcp_model_access = false` empties the tool SOURCE (`connectors/user-mcp-model-capability.ts`'s `listPolicyGatedModelAccessibleOwnerCodeServerIds`), fail-closed when the policy accessor is absent, read per turn. `nimbus connector tools|call` are owner-initiated and unaffected.
8. Only the I28 act door can PROPOSE an `mcp_*` call from an MCP client (never `ext_*`).

## 3. The S3 Extension Runtime (PRs 1–4)

Install and run are **different consents**. Install records what arrived; a run grant records what may execute, with which reach.

| PR | What it added | Key code |
|---|---|---|
| 1 | Install gated in the executor (HITL `extension.install`); whole-tree digest (V66, `tree_digest`); `nimbus extension rehash` (gated like install; refuses on a manifest/entry hash mismatch) | `extensions/install-from-local.ts`, `extensions/tree-digest.ts` (`computeExtensionTreeDigest`), `index/extension-tree-digest-v66-sql.ts` |
| 2 | Run grants: `nimbus extension approve <id>` (TTY only, **no `--yes`**) under HITL `extension.run` (I2 frozen set) records version, tree digest, resolved network/read/write grants and an `ext_` service id; `revoke` withdraws (ungated — it only narrows) | `extensions/approve-run.ts` (`approveExtensionRun`, `revokeExtensionRun`), `extensions/run-grant-store.ts`, `index/extension-run-grant-v70-sql.ts`, `extensions/extension-run-grants.ts` |
| 3 | The runtime, invariant I43: verify → stage → build → spawn, on first use (not at approval, not at boot) | `extensions/extension-runtime.ts` (`prepareSpawn`), `extensions/verified-extension.ts`, `extensions/extension-stage.ts`, `extensions/run-extension-entry.ts`, `connectors/lazy-mesh/{extension-slot,extension-slot-source}.ts` |
| 4 | `approve --model`: the extension's tools join the I42 model path as `<serviceId>__<tool>` (e.g. `ext_com_example_x__search`) | `run-grant-store.ts`'s `listModelAccessibleExtensionGrants`, mesh `listOwnerCodeServerTools` |

**The spawn path (I43), in order — keep it ordered:**

1. `readVerifiedExtensionForSpawn` re-reads row, grant, manifest + entry hash, tree digest (against row AND grant), I16 for a publisher manifest, entry inside the tree (`ERR_EXTENSION_ENTRY_OUTSIDE`), and re-resolved grants equal to the stored ones (`ERR_EXTENSION_RUN_CHANGED`). Each step throws a typed `ExtensionRunGrantError`. It trusts no earlier pass.
2. `stageVerifiedExtension` sweeps `extensionStageRootFor(sandboxDir, serviceId)` (= `<sandboxDir>/ext-stage/<serviceId>`), copies regular files to a fresh `<uuid>` dir, re-digests the COPY (`ERR_EXTENSION_RUN_TREE_CHANGED` on mismatch, stage removed).
3. `buildExtensionRuntimeManifest` (`ext.<serviceId>`: verified grants + runtime read paths, never stored) and `buildExtensionSpawnSpec` — both named only in `extension-runtime.ts`, built once inside `prepareSpawn`.
4. `wrapServerSpecInCwd` with the stage as cwd → I1 + I15 apply unchanged. The install tree is **not** granted at all.
5. An abandoned prepared spawn must `discard()` its stage (`PreparedExtensionSpawn` in `extension-slot-source.ts`).

**Why a fresh copy as cwd:** (a) Windows module loading needs `FILE_WRITE_ATTRIBUTES` (see Traps), and every platform grants the cwd read-write; (b) Bun honours `bunfig.toml` `preload`, `.env` and `node_modules` in the cwd and above, none digested — a long-lived cwd let a previous run plant code that survived revoke + re-approve. Stage ancestors are granted to no spawn; a declared grant overlapping the sandbox root refuses `ERR_EXTENSION_GRANT_PROTECTED`.

**Child role.** Compiled build: the gateway's `__nimbus-extension` self-role. Dev tree: inline `bun --no-env-file --no-install -e` (the confined child cannot load the gateway's own source).

**Mesh slot.** Lazy, keyed `mesh:ext:<serviceId>` (`extensionMeshKey`). Stop/disable/revoke/remove call `stopExtensionClient`. A new spawn awaits the previous client's settled disconnect. Under a signed org policy with a connector allowlist, an unlisted `ext_` id refuses `ERR_EXTENSION_RUN_POLICY` — checked by the slot source before every spawn and on every listing reusing a live client (the mesh's own filter ignores `ext_` ids).

**Boot guards** (`platform/assemble.ts`): the slot source exists only when `isExtensionRuntimeEnabled` (`[extensions] runtime`, default `true`, read once at boot, AND not demo-rooted, I41); every extension spawn waits on a gate resolved in the `finally` of `verifyExtensionsBestEffort` (I16 hard-disables first; a throwing pass cannot wedge spawns). With the runtime off, `approve` refuses `ERR_EXTENSION_RUNTIME_DISABLED`.

**Service id** (`extensions/extension-service-id.ts`, wrapping the rule in `packages/registry-format/src/extension-id.ts`): `deriveExtensionServiceId` = `ext_` + the manifest id lowercased with non-`[a-z0-9]` mapped to `_`, matching `EXTENSION_SERVICE_ID_PATTERN`. Computed ONCE at first grant and stored, never recomputed; re-approval keeps it. Prefix collisions at an `_` boundary refuse `ERR_EXTENSION_SERVICE_ID_COLLISION`.

**Run states** (`extensions/run-state.ts`'s `extensionRunState`, cheap — no re-hash): `disabled` → `no_grant` → `grant_stale` (grant's version or tree digest ≠ row's) → `running` (mesh holds a live client, consulted LAST) / `ready`.

**I16** (`extensions/verify-extensions.ts`, `install-from-local.ts`): a `publisher` manifest is verified with `verifyManifestSignature` (from `@nimbus-dev/sdk`, re-exported by `extensions/verify-signature.ts`); the pubkey lives only at Vault key `extension.publisher_key.<id>`. A failure flips `enabled = 0` and records the reason in `SignatureDisabledRegistry` (`extensions/hard-disable.ts`), which `extension list|info` render. `(unverified)` means "no publisher", not "failed".

**Static D33** (`scripts/structure-audit/check-nimbus-invariants.ts`):

- **(a)** `checkExtensionRoleConfinement` — the `__nimbus-extension` literal only in `platform/runtime-layout.ts`; `selfSpawn("extension", …)` only in `extensions/extension-launch-command.ts` (whose `extensionEntryCommand` D38(b) confines to the run and eval builders).
- **(b)** `checkRunGrantTableConfinement` — `extension_run_grant` only in `run-grant-store.ts` and its V70 DDL.
- **(c)** `checkRunGrantWriters` — `upsertRunGrant` only in the store + `approve-run.ts`; `deleteRunGrant` additionally `automation/extension-store.ts`. Aliased imports count.
- Stated bound: text scans; a dynamically composed role string, call or identifier evades them. The I43 source pins in `security-invariants.test.ts` cover the spec builders.

**Surfaces.** `extension.approveRun` / `extension.revokeRun` are CLI-only, LAN-forbidden (`ipc/lan-rpc.ts`), demo-refused, and absent from the Tauri allowlist; the renderer may `extension.enable` (the next spawn re-verifies) but never approve. Calls: `nimbus connector tools|call ext_<id>` (backed by `connector.userMcpTools` / `connector.userMcpCall`). Handlers: `ipc/automation-rpc.ts`, `ipc/connector-rpc-handlers/user-mcp.ts`.

**Stated bounds / not shipped** (do not claim otherwise):

- Check-then-spawn: a same-user writer can race the copy's digest and the child's `import()`.
- A DB-write attacker can rewrite row digest and grant consistently — defended against filesystem-only writers.
- A live client is not re-verified until its next spawn; the org policy IS re-read per listing.
- The extension's own traffic to granted hosts is not ledgered; only `ext_*` dispatches are.
- Auto-update's stop-then-swap: a spawn staged between the two steps runs the old verified copy.
- Compiled-form autoload of `<cwd>/bunfig.toml` / `.env` stays on (plain `bun build --compile`); for extensions the cwd is the digested stage.
- The compiled self-role path is reasoned from a compiled probe, not exercised end to end; the dev-tree shape is (`packages/gateway/test/e2e/extension-runtime.e2e.test.ts`).
- `ext_*` tools are not proposable on the I28 act door, and capture routing stays `mcp_`-only. An extension that declares `sync` DOES sync (2026-10-20): `platform/register-extension-sync.ts` registers it under its index id, one `sync.run` row per run, configured-ness from the grant's credentials; `nimbus extension remove` is its only removal path (`connector remove` refuses `ERR_CONNECTOR_IS_EXTENSION`).
- **Marketplace registry is Phase 9.5; its project 1 (registry protocol + client) is complete** (`docs/roadmap.md`): the signed-registry client shipped 2026-10-18 (PR 3), registry-sourced updates and invariant I44 the same day (PR 4). `nimbus registry add|list|refresh|remove` (V71 `extension_registry`, root key pinned, `registry.add` HITL TTY-only and never delegable), `nimbus extension search`, `extension info --registry/--remote`, `extension install <id> [--registry] [--version] [--channel beta]`; code in `extensions/registry/` (`registry-transport.ts`, `registry-fetch.ts` — the only `fetch(`, I29 `registry` class, D22(h) —, `registry-resolve.ts`, `install-from-registry.ts`, `registry-store.ts`) and `ipc/registry-rpc.ts`. A bare id in two registries is refused, never prioritised. Install verifies index, hashes, publisher key from the signed index, I16 signature, Vault conflict and entry hash BEFORE the `extension.install` prompt. The update daemon reads registries (PR 4): `registry/registry-update-source.ts` checks each registry-installed extension against its OWN source registry only (one index fetch per registry per tick, root fingerprint must be unchanged, local-path installs never polled); apply re-verifies against the current signed index before the swap and leaves the run grant stale (re-approve). The old HTTP registry client, `extension sync` and the publisher-key fetcher are deleted; a signed LOCAL install takes `--publisher-key` or a Vault-cached key, never a fetched one. I44 pins all of this (behavioural + chain-order source tests in `security-invariants.test.ts`); `nimbus doctor` warns about an extension whose source registry was removed and a registry whose index is older than 30 days; the dogfood scenario runs end to end in `packages/gateway/test/e2e/registry-acceptance.e2e.test.ts`. Not shipped: network publishing, a baked trust store, dependencies/packs, quality layer, ratings, catalog site.

## 3b. Publishing an extension to a registry (Phase 9.5 project 2)

Flow: `nimbus scaffold extension <name> [--publisher <id>]` (a publishable template, one `--target=bun` bundle in `dist/`) -> `nimbus extension sign` (fills `publisher.key`) -> `nimbus extension publish <dir> --registry-repo <owner/repo>` (`packages/cli/src/commands/`; validates with `validatePublish` in `packages/registry-format/src/validate-publish.ts`, opens a PR adding `extensions/<id>/<version>/`) -> the registry repo's CI.

- The CI is `packages/github-actions/registry-action` (`src/check.ts`, `src/sign.ts`, `src/git-tree.ts`, `src/registry-state.ts`, `src/site-commit.ts`): `check` is a reviewer aid (a PR can edit it); `sign` behind the `registry-signing` environment is the boundary. Rebuild its `dist/index.js` (`bun run build` in the package) after any source or dependency change. `audit:action-dist` checks the recorded input hash everywhere and, in CI, byte-compares against a fresh build with the Bun named in the header.
- `nimbus registry maintain init <dir> --github` (`packages/cli/src/commands/registry-maintain.ts`, `registry-templates/{workflows,readme}.ts`) writes the repo; the action pin comes from `packages/cli/src/release-commit.ts` (embedded by `release.yml`) or `--action-ref`.
- Hyphenated action inputs are read by `packages/github-actions/shared/gha-io.ts` under the runner's `INPUT_<UPPERCASED-NAME>` (hyphens kept). Owner steps: `docs/registry-hosting.md`.
- Known bound: no client-side refusal of an equal index `sequence`; `gh-pages` branch protection is the owner's.

## 4. Platform Traps (learned the hard way)

- **Windows: Bun's module loader opens every module file asking for `FILE_WRITE_ATTRIBUTES`.** A read-only AppContainer grant gives `EPERM reading "<file>"` on `import()` while `readFileSync` of the same file works; a file entry point fails as `CouldntReadCurrentDirectory`. Code a confined Bun child must load has to live in a dir it holds read-write — never "fix" it by granting an install tree write.
- **Windows: two sandbox-spawning processes at once collide** (helper exit `65`, `hr=0x800703fa`, a profile deleted under another). Never run sandbox tests beside a background `bun run preflight`.
- **Windows: a stray `nimbus-sandbox-helper.exe` next to `process.execPath` changes test outcomes.** `bun run <script>` repoints `execPath` at a Bun shim temp dir; a helper there flips `degradedReason()` tests. When a failure tracks the COMMAND (`bun test` vs `bun run test:coverage:sandbox` over the same files), check `dirname(process.execPath)` before blaming mocks or order.
- **Windows: a huge ACE count on a granted dir makes every confined spawn fail** (`SetEntriesInAclW` error `87`). Check the DACL size of the runtime bin dir; the boot sweep and release-on-exit now bound it. `test/integration/platform/sandbox/win32-ace-release.test.ts` must wait for the profile delete too.
- **Linux: `bwrap` binds `/usr`, `/etc`, `/lib` (and `/lib64` if present) but NOT `/bin`.** On usrmerge distros `/bin/sh` exists on the host and fails inside (`execvp`). Order candidates `/usr/bin/...` first (`computer-use/cu-lanes/terminal-shells.ts`'s `SH_CANDIDATES`) and have the integration test import the real resolver. Only the Linux CI leg sees this.
- **Linux: `buildBwrapArgv` must pass `--chdir`** or the child starts in `$HOME`; and `--unshare-pid` makes a child's `process.pid` namespace-local (map via host `/proc/*/status` `NSpid`).
- **A confinement probe must not be satisfiable by the sandbox.** Target a sentinel the parent wrote outside every grant and proved readable first; count ANY child read failure as denial; keep the probe inline, zero-import and template-free (`bun -e`). `/etc/passwd` is `--ro-bind`ed by bwrap and allowed on macOS (`toolgen/toolgen-confinement.ts`'s `assertToolConfinement` is the model). Drive the REAL probe from every test layer.
- **A fresh worktree has no `nimbus-sandbox-helper`** (compiled, git-ignored), so real-confinement tests fail there and nowhere else — not a branch regression. Build it: `bun run build:sandbox-helper:win32` (VS Build Tools; the `vswhere` noise is harmless) or `bun run build:sandbox-helper`. Some CI-precondition tests (exec gate, `nimbus exec` e2e, terminal lane) deliberately FAIL rather than skip without it.
- **A bare `Bun.spawn` from the detached gateway pops a console window per child on Windows.** `Bun.spawn` honours `windowsHide: true`. Counting `conhost.exe` cannot measure it; count visible `ConsoleWindowClass` windows.
- **A test whose premise your OS cannot satisfy must verify the premise, not `skipIf` it.** Attempt the capability (chmod, binary present, sandbox confines), confirm it took effect, bail explicitly otherwise — absence must never read as a pass. Use `bun run audit:platform-test-gaps` to name tests your OS cannot run.

## 5. Where Things Live

| Path | Role |
|---|---|
| `packages/gateway/src/platform/sandbox/sandbox-runner.ts` | `SandboxRunner`, `SandboxSpawnOptions`, `createSandboxRunner` |
| `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts` | the single `runner.spawn` boundary (I15) |
| `packages/gateway/src/platform/sandbox/{linux,darwin,win32}.ts` | per-OS backends |
| `packages/gateway/src/platform/sandbox/sandbox-policy.ts` | `SandboxPolicy`, `policyFromManifest`, env names |
| `packages/gateway/src/platform/sandbox/sandbox-cwd.ts` | per-policy leaf + `ext-stage` root |
| `packages/gateway/src/platform/sandbox/{win32-reap,win32-release,orphan-reap}.ts` | Windows profile/ACE lifecycle |
| `packages/gateway/src-native/sandbox-helper/` · `packages/gateway/src-native/sandbox-helper-win32/README.md` | native helpers (Linux C, Windows contract + exit codes `65`–`68`) |
| `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` | `wrapServerSpec`, `wrapServerSpecInCwd` |
| `packages/gateway/src/connectors/lazy-mesh/{mesh,user-mcp,extension-slot,extension-slot-source}.ts` | mesh, user-MCP spawn, `mesh:ext:` slot |
| `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts` | `FIRST_PARTY_MANIFESTS`, `manifestForFirstParty` |
| `packages/gateway/src/extensions/spawn-env.ts` | `extensionProcessEnv` (I1) |
| `packages/gateway/src/extensions/{extension-runtime,verified-extension,extension-stage,run-extension-entry}.ts` | I43 spawn path |
| `packages/gateway/src/extensions/{approve-run,run-grant-store,extension-run-grants,run-grant-env,run-grant-error,run-state,extension-service-id}.ts` | run grants |
| `packages/gateway/src/extensions/{install-from-local,verify-extensions,hard-disable,tree-digest}.ts` | install, I16, digest |
| `packages/gateway/src/connectors/{owner-code-server,user-mcp-store,user-mcp-registration,user-mcp-model-capability,registry}.ts` | I42 helpers + dispatcher check |
| `packages/gateway/src/platform/spawn-capture.ts` · `scripts/audit/check-windows-console-hide.ts` | hidden spawns (D25, `audit:windows-console`) |
| `scripts/structure-audit/check-nimbus-invariants.ts` | D10, D25, D33 |
| `packages/gateway/src/extensions/registry/*` · `packages/gateway/src/ipc/registry-rpc.ts` | registry client (I44) |
| `packages/registry-format/src/*` | the pure index format, signer, manifest parser and id rules the registry client and CLI share |
| `packages/gateway/src/security-invariants.test.ts` | I1 / I15 / I16 / I42 / I43 / I44 enforcement |
| `packages/gateway/test/e2e/{extension-runtime,user-mcp,registry,registry-acceptance}.e2e.test.ts` | real-gateway E2E |

## 6. Checklist for Changing This Area

1. **New spawn under `connectors/lazy-mesh/`:** wrap the spec literal in `wrapServerSpec(...)` at the site, pass `env: extensionProcessEnv(...)`, run `bun run audit:invariants`.
2. **New admission of a confined execution:** gate on `canConfine(policy)` over the policy that actually spawns, before consent — never `isFullyActive()` / `degradedReason()`.
3. **New or changed defense:** the triple rule — production wiring + `docs/SECURITY-INVARIANTS.md` entry + `security-invariants.test.ts` assertion in ONE commit; update the `CLAUDE.md` and `GEMINI.md` summaries (see `nimbus-security-invariants`).
4. **Confinement claim:** add a per-platform integration test with a positive control (prove the unconfined run CAN do the thing first), and self-validate premises instead of `skipIf`.
5. **New IPC method:** `checkLanMethodAllowed` is a denylist — add RCE-class / owner-approval methods to `ipc/lan-rpc.ts`; keep them off `ALLOWED_METHODS` in `packages/ui/src-tauri/src/gateway_bridge.rs` and add a Rust assertion (see `nimbus-ipc`, `nimbus-tauri-allowlist`); wire the outer routing match, not just the handler.
6. **New run-grant field or check:** extend `readVerifiedExtensionForSpawn` AND `approveExtensionRun` through the one env builder `buildExtensionRunGrantEnv` — two copies drift into `ERR_EXTENSION_RUN_CHANGED` on every spawn.
7. **Schema change:** see `nimbus-db-migrations`; keep `extension_run_grant` confined (D33(b)).
8. **Docs:** `docs/sandbox.md` (operator behaviour, platform asymmetry, stated bounds), `docs/SECURITY-INVARIANTS.md`, `docs/cli-reference.md` (refusal codes per command), `docs/architecture.md`, `docs/CHANGELOG.md`.
9. **Before pushing:** build the sandbox helper, run the sandbox tests alone (no concurrent preflight), then `bun run preflight:fast` and `bun run audit:doc-refs`.
