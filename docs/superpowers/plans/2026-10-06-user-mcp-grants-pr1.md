# User MCP Servers That Actually Run — PR 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every sandboxed connector its own working directory outside the Nimbus data/config folders, let `nimbus connector add --mcp` register a user MCP server with owner-approved read/network grants, make its tools callable by the owner from the CLI behind a mandatory approval (invariant I42), and make `nimbus scaffold mcp` emit a real, tested, compilable MCP server.

**Architecture:** `PlatformPaths` gains `sandboxDir`; `wrapServerSpec` derives a per-policy leaf under it and the sandbox wrapper creates it before spawning. User-MCP registration is resolved and validated in a pure module BEFORE the HITL prompt, stored in three new V65 columns, and turned into the spawn manifest. Two new CLI-only IPC methods list and call one user server's tools through a dispatching `ToolExecutor`, whose gate now requires HITL for any `mcp_*` service (I42). The scaffold template is a compiled single-file MCP server, proven end to end by a gateway E2E test.

**Tech Stack:** Bun 1.3 / TypeScript strict, `bun:sqlite`, `@modelcontextprotocol/sdk` 1.32.0, `@mastra/mcp`, the PAL `SandboxRunner` (bwrap / SBPL / AppContainer helper).

**Spec:** `docs/superpowers/specs/2026-10-06-user-mcp-grants-design.md` (§ A–E; § F is PR 2).

## Global Constraints

- No `any`; external data is `unknown` and narrowed (Non-Negotiable 7).
- Every SQLite write goes through `dbRun`/`dbExec`/`dbStmtRun` (I14 / D12).
- Every lazy-mesh spawn still goes through `wrapServerSpec` (I15 / D10).
- `sandboxDir` per OS, verbatim: Windows `join(LOCALAPPDATA, "Nimbus", "sandbox")`; macOS `join(homedir(), "Library", "Caches", "Nimbus", "sandbox")`; Linux `join(XDG_CACHE_HOME ?? join(home, ".cache"), "nimbus", "sandbox")`; demo `join(<demoRoot>, "sandbox")`.
- Leaf name: `policyId.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "_")`.
- Schema V65 columns, verbatim: `read_paths_json TEXT NOT NULL DEFAULT '[]'`, `net_hosts_json TEXT NOT NULL DEFAULT '[]'`, `model_access INTEGER NOT NULL DEFAULT 0`.
- User-MCP manifest id stays `user.<service_id>` (changing it would orphan the AppContainer profile).
- Windows migration marker file name: `sandbox-cwd-migration-v1.done`, in `paths.dataDir`.
- New IPC methods `connector.userMcpTools`, `connector.userMcpCall`: LAN-forbidden, NOT on the Tauri allowlist (stays 107).
- Scaffold SDK pin `1.32.0` must equal `packages/cli/package.json`'s `@modelcontextprotocol/sdk`.
- Test data only in `mkdtempSync(join(tmpdir(), ...))` dirs — never `%LOCALAPPDATA%\Nimbus`, `%APPDATA%\Nimbus`, `~/.local/share/nimbus`, `~/Library/...`.
- Run `bun run preflight:fast` before the final commit of every task; `bun run typecheck` must be clean.
- A fresh worktree needs the Windows sandbox helper built for sandbox tests (see the `nimbus-preflight` skill); 9-10 toolgen/exec tests fail with `ERR_*_SANDBOX_DEGRADED` without it — that is the harness, not your change.

## Review Focus

1. **A path with a space** (`C:\Users\Jane Doe\srv\dist\x.exe`) — registration must keep it as ONE argv token end to end (CLI → IPC `argv` → row → spawn). Test owned by Task 7 (CLI) and Task 6 (handler stores `argv` verbatim).
2. **A binary or `--read` path inside the data or config folder** — refused before any prompt, including when the auto-added command directory is the offender. Task 5.
3. **The legacy positional form** `nimbus connector add --mcp mcp_x bun srv.ts` (no `--`) keeps working. Task 7.
4. **An existing install upgrading** with user-MCP rows from before V65 — defaults to deny-all, still spawns, now with a leaf cwd. Task 4 (migration test on a pre-V65 row).
5. **Removing a user MCP while its process runs** — on Windows the leaf is locked; the remove must still succeed and log. Task 6.

---

### Task 1: `PlatformPaths.sandboxDir`

**Files:**
- Modify: `packages/gateway/src/platform/paths.ts` (interface + the three resolvers)
- Modify: `packages/gateway/src/platform/demo-root.ts` (`deriveDemoPaths`)
- Modify: `packages/cli/src/paths.ts` (`CliPlatformPaths` + `realCliPlatformPaths`)
- Modify: `packages/cli/src/lib/demo-root.ts` (`deriveDemoPaths`)
- Create: `packages/gateway/src/platform/sandbox-dir-placement.test.ts`
- Modify: every test/fixture that builds a `PlatformPaths`/`CliPlatformPaths` literal (find them with `bun run typecheck` and `bun run typecheck:tests`; today ~49 files contain `tempDir:`)

**Interfaces:**
- Produces: `PlatformPaths.sandboxDir: string` and `CliPlatformPaths.sandboxDir: string` (REQUIRED, not optional — a `?` with a fallback would silently put the root somewhere unreviewed).

- [ ] **Step 1: Write the failing placement test** — `sandbox-dir-placement.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join, relative, isAbsolute } from "node:path";

import { deriveDemoPaths } from "./demo-root.ts";
import type { PlatformPaths } from "./paths.ts";

/** true when `child` is `parent` or lies inside it. */
function isSameOrInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function assertPlacement(p: PlatformPaths): void {
  for (const other of [p.dataDir, p.configDir]) {
    expect(isSameOrInside(p.sandboxDir, other)).toBe(false);
    expect(isSameOrInside(other, p.sandboxDir)).toBe(false);
  }
}

const root = join("/", "home", "u");
const realLinux: PlatformPaths = {
  configDir: join(root, ".config", "nimbus"),
  dataDir: join(root, ".local", "share", "nimbus"),
  logDir: join(root, ".local", "share", "nimbus", "logs"),
  socketPath: join("/", "run", "user", "1", "nimbus-gateway.sock"),
  extensionsDir: join(root, ".local", "share", "nimbus", "extensions"),
  tempDir: join("/", "tmp", "nimbus"),
  sandboxDir: join(root, ".cache", "nimbus", "sandbox"),
};
const realDarwin: PlatformPaths = {
  ...realLinux,
  configDir: join(root, "Library", "Application Support", "Nimbus"),
  dataDir: join(root, "Library", "Application Support", "Nimbus"),
  sandboxDir: join(root, "Library", "Caches", "Nimbus", "sandbox"),
};

describe("sandboxDir placement", () => {
  test("linux layout keeps sandboxDir out of data/config", () => assertPlacement(realLinux));
  test("darwin layout keeps sandboxDir out of data/config (configDir === dataDir)", () =>
    assertPlacement(realDarwin));
  test("demo layout keeps sandboxDir inside the demo root and out of data/config", () => {
    const demo = deriveDemoPaths(realLinux);
    assertPlacement(demo);
    expect(isSameOrInside(demo.sandboxDir, join(realLinux.dataDir, "demo"))).toBe(true);
  });
});
```

Also add one test per real resolver in the existing paths test file (find it: `grep -rln "createLinuxPaths\|createWindowsPaths\|createDarwinPaths" packages/gateway/src --include=*.test.ts`), following that file's env-injection pattern, asserting `sandboxDir` equals the Global-Constraints value and passes `assertPlacement`. Windows: `LOCALAPPDATA=X` → `join(X, "Nimbus", "sandbox")`. Linux: with and without `XDG_CACHE_HOME`.

- [ ] **Step 2: Run it — expect a TYPE error / FAIL** (`sandboxDir` does not exist).

Run: `bun test packages/gateway/src/platform/sandbox-dir-placement.test.ts`

