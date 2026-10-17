# Extension Runtime PR 3 (spawn) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An installed extension with a live run grant actually runs, as a sandboxed MCP stdio server, reachable through `nimbus connector tools|call ext_<id>`, behind the I42 per-call prompt, under a new invariant I43.

**Architecture:** A new gateway self-role `__nimbus-extension` `import()`s the extension's entry file. `extensions/extension-runtime.ts` is the ONE place that builds its spawn spec, and it does so only after `readVerifiedExtensionForSpawn` re-verifies row, grant, manifest hash, entry hash, tree digest, I16 signature and the re-resolved grants. The lazy mesh gains a `mesh:ext:<serviceId>` slot fed by an injected `ExtensionSlotSource`. I42's `mcp_` predicate widens to "owner-approved code server" (`mcp_` ∪ `ext_`).

**Tech Stack:** Bun 1.4, TypeScript strict, bun:sqlite, `@mastra/mcp` `MCPClient`, bun:test, Biome.

**Spec:** `docs/superpowers/specs/2026-10-11-extension-runtime-design.md` — read § 4.3–4.9, § 5, § 8, and the § 11 + § 12 amendments (they override the body). Branch-only: both the spec and this plan are deleted in the last task before the PR.

## Global Constraints

- All paths below are relative to `packages/gateway/src/` unless they start with `packages/`, `docs/`, `scripts/` or a repo-root file.
- No `any`; `unknown` for external data. Biome clean. Paths via `node:path`, never hard-coded separators.
- Service id pattern (existing): `EXTENSION_SERVICE_ID_PATTERN = /^ext_[a-z0-9_]{1,62}$/` in `extensions/extension-service-id.ts`. Never recompute a stored service id.
- Mesh key: `mesh:ext:<serviceId>`. Sandbox manifest id / AppContainer profile / cwd leaf: `ext.<serviceId>`.
- Self-role sentinel: `__nimbus-extension`; role key `extension`.
- The stored grant (`permissions_json`) never contains the install path or runtime read paths; both are added fresh at every spawn (spec § 11 item 7).
- Every pre-spawn refusal throws `ExtensionRunGrantError` (`extensions/run-grant-error.ts`) with an `ERR_EXTENSION_*` code; reuse existing codes (`RUN_NOT_APPROVED`, `RUN_DISABLED`, `RUN_UNVERIFIED`, `RUN_NO_DIGEST`, `RUN_TREE_CHANGED`, `RUN_CHANGED`) and add only `ERR_EXTENSION_RUN_POLICY`, `ERR_EXTENSION_RUNTIME_DISABLED`, `ERR_EXTENSION_ENTRY_OUTSIDE`.
- Never reached by the model in this PR: extension tools must not enter `listToolsForDispatcher`'s merged map (spec § 12 item 4).
- Commits: conventional type, `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. No `!` (nothing a user must change).
- Before every commit run `bun run typecheck` and the task's tests; before the PR run `bun run preflight:fast` then the full `bun run preflight`.
- Tests that touch the real sandbox: do NOT run them beside a background preflight (Windows helper ACL race). A fresh worktree needs the sandbox helper built (`nimbus-commands` skill).

## Review Focus

1. **A running extension after revoke/remove/disable.** Each must terminate the child, including when the grant row is already gone — pinned by Task 5 (mesh map) and Task 9 (e2e, child really exits).
2. **Bytes changed between two calls of the same live client.** A client that stays connected never re-spawns, so a swapped sibling file only takes effect at the next spawn — the e2e must force a disconnect (revoke + re-approve is wrong; use `extension.disable` then `enable`) before asserting the refusal. Task 9.
3. **Manifest `entry` pointing outside the install tree** (`../../x.js`, absolute path, symlinked dir). Must refuse before spawn with `ERR_EXTENSION_ENTRY_OUTSIDE`. Task 3.
4. **A publisher-signed extension whose publisher key was removed from the Vault after approval.** Must refuse at spawn (fail-closed), not run as unsigned. Task 3.
5. **`[extensions] runtime = flase` (typo).** Must keep the default (`true`), not silently disable or enable. Task 7.

---

### Task 1: Widen I42 to owner-approved code servers (`mcp_` ∪ `ext_`)

**Files:**
- Create: `connectors/owner-code-server.ts`, `connectors/owner-code-server.test.ts`
- Modify: `engine/executor.ts:239` (`isUserMcpActionType` → body uses the new predicate; keep the exported name so call sites at :272/:364/:397 are unchanged), `connectors/registry.ts:101-112,180-186`, `share/read-tool-registry.ts:65`, `ipc/share-rpc.ts:168`
- Test: `security-invariants.test.ts` (I42 block, ~:5574), `connectors/proposable-actions.test.ts`
- Docs: I42 row in `CLAUDE.md`, `GEMINI.md`, `docs/SECURITY-INVARIANTS.md` § I42 (triple rule — same commit)

**Interfaces:**
- Produces (in `connectors/owner-code-server.ts`):
  - `isOwnerCodeServerServiceId(id: string): boolean` — `USER_MCP_SERVICE_ID_PATTERN.test(id) || EXTENSION_SERVICE_ID_PATTERN.test(id)`
  - `isOwnerCodeServerToolKey(key: string): boolean` — `startsWith("mcp_") || startsWith("ext_")`
  - `ownerCodeServerToolKeyForActionType(actionType: string): string | undefined` — `<serviceId>_<tool>` iff `serviceOf(actionType)` is an owner-code-server id (mirror `userMcpToolKeyForActionType`)
  - `normalizeOwnerCodeServerServiceId(raw: unknown): string | null` — trim, lowercase, then the predicate (mirror `normalizeUserMcpServiceId`)

- [ ] **Step 1: Write failing unit tests** in `owner-code-server.test.ts`: `isOwnerCodeServerServiceId` true for `mcp_a`, `ext_a`, `ext_a_b`; false for `ext_`, `ext-a`, `EXT_A` (pattern is lowercase), `github`, `extension`; `ownerCodeServerToolKeyForActionType("ext_foo.echo") === "ext_foo_echo"`, `("github.pr_list") === undefined`; `isOwnerCodeServerToolKey("ext_foo_echo") === true`; and a table assertion that no `CONNECTOR_SERVICE_IDS` entry satisfies `isOwnerCodeServerServiceId`.
- [ ] **Step 2: Add I42 `ext_` cases to `security-invariants.test.ts`** in the existing I42 block, mirroring its tests 3–5 with `ext_x.y`: (a) behavioural deny → `rejected`, 1 prompt, 0 dispatches, `HITL_REQUIRED.has("ext_x.y") === false`; (b) `tryDelegatedApproval` returns `fallback` for `ext_x.y` (behavioural, with a delegation stub that would otherwise approve); (c) `isReadOnlyToolId("ext_x_y") === false` and `runReplayTool` returns `unavailable` for it; (d) `createConnectorDispatcher` rejects `ERR_USER_MCP_ACTION_MISMATCH` for `github.pr_list` carrying `mcpToolId: "ext_x_echo"`, AND for `ext_x.echo` carrying `mcpToolId: "mcp_x_echo"`.
- [ ] **Step 3: Add a proposability pin** in `proposable-actions.test.ts`: `classifyActionType("ext_foo.echo", ctx)` is NOT `proposable` (expect `{ kind: "unknown" }`) with a ctx whose `modelAccessServices()` contains `ext_foo` — extensions are not proposable on the act door in PR 3.
- [ ] **Step 4: Run** `bun test packages/gateway/src/connectors/owner-code-server.test.ts packages/gateway/src/security-invariants.test.ts packages/gateway/src/connectors/proposable-actions.test.ts` — expect the new cases FAIL.
- [ ] **Step 5: Implement** `owner-code-server.ts` and switch the four sites to it (executor predicate body; registry `toolsFor` + `assertUserMcpKeyMatchesActionType`; share read-tool registry; share-rpc replay guard). Leave `proposable-actions.ts`, `sync-egress.ts`, `capture-rpc.ts`, `assemble.ts:3466` on the `mcp_`-only helpers (deliberate: an extension has no sync, no act-door proposal, no `isServiceConfigured` row). Update any existing source-regex pin in the I42 block that names the old helper.
- [ ] **Step 6: Re-run Step 4's command** — expect PASS. Then `bun test packages/gateway/src/engine packages/gateway/src/connectors packages/gateway/src/share` — PASS.
- [ ] **Step 7: Reword the I42 row** in `CLAUDE.md`, `GEMINI.md` and `docs/SECURITY-INVARIANTS.md`: "any action whose service is an owner-approved code server id (`mcp_*` user MCP, or `ext_*` approved extension)…"; name `connectors/owner-code-server.ts` in the wiring list; state that extension tools are not offered to the model and not proposable in this release.
- [ ] **Step 8: Commit** `feat(security): widen I42 to approved extension service ids (ext_)`.

### Task 2: The `__nimbus-extension` self-role + static D33(a)

**Files:**
- Modify: `platform/runtime-layout.ts:11` (add `extension: "__nimbus-extension"`), `index.ts` (new branch after the connector branch), `platform/runtime-layout.test.ts`, `entry-graph.test.ts`
- Create: `extensions/run-extension-entry.ts`, `extensions/run-extension-entry.test.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (D33 section ~:1848, runner ~:3053, scan list ~:2762 if new files must be listed), `scripts/structure-audit/check-nimbus-invariants.test.ts` (after D33(c) ~:3146)

