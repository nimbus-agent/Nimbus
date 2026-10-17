# Extension runtime: installed extensions actually run (design)

- **Date:** 2026-10-11
- **Slot:** S3 — Open Surface, first slice (the Phase 9.5 prerequisite row *Extensions actually run*)
- **Status:** proposed; nothing here is implemented
- **Invariant budget:** one new invariant (I43), one widened invariant (I42), one new static rule (D32), one migration (V66)

## 1. Problem

`nimbus extension install` copies a package into the extensions directory, hashes its manifest
and entry file, verifies a publisher's Ed25519 manifest signature (I16), writes an `extension` row
and enables it. Nothing ever starts the extension. `docs/cli-reference.md` says so ("Installed
extensions are not executed"), and `docs/ecosystem-roadmap.md` § Track 0 calls the extension system
the largest "shipped but dark" surface in the product. Every Phase 9.5 marketplace row (connector
liveness, `nimbus extension audit`, `nimbus extension clone`, quality scores measured against a
running extension) assumes a runtime that does not exist.

This slice adds one. When it ships, an installed and owner-approved extension runs as a sandboxed
MCP stdio server. Its tools reach the owner through `nimbus connector call` and, if the owner opts
in, the engine agent. Every call is HITL-gated, exactly as a `connector add --mcp` server's calls
are today.

## 2. What already exists

The parts are all present. Only the wiring is missing.

| Piece | Where | State |
| --- | --- | --- |
| Manifest parser (`id`, `version`, `entry`/`entrypoint`, `permissions`, `publisher`, `signature`, `dependsOn`) | `packages/gateway/src/extensions/manifest.ts` | live |
| Permission validator (RFC 1123 hosts, `host:port`, no `..` paths) | `packages/gateway/src/extensions/permissions-validator.ts` | live |
| Install, hashing and dependency resolution | `packages/gateway/src/extensions/install-from-local.ts` | live |
| Startup integrity pass (manifest + entry hash, I16 signature, crash recovery) | `packages/gateway/src/extensions/verify-extensions.ts` | live, runs in `platform/assemble.ts` before the auto-update daemon |
| A strict synchronous re-verify (`verifyOneExtensionStrict`) | same file | **defined, no production caller** |
| Env scoping for any extension child (I1) | `packages/gateway/src/extensions/spawn-env.ts` | live |
| Sandbox wrap of any `ServerSpec` (I15/D10) | `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` | live |
| A working template: an owner-approved arbitrary MCP server, spawned lazily in a mesh slot, every call HITL-gated | `packages/gateway/src/connectors/lazy-mesh/user-mcp.ts`, `packages/gateway/src/connectors/user-mcp-store.ts`, I42 | live |
| A mesh stop hook for extensions (`stopExtensionClient`) | `packages/gateway/src/connectors/lazy-mesh/mesh.ts` | **wired, but stops keys no slot uses** (see 3.4) |

## 3. Gaps the runtime has to close first

These are defects today that do little harm only because nothing runs. With a runtime, each one
becomes a hole. The slice fixes all of them; none can wait for later.

### 3.1 Install consent is client-side only

`extension.install` is in the I2 frozen HITL set (`packages/gateway/src/engine/executor.ts`), but
no code builds an executor action of that type. `handleExtensionInstall`
(`packages/gateway/src/ipc/automation-rpc.ts`) calls `installExtensionFromLocalDirectory` directly.
The only consent is a `@clack/prompts` confirm in the CLI (`packages/cli/src/commands/extension.ts`),
which `--yes` skips and which any other socket client never sees. That breaks Non-Negotiable 2
("the consent gate lives in the executor"). It matters little while install only copies files. It
matters a great deal once installed code can run.

`connector.addMcp` already has the right shape (`addMcpBehindOwnerGate` in
`packages/gateway/src/ipc/connector-rpc.ts`): resolve, then gate, then store exactly what was
approved.

### 3.2 Integrity covers two files, not the package

The `extension` row stores `manifest_hash` and `entry_hash`, and nothing else. An entry file that
imports `./chunk-abc.js`, or anything under the package's own `node_modules/`, imports bytes nobody
hashed. Separately, the I16 publisher signature covers the **manifest object only**
(`packages/gateway/src/extensions/verify-signature.ts` wraps the SDK's flat manifest signature), so
it proves who published the manifest, not which code shipped with it. Today neither gap matters.
At runtime, an attacker with filesystem write access could swap a sibling module and have it
executed under a valid signature and a matching entry hash.

### 3.3 Manifest grants reach the sandbox verbatim

`policyFromManifest` (`packages/gateway/src/platform/sandbox/sandbox-policy.ts`) returns
`{ id, permissions: manifest.permissions }` unchanged. A third-party manifest can declare
`filesystem.read: ["<dataDir>"]` or a Vault-adjacent directory, and nothing refuses it. The
user-MCP path refuses protected roots at registration (`connectors/user-mcp-registration.ts`,
`ERR_USER_MCP_READ_PATH_PROTECTED`). The extension path has no equivalent check.

### 3.4 `stopExtensionClient` stops nothing

`LazyConnectorMesh.stopExtensionClient(id)` calls `stopUserMcpClient(id)` and `stopLazyClient(id)`.
The first resolves to key `mesh:user:<id>` and the second to the bare `<id>`, and no slot uses
either key. Startup verification, `extension.disable` and auto-update all call this hook, so today
each of them "stops" an extension that was never started. Once extensions run, a tampered or
disabled extension would keep running. The runtime's slot key must be the key this hook stops.

### 3.5 `extension.enable` is renderer-callable

`extension.enable` / `disable` / `remove` are on the Tauri allowlist (`gateway_bridge.rs`) and
LAN-forbidden. Once enabled means running, `enable` could be a code-execution switch, which I7
forbids from the renderer. This design avoids that by making the **run grant** (section 4.4), not
`enabled`, the boundary: `enable` can only resume code the owner already approved, and only the CLI
can create a grant. So `enable` stays on the allowlist, and section 8 pins that reasoning with a test.

## 4. Design

### 4.1 What an extension is at runtime

An extension's `entry` is an **MCP stdio server**: the same contract a `connector add --mcp` server
satisfies and a `@nimbus-dev/sdk` connector already implements. The runtime gives it no other
capability: no Vault access, no `SyncContext`, no index writes, no sync scheduling. An extension
that wants to index data is out of scope (section 6).

### 4.2 Service id

Every extension gets a derived, stored **service id** of the form `ext_<slug>`, matching
`/^ext_[a-z0-9_]{1,62}$/`. The slug is the manifest id, lowercased, with every character outside
`[a-z0-9]` mapped to `_`. Two things make collisions safe:

- The id is computed once, when the run grant is created, and stored in the grant row (section 4.4).
  It is never recomputed, so changing the slug rule later cannot move an existing extension's tools.
- Creating a grant **refuses** an id that equals, extends, or is extended by (via `_`) another
  stored `ext_` id. This is the same prefix rule `resolveUserMcpRegistration` applies to `mcp_` ids,
  and for the same reason: `assertUserMcpKeyMatchesActionType` cannot tell `ext_a.b_tool` apart from
  `ext_a_b.tool`.

The `ext_` namespace is disjoint from `mcp_` and from every first-party id. A test asserts that no
`CONNECTOR_SERVICE_IDS` entry starts with `ext_`.

### 4.3 How it is launched

A compiled gateway ships alone, so it cannot run `bun <entry.js>`. On Windows, a file entry point
also fails under AppContainer (`CouldntReadCurrentDirectory`, `docs/sandbox.md` § Known
limitation). The runtime therefore adds a **third self-role**:

```text
<gateway> __nimbus-extension <absolute-entry-path>
```

`ROLE_SENTINELS` (`packages/gateway/src/platform/runtime-layout.ts`) gains `extension`, and
`packages/gateway/src/index.ts` gains one branch that does `await import(pathToFileURL(entry))`.
That is the same import-a-granted-file shape `toolgen-client.ts` uses through `-e`, chosen for the
same Windows reason. The role branch evaluates nothing else from the gateway graph
(`entry-graph.test.ts` already enforces this for the other roles).

The spawned spec is:

```text
wrapServerSpec(
  { command, args: selfSpawn("extension", [entryPath]), env: extensionProcessEnv({}) },
  runtimeManifest,          // section 4.5 — NOT the raw manifest
  paths.sandboxDir,         // per-extension cwd leaf via sandboxCwdFor
)
```

It runs in a new lazy-mesh slot keyed `mesh:ext:<serviceId>`, with the same lazy connect,
idle-disconnect and drain refcount as `mesh:user:<id>` slots. `stopExtensionClient(extensionId)` is
re-pointed to resolve the extension's stored service id and stop `mesh:ext:<serviceId>`, which
closes gap 3.4.

### 4.4 The run grant (the boundary)

Installing and running become **two separate approvals**, because they consent to different
things. Install approves "put these bytes on my disk". Running approves "execute them, with these
grants, whenever a tool is needed, unattended".

- **New HITL action type `extension.run`**, added to the I2 frozen set. Created by a new CLI-only,
  LAN-forbidden IPC method `extension.approveRun` (`nimbus extension approve <id> [--model]`).
  Following the `addMcpBehindOwnerGate` order:
  1. Resolve, which may refuse before any prompt: the row exists and is enabled; the strict
     re-verify (4.6) passes; the runtime manifest (4.5) builds without a protected-root refusal;
     the service id (4.2) is free.
  2. Build the consent payload from the resolved values: id, version, publisher id and key
     fingerprint (or `unsigned`), the tree digest, the final network hosts and read/write paths
     **as they will be granted** (after 4.5), the service id, and `modelAccess`.
  3. Run `toolExecutor.gate({ type: "extension.run", payload })`. Anything other than `proceed`
     stops here.
  4. Store exactly what was approved.
- **New table `extension_run_grant` (schema V66):** `extension_id` (PK, FK → `extension.id`
  ON DELETE CASCADE), `service_id` (UNIQUE), `version`, `tree_digest`, `permissions_json` (the
  resolved runtime grants), `model_access`, `approved_at`.
- **A grant binds to bytes and grants, not to a name.** The slot spawns only if, at spawn time, the
  live tree digest equals `tree_digest` **and** the live runtime manifest equals `permissions_json`.
  Any mismatch refuses the spawn, marks the slot `persistent_error` (`connectors/health.ts`), and
  does not delete the grant. The owner sees "approval is for different code" and re-approves.
- **Existing installs do not start on upgrade.** No grant row exists for them, so nothing runs
  until the owner runs `nimbus extension approve`. The gateway never runs code silently just
  because its binary was upgraded.
- `nimbus extension revoke <id>` (`extension.revokeRun`, CLI-only, LAN-forbidden) deletes the grant
  and stops the slot. `extension.remove` cascades the grant through the FK.

Install itself also moves behind the executor (closing 3.1): `extension.install` resolves, gates
on the existing `extension.install` action type with a payload of id, version, source path,
publisher and declared permissions, then installs. The CLI keeps its `--yes` flag, which now only
skips the redundant client-side confirm. It can no longer skip the gate, because the gate is no
longer in the client.

### 4.5 The runtime manifest (what the sandbox is actually given)

The runtime builds the sandbox manifest from the declared one rather than passing the declared one
through (closing 3.3). It keeps the I15 call shape; only its input changes.

- `id`: `ext.<serviceId>`. This names the Windows AppContainer profile and the cwd leaf, mirroring
  user MCP's `user.<service_id>`.
- `network`: the declared hosts, unchanged (already validated).
- `filesystem.read`: the declared paths, after a `realpath` resolution and the user-MCP
  protected-root refusal (`userMcpProtectedRoots()`: the data, config and sandbox-root dirs), plus
  the extension's own `install_path` (added by the runtime after that check, since on macOS and
  Linux the extensions directory lives under the protected data dir) and the Bun runtime's required read paths (the
  `exec/exec-runtimes.ts` `requiredReadPaths` list, which `docs/sandbox.md` explains is not
  optional on Windows).