- [ ] **Step 3: Implement.**
  - `PlatformPaths` adds, with a doc comment: `/** Root of per-policy sandbox working directories (one leaf per policy id, created at spawn). Never equal to, inside, or an ancestor of dataDir/configDir — see docs/sandbox.md. */ sandboxDir: string;`
  - `createWindowsPaths`: `sandboxDir: join(localAppData, "Nimbus", "sandbox"),`
  - `createDarwinPaths`: `sandboxDir: join(homedir(), "Library", "Caches", "Nimbus", "sandbox"),`
  - `createLinuxPaths`: `const cacheRoot = processEnvGet("XDG_CACHE_HOME") ?? join(home, ".cache");` then `sandboxDir: join(cacheRoot, "nimbus", "sandbox"),`
  - gateway `deriveDemoPaths`: `sandboxDir: join(root, "sandbox"),`
  - CLI mirrors: identical values using `envGet`; CLI `deriveDemoPaths` identical line. (`scripts/parity/demo-root.parity.test.ts` compares both `deriveDemoPaths` with `toEqual`, so both MUST change.)
  - Update every fixture literal: add `sandboxDir: join(<that fixture's temp root>, "sandbox")` (or a sibling of its `tempDir`). Never point a fixture at a real user path.

- [ ] **Step 4: Run** `bun test packages/gateway/src/platform scripts/parity` then `bun run typecheck` and `bun run typecheck:tests` — expect PASS / clean (typecheck:tests is advisory on win32; also run it to find fixtures).

- [ ] **Step 5: Commit** — `git commit -m "feat(platform): add PlatformPaths.sandboxDir outside data and config"`

---

### Task 2: Per-policy sandbox working directory

**Files:**
- Create: `packages/gateway/src/platform/sandbox/sandbox-cwd.ts` + `sandbox-cwd.test.ts`
- Modify: `packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.ts` (+ its test)
- Modify: `packages/gateway/src/platform/sandbox/sandbox-wrapper.ts` (create the cwd before spawn)
- Modify: `packages/gateway/src/toolgen/toolgen-client.ts:50` (exact-cwd variant)
- Modify: `packages/gateway/src/connectors/lazy-mesh/mesh.ts:~95-114` (filesystem MCP third arg + `spawnContext.sandboxCwd`)
- Modify: `packages/gateway/src/platform/assemble.ts:1252, 2418, 2433, 2455, 2469, 2568` (`paths.dataDir` → `paths.sandboxDir` for every `sandboxCwd:`)
- Modify (doc comments only): `connectors/lazy-mesh/slot.ts:30`, `sync/types.ts:27`
- Modify: `packages/gateway/src/security-invariants.test.ts` (I15 block)

**Interfaces:**
- Consumes: `PlatformPaths.sandboxDir` (Task 1).
- Produces: `sandboxLeafName(policyId: string): string`, `sandboxCwdFor(sandboxRoot: string, policyId: string): string` (sandbox-cwd.ts); `wrapServerSpec(spec, manifest, sandboxRoot)` now sets `NIMBUS_SANDBOX_CWD = sandboxCwdFor(sandboxRoot, manifest.id)`; new `wrapServerSpecInCwd(spec, manifest, cwd)` keeps the old exact-cwd behaviour.

**Ruling recorded here:** the ~40 `sandboxCwd: string` fields/params keep their NAME; their value becomes the sandbox ROOT. Renaming them is churn across ~15 files with no behavioural gain; the doc comments on `MeshSpawnContext.sandboxCwd` and `SyncContext.sandboxCwd` state the new meaning, and the I15 test pins that no producer passes `paths.dataDir`.

- [ ] **Step 1: Failing tests** — `sandbox-cwd.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { BUNDLED_CONNECTORS } from "../../connectors/bundled-connector-registry.ts";
import {
  FIRST_PARTY_MANIFESTS,
  manifestForFirstParty,
} from "../../connectors/lazy-mesh/first-party-manifests.ts";
import { sandboxCwdFor, sandboxLeafName } from "./sandbox-cwd.ts";

describe("sandboxLeafName", () => {
  test("maps dots and other punctuation to underscores, lowercased", () => {
    expect(sandboxLeafName("com.nimbus.github-actions")).toBe("com_nimbus_github-actions");
    expect(sandboxLeafName("user.mcp_echo")).toBe("user_mcp_echo");
    expect(sandboxLeafName("A/B\\C:D")).toBe("a_b_c_d");
  });
  test("cannot produce a Windows reserved device name from a prefixed id", () => {
    expect(sandboxLeafName("com.nimbus.con")).toBe("com_nimbus_con");
  });
  test("every first-party and bundled-derived id gets a distinct leaf, none in the user.* space", () => {
    const ids = new Set<string>();
    for (const m of Object.values(FIRST_PARTY_MANIFESTS)) ids.add(m.id);
    for (const k of Object.keys(BUNDLED_CONNECTORS)) {
      ids.add(manifestForFirstParty(k).id);
      ids.add(manifestForFirstParty(k.replaceAll("-", "_")).id);
    }
    const leafOwner = new Map<string, string>();
    for (const id of ids) {
      const leaf = sandboxLeafName(id);
      const prior = leafOwner.get(leaf);
      if (prior !== undefined) expect(`${prior} vs ${id}`).toBe("distinct leaves");
      leafOwner.set(leaf, id);
      expect(leaf.startsWith("user_")).toBe(false);
    }
  });
});

describe("sandboxCwdFor", () => {
  test("joins the root and the leaf", () => {
    expect(sandboxCwdFor(join("r", "sb"), "user.mcp_x")).toBe(join("r", "sb", "user_mcp_x"));
  });
});
```

  NOTE for the distinctness test: `github_actions` (table) and `github-actions` (bundled key, falls back to `com.nimbus.github-actions`) are the SAME id (`com.nimbus.github-actions`) — a `Set` dedupes identical ids, so only genuinely different ids that collide fail. If the assertion finds a real collision, STOP and report it; do not weaken the test.

  In `wrap-server-spec.test.ts` change `"adds NIMBUS_SANDBOX_CWD env from the cwd argument"` to expect `sandboxCwdFor("/home/user/sbx", "com.nimbus.test")` for `wrapServerSpec(makeSpec(), makeManifest(), "/home/user/sbx")`, and the overlay test to expect `sandboxCwdFor(LEGIT_CWD, "com.nimbus.test")`. Add a `wrapServerSpecInCwd` test asserting the env equals the given cwd exactly.

- [ ] **Step 2: Run** `bun test packages/gateway/src/platform/sandbox/sandbox-cwd.test.ts packages/gateway/src/connectors/lazy-mesh/wrap-server-spec.test.ts` — expect FAIL.

- [ ] **Step 3: Implement.**

`sandbox-cwd.ts`:
```ts
import { join } from "node:path";

/**
 * The per-policy working-directory leaf. A fixed character class, so a real policy id can never
 * produce a Windows reserved device name (`CON`, `NUL`, ...), a trailing dot/space, or a path
 * separator; matches `mcpServerKeyForUserConnector`'s mapping for user MCPs.
 */
export function sandboxLeafName(policyId: string): string {
  return policyId.toLowerCase().replaceAll(/[^a-z0-9_-]/g, "_");
}

/** The working directory a sandboxed spawn of `policyId` runs in: `<sandboxRoot>/<leaf>`. */
export function sandboxCwdFor(sandboxRoot: string, policyId: string): string {
  return join(sandboxRoot, sandboxLeafName(policyId));
}
```

`wrap-server-spec.ts`: rename the third parameter to `sandboxRoot` and set `[SANDBOX_CWD_ENV]: sandboxCwdFor(sandboxRoot, manifest.id)`; extend the doc comment: the cwd is a per-policy leaf under a root that is never the data or config dir (spec § A), created by the sandbox wrapper before spawn. Add:

```ts
/**
 * `wrapServerSpec` with an EXACT working directory instead of a per-policy leaf. Only for a spawn
 * whose cwd is already a directory of its own — a generated tool runs in its script's directory.
 * Never pass `paths.dataDir` or `paths.configDir` here.
 */
export function wrapServerSpecInCwd(
  spec: ServerSpec,
  manifest: ExtensionManifest,
  cwd: string,
): ServerSpec { /* same body as before this task, env CWD = cwd */ }
```
Implement both through one private helper so the env shape cannot drift.

`toolgen-client.ts:50`: call `wrapServerSpecInCwd(...)`. Before switching, grep `security-invariants.test.ts` and `scripts/structure-audit/check-nimbus-invariants.ts` for `wrapServerSpec` assertions about `toolgen-client.ts`; if a rule/test pins the literal `wrapServerSpec(` there, update it to accept `wrapServerSpecInCwd(` in the same commit and say so in the report.

`sandbox-wrapper.ts`: after reading `cwd` and before `createSandboxRunner()`:
```ts
  // The per-policy leaf (spec § A) is created here, at the single point every wrapped spawn passes
  // through, and BEFORE the runner canonicalises it: `canonical-path.ts` falls back to the input
  // spelling for a path that does not exist, which would apply the Windows ACE to the wrong name.
  try {
    mkdirSync(cwd, { recursive: true });
  } catch (e) {
    fatal(`cannot create sandbox working directory ${cwd}: ${(e as Error).message}`);
  }
```

`mesh.ts`: `sandboxCwd: paths.sandboxDir,` and the filesystem MCP's third `wrapServerSpec` argument becomes `paths.sandboxDir` (its explicit `dataDir` read/write grant and its `bunx` argument are unchanged — spec § A exception).

`assemble.ts`: all six `sandboxCwd: paths.dataDir` → `sandboxCwd: paths.sandboxDir`.

Doc comments: `MeshSpawnContext.sandboxCwd` and `SyncContext.sandboxCwd` — "The sandbox ROOT (`PlatformPaths.sandboxDir`). Despite the name, not a cwd: `wrapServerSpec` derives each spawn's own leaf under it."

`security-invariants.test.ts`, inside the existing I15 `describe`, add:
```ts
test("I15 — no sandboxed spawn runs in the data directory", () => {
  for (const rel of ["platform/assemble.ts", "connectors/lazy-mesh/mesh.ts"]) {
    const src = readFileSync(join(GATEWAY_SRC, rel), "utf8");
    expect(src).not.toMatch(/sandboxCwd:\s*paths\.dataDir/);
    expect(src).toMatch(/sandboxCwd:\s*paths\.sandboxDir/);
  }
  const wrap = readFileSync(join(GATEWAY_SRC, "connectors/lazy-mesh/wrap-server-spec.ts"), "utf8");
  expect(wrap).toMatch(/sandboxCwdFor\(/);
});
```
(Use whatever source-root constant that file already uses instead of `GATEWAY_SRC`.) Prove it red by temporarily reverting one `assemble.ts` site, then restore.

- [ ] **Step 4: Run** the two Step-2 files, `bun test packages/gateway/src/security-invariants.test.ts`, `bun test packages/gateway/test/integration/platform/sandbox`, and `bun run typecheck` — expect PASS.

- [ ] **Step 5: Commit** — `fix(sandbox): give each sandboxed spawn its own working directory`

---

### Task 3: Windows boot revoke of legacy data-directory ACEs

**Files:**
- Modify: `packages/gateway/src/platform/sandbox/win32-reap.ts` (+ create `win32-legacy-cwd-revoke.test.ts`)
- Modify: `packages/gateway/src/platform/assemble.ts:~3275` (call it inside the existing `if (bootPolicy.reapAppContainers)` block)

**Interfaces:**
- Consumes: `buildRevokeGrantsArgv` (`win32-argv.ts`), `HelperRun` (`win32-release.ts`), `FIRST_PARTY_MANIFESTS`, `manifestForFirstParty`, `BUNDLED_CONNECTORS`, `listUserMcpConnectors` (`connectors/user-mcp-store.ts`).
- Produces:
  - `export const SANDBOX_CWD_MIGRATION_MARKER = "sandbox-cwd-migration-v1.done";`
  - `export function legacyDataDirGrantIds(userMcpServiceIds: readonly string[]): string[]`
  - `export async function revokeLegacyDataDirGrants(deps: { dataDir: string; ids: readonly string[]; run: HelperRun; markerExists: () => boolean; writeMarker: () => void; logger: Pick<Logger, "info" | "warn"> }): Promise<"skipped" | "done" | "partial">`
  - `export function revokeLegacyDataDirGrantsAtBoot(deps: { db: Database; dataDir: string; logger: Logger }): Promise<void>` — Windows-only, never rejects.

- [ ] **Step 1: Failing tests** (`win32-legacy-cwd-revoke.test.ts`, runs on every OS — pure logic with an injected `run`):
  - `legacyDataDirGrantIds(["mcp_a"])` contains `com.nimbus.github`, `com.nimbus.github-actions`, `com.nimbus.cloud-logging` (a bundled key with no table entry), `user.mcp_a`; does NOT contain `com.nimbus.filesystem`; has no duplicates.
  - `revokeLegacyDataDirGrants` with `markerExists: () => true` returns `"skipped"` and calls `run` zero times.
  - With no marker and every `run` resolving: calls `run` once per id with exactly `buildRevokeGrantsArgv({ id, permissions: { network: [], filesystem: { read: [], write: [] } } }, { cwd: dataDir })`, writes the marker once, returns `"done"`.
  - With one `run` rejecting: still calls `run` for every id, does NOT write the marker, returns `"partial"`, logs one warning.

- Windows-only integration test `packages/gateway/test/integration/platform/sandbox/legacy-cwd-revoke.integration.test.ts` (`skipIf` not win32 or helper missing, like its neighbours): spawn a trivial command through `createSandboxRunner()` with policy id `com.nimbus.revoke-it-<random>` and `cwd` = a fresh temp dir, wait for exit; read the dir's ACL with `icacls` and assert the entry count ROSE versus before the spawn (the premise — without it the test passes vacuously); run `revokeLegacyDataDirGrants` with `ids: [thatId]`, `dataDir: tempDir`, a real helper `run`, a temp marker; assert the count is back to the pre-spawn value and the marker exists.

- [ ] **Step 2: Run** `bun test packages/gateway/src/platform/sandbox/win32-legacy-cwd-revoke.test.ts` — FAIL.

- [ ] **Step 3: Implement** in `win32-reap.ts`. Ids: every `FIRST_PARTY_MANIFESTS` value's `id`; for each `BUNDLED_CONNECTORS` key `k`, `manifestForFirstParty(k).id` and `manifestForFirstParty(k.replaceAll("-", "_")).id`; `user.${serviceId}` per argument; minus `"com.nimbus.filesystem"`; deduped, sorted. Revokes run SEQUENTIALLY (each rewrites the same DACL; concurrent rewrites race — the same reason the mesh lists user slots one at a time). `revokeLegacyDataDirGrantsAtBoot` returns immediately unless `process.platform === "win32"` and the helper exists (`existsSync(helperPath())`); builds `run` like `helperRunner(helperPath())` from `win32.ts`; reads user ids via `listUserMcpConnectors(deps.db)` inside a try (on throw: warn and return — never revoke with a partial id set... a missing user id only leaves its ACE, so continuing with first-party ids is acceptable: log and continue with `[]`); marker = `join(dataDir, SANDBOX_CWD_MIGRATION_MARKER)` via `existsSync` / `writeFileSync(..., new Date().toISOString())`; logs `info` on `done`. Wrap the whole body in try/catch → `warn`, never reject.

  `assemble.ts`, immediately after the `void reapAppContainersAtBoot({...})` call inside the same `if`:
```ts
    // Spec § A: before per-policy working directories, every connector ran with `dataDir` as its
    // cwd and the helper left an inheritable ACE there per SID. Nothing re-grants it now (except
    // the filesystem MCP, deliberately), so revoke once and record a marker.
    void revokeLegacyDataDirGrantsAtBoot({ db, dataDir: paths.dataDir, logger: syncLogger });
```

- [ ] **Step 4: Run** the test file + `bun test packages/gateway/src/security-invariants.test.ts` (I41 pins `assemble.ts`'s guarded reap call — make sure the new call sits INSIDE the same guard) + `bun run typecheck`.

- [ ] **Step 5: Commit** — `fix(sandbox): revoke stale data-directory grants on Windows once`

---

### Task 4: Schema V65 + manifest from the row

**Files:**
- Create: `packages/gateway/src/index/user-mcp-grants-v65-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (append the step), `packages/gateway/src/index/local-index.ts:282` (`CURRENT_SCHEMA_VERSION = 65`)
- Modify: `packages/gateway/src/connectors/user-mcp-store.ts` (row type, select, insert)
- Modify: `packages/gateway/src/connectors/lazy-mesh/user-mcp.ts` (manifest from row, unified failure recorder)
- Create: `packages/gateway/src/index/migrations/runner-v65.test.ts`; extend `user-mcp-store` and `user-mcp` tests
- Modify: `docs/internals/known-todos.md` (delete the `user-mcp.ts:13` entry), `docs/schema-reference.md` (V65 row)

**Interfaces:**
- Produces:
  - `UserMcpConnectorRow` gains `read_paths_json: string; net_hosts_json: string; model_access: number;`
  - `insertUserMcpConnector(db, row)` requires those three (no defaults at the call site).
  - `export function userMcpManifestFromRow(row: UserMcpConnectorRow): { ok: true; manifest: ExtensionManifest } | { ok: false; column: "read_paths_json" | "net_hosts_json"; reason: string }`
  - `export function recordUserMcpRowFailure(ctx: MeshSpawnContext, serviceId: string, column: "args_json" | "read_paths_json" | "net_hosts_json", reason: string): void` (replaces `recordArgsJsonFailure`; update its callers/tests).

- [ ] **Step 1: Failing tests.**
  - `runner-v65.test.ts` (follow `runner-v44.test.ts`'s pattern): migrate a fresh DB to 64, insert a row with the OLD four columns, migrate to 65, assert the row reads `read_paths_json = '[]'`, `net_hosts_json = '[]'`, `model_access = 0`, and `user_version = 65`.
  - store test: insert with grants → `listUserMcpConnectors` returns them verbatim.
  - `userMcpManifestFromRow`: grants `["/a"]`/`["api.x.com"]` → manifest `{ id: "user.mcp_x", version: "0.0.0", permissions: { network: ["api.x.com"], filesystem: { read: ["/a"], write: [] } }, updateChannel: "stable" }`; `read_paths_json = "nope"` → `{ ok: false, column: "read_paths_json" }`; `net_hosts_json = "[1]"` → `{ ok: false, column: "net_hosts_json", reason: "expected string array" }`.
  - `ensureUserMcpClient` with a malformed `net_hosts_json` row registers NO client and records a `persistent_error` mentioning `net_hosts_json`.

- [ ] **Step 2: Run** them — FAIL.

- [ ] **Step 3: Implement.**

`user-mcp-grants-v65-sql.ts`:
```ts
/**
 * V65 — owner-approved grants for user MCP servers (spec 2026-10-06 § B). Defaults keep every
 * existing row at today's deny-all behaviour; `model_access` is stored now and read by PR 2.
 */
export const USER_MCP_GRANTS_V65_SQL = [
  `ALTER TABLE user_mcp_connector ADD COLUMN read_paths_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE user_mcp_connector ADD COLUMN net_hosts_json TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE user_mcp_connector ADD COLUMN model_access INTEGER NOT NULL DEFAULT 0`,
] as const;
```
`runner.ts`: `simpleStep(64, 65, "user MCP grants (read paths, network hosts, model access)", USER_MCP_GRANTS_V65_SQL),`. `local-index.ts`: `CURRENT_SCHEMA_VERSION = 65`.

`user-mcp-store.ts`: SELECTs list all seven columns when `readIndexedUserVersion(db) >= 65`; for 11..64 select the old four and fill `'[]','[]',0` in code (keeps old test DBs readable). Insert requires `>= 65` (throw `"user_mcp_connector grants require schema v65+"`).

`user-mcp.ts`: replace `userMcpDefaultManifest` with `userMcpManifestFromRow` (strict `string[]` parse per column, same shape as the `args_json` parse); in `ensureUserMcpClient`, after the args parse, `const m = userMcpManifestFromRow(row); if (!m.ok) { recordUserMcpRowFailure(ctx, row.service_id, m.column, m.reason); return; }` and pass `m.manifest` to `wrapServerSpec`. Rename `recordArgsJsonFailure` → `recordUserMcpRowFailure(ctx, serviceId, column, reason)`; message `malformed ${column} (${reason})`.

- [ ] **Step 4: Run** the tests + `bun test packages/gateway/src/index packages/gateway/src/connectors/lazy-mesh packages/gateway/src/connectors/user-mcp*` + `bun run typecheck`. CLAUDE.md/GEMINI.md say `schema V64` — change both to `V65` here (status-drift reads them).

- [ ] **Step 5: Commit** — `feat(user-mcp): store owner-approved grants (schema V65)`

---

### Task 5: Registration resolver (pure)

**Files:**
- Create: `packages/gateway/src/connectors/user-mcp-registration.ts` + `user-mcp-registration.test.ts`

**Interfaces:**
- Produces:
```ts
export type UserMcpRegistrationInput = {
  readonly serviceId: string;            // already normalised by the caller
  readonly argv: readonly string[];      // [command, ...args], exact tokens
  readonly readPaths: readonly string[];
  readonly netHosts: readonly string[];
  readonly modelAccess: boolean;
};
export type UserMcpRegistrationEnv = {
  readonly platform: NodeJS.Platform;
  readonly protectedRoots: readonly string[];        // dataDir, configDir, sandboxDir
  readonly registeredServiceIds: readonly string[];
  which(cmd: string): string | null;
  realpath(p: string): string;                        // throws when p does not exist
};
export type ResolvedUserMcpRegistration = {
  readonly serviceId: string;
  readonly command: string;            // absolute
  readonly args: readonly string[];
  readonly readPaths: readonly string[];  // canonical, deduped, incl. auto command dir (non-win32)
  readonly netHosts: readonly string[];   // lowercased, deduped
  readonly modelAccess: boolean;
};
export class UserMcpRegistrationError extends Error {
  constructor(readonly code: UserMcpRegistrationErrorCode, message: string);
}
export type UserMcpRegistrationErrorCode =
  | "ERR_USER_MCP_ARGV_EMPTY"
  | "ERR_USER_MCP_COMMAND_NOT_FOUND"
  | "ERR_USER_MCP_READ_PATH_RELATIVE"
  | "ERR_USER_MCP_READ_PATH_MISSING"
  | "ERR_USER_MCP_READ_PATH_PROTECTED"
  | "ERR_USER_MCP_NET_HOST_INVALID"
  | "ERR_USER_MCP_ID_COLLISION";
export function resolveUserMcpRegistration(
  input: UserMcpRegistrationInput,
  env: UserMcpRegistrationEnv,
): ResolvedUserMcpRegistration;
```

- [ ] **Step 1: Failing tests** — one per rule, each with a fake env (`which` from a map, `realpath` returning the input for a known set and throwing otherwise). Required cases:
  - empty argv → `ERR_USER_MCP_ARGV_EMPTY`.
  - bare `echo-srv` resolved by `which` → `command` absolute; unresolvable → `ERR_USER_MCP_COMMAND_NOT_FOUND`.
  - absolute command kept, then `realpath`ed; a missing absolute command → `ERR_USER_MCP_COMMAND_NOT_FOUND`.
  - command with a space in its path stays one token (`argv[0] = "/home/Jane Doe/srv/x"`).
  - relative `--read` → `ERR_USER_MCP_READ_PATH_RELATIVE`; missing → `ERR_USER_MCP_READ_PATH_MISSING`.
  - read path equal to, inside, and an ANCESTOR of each protected root → `ERR_USER_MCP_READ_PATH_PROTECTED` (three directions × three roots — table-driven).
  - linux/darwin: command `/opt/srv/bin/x` → `readPaths` includes `/opt/srv/bin`; win32: not added.
  - linux: command inside `dataDir` → `ERR_USER_MCP_READ_PATH_PROTECTED` (the auto-added dir is checked too).
  - win32 comparison is case-insensitive: read `C:\USERS\U\APPDATA\LOCAL\NIMBUS\DATA\x` vs root `C:\Users\u\AppData\Local\Nimbus\data` → protected.
  - net: `API.Example.com` → `api.example.com`; `host:443` ok; `10.0.0.1` ok; `https://x`, `x/y`, `*.x.com`, `x:0`, `x:70000`, `` → `ERR_USER_MCP_NET_HOST_INVALID`.
  - ids: registering `mcp_a_x` while `mcp_a` exists, and `mcp_a` while `mcp_a_x` exists → `ERR_USER_MCP_ID_COLLISION`; `mcp_ab` with `mcp_a` → allowed.
  - duplicates in read/net are deduped; output order is input order.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** Rules in this order (first failure throws): argv non-empty → id collision → command resolution (`isAbsolute(argv[0])` ? `realpath(argv[0])` (catch → NOT_FOUND) : `which(argv[0])` then `realpath`) → each read path (absolute, `realpath`, protected check) → append `dirname(command)` when `platform !== "win32"` and protected-check it → net hosts. Overlap: `isSameOrInside(a, b) || isSameOrInside(b, a)` using `path.relative` (for `win32`, compare lowercased strings through `path.win32.relative`; else `path.posix.relative`). Net host regex (after `.toLowerCase().trim()`):

```ts
const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOST_RE = new RegExp(`^${LABEL}(?:\\.${LABEL})*(?::(\\d{1,5}))?$`);
// port, when present, must be 1..65535. IPv6 literals are NOT accepted in this slice (stated bound).
```
Every error message names the offending value.

- [ ] **Step 4: Run** — PASS; `bun run typecheck`.

- [ ] **Step 5: Commit** — `feat(user-mcp): resolve and validate registrations before approval`

---

### Task 6: `connector.addMcp` resolves before the prompt; remove cleans the leaf

**Files:**
- Modify: `packages/gateway/src/ipc/connector-rpc.ts:75-96` (the `connector.addMcp` case)
- Modify: `packages/gateway/src/ipc/connector-rpc-handlers/config.ts:14-50` (`handleConnectorAddMcp` takes the resolved registration)
- Modify: `packages/gateway/src/ipc/connector-rpc-handlers/removal.ts:~123`
- Modify: `packages/gateway/src/connectors/lazy-mesh/mesh.ts` (two public methods)
- Modify: the existing addMcp/remove tests (`connector-rpc*.test.ts`, `connector-rpc-handlers/*.test.ts` — find with `grep -rln "connector.addMcp\|handleConnectorAddMcp" packages/gateway/src`)

**Interfaces:**
- Consumes: Task 5's resolver; Task 4's insert; Task 2's `sandboxCwdFor`.
- Produces on `LazyConnectorMesh`:
  - `userMcpProtectedRoots(): readonly string[]` → `[paths.dataDir, paths.configDir, paths.sandboxDir]` (store `paths` on the instance if not already).
  - `async removeUserMcpSandbox(serviceId: string): Promise<void>` — `await this.stopUserMcpClient(serviceId)`, then `rmSync(sandboxCwdFor(sandboxRoot, \`user.${serviceId}\`), { recursive: true, force: true })` in try/catch → `this.logger?.warn({ serviceId, err }, "user MCP sandbox directory not removed")`. Never throws.
- IPC params for `connector.addMcp`: `{ serviceId: string; argv?: string[]; commandLine?: string; readPaths?: string[]; netHosts?: string[]; modelAccess?: boolean }` — exactly one of `argv`/`commandLine` (`commandLine` → `parseUserMcpCommandLine` for compatibility).
- Gate payload, exactly: `{ serviceId, command, args, readPaths, netHosts, modelAccess }` plus `networkNote: "Windows AppContainer network access is all-or-nothing (internetClient): this server can reach any host, not only the ones listed."` only when `process.platform === "win32" && netHosts.length > 0`.

- [ ] **Step 1: Failing tests.**
  - addMcp with `argv: ["C:\\Users\\Jane Doe\\x.exe"]` (fake env) stores `command` = that exact string and `args_json = "[]"`.
  - A request whose read path is inside `dataDir` throws `ConnectorRpcError` (-32602, message starts `ERR_USER_MCP_READ_PATH_PROTECTED`) and the gate's consent was NEVER requested (assert the fake executor's `gate` call count is 0).
  - A valid request: the gate is called once with the exact payload above; on approval the row has the resolved grants; on rejection no row exists.
  - `connector.remove` of a user MCP calls `connectorMesh.removeUserMcpSandbox(id)` once; a throwing `rmSync` (inject via a mesh test double) does not fail the remove.
  Give the resolver's `which`/`realpath` to the handler through `ConnectorRpcHandlerContext` test seams (`resolveCommand?`, `realpath?`), defaulting to `Bun.which` and `realpathSync.native` — DI, not `mock.module`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** In the `connector.addMcp` case: require `toolExecutor` and `connectorMesh` (existing errors); normalise `serviceId` and the built-in conflict check (move them from `handleConnectorAddMcp` into the case, BEFORE the gate); build `argv`; call `resolveUserMcpRegistration` with `{ platform: process.platform, protectedRoots: connectorMesh.userMcpProtectedRoots(), registeredServiceIds: listUserMcpConnectors(db).map((r) => r.service_id), which, realpath }`; map `UserMcpRegistrationError` → `ConnectorRpcError(-32602, \`${e.code}: ${e.message}\`)`; gate with the payload; on `"proceed"` call `handleConnectorAddMcp(ctx, resolved)` which inserts (`args_json = JSON.stringify(args)`, the three grant columns, `model_access = modelAccess ? 1 : 0`) and registers the syncable exactly as today. Keep the #808 comment's point (the payload names what is consumed) and update its wording.

  `removal.ts`: after `deleteUserMcpConnector(db, id)`, when `ctx.connectorMesh !== undefined && USER_MCP_SERVICE_ID_PATTERN.test(id)`, `await ctx.connectorMesh.removeUserMcpSandbox(id)`.