**Interfaces:**
- Produces: `runExtensionEntry(entryPath: string | undefined): Promise<void>` — exits 2 (via the same `failRole` shape `index.ts` uses for the connector role) on a missing/relative path; otherwise `await import(pathToFileURL(entryPath).href)`. Imports only `node:url` / `node:path`.
- Produces: `export function checkExtensionRoleConfinement(files: readonly FileEntry[]): Violation[]` (rule `"extension-role-confined"`).

- [ ] **Step 1: Failing tests.** `runtime-layout.test.ts`: `selfSpawn("extension", ["/x/e.js"], compiledLayout)` → `{command: execPath, args: ["__nimbus-extension", "/x/e.js"]}`; dev layout → `[gatewayEntry, "__nimbus-extension", "/x/e.js"]`; the three sentinels are distinct. `entry-graph.test.ts`: `staticDepsOf(index.ts)` still equals `[platform/runtime-layout.ts]`, and the static graph of `extensions/run-extension-entry.ts` contains no file matching the existing `STATEFUL` regex (`db/`, `vault/`, `ipc/`). `run-extension-entry.test.ts`: spawn `bun -e` that calls `runExtensionEntry` on a temp file writing a marker → marker written; with `undefined` → exit 2.
- [ ] **Step 2: Failing D33(a) fixtures** (copy D33(c)'s `file()` helper and `test.each` style): allowed — `__nimbus-extension` in `packages/gateway/src/platform/runtime-layout.ts`; `selfSpawn("extension", [p])` in `packages/gateway/src/extensions/extension-runtime.ts`. Violations — the literal in any other non-test gateway file; `selfSpawn('extension'` / `` selfSpawn(`extension` `` / `selfSpawn( "extension"` elsewhere (including `index.ts`). Not violations — the literal inside a comment; a `.test.ts` file; `selfSpawn("sandbox"`.
- [ ] **Step 3: Run** `bun test packages/gateway/src/platform/runtime-layout.test.ts packages/gateway/src/entry-graph.test.ts packages/gateway/src/extensions/run-extension-entry.test.ts scripts/structure-audit/check-nimbus-invariants.test.ts` — FAIL.
- [ ] **Step 4: Implement.** Sentinel; `index.ts` branch `else if (role === ROLE_SENTINELS.extension) await (await import("./extensions/run-extension-entry.ts")).runExtensionEntry(roleArgs[0])` — dynamic import only, no literal. D33(a): scan `stripComments(contents)` only (NOT `stripStringLiterals`, which would blank the literal — same as D29(a)); regexes `/__nimbus-extension/` and ``/\bselfSpawn\(\s*["'`]extension["'`]/``; per-regex allow-list; wire into the runner block beside D33(b)/(c) with `::error … D33(a)`. Update the D33 header comment (it says (a) lands in PR 3).
- [ ] **Step 5: Run** Step 3's command, then `bun run audit:invariants` (or the script name `nimbus-commands` lists for `check-nimbus-invariants.ts`) — PASS.
- [ ] **Step 6: Commit** `feat(extensions): __nimbus-extension self-role and static rule D33(a)`.

### Task 3: `readVerifiedExtensionForSpawn` — the pre-spawn re-verification

**Files:**
- Create: `extensions/verified-extension.ts`, `extensions/verified-extension.test.ts`
- Modify: `extensions/run-grant-error.ts` (add the three new codes from Global Constraints)

**Interfaces:**
- Consumes: `getRunGrant`, `listExtensions`, `verifyOneExtensionStrict`, `readVerifiedManifest` (approve-run.ts:114), `computeExtensionTreeDigest`, `verifyManifestSignature`, `readPublisherKey` (`extensions/publisher-keys.ts`), `signatureDisabledRegistry`, `resolveExtensionRunGrants` + `serializeRunGrants`, `ExtensionRunGrantEnv`.
- Produces:
  ```ts
  export interface VerifiedExtensionForSpawn {
    readonly extensionId: string;
    readonly serviceId: string;
    readonly version: string;
    readonly installPath: string;          // realpath
    readonly entryPath: string;            // absolute, realpath, inside installPath
    readonly grants: ResolvedRunGrants;    // freshly re-resolved, equal to the stored grant
  }
  export interface VerifiedExtensionDeps {
    readonly db: Database;
    readonly vault: NimbusVault;
    readonly env: ExtensionRunGrantEnv;
  }
  export async function readVerifiedExtensionForSpawn(extensionId: string, deps: VerifiedExtensionDeps): Promise<VerifiedExtensionForSpawn>
  ```

The order is the invariant; each step throws `ExtensionRunGrantError`:
1. row exists (`NOT_FOUND`) and `enabled === 1` (`RUN_DISABLED`);
2. grant exists (`RUN_NOT_APPROVED`);
3. `signatureDisabledRegistry.reasonFor(id)` undefined, and `verifyOneExtensionStrict(row)` true (`RUN_UNVERIFIED`);
4. `readVerifiedManifest(row)`; `row.tree_digest` non-null (`RUN_NO_DIGEST`);
5. live `computeExtensionTreeDigest(install_path)` === `row.tree_digest` === `grant.tree_digest` (`RUN_TREE_CHANGED`); `manifest.version === row.version === grant.version` (`RUN_CHANGED`);
6. if `manifest.publisher` is defined: key from `readPublisherKey(vault, publisher.id)` must exist and `verifyManifestSignature` must not throw (`RUN_UNVERIFIED`); no publisher ⇒ unsigned, allowed;
7. entry = `manifest.entry ?? "dist/index.js"` (the same default `verifyOneExtensionStrict` uses — import it or share the constant, do not duplicate the literal); `realpath(join(installPath, entry))` must be inside `realpath(installPath)` (`ENTRY_OUTSIDE`);
8. `serializeRunGrants(resolveExtensionRunGrants(manifest.permissions, installPath, env)) === grant.permissions_json` (`RUN_CHANGED`).

- [ ] **Step 1: Failing tests** over a real temp-dir install (real SQLite, `upsertRunGrant` + `insertExtensionRow` from the existing stores; build the fixture with the same helpers `approve-run.test.ts` uses). One `test` per refusal above, asserting the exact code, plus: happy path returns `entryPath` inside `installPath` and `grants` deep-equal to the stored JSON parsed; a sibling file edited after approval → `RUN_TREE_CHANGED`; an added file → `RUN_TREE_CHANGED`; `entry: "../outside.js"` → `ENTRY_OUTSIDE`; a publisher-signed fixture whose Vault key was deleted after approval → `RUN_UNVERIFIED` (Review Focus 4); a declared read path deleted after approval → a `RUN_CHANGED` or `GRANT_PATH_MISSING` refusal (assert it refuses; either code is acceptable — pin whichever the resolver produces); calling it twice re-hashes both times (spy `computeExtensionTreeDigest` via an injected `deps.treeDigest?` defaulting to the real one, asserting 2 calls — never a cache).
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/verified-extension.test.ts` — FAIL.
- [ ] **Step 3: Implement** in the order above. Close every DB statement (`bun-sqlite prepare must finalize`).
- [ ] **Step 4: Run** Step 2 — PASS; `bun test packages/gateway/src/extensions` — PASS.
- [ ] **Step 5: Commit** `feat(extensions): re-verify an extension immediately before every spawn`.

### Task 4: `extensions/extension-runtime.ts` — the spawn spec and the slot source

**Files:**
- Create: `extensions/extension-runtime.ts`, `extensions/extension-runtime.test.ts`
- Create: `connectors/lazy-mesh/extension-slot-source.ts` (interface only, so the mesh does not import the runtime)

**Interfaces:**
- Produces (in `connectors/lazy-mesh/extension-slot-source.ts`):
  ```ts
  export interface PreparedExtensionSpawn { readonly extensionId: string; readonly serviceId: string; readonly spec: ServerSpec }
  export interface ExtensionSlotSource {
    /** Grant service ids of enabled extensions. Never verifies. */
    listServiceIds(): readonly string[];
    /** Full re-verification + spec build. Throws ExtensionRunGrantError on any refusal. */
    prepareSpawn(serviceId: string): Promise<PreparedExtensionSpawn>;
  }
  ```
- Produces (in `extensions/extension-runtime.ts`):
  - `buildExtensionRuntimeManifest(v: VerifiedExtensionForSpawn, runtimeReadPaths: readonly string[]): ExtensionManifest` — `{ id: "ext." + serviceId, version, permissions: { network: grants.network, filesystem: { read: [...grants.read, installPath, ...runtimeReadPaths], write: grants.write } }, updateChannel: "stable" }`
  - `buildExtensionSpawnSpec(v, deps: { runtimeReadPaths: readonly string[]; sandboxDir: string }): ServerSpec` — `wrapServerSpec({ ...selfSpawn("extension", [v.entryPath]), env: extensionProcessEnv({}) }, buildExtensionRuntimeManifest(...), sandboxDir)`
  - `createExtensionSlotSource(deps: VerifiedExtensionDeps & { sandboxDir: string; runtimeReadPaths: () => readonly string[]; isConnectorAllowed: (serviceId: string) => boolean }): ExtensionSlotSource` — `prepareSpawn` resolves the extension id from the grant by service id, refuses `RUN_POLICY` when `!isConnectorAllowed(serviceId)` (spec § 12 item 5), then `readVerifiedExtensionForSpawn`, then `buildExtensionSpawnSpec`. `runtimeReadPaths` is a thunk so it is recomputed per spawn.

- [ ] **Step 1: Failing tests.** Manifest builder: id `ext.ext_foo`; read list = grants.read + installPath + runtime paths in that order; write list never contains installPath; network unchanged. Spec builder: decode `NIMBUS_SANDBOX_POLICY_JSON` from the returned env and assert it equals the built manifest's permissions and id; the inner argv (after the sandbox sentinel) ends with `["__nimbus-extension", entryPath]`; env carries no key outside `extensionProcessEnv({})` + the two sandbox vars. Slot source: `listServiceIds` excludes a disabled row's grant; `prepareSpawn` with `isConnectorAllowed → false` throws `ERR_EXTENSION_RUN_POLICY` before touching the disk (assert via an injected verifier spy, 0 calls); an unknown service id throws `ERR_EXTENSION_RUN_NOT_APPROVED`.
- [ ] **Step 2: Run** `bun test packages/gateway/src/extensions/extension-runtime.test.ts` — FAIL.
- [ ] **Step 3: Implement.** If dev-tree spawning later fails because the sandbox cannot read the gateway source (spec R2), the fix belongs here: append `dirname(layout.gatewayEntry)`'s package root to `runtimeReadPaths` only when `!isCompiledBinary(layout)` — do it only if Task 9 proves it necessary, and record that in the CHANGELOG entry.
- [ ] **Step 4: Run** Step 2 — PASS. Run the static audit — D33(a) passes with the one `selfSpawn("extension"` here.
- [ ] **Step 5: Commit** `feat(extensions): build an extension's sandboxed spawn spec from its verified grant`.

### Task 5: The `mesh:ext:` slot and the re-pointed stop hook

**Files:**
- Modify: `connectors/lazy-mesh/keys.ts:42-46` (add `EXT_MESH_PREFIX = "mesh:ext:"`, `extensionMeshKey(serviceId)`), `connectors/lazy-mesh/mesh.ts` (constructor option, new methods, `stopExtensionClient` :289), `connectors/registry.ts:62-72` (`meshDispatcherClient`)
- Create: `connectors/lazy-mesh/mesh-extension-slot.test.ts`

**Interfaces:**
- Consumes: `ExtensionSlotSource` (Task 4), `transitionHealth` (`connectors/health.ts`).
- Produces on `LazyConnectorMesh`:
  - constructor option `extensionSlots?: ExtensionSlotSource` and `extensionSpawnGate?: Promise<void>` (also add both to `createLazyConnectorMesh`'s options type)
  - `listExtensionTools(serviceId: string): Promise<LazyMeshToolMap | undefined>` — `undefined` when no source or id not in `listServiceIds()`; awaits `extensionSpawnGate`; if no live client, `await prepareSpawn` → create `MCPClient` (same construction as `ensureUserMcpClient`, server key from the service id) under `extensionMeshKey`, record `extensionId → serviceId` in a private `Map`, `bumpToolsEpoch`, `scheduleLazyDisconnect`; on `ExtensionRunGrantError` call `transitionHealth(healthDb, serviceId, { type: "persistent_error", error: err.code })` and rethrow.
  - `listExtensionToolsForDispatcher(serviceId)` — the same, drain-refcount wrapped exactly like `listUserMcpToolsForDispatcher`.
  - `listOwnerCodeServerTools(serviceId)` / `listOwnerCodeServerToolsForDispatcher(serviceId)` — route by prefix to the user-MCP or extension method.
  - `isExtensionRunning(extensionId: string): boolean` — the map has it AND the slot has a client.
  - `stopExtensionClient(extensionId)` — keep the two existing lines, add: look up the map, `stopLazyClient(extensionMeshKey(serviceId))`, delete the map entry.
  - `removeExtensionSandbox(serviceId: string): Promise<void>` — `sandboxCwdFor(paths.sandboxDir, "ext." + serviceId)` leaf, same 3×100 ms retry and never-throws contract as `removeUserMcpSandbox`.
- Disconnect paths (idle timer, stop) must delete the map entry so `isExtensionRunning` turns false.
- `collectUserMcpToolMap` and `ensureUserMcpConnectorsRunning` stay `mesh:user:`-only (spec § 12 item 4) — add a comment saying why.

- [ ] **Step 1: Failing tests** with a fake `ExtensionSlotSource` whose `prepareSpawn` returns a spec for a tiny stdio MCP echo server (reuse the fixture server the existing mesh user-MCP tests use; unconfined spec is fine here — confinement is Task 9's): first `listExtensionTools` calls `prepareSpawn` once and returns `ext_foo_echo`; a second call within the idle window does NOT call it again; after `stopExtensionClient("foo-ext")` the slot is gone, `isExtensionRunning` is false, and the next list calls `prepareSpawn` again (re-verification per spawn); `stopExtensionClient` works after the source no longer lists the id (grant deleted — Review Focus 1); a `prepareSpawn` throwing `ERR_EXTENSION_RUN_TREE_CHANGED` rejects with that code, records `persistent_error` with that code in a real health DB, and leaves no slot; `listToolsForDispatcher()` output contains no `ext_` key while an ext slot is live; the spawn gate: with an unresolved `extensionSpawnGate`, `listExtensionTools` does not call `prepareSpawn` until it resolves; `removeExtensionSandbox` deletes `ext.ext_foo` leaf and never throws on a missing one.
- [ ] **Step 2: Run** `bun test packages/gateway/src/connectors/lazy-mesh/mesh-extension-slot.test.ts` — FAIL.
- [ ] **Step 3: Implement;** in `meshDispatcherClient` route the existing `listUserMcpTools` member to `mesh.listOwnerCodeServerToolsForDispatcher` so `createConnectorDispatcher`'s single-slot `toolsFor` (now keyed on `ownerCodeServerToolKeyForActionType` from Task 1) reaches extensions.
- [ ] **Step 4: Run** Step 2, then `bun test packages/gateway/src/connectors` — PASS.
- [ ] **Step 5: Commit** `feat(connectors): a lazy mesh:ext: slot for approved extensions; stop hook stops it`.

### Task 6: Owner invocation over IPC and the CLI

**Files:**
- Modify: `ipc/connector-rpc-handlers/user-mcp.ts:56-110`, `ipc/connector-rpc-handlers/user-mcp.test.ts` (or the existing test file for these handlers), `packages/cli/src/commands/connector-user-mcp.ts:17-18` (usage strings), its test

**Interfaces:**
- Consumes: `normalizeOwnerCodeServerServiceId` (Task 1), `mesh.listOwnerCodeServerTools` (Task 5).
- Error mapping: an `ExtensionRunGrantError` from listing becomes `ConnectorRpcError(-32602, err.message)` (the message already starts with the code); an unknown/unapproved `ext_` id stays `ERR_USER_MCP_NOT_REGISTERED` (message names both `nimbus connector add --mcp` and `nimbus extension approve`).

- [ ] **Step 1: Failing tests:** `connector.userMcpTools` with `ext_foo` lists `echo` (prefix stripped); `connector.userMcpCall` with `ext_foo`/`echo` executes action type `ext_foo.echo` with `payload.mcpToolId === "ext_foo_echo"` (assert via a recording executor); a listing that throws `ExtensionRunGrantError("ERR_EXTENSION_RUN_TREE_CHANGED", …)` surfaces `-32602` with that code and never reaches the executor; `EXT_FOO` normalizes to `ext_foo`. CLI: usage text names `<mcp_id|ext_id>`; exit code for `ERR_EXTENSION_RUN_*` is 2 (same class as not-registered).
- [ ] **Step 2: Run** the two test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `bun test packages/cli/src/commands` — PASS.
- [ ] **Step 5: Commit** `feat(connector): nimbus connector tools|call reach approved extensions`.

### Task 7: Wiring, kill switch, lifecycle and run state

**Files:**
- Modify: `config/nimbus-toml.ts:1306-1350` (`NimbusExtensionsToml.runtime: boolean`, default `true`, `parseBool`), `config/nimbus-toml-extensions.test.ts`
- Modify: `platform/assemble.ts` (~:914 mesh construction, ~:3613 after `verifyExtensionsBestEffort`), `ipc/server/dispatchers.ts:1925` (`buildExtensionRunGrantEnv` — reuse it for the slot source's `env` so approve and spawn resolve identically)
- Modify: `extensions/approve-run.ts` (refuse `ERR_EXTENSION_RUNTIME_DISABLED` when the runtime is off — inject `runtimeEnabled: boolean` via `ApproveExtensionRunDeps`), `ipc/automation-rpc.ts` (`extension.remove` :322; list/info runState), `extensions/run-state.ts`, `extensions/auto-update-rpc.ts:29-57`
- Modify: `packages/cli/src/commands/extension.ts:86-135` (`formatRunLine` drops "not executed until the extension runtime ships")
- Tests: alongside each

**Decisions:**
- assemble: build `createExtensionSlotSource(...)` only when `extensionsCfg.runtime && paths.demo !== true`; pass it plus `extensionSpawnGate` (a deferred resolved right after `await verifyExtensionsBestEffort(...)`, and also resolved if that call throws, so a failed verify cannot wedge every extension forever — the per-spawn verify still refuses) into the mesh.
- `ExtensionRunState` gains `"running"`; order: `disabled`, `no_grant`, `grant_stale`, then `running` if `mesh.isExtensionRunning(id)`, else `ready`. `extensionRunFields(row, grant, running: boolean)`.
- `extension.remove`: read the grant first; `await mesh.stopExtensionClient(id)`; delete as today; then `await mesh.removeExtensionSandbox(grant.service_id)` when a grant existed.
- auto-update payload gains `runGrantNote?: string` = ``"Running the new version will need a new `nimbus extension approve " + id + "`."`` only when a grant exists.

- [ ] **Step 1: Failing tests:** TOML — absent ⇒ `true`; `runtime = false` ⇒ false; `runtime = flase` ⇒ `true` (Review Focus 5) and does not throw. approve-run — runtime off ⇒ `ERR_EXTENSION_RUNTIME_DISABLED` before the gate is called (0 gate calls). run-state — the `running` ordering table (a disabled-but-mapped extension reports `disabled`). automation-rpc — `extension.remove` on a running extension calls the stop hook before the row delete (ordered recorder) and removes the leaf; list/info carry `runState: "running"` when the mesh says so. auto-update — note present iff grant exists. CLI — `formatRunLine` for `running` and `ready`, no "not executed" text. assemble — extend the existing I41 demo pin in `security-invariants.test.ts` (or the assemble test it uses) to assert no slot source is passed on a demo gateway.
- [ ] **Step 2: Run** the touched test files — FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS; `bun test packages/gateway/src/ipc packages/gateway/src/extensions packages/gateway/src/config packages/cli/src` — PASS.
- [ ] **Step 5: Commit** `feat(extensions): wire the runtime; [extensions] runtime kill switch; remove stops a running extension`.

### Task 8: Invariant I43 (wiring + docs + test, one commit)

**Files:**
- Modify: `security-invariants.test.ts` (new `describe("I43 — …")` after I42), `docs/SECURITY-INVARIANTS.md` (new `## I43` before "How a new invariant is added", same paragraph labels as I42: Statement / Why / Bounds, stated / Static rule / Wiring / Test), `CLAUDE.md` + `GEMINI.md` (I43 bullet after I42; I29 bullet gains "an approved extension's own `--net`-equivalent traffic is likewise not ledgered"; static-complement paragraph names D33(a); status line "Invariants I1–I43")
- Modify every `I1–I42` ceiling surface to `I1–I43`: `CLAUDE.md`, `GEMINI.md`, `docs/architecture.md`, `docs/README.md`, `docs/SECURITY-INVARIANTS.md`, `.github/SECURITY.md`, `.coderabbit.yaml` (`I1-I43`), `.claude/commands/nimbus-file-map.md`, `.claude/commands/nimbus-tool-output-envelope.md`, `.claude/commands/nimbus-tauri-allowlist.md`. Re-grep `I1–I42` and `I1-I42` repo-wide after editing; `CHANGELOG.md` history stays.

**I43 statement (copy into docs):** an installed extension's code executes only through `extensions/extension-runtime.ts`'s `prepareSpawn`, which requires a live run grant created behind the executor-gated `extension.run` approval; an immediate pre-spawn `readVerifiedExtensionForSpawn` (row, grant, manifest + entry hash, tree digest against row AND grant, I16 for a publisher manifest, entry inside the install tree, re-resolved grants equal to the stored ones); the `ext.<serviceId>` runtime manifest built from those grants; and the `__nimbus-extension` self-role launched through `wrapServerSpec` (I15). Any failure spawns nothing. Bounds: check-then-spawn (a writer racing the window between digest and `import()` is not stopped); the DB-write attacker (can rewrite digest and grant consistently); a live client is not re-verified until its next spawn; the extension's own network traffic to granted hosts is not ledgered.

- [ ] **Step 1: Write the I43 block:** (a) behavioural — over a real temp install with a fake mesh-free call to `createExtensionSlotSource(...).prepareSpawn`: no grant ⇒ refuses; stale digest ⇒ refuses; changed permissions ⇒ refuses; failed I16 ⇒ refuses; happy path returns a spec whose decoded policy id is `ext.<serviceId>` and whose inner argv contains `__nimbus-extension`; (b) source pin — `extension-runtime.ts`'s `prepareSpawn` body calls `readVerifiedExtensionForSpawn(` before `buildExtensionSpawnSpec(` (indexOf order); (c) `HITL_REQUIRED.has("extension.run") === true`; (d) `stopExtensionClient` source references `extensionMeshKey(` (gap 3.4 pin); (e) `checkExtensionRoleConfinement` over the real repo files returns `[]`.
- [ ] **Step 1b: Rust allowlist pin** (spec § 8): in `packages/ui/src-tauri/src/gateway_bridge.rs`'s tests, assert `extension.enable` stays on `ALLOWED_METHODS` while `extension.approveRun` is absent, with a comment citing I43 (enable resumes code the owner already approved; only the CLI can create a grant). Run `cargo test` in `packages/ui/src-tauri` for that test.
- [ ] **Step 2: Run** `bun test packages/gateway/src/security-invariants.test.ts` — PASS (the wiring exists from Tasks 3–5; a failure here is a real gap — fix the wiring, not the test).
- [ ] **Step 3: Red-prove** (b): temporarily swap the two calls in `prepareSpawn`, re-run, confirm FAIL, revert.
- [ ] **Step 4: Docs edits** as listed; then `bun run audit:status-drift` and `bun run audit:doc-refs` — PASS; `bun test scripts/structure-audit` — PASS.
- [ ] **Step 5: Commit** `feat(security): invariant I43 — extension code runs only through the verified spawn path`.

### Task 9: End-to-end through a real gateway and a real sandbox

**Files:**
- Create: `packages/gateway/test/e2e/extension-runtime.e2e.test.ts`
- Reuse patterns from: `test/e2e/user-mcp.e2e.test.ts` (fixture build, `sandboxAvailable`, `installDefaultHelper`, CI-precondition test, `consent.request` responder, `gateway-runner.ts` boot) and `test/e2e/extension-run-grant.e2e.test.ts`.

**Fixture:** a temp extension package: `nimbus.extension.json` (id `e2e.echo`, version `1.0.0`, `entry: "dist/index.js"`, `permissions` declaring one read of a granted temp dir, no network), `dist/index.js` = a stdio MCP server built from the `nimbus scaffold mcp` output (as user-mcp.e2e does) with tools `echo` and `probe` (reads a path, returns `READ`/`DENIED`), its `node_modules` populated by junctioning `@modelcontextprotocol/sdk` and `zod` (as user-mcp.e2e does), plus one sibling module `dist/chunk.js` imported by the entry.

- [ ] **Step 1: Write the suite** (`describe.skipIf(!sandboxAvailable)`, plus the CI-precondition twin): install via `extension.install` (answer consent `true`); `extension.approveRun` (answer `true`) ⇒ `serviceId === "ext_e2e_echo"`; `extension.list` runState `ready`; `connector.userMcpTools {serviceId: "ext_e2e_echo"}` ⇒ `echo`, `probe`; runState now `running`; `connector.userMcpCall echo` with consent `true` ⇒ ok and a prompt containing `ext_e2e_echo.echo` was raised; with consent `false` ⇒ `rejected`; `probe` of the granted dir ⇒ `READ`; `probe` of a sentinel outside every grant (positive control: test process reads it first) ⇒ `DENIED` matching `/EACCES|EPERM|ENOENT/`; `egress.list` holds one row per executed call; then Review Focus 2 — edit `dist/chunk.js`, `extension.disable` (assert runState `disabled` and the child process is gone — use `isExtensionRunning` via runState after disable, and assert the old child's pid no longer exists if the fixture's `echo` returns `process.pid`), `extension.enable`, `connector.userMcpTools` ⇒ `-32602` with `ERR_EXTENSION_RUN_TREE_CHANGED`; `extension.revokeRun` ⇒ next `userMcpTools` ⇒ `ERR_USER_MCP_NOT_REGISTERED`; `extension.remove` on a re-approved running instance ⇒ child gone, `ext.ext_e2e_echo` sandbox leaf gone.
- [ ] **Step 2: Run** `bun test packages/gateway/test/e2e/extension-runtime.e2e.test.ts` on this (Windows) machine — iterate until green. If the dev-tree spawn fails reading the gateway source under the sandbox, apply Task 4 Step 3's conditional fix and add a unit test for it.
- [ ] **Step 3: Linux run** — `bun run verify:docker --changed` (expect the known unrelated exec-e2e red per the verify:docker note; this file must pass). macOS is verified by the PR's macOS leg.
- [ ] **Step 4: Commit** `test(e2e): an approved extension runs, is confined, and refuses changed code`.

### Task 10: Docs close-out and PR

**Files:** `docs/cli-reference.md` (replace "Installed extensions are not executed" and document `nimbus connector tools|call ext_…`, runState `running`, `[extensions] runtime`), `docs/configuration` reference for `[extensions] runtime` (find where `update_check_interval_hours` is documented), `docs/sandbox.md` (an extension spawns as `ext.<serviceId>`; what is granted), `docs/architecture.md` (extension runtime subsection), `docs/roadmap.md` S3 row ("PRs 1–3 of 4 shipped … 2026-10-17"), `docs/CHANGELOG.md` (dated entry: what shipped, I43, D33(a), the remove-never-stopped fix, the org-allowlist correction, stated bounds, "not yet: `--model`, lockoff, doctor line — PR 4"; "found, not fixed": carry forward the two open items from PR 2), `CLAUDE.md` + `GEMINI.md` status paragraph (S3 extension runtime PR 3 sentence; "Nothing spawns an extension yet" sentence replaced).

- [ ] **Step 1: Edit docs;** run `bun run audit:doc-refs` and `bun run audit:status-drift` — PASS.
- [ ] **Step 2: Strip branch-only files:** `git rm docs/superpowers/specs/2026-10-11-extension-runtime-design.md docs/superpowers/plans/2026-10-17-extension-runtime-spawn.md` and commit `chore: strip the branch-only spec and plan before the PR`.
- [ ] **Step 3: Verify** `bun run preflight` — all green (do not run sandbox tests concurrently with it).
- [ ] **Step 4: Open the PR** with `gh pr create`, title `feat(extensions): approved extensions run, sandboxed, under invariant I43 (S3 extension runtime PR 3)`; body: what ships, I42 widening, I43 + D33(a), stated bounds, what is NOT verified (the compiled-binary role is proven only by PR 1's R1 compiled-import test, not by a released-install smoke), and `🤖 Generated with [Claude Code](https://claude.com/claude-code)`. Do not merge.
