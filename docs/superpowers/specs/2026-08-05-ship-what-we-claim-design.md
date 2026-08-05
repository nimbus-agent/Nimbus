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
- A binary compiled from a gateway-rooted entry bundling **all 94** connector `server.ts` modules
  builds cleanly (676 modules, 0.44 s) and answers a real MCP `initialize` and `tools/list` over
  stdio, returning `serverInfo.name === "nimbus-github"` and the full tool list. Booting every
  connector in it found the ten-connector `import.meta.main` defect recorded in component 3.

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
| `__nimbus-connector <id>` | `await BUNDLED_CONNECTORS[id]()`; the connector's `server.ts` starts on import |
| anything else | the gateway |

An unknown id exits non-zero with a message naming the known ids — never a silent fall-through to
the gateway role, which is the failure mode this design exists to remove.

`index.ts` is a **thin shim**: it reads `argv[2]` and then **dynamically** imports exactly one of
three role modules (`gateway-main.ts`, the sandbox wrapper, the connector registry). Its current
static imports of the whole gateway graph move into `gateway-main.ts`. This is load-bearing, not
tidiness: dispatching inside today's `index.ts` would prevent the `createPlatformServices()` *call*
but not module *evaluation*, and that graph has import-time side effects —
`connectors/registry.ts:8`, `engine/run-ask.ts:21` and `index/sqlite-vec-load.ts:7` construct pino
loggers at module scope, and `Config` freezes every `NIMBUS_*` variable at first import.

**Enforcement test:** a module-graph assertion that the connector role's transitive imports exclude
`db/`, `vault/` and `ipc/`. The roles create no new privilege — anyone able to exec the binary could
already exec anything — but they must not become a second way into gateway state, and a structural
claim is checked structurally rather than with a runtime tripwire.

### 3. `connectors/bundled-connector-registry.ts` (new)

`Record<string, () => Promise<unknown>>` mapping connector id to a dynamic import of its
`server.ts`. Lazy, so only the requested connector evaluates; statically enumerated, so the bundler
retains them all. All **94** connector packages with a `src/server.ts` are members.

A drift test derives the expected key set from the connector packages that `connector-spawns.ts`
and `chatops-bot-spawn.ts` actually reference, rather than hand-listing it. Hand-listed connector
membership tables in this repo have drifted three times.

**The connector entry contract becomes explicit.** Ten connectors (`argocd`, `bigeye`, `flux`,
`looker`, `mlflow`, `monte-carlo`, `powerbi`, `snowflake`, `tableau`, `workday`) end with
`if (import.meta.main) { await runReadOnlyMcpConnector(...) }`. That guard is true under
`bun server.ts` and **false under a registry import**: measured, all ten load, start nothing and
exit 0 in silence while answering normally in dev mode.

The guard cannot simply be deleted — it is load-bearing. Those ten are the only entrypoints a test
can import, and their tests do import them for the register function
(`snowflake/test/server-list-pagination.test.ts:3`, `argocd/test/server-writes.test.ts:3`); removing
the guard would connect a real `StdioServerTransport` to the test runner's stdin/stdout. So each of
the ten gains `export async function startConnector(): Promise<void>` wrapping its existing
bootstrap and keeps the guard as `if (import.meta.main) await startConnector();`. The registry
awaits the import and then calls `startConnector` when the module exports it; the other 84 start on
import as they do today.

A static audit enforces the rule that closes the drift: **a connector `server.ts` containing
`import.meta.main` must export `startConnector`.** Everything else is covered by the boot smoke.
Normalising all 94 onto an exported entry was considered and rejected — a 94-file change across two
distinct tail shapes (50 helper-bootstrap, 34 explicit-connect) for a guarantee the boot smoke
already gives.