- [ ] **Step 4: Run** `bun test packages/gateway/src/ipc packages/gateway/src/connectors` + `bun run typecheck`.

- [ ] **Step 5: Commit** — `feat(user-mcp): approve resolved grants, clean the sandbox on remove`

---

### Task 7: CLI `connector add --mcp` flags

**Files:**
- Modify: `packages/cli/src/commands/connector.ts` (`runConnectorAddMcp` ~1156, help text ~1359, usage strings ~1161/1323)
- Create: `packages/cli/src/commands/connector-add-mcp-args.ts` + `.test.ts`

**Interfaces:**
- Produces:
```ts
export type AddMcpRequest = {
  serviceId: string; argv: string[]; readPaths: string[]; netHosts: string[]; modelAccess: boolean;
};
/** `tail` is everything after `--mcp`. `cwd` resolves relative --read paths and a relative command. */
export function parseAddMcpArgs(tail: readonly string[], cwd: string): AddMcpRequest;
```

- [ ] **Step 1: Failing tests** (`node:path` `resolve`/`join` for expected values):
  - `["mcp_x", "--read", "data", "--net", "api.x.com", "--model", "--", "./dist/x", "--flag"]`, cwd `C` → `{ serviceId: "mcp_x", argv: [resolve("C","./dist/x"), "--flag"], readPaths: [resolve("C","data")], netHosts: ["api.x.com"], modelAccess: true }`.
  - legacy `["mcp_brave", "npx", "-y", "@some/mcp-server"]` → `argv: ["npx", "-y", "@some/mcp-server"]`, no grants, `modelAccess: false` (bare command NOT resolved).
  - `dist/x` and `..\\x.exe` are relative-with-separator → resolved; `x` stays bare.
  - an absolute command is untouched; a path with a space stays one token.
  - after `--`, a token `--read` is part of argv, not a flag.
  - errors (each `toThrow(/Usage: nimbus connector add --mcp/)`): no id; `--read` without a value; unknown flag before `--`; nothing after `--`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement** the parser; rewrite `runConnectorAddMcp(tail)` to `const req = parseAddMcpArgs(tail, process.cwd()); const r = await withIpc((c) => c.call<{ ok: boolean; serviceId: string }>("connector.addMcp", req), undefined, INTERACTIVE_RPC_TIMEOUT_MS);` and print `Registered user MCP connector: <id>` plus one line per grant. Usage/help text:
```
nimbus connector add --mcp <mcp_id> [--read <path>]... [--net <host[:port]>]... [--model] -- <command> [args...]
```
Example line: `Example: nimbus connector add --mcp mcp_echo -- /abs/path/echo/dist/echo`. (`--model` is accepted and stored; § F makes it do something in PR 2 — the help line says "(offer this server's tools to the model; takes effect in a later release)".)

- [ ] **Step 4: Run** `bun test packages/cli/src/commands/connector-add-mcp-args.test.ts packages/cli/src/commands/connector.test.ts` + typecheck.

- [ ] **Step 5: Commit** — `feat(cli): connector add --mcp takes --read/--net/--model grants`

---

### Task 8: Invariant I42 — every user-MCP tool call needs the local owner's approval

**Files:**
- Modify: `packages/gateway/src/engine/executor.ts` (`gate`, `tryDelegatedApproval`, new export)
- Modify: `packages/gateway/src/engine/executor*.test.ts` (find the gate tests)
- Modify: `packages/gateway/src/security-invariants.test.ts` (new `describe("I42 — ...")`)
- Modify: `docs/SECURITY-INVARIANTS.md` (new `## I42` section before `## How a new invariant is added`)
- Modify: `CLAUDE.md`, `GEMINI.md` (new I42 bullet; every `I1–I41`/`I29–I41`/"through I41" ceiling → `I42`), `.github/SECURITY.md`, `.coderabbit.yaml`, `docs/architecture.md` (§ invariant table ceiling, "COMPLETE as of I41"), `docs/README.md` (`I1`–`I27` and `I29`–`I41` → `I42`; "Forty enumerated invariants" → "Forty-one"; line ~907)

**Interfaces:**
- Produces: `export function isUserMcpActionType(actionType: string): boolean` in `executor.ts`.

- [ ] **Step 1: Failing tests.**
  - executor: an action `{ type: "mcp_echo.echo" }` with an empty `HITL_REQUIRED` membership and no policy → consent requested once; denial → `{ status: "rejected" }` and the dispatcher's `dispatch` called 0 times; approval → dispatched once with `hitlStatus: "approved"` in the audit row.
  - executor with a delegation dep whose store reports an active delegate for `mcp_echo.echo` → the LOCAL consent is still requested and `requestRemote` is called 0 times.
  - `isUserMcpActionType`: `mcp_echo.echo` true, `mcp_a_b.x_y` true, `connector.addMcp` false, `github.pr_list` false, `mcp_.x` false (pattern needs ≥1 char after the prefix), `MCP_X.y` false.
  - security-invariants `I42`: (a) `executor.ts` source matches `/HITL_REQUIRED\.has\(action\.type\)\s*\|\|\s*isUserMcpActionType\(action\.type\)/`; (b) `tryDelegatedApproval` returns `"fallback"` for user-MCP types (source match on `isUserMcpActionType(action.type)` inside it); (c) a behavioural case constructing a `ToolExecutor` with a fake consent that DENIES and asserting `dispatch` is never called for `mcp_x.y`.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.**
```ts
import { USER_MCP_SERVICE_ID_PATTERN } from "../connectors/user-mcp-store.ts";

/**
 * I42: a user-registered MCP server runs arbitrary owner-approved code, and its tools are not
 * enumerable ahead of time, so EVERY call to one needs the local owner's approval — derived from
 * the action TYPE alone (I3), never configurable, joined by OR so it only ever tightens.
 */
export function isUserMcpActionType(actionType: string): boolean {
  return USER_MCP_SERVICE_ID_PATTERN.test(serviceOf(actionType));
}
```
In `gate`: `const requiresHITL = HITL_REQUIRED.has(action.type) || isUserMcpActionType(action.type) || this.requiredByPolicy(action.type);` and extend the existing comment (I2 floor, I42 floor, policy third). In `tryDelegatedApproval`: `if (this.delegation === undefined || isUserMcpActionType(action.type)) return "fallback";` with a one-line comment (I42: a delegate never approves a user-MCP call). Check the import does not create a cycle (`user-mcp-store.ts` imports only db/index modules); if `audit:boundaries` objects, move `USER_MCP_SERVICE_ID_PATTERN` to a tiny `connectors/user-mcp-id.ts` re-exported from the store.

  Docs: `## I42 — every user-MCP tool call needs the local owner's approval` with **Statement**, **Why** (arbitrary code; tools unknowable in advance; the owner-CLI path and PR 2's model path share it), **Delegation** (I20 deliberately not consulted), **Bounds** (the egress row's destination is the service id, not a host; the gate proves the owner saw the call, not that they understood the input), **Wiring** (`engine/executor.ts`), **Test** (`security-invariants.test.ts` `I42`; e2e `test/e2e/user-mcp.e2e.test.ts` from Task 12). CLAUDE.md/GEMINI.md bullet, compact, same style as I41's: `- **I42** — any action whose service is a user-MCP id (\`mcp_*\`) requires HITL at the executor gate (OR-joined with I2 and the policy overlay; derived from \`action.type\`, I3), and a delegate (I20) never approves one · \`engine/executor.ts\``.

- [ ] **Step 4: Run** the executor tests, `bun test packages/gateway/src/security-invariants.test.ts`, `bun run audit:status-drift`, `bun run audit:doc-refs`, then `bun run preflight:fast`. Fix every surface `audit:status-drift` names; then `grep -rn "I41" CLAUDE.md GEMINI.md docs .github .coderabbit.yaml .claude/commands` and update any remaining CEILING statement (leave references to I41 itself alone).

- [ ] **Step 5: Commit** — `feat(engine): I42 — user-MCP tool calls always need owner approval`

---

### Task 9: `connector.userMcpTools` / `connector.userMcpCall`