- `filesystem.write`: the declared paths after the same resolution and refusal, and additionally
  refused when inside `install_path`. **An extension may never write its own code**, or the tree
  digest would be the extension's to change.

A refusal is a named error (`ERR_EXTENSION_GRANT_PROTECTED`, `ERR_EXTENSION_GRANT_SELF_WRITE`)
raised before consent, so an unsatisfiable grant never prompts.

### 4.6 Integrity: a tree digest, verified at every spawn

- **New column `extension.tree_digest` (V66).** It is a SHA-256 over the sorted list of
  `(relative path, SHA-256 of bytes)` for every regular file under `install_path`, computed at
  install and at auto-update apply. A symlink anywhere in the tree refuses the install
  (`ERR_EXTENSION_SYMLINK`), because a link can point outside the hashed tree. Rows from before
  V66 get a NULL digest, and a NULL digest cannot satisfy a grant, so pre-V66 installs need a
  reinstall or `nimbus extension rehash <id>`. That command is behind the existing
  `extension.install` gate, since adopting the bytes on disk as the approved bytes is exactly what
  install approves.
- **Verified live before every spawn**, not cached. Following I40's rule, the spawn path calls one
  accessor, `readVerifiedExtensionForSpawn`, which re-reads the manifest, recomputes the tree
  digest, re-runs the I16 signature check for a `publisher` extension, and compares against both
  the row and the grant. The startup pass and the `last_verified_at` column are caches for
  `nimbus extension list`, never an authority. `verifyOneExtensionStrict` either becomes this
  accessor's core or is deleted; it is not left as a second, unused verifier.