A second audit asserts connector `dependencies` stay within an allowlist. The union across all 94 is
`@modelcontextprotocol/sdk`, `@nimbus-dev/sdk` and `zod`, plus `hyparquet`, `imapflow`, `nodemailer`
and `tsdav` — all pure JavaScript, so nothing is broken today. A future connector adding a native
dependency would break the compiled gateway silently, visible only as a failed sync on a user's
machine.

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
No build-time codegen is involved: such an import **evaluates to the content-hashed bunfs path at
runtime** and the bundler substitutes the value, so the map is four literal import statements and no
generator.

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

### 7. `install-smoke.yml` assertion coverage

The roadmap's "move install-smoke outside the repo checkout" is an inaccurate premise, and this
spec repeated it before checking. **Both legs already stage outside the checkout**: they copy the
binaries into `$RUNNER_TEMP/stage` (`install-smoke.yml:147` and `:454`) and run against a sandboxed
`HOME` / `LOCALAPPDATA`. The gap is coverage, not location — nothing asserted today exercises a
connector spawn, the console, the OpenAPI route or sqlite-vec, so the whole class is invisible.

The sidecar joins the staged directory, and four assertions are added, none of which touches a cloud
API:

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

- **Unit** — `runtime-layout` across both runtime shapes; the registry drift test; the connector-role
  module-graph assertion; embedded-asset map completeness; `resolveConsoleAsset` traversal rejection
  in dev mode.
- **Static** — `import.meta.main` forbidden in connector entrypoints; the connector dependency
  allowlist; the `import.meta.dir` confinement rule.
- **Integration — the all-connector boot smoke, a required gate.** Every registry entry is spawned
  from the compiled binary with no credentials and fed one `initialize`. Each must either answer with
  a valid `serverInfo` or exit non-zero naming a missing environment variable. **Silence and hangs
  fail.** This is not optional coverage: run once during design it found ten connectors that load,
  start nothing and exit 0.
- **E2E** — `install-smoke.yml` with its four new assertions.

Coverage gates in force are unchanged; new files under `packages/gateway` are subject to the
per-file floor (≥85% line, ≥80% branch), which is Linux-authoritative.

## Delivery

Three stacked PRs:

1. The thin `index.ts` shim + `runtime-layout` + the bundled connector registry + the ten connector
   entry conversions + the two static audits + the boot smoke + the ~90-site spawn migration.
2. Embedded assets + console build wiring + the vec0 release step.
3. `install-smoke.yml` assertions + the documentation pass + the status-drift scanner extension.

PR 1 is larger than the original three-way split implied. The addition is what stops ten connectors
from shipping silently dead.

## Measurements

Taken on Windows against this tree, and recorded so they are not re-derived.

| Quantity | Value |
|---|---|
| Connector packages with a `src/server.ts` | 94 |
| Bun runtime baseline binary (trivial entry) | 93.9 MB |
| Binary with all 94 connectors bundled | 97.7 MB (**+4.0%**) |
| Bundle of all 94 | 676 modules, 0.44 s |
| Connectors answering `initialize` with no credentials | 79 of 94 |

No CI size-budget gate is built. It would guard a 4% delta while adding a per-platform baseline to
maintain, and this repository's ratcheted baselines have produced false greens before. Revisit if
the number moves materially.

## Risks, to be measured rather than assumed

- **`release.yml` per-matrix compile** surviving the enlarged build graph, including the Windows leg
  with its line continuations.
- **Any connector that reads a file relative to its own source at import time** — such a connector
  would fail in exactly the way this design fixes elsewhere. The boot smoke is the detector.

## Known limitations

`install-smoke.yml` runs as the runner's default user, which is an administrator on the hosted
Windows and macOS images. Running it as a freshly created standard user would mean creating the
account, initialising its profile and getting DPAPI or the login keychain to work under it — a new
flake class in the workflow's most delicate area, for near-zero signal given the Windows installer is
already per-user and the smoke already sandboxes `HOME` and `LOCALAPPDATA`.

## Explicitly out of scope

Extension execution, the Tauri desktop binary, OS notifications and the voice subsystem stay dark.
Their documentation is retracted here; their code waits for later clusters.