**Files:**
- Modify: `packages/gateway/src/connectors/lazy-mesh/mesh.ts` (new `listUserMcpTools`)
- Modify: `packages/gateway/src/ipc/connector-rpc.ts` (two cases + `userMcpExecutor` option)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts:~1925-1960` (build the dispatching executor for `connector.userMcpCall` only)
- Modify: `packages/gateway/src/ipc/lan-rpc.ts` (LAN denylist entries)
- Tests: `connector-rpc` unit tests for both cases; `lan-rpc.test.ts` (call `checkLanMethodAllowed` for both + a negative control); `ui/src-tauri` allowlist test unchanged (assert by name that neither method is present, wherever the existing allowlist-by-name test lives).

**Interfaces:**
- Produces:
  - `LazyConnectorMesh.listUserMcpTools(serviceId: string): Promise<LazyMeshToolMap | undefined>` — `undefined` when no row exists; otherwise `await this.ensureUserMcpRunning(serviceId)` then `listLazyMeshClientTools(this.getLazyClient(userMcpMeshKey(serviceId)))`. ONE slot, never the merged map.
  - `connector.userMcpTools` params `{ serviceId }` → `{ serviceId, tools: Array<{ name: string; description: string; inputSchema: unknown }> }` where `name` is the key minus `${serviceId}_`, `inputSchema` is `z.toJSONSchema(tool.inputSchema)` when it is a zod schema (try/catch → `null`), else the raw value if it is a plain object, else `null`.
  - `connector.userMcpCall` params `{ serviceId, tool, input? }` (`input` must be a plain object, default `{}`) → `{ status: "ok"; result: unknown } | { status: "rejected"; reason: string }`.
  - `dispatchConnectorRpc` option `userMcpExecutor?: ToolExecutor`.

- [ ] **Step 1: Failing tests.**
  - `userMcpTools` for an unknown id → `-32602` `ERR_USER_MCP_NOT_REGISTERED`; for a registered id with a fake mesh returning `{ mcp_x_echo: {...}, mcp_x_probe: {...} }` → names `["echo", "probe"]` sorted.
  - `userMcpCall` with a tool missing from that slot's listing → `-32602` `ERR_USER_MCP_UNKNOWN_TOOL` and `userMcpExecutor.execute` called 0 times.
  - `userMcpCall` valid → `execute` called once with exactly `{ type: "mcp_x.echo", payload: { mcpToolId: "mcp_x_echo", input: { text: "hi" } } }`; its result returned verbatim.
  - non-object `input` (`"str"`, `[]`) → `-32602`.
  - `checkLanMethodAllowed("connector.userMcpTools")` and `("connector.userMcpCall")` refuse; `"connector.listStatus"` still allowed (negative control).

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** In `dispatchers.ts`, inside the connector branch, when `method === "connector.userMcpCall"` and `ctx.options.connectorMesh` exists, build:
```ts
    // I42 + I29: unlike the gate-only executor above, this one DISPATCHES, so it carries a real
    // egress sink and the real connector dispatcher. No delegation dep: I42 asks the local owner.
    const mesh = ctx.options.connectorMesh;
    const userMcpExecutor = new ToolExecutor(
      bindConsentChannel(ctx.consentImpl, clientId),
      ctx.options.localIndex,
      createConnectorDispatcher({
        listTools: () => mesh.listToolsForDispatcher(),
        getToolsEpoch: () => mesh.getToolsEpoch(),
      }),
      undefined,
      makeEgressSink(ctx.options.localIndex.getDatabase()),
      ctx.options.policyHitl ?? NO_POLICY_OVERLAY,
    );
```
and pass it as `userMcpExecutor`. Method routing needs nothing new — `tryDispatchConnectorRpc` already claims the `connector.` prefix — but the E2E in Task 12 is what proves it. LAN: add both full method names to the denylist set next to `"connector.addMcp"` with the comment `// CLI-only: lists/calls an owner-registered user MCP (I42)`; add `"connector.userMcpCall"` to `WRITE_METHODS`.

- [ ] **Step 4: Run** `bun test packages/gateway/src/ipc packages/gateway/src/connectors/lazy-mesh` + typecheck + `bun run audit:nimbus-invariants` (D22(a) must still pass — `connectors.dispatch` stays only in `executor.ts`).

- [ ] **Step 5: Commit** — `feat(user-mcp): list and call a user MCP's tools over CLI-only IPC`

---

### Task 10: CLI `connector tools` / `connector call`

**Files:**
- Modify: `packages/cli/src/commands/connector.ts` (two subcommands + help)
- Create: `packages/cli/src/commands/connector-user-mcp.ts` + `.test.ts` (parsing + rendering, DI over the IPC call)

**Interfaces:**
- Produces: `runConnectorTools(tail, deps?)`, `runConnectorCall(tail, deps?)`; `deps.call` defaults to `withIpc`-backed calls (DI for tests, not `mock.module`).
- Exit codes for `call`: `0` status ok; `1` IPC/tool error; `2` refused (`status: "rejected"` or an `ERR_USER_MCP_UNKNOWN_TOOL` / `ERR_USER_MCP_NOT_REGISTERED` error). Set via `process.exitCode`.

- [ ] **Step 1: Failing tests:** `tools mcp_x` prints one line per tool (`echo — <description>`); `--json` prints the raw response; `call mcp_x echo --input '{"text":"hi"}'` sends `{ serviceId: "mcp_x", tool: "echo", input: { text: "hi" } }` and prints the result's text content (join `content[].text` when the result is an MCP `{ content: [...] }`, else `JSON.stringify`); `--input` that is not a JSON object → usage error, exit 1, nothing sent; rejected → exit 2 and `Refused: <reason>`.

- [ ] **Step 2: Run** — FAIL.  **Step 3: Implement** — `call` uses the interactive consent default and `INTERACTIVE_RPC_TIMEOUT_MS` (it raises an I42 prompt). Help lines:
```
  nimbus connector tools <mcp_id> [--json]                         List a user MCP server's tools
  nimbus connector call <mcp_id> <tool> [--input <json>] [--json]   Call one (asks for approval)
```
- [ ] **Step 4: Run** the CLI tests + typecheck.  **Step 5: Commit** — `feat(cli): connector tools and connector call for user MCP servers`

---

### Task 11: `nimbus scaffold mcp`

**Files:**
- Rewrite: `packages/cli/src/commands/scaffold.ts`; rewrite `scaffold.test.ts`
- Modify: `packages/cli/src/commands/help.ts:128`

