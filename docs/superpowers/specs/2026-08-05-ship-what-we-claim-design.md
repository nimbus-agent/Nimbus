# What We Ship Is What We Claim — Design

**Date:** 2026-08-05
**Status:** Approved, ready for planning
**Cluster:** Ecosystem roadmap cluster 1 (`docs/ecosystem-roadmap.md` § The eleven clusters)
**Branch:** `dev/asaf/ship-what-we-claim`

## Goal

A person who installs a released Nimbus binary gets a gateway that can sync connectors, load
semantic memory, serve its own admin console and serve its OpenAPI document — and every remaining
sentence of user-facing documentation describes something that exists.

## The defect

Four runtime paths are derived from the **source tree layout** by walking up from
`import.meta.dir`. In a `bun build --compile` binary that directory is the read-only bunfs root, so
every one of them resolves to a path that does not exist. Two further assets are never produced by
the release pipeline at all. The first four rows below are the same defect; the fifth is a
packaging gap.

| Site | Derivation today | Consequence in a released binary |
|---|---|---|
| `connectors/lazy-mesh/keys.ts:6-10` | `<gateway-src>/../../../../mcp-connectors/<pkg>/src/server.ts`, spawned as `command: "bun"` at ~90 call sites | **No connector can sync.** Requires both `bun` on `PATH` and a source tree that is not shipped |
| `connectors/lazy-mesh/wrap-server-spec.ts:7-24` | `process.execPath` + `<gateway-src>/platform/sandbox/sandbox-wrapper.ts` | `process.execPath` is the gateway binary and `index.ts` `main()` ignores `argv`, so a spawn attempt boots a **nested gateway** instead of failing |
| `ipc/admin-console-assets.ts:35` | `<gateway-src>/../../admin-console/dist` | `nimbus admin console` prints a URL that returns HTTP 503 |
| `ipc/http-server.ts:190` | `<gateway-src>/../../openapi/v1.yaml` | the OpenAPI document is unreachable |
| `packages/admin-console` + `vec0` sidecar | not built or copied by `release.yml` at all | the console has no build output to embed, and semantic memory is silently disabled |

CI has never observed any of this because `install-smoke.yml` runs the quickstart **inside the repo
checkout**, where the source tree is present and `bun` is on `PATH`.

### Verification performed

Every mechanic below was measured on Windows with a real compiled binary before this design was
written, not inferred from documentation.

- `import.meta.dir` in a compiled binary is `B:\~BUN\root` (POSIX: `/$bunfs/root`). Walking up from
  it yields paths that do not exist — this is the direct cause of all five rows above.
- `process.argv` in a compiled binary is `["bun", "<bunfs>/<name>", ...userArgs]`. **`argv.slice(2)`
  is therefore identical in compiled and dev mode**, so a single sentinel dispatch serves both with
  no branching.
- Assets imported with `{ type: "file" }` are embedded and readable through **`node:fs`**
  (`existsSync` and `readFileSync` both succeed), so the existing asset readers keep their shape.
  Embedded files land in a flat bunfs root under **content-hashed names**, so there is no directory
  to join a relative path against.
- Re-executing `process.execPath` with a sentinel argument works: the child received
  `argv.slice(2) === ["__child", "alpha", "beta"]`.
- A binary compiled from a gateway-rooted entry that bundles five connector `server.ts` modules
  builds cleanly (243 modules) and answers a real MCP `initialize` and `tools/list` over stdio,
  returning `serverInfo.name === "nimbus-github"` and the full tool list.

## Approach

**One binary, three roles.** The gateway binary gains an argv sentinel dispatch and carries the
connector servers in its own build graph. The child is still a separate process speaking MCP over
stdio, so non-negotiable #4 (MCP as connector standard) is preserved. The release keeps making the
promise it already makes in `docs/README.md`: one signed artifact per platform.

Rejected alternatives, recorded so they are re-decided rather than re-discovered:

- **A real install layout** — ship `connectors/nimbus-mcp-*` binaries beside the gateway. Keeps
  connectors uncoupled and independently versioned, but costs ~26 extra signed binaries per platform
  per release. Signing and notarization procurement is already the gating constraint on clusters 6
  and 8.
- **Ship `bun` plus the source tree** — contradicts the single-signed-binary claim in
  `docs/README.md:620`, and user-editable connector source destroys the integrity story that I16
  exists to protect.

## Components

### 1. `platform/runtime-layout.ts` (new)

The only module permitted to distinguish the two runtime shapes.

- `isCompiledBinary(): boolean` — detects the bunfs root.
- `selfSpawn(role, args): {command: string; args: string[]}` — compiled: `[execPath, sentinel,
  ...args]`; dev: `[execPath /* bun */, <gateway>/src/index.ts, sentinel, ...args]`. The child sees
  the same `argv.slice(2)` either way.
- `embeddedAsset(name): string` — the name→path map for baked assets.

A `scripts/structure-audit` rule confines runtime path derivation from `import.meta.dir` to this
module, allowlisting `perf/surfaces/*` (dev-only by construction) and test files.

### 2. Sentinel dispatch in `gateway/src/index.ts`

Dispatch on `process.argv[2]` **before** `createPlatformServices()`:

| `argv[2]` | Role |
|---|---|
| `__nimbus-sandbox` | today's `sandbox-wrapper.ts` `main()`, extracted to a function |
| `__nimbus-connector <id>` | `await BUNDLED_CONNECTORS[id]()`; the connector's `server.ts` self-starts on import |
| anything else | the gateway |