- **What this defends, stated narrowly.** It defends against an attacker who can write the
  extension directory *between* sessions or *between* approval and spawn. Like I39's DNS residual,
  it is check-then-spawn, not spawn-what-was-checked: a writer racing the millisecond window
  between digest and `import()` is not stopped. It does not defend against an attacker who can
  write the database too, because they can rewrite `tree_digest` and the grant consistently. That
  is the same narrowing I40 states for hash-based checks, and it is why a publisher signature over
  the *code* (the SDK's unshipped JWS envelope) remains the stronger future fix (section 6).

### 4.7 Tool calls: I42, widened to `ext_`

An extension runs third-party code whose tools cannot be listed ahead of time, which is exactly
the case I42 already handles for `mcp_` ids. Rather than create a parallel invariant, I42's
predicate is widened from "service id matches `mcp_…`" to "service id is an **owner-approved code
server** id", meaning `mcp_…` or `ext_…`. One function, `isOwnerCodeServerServiceId`, replaces
`USER_MCP_SERVICE_ID_PATTERN.test` at each I42 site:

- `engine/executor.ts` `isUserMcpActionType`: every `ext_<id>.<tool>` call requires HITL, derived
  from the type only (I3), and a delegate never approves one (I20).
- `connectors/registry.ts` `assertUserMcpKeyMatchesActionType`: an `ext_` key runs only under its
  own action type, in both directions.
- `share/read-tool-registry.ts` and `ipc/share-rpc.ts`: share replay never runs an `ext_` tool.
- Consent display: the payload is shown unredacted, for the same reason I42 gives for `mcp_`.

**Owner invocation** goes through the existing `connector.userMcpTools` / `connector.userMcpCall`
methods, extended to accept an `ext_` id (`nimbus connector tools ext_foo`,
`nimbus connector call ext_foo <tool>`). No new call surface is added.

**Model access** is opt-in per grant (`--model` at approve time, stored in
`extension_run_grant.model_access`) and follows I42's model path exactly. It is offered only to the
local owner's client kinds, each call goes through the turn's own executor, and the result is
wrapped by `wrapToolOutput` / `wrapToolDescription` and the schema sanitiser (I11). The org-policy
lockoff `[policy.capabilities.ai_v2] user_mcp_model_access = false` **also empties the extension
tool source**. That only tightens, and it is the conservative reading of a lockoff whose purpose is
"do not offer owner-approved third-party code to the model". The `AI_V2_CAPABILITIES` doc comment
and `docs/SECURITY-INVARIANTS.md` both say so explicitly; this slice adds no eighth capability name.

The org connector allowlist (`isConnectorAllowed`, I22) applies to `ext_` keys at the mesh's
existing filter, so an org can block extensions by service id with no new mechanism.

### 4.8 Lifecycle

| Event | Effect |
| --- | --- |
| Gateway boot | The runtime registers no slot until `verifyExtensionsBestEffort` has finished. Slots connect lazily, on first tool listing or call, never at boot. |
| `extension.disable` | Stops `mesh:ext:<serviceId>` (through the re-pointed hook) and keeps the grant. `enable` resumes it. |
| `extension.remove` | Stops the slot, deletes the grant (cascade), and clears the sandbox leaf, mirroring `removeUserMcpSandbox`. |
| Auto-update applied | Stops the slot. The new version's digest differs from the grant's, so the next spawn refuses until the owner re-approves. A *widened* permission diff (`auto-update-permissions-diff.ts` `isWidened`) is already shown at the `extension.autoUpdate` gate; this slice adds the sentence "running it will need a new `nimbus extension approve`" to that prompt. |
| Startup verify fails (hash or I16) | The existing pass disables the row and calls the hook, which now actually stops the slot. |
| Demo-rooted gateway (I41) | Inert. No slot is registered, and `extension.approveRun` / `revokeRun` join `extension.install` in the demo gate (`ipc/server/demo-gate.ts`). |
| `[extensions] runtime = false` (new key, default `true`) | No slot is registered and `approveRun` refuses. This gives an owner a kill switch, the same way `[tool_generation] enabled` does. |

### 4.9 Egress

Every extension tool **call** reaches `connectors.dispatch` through the executor, so the I29
executor chokepoint already appends one `egress_ledger` row per call. No new appender and no new
coverage class are needed. The extension's **own** network traffic, to hosts the owner approved in
the grant, is not ledgered by Nimbus. This bound is identical to a user MCP server's `--net`
traffic, which I29 already states, and the I29 bullet is extended to name extensions next to it
rather than leaving it implied. `nimbus extension audit` (Phase 9.5) is where observed traffic gets
measured, and it is out of scope here.

## 5. Invariant and static rule

**I43 (new).** An installed extension's code executes only through
`extensions/extension-runtime.ts`'s spawn path. That path requires all of the following:

1. a live `extension_run_grant` created behind the executor-gated `extension.run` approval;
2. an immediate pre-spawn re-verification (`readVerifiedExtensionForSpawn`) of the tree digest,
   the manifest hash, and (for a `publisher` extension) the I16 signature, against both the row and
   the grant;
3. a runtime manifest equal to the granted one, with protected roots and self-writes refused;
4. the `__nimbus-extension` self-role, launched through `wrapServerSpec` (I15).

A failure at any step spawns nothing. The stated bounds are the check-then-spawn window and the
DB-write attacker (4.6).

**I42 (widened).** Its predicate becomes `mcp_` ∪ `ext_`, as in 4.7. Its existing enforcement
test gains `ext_` cases. The I42 row in `CLAUDE.md`, `GEMINI.md` and `docs/SECURITY-INVARIANTS.md`
is reworded in the same commit (triple rule).

**D32 (new static rule, `scripts/structure-audit/check-nimbus-invariants.ts`).** Two rules:

- **(a)** The `__nimbus-extension` sentinel and `selfSpawn("extension"` may appear only in
  `platform/runtime-layout.ts`, `index.ts` and `extensions/extension-runtime.ts`.
- **(b)** `extension_run_grant` (bare or SQLite-quoted) may appear only in the grant store, the V66
  DDL file and `extensions/extension-runtime.ts`.

As with D27(b), the stated bound is that a dynamically assembled identifier evades a text scan, so
capability confinement (only the store is handed a `Database` for that table) is the real defense.

## 6. Explicitly not in this slice

- **Extensions that index data or hold credentials.** No `SyncContext`, no Vault keys, no
  `sync()`. An extension that needs a secret receives it through its own declared mechanism, and
  the sandbox's per-host network grant still bounds where it can go. Credentialed extensions need
  their own consent pass, because I1's env scoping is the only thing standing between an extension
  and a credential.
- **A code-covering publisher signature.** The SDK's detached-JWS envelope has not shipped
  (`verify-signature.ts`). When it does, verifying a signature over the tree digest replaces "the
  DB holds the expected digest" with "the publisher signed the digest". That is a later slice.
- **Inter-extension calls.** `dependsOn` stays an install-time resolution. Each extension is its
  own process and slot, and they share nothing at runtime.
- **The marketplace** (`registry.nimbus-agent.dev`, publish, search, quality scores, `nimbus
  extension audit`). All of it builds on this slice.
- **Resource limits.** `SandboxPolicy.limits` is carried through but enforced by nobody today
  (`parseSandboxPolicy`'s docstring). That is pre-existing, and it is stated rather than fixed here.
- **Desktop UI.** No new renderer-callable method. `approveRun` / `revokeRun` are CLI-only.

## 7. Surfaces

| Method | Who can call | LAN | Tauri |
| --- | --- | --- | --- |
| `extension.approveRun` | CLI | forbidden | absent |
| `extension.revokeRun` | CLI | forbidden | absent |
| `extension.rehash` | CLI | forbidden | absent |
| `extension.list` / `info` | unchanged; gain `runGrant: { serviceId, approvedAt, modelAccess } \| null` and `runState: "no_grant" \| "grant_stale" \| "ready" \| "running" \| "disabled"` | unchanged | unchanged |
| `connector.userMcpTools` / `userMcpCall` | unchanged; accept `ext_` ids | forbidden (unchanged) | absent (unchanged) |

CLI: `nimbus extension approve <id> [--model]`, `nimbus extension revoke <id>`,
`nimbus extension rehash <id>`. `nimbus doctor` gains one line counting installed extensions with
no grant or a stale grant, so an upgrade that leaves extensions unapproved is visible rather than
silent.

## 8. Test plan

| Layer | Proves |
| --- | --- |
| Unit: service-id derivation | slug rule; prefix-collision refusal in both directions; no first-party id starts with `ext_` |
| Unit: runtime manifest | protected-root refusal; self-write refusal; install path and runtime read paths added; symlink refusal |
| Unit: tree digest | order-independent over directory listing; detects a changed sibling file, an added file and a removed file |
| Unit: approve flow | refusals happen before the gate; `proceed` stores exactly the consent payload; `deny` stores nothing |
| `security-invariants.test.ts` I43 block | spawn refuses with no grant, a stale digest, a changed permission set, or a failed I16; `extension.run` is in the frozen set; `extension.install` is now actually gated (fails today, by design) |
| `security-invariants.test.ts` I42 block | `ext_` action types require HITL; a delegate is refused; dispatcher key/type mismatch is refused; share replay refuses an `ext_` tool |
| Static D32 | fixture files violating (a) and (b) are caught; the three allow-listed files pass |
| Integration, per platform (`test/integration/extensions/`) | a fixture MCP extension installed, approved, listed and called through a **real** sandbox; then a sibling file is modified on disk and the next spawn refuses; a declared read of `<dataDir>` refuses before consent; a read of an undeclared path fails at the OS |
| Integration: the hook | `extension.disable` and a failed startup verify actually terminate the running child, which pins gap 3.4 |
| Rust allowlist test | `extension.enable` stays on the allowlist, with a comment pointing at I43 (enable cannot create a grant) |
| E2E | `nimbus extension install` then `approve` then `nimbus connector call ext_… <tool>` against a real gateway subprocess over a real socket, so both dispatcher layers route the new methods (the `nimbus explain last` lesson in `CLAUDE.md`) |
| Released-install smoke | the compiled binary runs the `__nimbus-extension` role and `import()`s an on-disk entry. This is the one fact no dev-tree test can establish (see R1) |

## 9. Risks and open questions

- **R1: `import()` of an external file from a compiled binary.** The design assumes a
  `bun build --compile` executable can `import()` an absolute on-disk path at runtime, and that the
  imported module can resolve its own relative imports and its own `node_modules`. The
  first-party connectors never exercise this, because they are bundled. Prove it on all three OSes
  **before** writing the rest. If it fails, the fallback is to require a single-file bundled entry
  (the scaffold already compiles), which narrows what authors can ship but changes nothing else in
  this design.
- **R2: Windows dev-tree spawn.** In a dev tree the role launches as `bun <gateway>/src/index.ts
  __nimbus-extension …`, which is a file entry point. The connector role has the same dev-tree
  shape and works under the sandbox in CI, so this is expected to hold. The per-platform
  integration test is what confirms it.
- **R3: Tree-digest cost.** Hashing an extension with a large `node_modules` on every spawn could
  be slow, especially on the 13–18×-slower CI runners. Spawns are lazy and rare (on first use after
  idle disconnect), so this is acceptable. If measurement says otherwise, cap the tree size at
  install (`ERR_EXTENSION_TOO_LARGE`) rather than cache the digest. Caching would reintroduce the
  trust-an-earlier-pass shape that I40 forbids.
- **Q1 (owner decision): reuse `user_mcp_model_access` or add an eighth lockoff name?** This design
  reuses it (4.7). A separate name would let an org allow one and lock the other. That is easy to
  add later, and adding it then only narrows, so starting with the shared name is the conservative
  choice.
- **Q2 (owner decision): `ext_` or one shared namespace with `mcp_`?** Separate prefixes keep
  `nimbus connector list` honest about where a server came from, and keep the two registries'
  collision rules independent. This design proposes `ext_`.

## 10. Delivery

Four PRs. Each is green on its own, and the user-visible capability lands only in PR 3.

1. **Gate install + tree digest (closes 3.1, 3.2).** Route `extension.install` through the
   executor, add V66 `extension.tree_digest` and symlink refusal, and add `nimbus extension
   rehash`. No runtime yet. Includes the R1 spike's findings, so the launch shape is settled before
   anything depends on it.
2. **Runtime manifest + grant store (closes 3.3).** Add the V66 `extension_run_grant` table, the
   service-id derivation, the runtime-manifest builder, and `approveRun` / `revokeRun` behind
   `extension.run`. Grants can be created, but nothing spawns.
3. **The runtime (closes 3.4).** Add the self-role, the `mesh:ext:` slot,
   `readVerifiedExtensionForSpawn`, the re-pointed stop hook, the I42 widening, I43, D32, the
   per-platform integration test and the E2E test. This is the PR that changes the
   `cli-reference.md` sentence "Installed extensions are not executed".
4. **Model access + docs close-out.** Add `--model`, the lockoff extension, the `nimbus doctor`
   line, and updates to `docs/architecture.md`, `docs/sandbox.md`, `docs/README.md` (both "not
   executed yet" sentences), `docs/ecosystem-roadmap.md` § Track 0, and the `docs/roadmap.md`
   Phase 9.5 checkbox. Add `CHANGELOG.md` entries and mirror `CLAUDE.md` / `GEMINI.md`.

None of these is a breaking change in the `CLAUDE.md` sense. An existing user has nothing to
change: installed extensions did not run before and do not run until approved. So none of the four
PR titles carries a `!`.

## 11. Amendments for PR 2 (2026-10-16, owner-approved)

PR 1 and the capture sink shipped between this spec and PR 2, and five details drifted. These
override the sections above wherever they disagree.

1. **Schema.** V66 went to `extension.tree_digest` and V67–V69 to the capture sink, so the grant
   table is **V70** `extension_run_grant`.
2. **Static rule.** D32 is the capture sink's (D32(a)–(g)). The extension rule is **D33**. Its
   table half, **D33(b)**, ships in PR 2 with the table; **D33(a)** (the self-role sentinel) ships
   in PR 3 with the role. D33(b) allows exactly `extensions/run-grant-store.ts` and
   `index/extension-run-grant-v70-sql.ts`; `extensions/extension-runtime.ts` joins in PR 3 only if
   it needs to, which it should not (it goes through the store).
3. **Protected roots.** There is no `userMcpProtectedRoots()` free function: the roots come from
   `LazyConnectorMesh.userMcpProtectedRoots()` (`[dataDir, configDir, sandboxDir]`), and the overlap
   check is private to `connectors/user-mcp-registration.ts`. PR 2 EXTRACTS that check into a
   shared helper rather than copying it. The check is two-way — a declared path that CONTAINS a
   protected root is refused too.
4. **I43** is still free and lands in PR 3 with the spawn path. PR 2 spawns nothing.
5. **Grant invalidation.** PR 1 recomputes `tree_digest` after an approved auto-update swap, so an
   update makes the grant stale (`grant_stale`), and the owner re-approves the new code. Intended.

Three corrections found while planning PR 2:

<!-- markdownlint-disable MD029 -->

6. **The FK cascade is not relied on.** (Corrected during Task 3: an earlier version of this item
   said the gateway's connection never enables foreign keys; `index/local-index.ts` does set
   `PRAGMA foreign_keys = ON`, so on the gateway's own connection the cascade DOES fire.)
   `deleteExtensionById` still deletes the grant explicitly, through the grant store, because the
   cascade only fires on a connection that enabled foreign keys and a caller holding a different
   connection may not have. The DDL keeps `ON DELETE CASCADE`.
7. **`permissions_json` stores the DECLARED grants as resolved, not the full runtime manifest.**
   § 4.4 compares "the live runtime manifest" to the stored one at spawn, but the runtime manifest
   includes the Bun runtime's read paths, which are machine-derived (`process.execPath`) and change
   on every Bun or gateway upgrade — every grant would go stale on upgrade. Same lesson as I40,
   which drops machine-derived read paths from what it signs. So the grant stores
   `{ network, read, write }` after resolution (§ 4.5's checks), and the runtime manifest adds the
   install path and the runtime read paths fresh at every spawn. The consent prompt still SHOWS
   those additions.
8. **Declared reads inside the extension's own install path are dropped, not refused.** The runtime
   grants the install path anyway, and on macOS/Linux the extensions directory sits under the
   protected data dir, so the protected-root check would otherwise refuse a harmless manifest.
   A declared WRITE that overlaps the install path in either direction (inside it, or a parent of
   it) is `ERR_EXTENSION_GRANT_SELF_WRITE`.

<!-- markdownlint-enable MD029 -->

PR 2 surface decisions:

- `nimbus extension approve <id>` requires a TTY and has **no `--yes`**: a run grant consents to
  unattended execution of third-party code, the same reason `nimbus captures accept` requires one.
  `revoke` needs no confirmation (it only narrows).
- `extension.revokeRun` is not gated (narrowing), and stops the extension's mesh client
  best-effort.
- `runState` in PR 2 is `"disabled" | "no_grant" | "grant_stale" | "ready"`. `"running"` joins in
  PR 3 with the runtime. `grant_stale` here compares the row to the grant (version, tree digest);
  PR 3 adds the live re-verification.
- `--model` and `modelAccess = true` wait for PR 4; PR 2 always stores `model_access = 0`.
- PR 2 ships the grant RESOLUTION (§ 4.5's checks, `resolveExtensionRunGrants`). The final
  sandbox-manifest ASSEMBLY (`ext.<serviceId>` id plus install path plus runtime read paths, handed
  to `wrapServerSpec`) moves to PR 3, next to its only consumer, so its shape is written against
  `wrapServerSpec`'s real input type rather than guessed.

Plan review (2026-10-16) — decisions recorded here so they are not re-litigated:

- **Consent payload field is `fingerprint`**, never `keyFingerprint`: both the consent display and
  the audit row redact any field whose name contains "key". Same name the install prompt uses.
- **The grants are re-resolved after approval**, not only the tree digest: a declared path outside
  the install tree (or a symlink on it) can be retargeted while the prompt is open.
- **A signature-failed extension is refused** even if `extension.enable` flipped it back on
  (`signatureDisabledRegistry`). The full I16 re-verification stays PR 3's, at spawn.
- **`extension.approveRun` / `revokeRun` emit `extension.stateChanged`** (`approveRun` /
  `revokeRun` actions), since `list`/`info` now carry `runState`.
- **`nimbus extension approve` registers the prompt handler directly**, so
  `NIMBUS_SCRIPT_CONSENT_SOURCE` cannot answer it.
- **Deferred, out of scope:** `extension.enable` re-enables an extension the startup signature pass
  hard-disabled without re-verifying it. Pre-existing, affects install-time state beyond run grants,
  and PR 2 now refuses such a row for a grant. Recorded in the CHANGELOG "Found, not fixed" line.
- **Not added to the demo gate:** `extension.rehash`. A demo gateway refuses `extension.install`, so
  it holds no extensions for rehash to act on; § 4.8 names only `approveRun` / `revokeRun`.

## 12. Amendments for PR 3 (2026-10-17, owner-approved scope)

Code review of `main` at `200cd105` found these drifts; they override the sections above.

1. **Static rule is D33(a)**, as § 11 item 2 says. It allows the `__nimbus-extension` literal in
   `platform/runtime-layout.ts` only, and `selfSpawn("extension"` in `extensions/extension-runtime.ts`
   only. `index.ts` dispatches through `ROLE_SENTINELS.extension`, never the literal, so it is not
   on the allow-list. The table half (D33(b)) does NOT gain `extension-runtime.ts`: the runtime
   reads grants through `run-grant-store.ts`.
2. **The stop hook keys on a live map, not on the grant.** The mesh records
   `extensionId → serviceId` when it creates a `mesh:ext:` client, and `stopExtensionClient(extensionId)`
   stops through that map. A grant read would miss after `revokeRun` / `remove` deleted it.
3. **`extension.remove` gains the stop call it never had** (it called no stop hook at all), then
   clears the `ext.<serviceId>` sandbox leaf.
4. **Extension tools stay OUT of the merged tool map in PR 3.** They are reachable only through the
   per-server path (`connector.userMcpTools` / `userMcpCall` and the dispatcher's single-slot
   `toolsFor`), so nothing offers them to the engine agent before PR 4's `--model`.
5. **Org allowlist.** The mesh's `dropDisallowedConnectorTools` ignores ids outside
   `CONNECTOR_SERVICE_IDS`, so § 4.7's "applies at the existing filter" is false. The extension
   slot source checks `isConnectorAllowed(serviceId)` itself and refuses with
   `ERR_EXTENSION_RUN_POLICY`.
6. **Spawn-refusal health.** The user-MCP path marks health only on a malformed row. The extension
   slot marks `persistent_error` on every pre-spawn refusal, with the error code as the message.
7. **The kill switch `[extensions] runtime` (default `true`) ships in PR 3**, parsed with
   `parseBool` so a malformed value cannot flip it. Off ⇒ no slot source is wired and `approveRun`
   refuses `ERR_EXTENSION_RUNTIME_DISABLED`. A demo-rooted gateway wires no slot source either.
8. **Unsigned extensions run** (the owner approved `unsigned` in the consent payload). A manifest
   that names a `publisher` must verify (I16) at every spawn; a missing publisher key refuses.