**Interfaces:**
- Produces: `export const SCAFFOLD_MCP_SDK_VERSION = "1.32.0";`, `parseScaffoldArgs(args): { kind: "mcp"; name: string; viaAlias: boolean }`, `buildScaffoldFiles(name: string, platform: NodeJS.Platform, absDir: string): readonly ScaffoldFile[]`, `runScaffold(args)`. `EXTENSION_MANIFEST_FILENAME` is REMOVED from this module (the gateway's own constant in `extensions/manifest.ts` is untouched; grep shows no other importer of the CLI one).

- [ ] **Step 1: Failing tests.**
  - `parseScaffoldArgs(["mcp", "echo"])` → `{ kind: "mcp", name: "echo", viaAlias: false }`; `["extension", "echo"]` → `viaAlias: true`; names `Echo`, `my-srv`, `a.b`, `""`, 63 chars → throw `/Usage: nimbus scaffold mcp <name>/`.
  - `buildScaffoldFiles("echo", "linux", "/w/echo")` paths are exactly `package.json`, `src/server.ts`, `src/server.test.ts`, `README.md`, `.gitignore`.
  - `package.json` parses; `dependencies["@modelcontextprotocol/sdk"] === SCAFFOLD_MCP_SDK_VERSION`, `dependencies.zod === "^4.6.5"`, `scripts.build === "bun build --compile src/server.ts --outfile dist/echo"`, `scripts.test === "bun test"`, `scripts.start === "bun src/server.ts"`.
  - `SCAFFOLD_MCP_SDK_VERSION` equals `packages/cli/package.json`'s `dependencies["@modelcontextprotocol/sdk"]` (read the file; this is the drift guard).
  - README for `linux` contains `nimbus connector add --mcp mcp_echo -- /w/echo/dist/echo`; for `win32` (`absDir` `C:\\w\\echo`) contains `-- C:\\w\\echo\\dist\\echo.exe`; neither contains `--read <` as the default instruction.
  - `runScaffold(["mcp","echo"])` in a temp cwd writes the files; running it again throws `/already exists/` and changes nothing; the alias prints one line naming `nimbus scaffold mcp`.
  - **The generated test must really run:** write the files into a temp dir, junction/symlink `node_modules/@modelcontextprotocol` → `packages/cli/node_modules/@modelcontextprotocol` and `node_modules/zod` → the repo root `node_modules/zod` (`symlinkSync(target, link, "junction")`), then `Bun.spawn(["bun", "test"], { cwd })` and assert exit 0 and output containing `2 pass`. Mark this one test with a 60 s timeout.

- [ ] **Step 2: Run** — FAIL.

- [ ] **Step 3: Implement.** Generated `src/server.ts` (exact content; `__NAME__` replaced):

```ts
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/** Build the server. Exported so the test can drive it in memory. */
export function createServer(): McpServer {
  const server = new McpServer({ name: "__NAME__", version: "0.1.0" });
  server.registerTool(
    "echo",
    { description: "Echo text back", inputSchema: { text: z.string() } },
    async ({ text }) => ({ content: [{ type: "text", text }] }),
  );
  return server;
}

if (import.meta.main) {
  await createServer().connect(new StdioServerTransport());
}
```

Generated `src/server.test.ts`:
```ts
import { describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "./server.ts";

async function connected(): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createServer().connect(serverSide);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
  return client;
}

describe("__NAME__", () => {
  test("lists the echo tool", async () => {
    const client = await connected();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("echo");
  });
  test("echoes its input", async () => {
    const client = await connected();
    const out = await client.callTool({ name: "echo", arguments: { text: "hi" } });
    expect(out.content).toEqual([{ type: "text", text: "hi" }]);
  });
});
```
README: sections Install (`bun install`), Test (`bun test`), Build (`bun run build` → `dist/<name>[.exe]`), Register (the exact absolute line for this OS), "Granting more" (`--read <dir>` for directories it must read, `--net <host>` for hosts it must reach; Windows note that any `--net` grant is all-or-nothing), "Calling it" (`nimbus connector tools mcp_<name>`, `nimbus connector call mcp_<name> echo --input '{"text":"hi"}'`, each call asks for approval). `.gitignore`: `node_modules/\ndist/\n`. `runScaffold`: `existsSync(dir)` → throw `./<name>/ already exists`; `mkdirSync(join(dir, "src"), { recursive: true })`; write files; print `Scaffolded MCP server at ./<name>/ — next: cd <name> && bun install && bun test && bun run build`. help.ts line: `nimbus scaffold mcp <name>        Minimal, tested MCP server you can register with connector add --mcp`.

- [ ] **Step 4: Run** `bun test packages/cli/src/commands/scaffold.test.ts` + typecheck.  **Step 5: Commit** — `feat(cli): scaffold mcp emits a real, tested MCP server`

---

### Task 12: End-to-end — scaffold, compile, register, list, call, confined

**Files:**
- Create: `packages/gateway/test/e2e/user-mcp.e2e.test.ts`

**Interfaces:**
- Consumes: everything above; harness pieces copied from `test/e2e/local-auth.e2e.test.ts` (`TestIpcClient`, `until`, the runner spawn, the temp `paths` object — add `sandboxDir: join(tmp, "sandbox")`).

- [ ] **Step 1: Write the test** (one `describe`, `beforeAll` 180 s):
  1. `tmp = mkdtempSync(join(tmpdir(), "nimbus-usermcp-e2e-"))`; scaffold by SPAWNING the CLI (the gateway may not import CLI source): `Bun.spawn(["bun", join(REPO, "packages/cli/src/index.ts"), "scaffold", "mcp", "echo_srv"], { cwd: tmp })`, assert exit 0.
  2. Junction `node_modules/@modelcontextprotocol` and `node_modules/zod` exactly as Task 11's test does.
  3. Write `src/probe.ts` (adds a `probe` tool to `createServer()` that `readFileSync`s a given path and returns `READ <content>` or `DENIED <error>`, then connects stdio), and compile it: `bun build --compile src/probe.ts --outfile dist/echo_srv` (no `--target`). Assert exit 0 and the binary exists (`.exe` on win32).
  4. `sentinel = join(tmp, "outside", "secret.txt")` containing `TOP-SECRET`; **positive control**: `readFileSync(sentinel)` in the test process returns it.
  5. Boot the gateway (runner), connect. Approve every `consent.request` while recording each request's `prompt` (the notification carries `{ requestId, prompt, details? }`; `prompt` is `formatConsentPrompt`'s text, which names the action type).
  6. `connector.addMcp` `{ serviceId: "mcp_echo_srv", argv: [binary] }` → `{ ok: true }`.
  7. `connector.userMcpTools` → names include `echo` and `probe`.
  8. `connector.userMcpCall` `{ tool: "echo", input: { text: "hello" } }` → `status: "ok"`, text `hello`; a recorded consent prompt contains `mcp_echo_srv.echo` (I42 fired).
  9. `connector.userMcpCall` `{ tool: "probe", input: { path: sentinel } }` → text starts with `DENIED` and does not contain `TOP-SECRET`.
  10. Switch the consent handler to DENY; call `echo` again → `status: "rejected"`.
  11. `connector.remove` `{ serviceId: "mcp_echo_srv" }` (approve) → the leaf `join(paths.sandboxDir, "user_mcp_echo_srv")` is gone, or the gateway log contains `user MCP sandbox directory not removed` (Windows may hold it while the child exits).
  `afterAll`: close, kill, `rmSync(tmp, { recursive: true, force: true })` in try/catch.

- [ ] **Step 2: Run** `bun test packages/gateway/test/e2e/user-mcp.e2e.test.ts` on this machine (Windows: build the sandbox helper first). It must pass here; Linux/macOS are proven by CI's E2E legs. If step 9 returns `READ`, STOP — the sandbox is not confining the user MCP; report it, do not weaken the assertion.

- [ ] **Step 3: Commit** — `test(e2e): a scaffolded user MCP runs confined and answers through the CLI path`

---

### Task 13: Documentation

**Files:** `docs/architecture.md` (§ Extension Scaffold ~929: delete the `NimbusExtensionServer` example; describe `nimbus scaffold mcp`, the per-policy sandbox directory, user-MCP grants and the CLI path), `docs/cli-reference.md` (`scaffold mcp` replacing `scaffold extension` ~4319, alias note; `connector add --mcp` flags; `connector tools`; `connector call` + exit codes), `docs/README.md` (~65 "hosts any third-party server you register…" — say what that now means; ~821 the scaffold paragraph), `docs/CONTRIBUTING.md` (~205), `docs/sandbox.md` (per-policy working directories + where they live per OS; the Windows one-time revoke and its marker; user-MCP grants; the Windows all-or-nothing network note; the remaining same-id DACL race; the filesystem MCP's deliberate `dataDir` grant; the stated bounds: no IPv6 host literals, a Windows `--read` on a directory the user cannot change the ACL of fails at spawn), `docs/SECURITY-INVARIANTS.md` I15 (the cwd is a per-policy leaf under `sandboxDir`, never `dataDir`/`configDir`; cite `sandbox-cwd.ts`), `docs/CHANGELOG.md` (new top entry under "## Post-Phase-6 deliveries"), `docs/roadmap.md` (a row for this delivery + PR 2 named as next), `docs/schema-reference.md` (V65, if Task 4 did not already).

- [ ] **Step 1:** Make the edits. Every claim must match shipped code; name what does NOT ship (model access is PR 2; script-mode servers; write grants).
- [ ] **Step 2:** `bun run audit:doc-refs`, `bun run audit:status-drift`, `bun run preflight:fast` — clean.
- [ ] **Step 3: Commit** — `docs: user MCP servers, per-connector sandbox directories, scaffold mcp`

---

## Final verification (controller)

`bun run preflight` on the branch (or `preflight:fast` + the touched suites + `bun test packages/gateway/test/e2e/user-mcp.e2e.test.ts` if the full run is too long), `bun run verify:docker --changed` for the Linux view, then strip `docs/superpowers/` from the branch before opening the PR (specs and plans never land on `main`).