An unknown id exits non-zero with a message naming the known ids — never a silent fall-through to
the gateway role, which is the failure mode this design exists to remove.

**Enforcement test:** neither sentinel role may touch the vault, the database or the IPC socket. The
roles create no new privilege — anyone able to exec the binary could already exec anything — but
they must not become a second way into gateway state.

### 3. `connectors/bundled-connector-registry.ts` (new)

`Record<string, () => Promise<unknown>>` mapping connector id to a dynamic import of its
`server.ts`. Lazy, so only the requested connector evaluates; statically enumerated, so the bundler
retains them all.

A drift test derives the expected key set from the connector packages that `connector-spawns.ts`
and `chatops-bot-spawn.ts` actually reference, rather than hand-listing it. Hand-listed connector
membership tables in this repo have drifted three times.

### 4. Spawn-site migration

`mcpConnectorServerScript(pkg)` is replaced by `connectorSpawn(pkg)`, returning
`selfSpawn("connector", [pkg])`. `wrapServerSpec` builds its command through
`selfSpawn("sandbox", [spec.command, ...spec.args])`. Roughly 90 mechanical call sites across
`connector-spawns.ts` and `chatops-bot-spawn.ts`.

**I15 and the sandbox chain are unchanged.** Only the contents of `command` and `args` change; the
requirement that every `ServerSpec` passes through `wrapServerSpec()` — and the static rule D10 that
enforces it — is untouched.

### 5. Embedded assets

`ipc/embedded-assets.ts` holds four `{ type: "file" }` imports: `openapi/v1.yaml` and the console's
`index.html`, `main.js` and `styles.css` (the console's entire build output is those three files).

`resolveConsoleDist(baseDir)` becomes `resolveConsoleAsset(rel)`, because embedded files carry
content-hashed names in a flat root and there is no dist directory to join against. In compiled mode
this resolves against a three-entry map, so path traversal is structurally impossible rather than
rejected by `safeAssetPath`; `safeAssetPath` remains for the dev path. `http-server.ts` reads the
OpenAPI document through the same map.

Embedding makes the console build a prerequisite of the gateway compile. It is wired into
`compile-gateway.ts`, `release.yml` and `scripts/lib/preflight-gates.ts` — the manifest whose drift
test fails when a CI gate is missing. `tsc` is unaffected: the file imports are declared, so
typecheck passes without `dist/` present, and only the compile step requires it.

### 6. vec0 sidecar in the release

No code change. `tryLoadFromSidecar()` already resolves `dirname(process.execPath)`
(`index/sqlite-vec-load.ts:66`). The copy logic moves out of `compile-gateway.ts` into
`scripts/copy-vec0-sidecar.ts`, called by both that script and each `release.yml` matrix leg, and
the sidecar ships in every archive and installer. The current failure is `log.debug` level — silent
semantic-memory loss — so the smoke test asserts its presence positively.

### 7. `install-smoke.yml` outside the checkout

The smoke copies the binaries and the sidecar to a temp directory **outside the repo** and runs the
quickstart there, with the sandboxed `HOME` / `LOCALAPPDATA` the workflow already sets up. Four new
assertions, none of which touches a cloud API:

1. `GET /admin` returns 200 with known console content.
2. The OpenAPI route returns 200.
3. `nimbus-gateway __nimbus-connector github` with a dummy token answers `initialize` and
   `tools/list` over stdio.
4. sqlite-vec is loaded rather than silently absent.

### 8. Documentation

Delete user-facing claims for capability that stays dark after this cluster — extension spawn, the
Tauri desktop binary, OS notifications, voice. Each retracted claim becomes a roadmap row; Track 0
of `docs/ecosystem-roadmap.md` already inventories all four, so the claim keeps exactly one home.
Status badges are not used: a reader who skims a badge believes the feature exists.

Add the contributor documentation to the status-drift scanner's scanned set so it cannot rot again.

## Testing

- **Unit** — `runtime-layout` across both runtime shapes; the registry drift test; the
  sentinel-roles-touch-no-gateway-state enforcement test; embedded-asset map completeness;
  `resolveConsoleAsset` traversal rejection in dev mode.
- **Integration** — a CI job that compiles the gateway and drives one bundled connector through
  `initialize` + `tools/list`, which is the probe already proven to work.
- **E2E** — the relocated `install-smoke.yml` with its four assertions.

Coverage gates in force are unchanged; new files under `packages/gateway` are subject to the
per-file floor (≥85% line, ≥80% branch), which is Linux-authoritative.

## Delivery

Three stacked PRs:

1. `runtime-layout` + sentinel dispatch + bundled connector registry + the ~90-site spawn migration.
2. Embedded assets + console build wiring + the vec0 release step.
3. Smoke relocation and assertions + the documentation pass + the status-drift scanner extension.

## Risks, to be measured rather than assumed

- **Binary size** after bundling roughly 40 connectors. Report before and after; the 243-module
  five-connector probe suggests the TypeScript is small relative to the embedded runtime, but the
  full set is unmeasured.
- **`release.yml` per-matrix compile** surviving the enlarged build graph, including the Windows leg
  with its line continuations.
- **Any connector that reads a file relative to its own source at import time** — such a connector
  would fail in exactly the way this design fixes elsewhere.

## Explicitly out of scope

Extension execution, the Tauri desktop binary, OS notifications and the voice subsystem stay dark.
Their documentation is retracted here; their code waits for later clusters.
