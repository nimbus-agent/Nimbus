# `nimbus demo` PR 2 — Inert Demo Gateway, Acme Corpus, `demo.seed`, Tour — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `nimbus demo` gives an evaluator three real agent briefs over a synthetic org in about a minute, on a demo gateway that cannot sync, cannot make an outbound call, and cannot be pointed at real data.

**Architecture:** PR 1 (#1545, merged) built the isolated demo root and invariant I41. This PR (a) makes a demo gateway INERT — its sync scheduler is constructed but disabled/never started/empty, its boot-time outbound work (updater check, telemetry flush, embedding download, extension auto-update) is skipped by the same `bootPolicyFor(paths)` mechanism PR 1 used, and one refusal gate at `dispatchMethod` blocks connector/vault/import/install writes; (b) adds a typed synthetic corpus (fictional org "Acme", all timestamps relative to seed time, all names on `.example` domains) written through production write APIs by a gateway-side seeder; (c) exposes the seeder as `demo.seed`, an IPC method that exists ONLY on a demo-rooted gateway; (d) adds the `nimbus demo` CLI command (reset → start → seed → restart → tour), a stderr banner on every `--demo` command, and demo-aware follow-up hints. I41 gains clauses (5) and (6).

**Tech Stack:** Bun 1.3, TypeScript strict, `bun:test`, Biome.

**Spec:** `docs/superpowers/specs/2026-09-18-nimbus-demo-design.md` — read § 4, § 5, § 6 (PR 2), and **§ 11** (PR 1 outcome, the two spike answers, the scheduler design, the carried items). Where § 5 and § 11.2 disagree about the scheduler, § 11.2 wins.

## Global Constraints

- Branch `dev/asafgolombek/nimbus-demo-pr2`, worktree `C:\gitrep\Nimbus\.claude\worktrees\nimbus-demo-pr2`. Run `git rev-parse --abbrev-ref HEAD` before EVERY commit; it must print `dev/asafgolombek/nimbus-demo-pr2`.
- **Never `git stash`** (the stash stack is shared across worktrees and sessions). Compare with `git diff` / `git show <sha>:<path>`.
- Commit with `git commit -F <file>` when a message contains backticks.
- No `any`; external data is `unknown`. TypeScript strict; `exactOptionalPropertyTypes` is on.
- `gateway` imports nothing from `cli`; `cli` imports nothing from `gateway`. Only `scripts/` may import both.
- SQLite writes go through the production APIs or `dbRun`/`dbExec` (`packages/gateway/src/db/write.ts`, invariant I14) — never a bare `db.run` in production code.
- A demo gateway is one whose `PlatformPaths.demo === true`; everything branches on that field (or `bootPolicyFor(paths)`), NEVER on the `NIMBUS_DEMO` env var.
- **Corpus rules (spec § 4.2):** every timestamp is an offset from the seed's `nowMs` — no absolute epoch number anywhere in the corpus; every email / URL / domain ends in `.example` (e.g. `acme.example`, `github.example`); the org is fictional ("Acme"); every file written to the workspace carries a "Synthetic demo file" header.
- **Stable error codes:** `ERR_DEMO_FORBIDDEN` (refusal gate, JSON-RPC code `-32000`), `ERR_DEMO_ALREADY_SEEDED` (`demo.seed` on a non-empty index, `-32010`), `ERR_SYNC_DISABLED` (a disabled scheduler's `forceSync`).
- **Refusal gate (spec § 5):** in a demo gateway, refuse every `connector.*` method EXCEPT `connector.listStatus`, `connector.status`, `connector.healthHistory`; also refuse `vault.set`, `vault.delete`, `data.import`, `extension.install`.
- **Seed marker:** `<demo dataDir>/demo-seed.json` = `{ "corpus": "acme", "version": 1, "seededAtMs": <number> }`, written LAST by the seeder.
- **Banner (stderr only, never stdout):** seeded `DEMO — synthetic "Acme" org, not your data · seeded <age> · nimbus demo reset to remove`; stale (older than 24h) `DEMO — synthetic "Acme" org · seeded <age> (stale — briefs may be empty) · run nimbus demo to re-seed`; unseeded `DEMO — not seeded yet · run nimbus demo`.
- **Tour headers:** `── [n/3] <title> ` padded with `─` to 56 characters, then a line `$ <exact command>`, then the brief VERBATIM.
- **Test data NEVER touches real state.** Every test that resolves paths or boots anything sets `APPDATA`/`LOCALAPPDATA`/`HOME`/`USERPROFILE`/`XDG_*`/`TMPDIR`/`TEMP`/`TMP` to temp dirs and verifies the child's `homedir()` premise before booting. Never run `nimbus demo` or `--demo` against this machine's real profile. Never construct a real OS vault.
- **Expected-only noise until the last task:** `audit:doc-refs` errors that point at THIS plan file (it names files later tasks create) and `lint:markdown` findings confined to `docs/superpowers/`. Anything else is real.
- A fresh worktree needs `bun run build:sandbox-helper:win32` (Windows) / `bun run build:sandbox-helper` (POSIX) before the full suite.

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/gateway/src/sync/scheduler.ts` (+ test) | modify | `syncDisabled` option |
| `packages/gateway/src/platform/demo-boot.ts` (+ test) | modify | BootPolicy gains 5 fields |
| `packages/gateway/src/platform/assemble.ts` | modify | scheduler + outbound guards, `ipcOpts.demo` |
| `packages/gateway/src/embedding/create-embedding-runtime.ts` | modify | no embedding runtime for a demo gateway |
| `packages/gateway/src/ipc/server/demo-gate.ts` (+ test) | create | pure refusal decision |
| `packages/gateway/src/ipc/server/options.ts` | modify | `demo?: boolean` |
| `packages/gateway/src/ipc/server/server.ts` (+ server test) | modify | gate at the top of `dispatchMethod` |
| `packages/gateway/src/demo/corpus/types.ts` | create | corpus record types |
| `packages/gateway/src/demo/corpus/acme.ts` (+ `acme.test.ts`) | create | the Acme corpus |
| `packages/gateway/src/demo/seed.ts` (+ `seed.test.ts`) | create | the seeder + marker + demo `nimbus.toml` |
| `packages/gateway/src/ipc/demo-rpc.ts` (+ test) | create | `demo.seed` handler |
| `packages/gateway/src/ipc/server/dispatchers.ts` | modify | `tryDispatchDemoRpc`, demo-only |
| `packages/gateway/src/ipc/lan-rpc.ts` (+ test) | modify | `demo` LAN-forbidden |
| `packages/ui/src-tauri/src/gateway_bridge.rs` | modify (test only) | assert `demo.seed` absent |
| `packages/cli/src/lib/demo-flag.ts` (+ test) | modify | `demo` subcommand sets `NIMBUS_DEMO=1` |
| `packages/cli/src/lib/stop-and-wait.ts` (+ test) | create | signal + wait for exit |
| `packages/cli/src/lib/demo-banner.ts` (+ test) | create | banner text + marker read |
| `packages/cli/src/commands/demo.ts` (+ test) | create | `nimbus demo` |
| `packages/cli/src/index.ts`, `commands/index.ts`, `commands/registry.ts`, `commands/help.ts`, `README.md` | modify | register `demo`, print banner |
| `packages/cli/src/lib/demo-hint.ts` (+ test) and the hint sites in Task 8 | create/modify | demo-aware follow-up hints |
| `packages/gateway/src/engine/run-ask.ts` | modify | demo-aware empty-index guidance |
| `scripts/parity/demo-root.parity.test.ts` | modify | marker filename parity |
| `packages/gateway/src/security-invariants.test.ts`, `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md` | modify | I41 clauses (5)–(6) |
| `packages/gateway/test/e2e/demo-tour.e2e.test.ts` | create | the whole flow, real processes, temp roots |
| `docs/cli-reference.md`, `docs/architecture.md`, `docs/CHANGELOG.md`, `docs/roadmap.md` | modify | docs |

---

### Task 1: A disabled sync scheduler — and a demo gateway that never starts or fills one

**Files:**
- Modify: `packages/gateway/src/sync/scheduler.ts` (constructor options ~127–161; `register` ~220; `start` ~253; `forceSync` ~312; `tick` ~456; `pump` ~526)
- Modify: `packages/gateway/src/sync/scheduler.test.ts`
- Modify: `packages/gateway/src/platform/demo-boot.ts`, `demo-boot.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (`createSchedulerWithMesh`, ~629–890)
- Modify: `packages/gateway/src/security-invariants.test.ts` (the existing I41 clause-4 `bootPolicyFor` expectations only)

**Interfaces:**
- Produces: `SyncScheduler` constructor option `syncDisabled?: boolean`; `export class SyncDisabledError extends Error` (message starts `ERR_SYNC_DISABLED:`); `BootPolicy.syncScheduler: boolean`.

**Why (spec § 11.2):** `tick()`/`pump()` return early only on `stopped`, `forceSync` needs no `start()`, and each finished job's `.finally` calls `tick()` — so an unstarted scheduler still runs a `connector.sync` / `index.rebody` job and then the whole schedule. The choke point must be inside the scheduler, keyed on an explicit option, not on `!started` (existing tests call `forceSync` without `start()`).

- [ ] **Step 1: Write the failing scheduler tests**

In `packages/gateway/src/sync/scheduler.test.ts`, reuse the file's existing fixture helpers (the ones its other tests use to build a `SyncRuntimeContext` and a fake `Syncable` whose `sync` records calls), and add a `describe("syncDisabled", …)` with:

```ts
test("forceSync rejects with ERR_SYNC_DISABLED and never runs the syncable", async () => {
  // build ctx + a recording fake syncable exactly as the neighbouring tests do
  const scheduler = new SyncScheduler(ctx, undefined, { syncDisabled: true });
  scheduler.register(fake);
  await expect(scheduler.forceSync(fake.serviceId)).rejects.toThrow("ERR_SYNC_DISABLED");
  expect(fakeSyncCalls()).toBe(0);
});

test("register writes no scheduler state and start() schedules nothing", async () => {
  const scheduler = new SyncScheduler(ctx, undefined, { syncDisabled: true });
  scheduler.register(fake);
  scheduler.start();
  await new Promise((r) => setTimeout(r, 80)); // > 3 of the 25 ms tick intervals
  expect(fakeSyncCalls()).toBe(0);
  expect(scheduler.getStatus()).toEqual([]);
  await scheduler.stop();
});

test("without the option, behaviour is unchanged (negative control)", async () => {
  const scheduler = new SyncScheduler(ctx, undefined, {});
  scheduler.register(fake);
  await scheduler.forceSync(fake.serviceId);
  expect(fakeSyncCalls()).toBe(1);
  await scheduler.stop();
});
```

Run: `bun test packages/gateway/src/sync/scheduler.test.ts -t "syncDisabled"` → FAIL (unknown option / no rejection). If `getStatus()` is not the right read for "no registration", use whatever the file's other tests use to observe registrations, and say so in the report.

- [ ] **Step 2: Implement `syncDisabled`**

In `scheduler.ts`: add `syncDisabled?: boolean` to the constructor's inline options type with a doc comment ("A scheduler that must never run a job — a demo-rooted gateway (invariant I41). `forceSync` rejects; `register`, `start`, `tick` and `pump` do nothing."); store `private readonly syncDisabled: boolean;` (`options?.syncDisabled === true`). Export:

```ts
export class SyncDisabledError extends Error {
  constructor(serviceId: string) {
    super(`ERR_SYNC_DISABLED: syncing is disabled in this gateway, so ${serviceId} cannot sync`);
    this.name = "SyncDisabledError";
  }
}
```

Then make these the FIRST statements: `register` → `if (this.syncDisabled) return;`; `start` → `if (this.syncDisabled) return;` (before the existing `started`/`stopped` check); `forceSync` → `if (this.syncDisabled) return Promise.reject(new SyncDisabledError(serviceId));`; `tick` and `pump` → change `if (this.stopped) { return; }` to `if (this.stopped || this.syncDisabled) { return; }`.

Run Step 1's command → PASS; then `bun test packages/gateway/src/sync/` → all green.

- [ ] **Step 3: `BootPolicy.syncScheduler`**

`demo-boot.ts`: add `readonly syncScheduler: boolean;` to `BootPolicy` (doc: "construct the scheduler with `syncDisabled`, register no syncable, never `start()` it — a demo gateway must never sync (§ 11.2)") and `syncScheduler: !demo` to the returned object. Update `demo-boot.test.ts` expectations to include the field. In `security-invariants.test.ts`, update ONLY the I41 clause-4 test's two `toEqual` objects to include `syncScheduler: true` / `syncScheduler: false`.

- [ ] **Step 4: Wire `createSchedulerWithMesh`**

`paths` is in scope there (it is on `SchedulerWithMeshOpts`). Add near the top of the function body:

```ts
  // I41 clause (6), spec § 11.2: a demo gateway's scheduler exists (IPC and the post-sync
  // refreshers are built alongside it) but can never run a job.
  const syncEnabled = bootPolicyFor(paths).syncScheduler;
```

Pass `...(syncEnabled ? {} : { syncDisabled: true })` into the `new SyncScheduler(...)` options object. Wrap `registerFilesystemRootSyncables(...)` in `if (syncEnabled) { … }`, and wrap `registerConnectorMeshSyncables(...)`, `registerUserMcpSyncablesFromDatabase(...)` and `syncScheduler.start();` together in ONE `if (syncEnabled) { … }` block. Leave `createLazyConnectorMesh`, `policyFilteredRegistrar` and `evaluateWatchersStartupCatchUp` unconditional. Import `bootPolicyFor` from `./demo-boot.ts` if not already imported. Before editing, `grep -n "syncScheduler.start()\|registerConnectorMeshSyncables(\|registerUserMcpSyncablesFromDatabase(\|registerFilesystemRootSyncables(" packages/gateway/src/platform/assemble.ts` must show one CALL of each (plus the function definitions).

- [ ] **Step 5: Verify + commit**

```bash
bun run typecheck
bun test packages/gateway/src/sync/ packages/gateway/src/platform/demo-boot.test.ts
bun test packages/gateway/src/security-invariants.test.ts -t "I41"
bunx biome check packages/gateway/src/sync/scheduler.ts packages/gateway/src/sync/scheduler.test.ts packages/gateway/src/platform/demo-boot.ts packages/gateway/src/platform/demo-boot.test.ts packages/gateway/src/platform/assemble.ts packages/gateway/src/security-invariants.test.ts
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/sync/scheduler.ts packages/gateway/src/sync/scheduler.test.ts packages/gateway/src/platform/demo-boot.ts packages/gateway/src/platform/demo-boot.test.ts packages/gateway/src/platform/assemble.ts packages/gateway/src/security-invariants.test.ts
git commit -m "feat(sync): a demo gateway's scheduler is disabled, empty and never started"
```

---

### Task 2: No outbound work from a demo gateway's boot

**Files:**
- Modify: `packages/gateway/src/platform/demo-boot.ts`, `demo-boot.test.ts`, `security-invariants.test.ts` (clause-4 expectations only)
- Modify: `packages/gateway/src/platform/assemble.ts` (`wireUpdaterIntoIpc` call ~4279; telemetry flush start ~4282–4290; extensions auto-update ~1950–1964)
- Modify: `packages/gateway/src/embedding/create-embedding-runtime.ts` (`createEmbeddingRuntimeNonBlocking`, `embeddingRuntimeWanted` ~136–148)

**Interfaces:**
- Consumes: Task 1's `BootPolicy`.
- Produces: `BootPolicy.updaterStartupCheck`, `.telemetryFlush`, `.embeddingRuntime`, `.extensionsAutoUpdate` (all `!demo`).

**Why (spec § 11.3 + gateway survey):** these run at BOOT, before `demo.seed` writes any config, so a seeded `nimbus.toml` cannot switch them off: the updater's `checkOnStartup` defaults to `true`; telemetry is env-selectable (`NIMBUS_TELEMETRY_ENABLED`); the embedding runtime downloads `Xenova/all-MiniLM-L6-v2` into `<dataDir>/models`, which for a demo gateway is the empty demo data dir; the extension auto-update daemon is env-selected (`NIMBUS_EXTENSIONS_REGISTRY_URL`). Loopback calls to a local model server (`llmRegistry.refreshProviderMeta`) never leave the machine and are not in scope.

- [ ] **Step 1: Extend the policy (test first)**

In `demo-boot.test.ts`, change both expectations to the full new shape — real: every field `true`; demo: every field `false` — for `reapAppContainers`, `envSidecars`, `syncScheduler`, `updaterStartupCheck`, `telemetryFlush`, `embeddingRuntime`, `extensionsAutoUpdate`. Run → FAIL. Add the four fields (each `readonly …: boolean` with a one-line doc naming the outbound call it prevents) and `!demo` values. Run → PASS. Update the I41 clause-4 `toEqual` objects in `security-invariants.test.ts` to the same full shapes.

- [ ] **Step 2: Guard the three `assemble.ts` sites**

`bootPolicy` is declared in `assemblePlatformServices` (`const bootPolicy = bootPolicyFor(paths);`, ~3146). Locate each site by string and wrap it:
- `wireUpdaterIntoIpc(paths.configDir, ipc, syncLogger);` → `if (bootPolicy.updaterStartupCheck) { wireUpdaterIntoIpc(paths.configDir, ipc, syncLogger); }`. Decided (verified 2026-09-19): `wireUpdaterIntoIpc` builds the updater, calls `ipc.setUpdater(updater)` and runs the startup `checkNow()` — skipping the WHOLE call on a demo gateway is correct, not just the check: `updater.*` methods then answer "Updater is not configured", which is true of a throwaway demo root (it has nothing to update, and updating it would mean fetching a release).
- The telemetry flush: `assemble.ts` ~4282–4290 declares `const telemetryStop = startTelemetryFlushScheduler({…});` and then `sidecarStops.push(telemetryStop.stop);` — BOTH statements move inside ONE `if (bootPolicy.telemetryFlush) { … }` block (wrapping only the call leaves `telemetryStop` undeclared at the push).
- The extensions auto-update daemon block (gated today on `NIMBUS_EXTENSIONS_REGISTRY_URL`) → add `bootPolicy.extensionsAutoUpdate &&` to its condition. If `bootPolicy` is not in scope at that site (it is inside a helper), compute `bootPolicyFor(paths)` there — it is a pure function.

- [ ] **Step 3: No embedding runtime for a demo gateway**

In `create-embedding-runtime.ts`, make `createEmbeddingRuntimeNonBlocking(db, paths, logger)` return exactly what it returns today when `embeddingRuntimeWanted(...)` is false (read the function; do not invent a new "off" value) when `bootPolicyFor(paths).embeddingRuntime === false`, checked FIRST. Add a unit test beside the existing ones: with a `PlatformPaths` literal carrying `demo: true` (temp dirs), the function returns the "no runtime" value and never calls the model loader (use the file's existing loader seam/mocks; if there is none, assert on the returned value only and say so).

- [ ] **Step 4: Verify + commit**

```bash
bun run typecheck
bun test packages/gateway/src/platform/demo-boot.test.ts packages/gateway/src/embedding/ packages/gateway/src/platform/assemble.test.ts
bun test packages/gateway/src/security-invariants.test.ts -t "I41"
bunx biome check packages/gateway/src/platform/demo-boot.ts packages/gateway/src/platform/demo-boot.test.ts packages/gateway/src/platform/assemble.ts packages/gateway/src/embedding/create-embedding-runtime.ts packages/gateway/src/security-invariants.test.ts
git rev-parse --abbrev-ref HEAD
git add -u
git status
git commit -m "feat(gateway): a demo gateway makes no outbound call at boot"
```

---

### Task 3: One refusal gate for connector, vault, import and install writes

**Files:**
- Create: `packages/gateway/src/ipc/server/demo-gate.ts`, `demo-gate.test.ts`
- Modify: `packages/gateway/src/ipc/server/options.ts` (add `demo?: boolean`; the file is type-only — no runtime logic)
- Modify: `packages/gateway/src/ipc/server/server.ts` (`dispatchMethod`, ~139)
- Modify: `packages/gateway/src/ipc/server/server.test.ts`
- Modify: `packages/gateway/src/platform/assemble.ts` (the `ipcOpts` literal ~3388)

**Interfaces:**
- Produces: `export const DEMO_CONNECTOR_READS: ReadonlySet<string>`; `export function demoRefusal(method: string): RpcMethodError | undefined`; `CreateIpcServerOptions.demo?: boolean`.

**Why:** the refused methods live in four different dispatchers (`connector.*` in the connector dispatcher, `connector.reindex` in the reindex dispatcher, `extension.*` in automation, `data.import` in phase-4, `vault.*` in the default arm), so the only single point is the top of `dispatchMethod`. It is an ALLOW-list for `connector.*`, so a connector method added later is refused in demo until someone decides otherwise.

- [ ] **Step 1: Write the failing unit tests**

`packages/gateway/src/ipc/server/demo-gate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { DEMO_CONNECTOR_READS, demoRefusal } from "./demo-gate.ts";
import { RpcMethodError } from "./rpc-error.ts";

/** Every `connector.<x>` literal the IPC layer handles — DERIVED from source, never hand-listed. */
function connectorMethodsInSource(): string[] {
  const root = join(import.meta.dir, "..");
  const found = new Set<string>();
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) {
        for (const m of readFileSync(p, "utf8").matchAll(/"(connector\.[A-Za-z]+)"/g)) {
          if (m[1] !== undefined) found.add(m[1]);
        }
      }
    }
  };
  walk(root);
  return [...found].sort();
}

describe("demoRefusal", () => {
  test("the derived connector method set is non-trivial (premise)", () => {
    const all = connectorMethodsInSource();
    expect(all).toContain("connector.auth");
    expect(all).toContain("connector.sync");
    expect(all).toContain("connector.listStatus");
    expect(all.length).toBeGreaterThanOrEqual(10);
  });

  test("every connector method outside the read allow-list is refused", () => {
    for (const method of connectorMethodsInSource()) {
      const r = demoRefusal(method);
      if (DEMO_CONNECTOR_READS.has(method)) expect(r).toBeUndefined();
      else {
        expect(r).toBeInstanceOf(RpcMethodError);
        expect(r?.message).toContain("ERR_DEMO_FORBIDDEN");
      }
    }
  });

  test("a connector method that does not exist yet is refused (allow-list, not deny-list)", () => {
    expect(demoRefusal("connector.someFutureWrite")).toBeInstanceOf(RpcMethodError);
  });

  test.each(["vault.set", "vault.delete", "data.import", "extension.install"])("%s is refused", (m) => {
    expect(demoRefusal(m)?.rpcCode).toBe(-32000);
  });

  test.each(["gateway.ping", "agents.oncall", "vault.get", "diag.snapshot", "connector.listStatus"])(
    "%s is allowed",
    (m) => {
      expect(demoRefusal(m)).toBeUndefined();
    },
  );
});
```

Run → FAIL (module missing).

- [ ] **Step 2: Implement `demo-gate.ts`**

```ts
import { RpcMethodError } from "./rpc-error.ts";

/**
 * The only `connector.*` methods a demo-rooted gateway serves (invariant I41 clause 6). An
 * ALLOW-list: a connector method added later is refused in the demo until someone decides
 * otherwise, instead of silently becoming a way to put real data into a root labelled
 * "not your data".
 */
export const DEMO_CONNECTOR_READS: ReadonlySet<string> = new Set([
  "connector.listStatus",
  "connector.status",
  "connector.healthHistory",
]);

/** Writes outside `connector.*` that would bring real credentials or real data into the demo root. */
const DEMO_REFUSED_METHODS: ReadonlySet<string> = new Set([
  "vault.set",
  "vault.delete",
  "data.import",
  "extension.install",
]);

/** The refusal for `method` on a demo-rooted gateway, or `undefined` when it may proceed. */
export function demoRefusal(method: string): RpcMethodError | undefined {
  const refused =
    (method.startsWith("connector.") && !DEMO_CONNECTOR_READS.has(method)) ||
    DEMO_REFUSED_METHODS.has(method);
  if (!refused) return undefined;
  return new RpcMethodError(
    -32000,
    `ERR_DEMO_FORBIDDEN: ${method} is not available in the demo root, which holds only the synthetic "Acme" org. Run it without --demo to use your real install.`,
    { kind: "demo_forbidden", method },
  );
}
```

Run Step 1 → PASS.

- [ ] **Step 3: Wire the gate**

`options.ts`: add `demo?: boolean;` with a doc line ("true only when the gateway is demo-rooted (`PlatformPaths.demo`); enables the demo refusal gate and the demo-only `demo.*` namespace — invariant I41"). `server.ts` `dispatchMethod`: as the FIRST statements after `const params = req.params;` (before the `session.declareKind` check):

```ts
    // I41 clause (6): a demo-rooted gateway refuses writes that would bring real credentials or
    // real data into a root labelled "not your data". The one routing choke point: the refused
    // methods are spread across four dispatchers.
    if (ctx.options.demo === true) {
      const refusal = demoRefusal(method);
      if (refusal !== undefined) throw refusal;
    }
```

`assemble.ts`: add `demo: paths.demo === true,` to the `ipcOpts` object literal.

- [ ] **Step 4: Prove it over a real socket**

In `server.test.ts`, following its existing `createIpcServer` + `exchangeFirstNdjsonLine` pattern, add: a server with `demo: true` answers `connector.auth` with error code `-32000` and a message containing `ERR_DEMO_FORBIDDEN`, and `gateway.ping` succeeds; the SAME `connector.auth` request to a server WITHOUT `demo` does NOT return `-32000` (negative control — whatever it returns today). Run the file → PASS.

- [ ] **Step 5: Verify + commit**

```bash
bun run typecheck
bun test packages/gateway/src/ipc/server/
bunx biome check packages/gateway/src/ipc/server/ packages/gateway/src/platform/assemble.ts
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/ipc/server/demo-gate.ts packages/gateway/src/ipc/server/demo-gate.test.ts packages/gateway/src/ipc/server/options.ts packages/gateway/src/ipc/server/server.ts packages/gateway/src/ipc/server/server.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "feat(ipc): refuse connector, vault, import and install writes on a demo gateway"
```

---

### Task 4: The Acme corpus

**Files:**
- Create: `packages/gateway/src/demo/corpus/types.ts`
- Create: `packages/gateway/src/demo/corpus/acme.ts`
- Create: `packages/gateway/src/demo/corpus/acme.test.ts`

**Interfaces:**
- Produces: the types below and `export function buildAcmeCorpus(): DemoCorpus`; `export const ACME_TOUR: { readonly whyRef: string; readonly ownersPath: string }`.

- [ ] **Step 1: The types**

`packages/gateway/src/demo/corpus/types.ts`:

```ts
/**
 * The synthetic demo corpus (spec § 4.2). Every time is an OFFSET from the seed's `nowMs`
 * (negative = in the past) — never an absolute epoch — so a corpus seeded on any day reads as
 * "today" to agents whose windows are 24h / 48h / 3d / 90d.
 */
export type At = (offsetMs: number) => number;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export interface DemoPerson {
  readonly key: string;
  readonly email: string; // must end in ".example"
  readonly displayName: string;
  readonly githubLogin: string;
  readonly slackHandle: string;
}

export interface DemoService {
  readonly id: string; // the [metrics.dora.<id>] id and the deployment `nimbus_service_id`
  readonly repo: string; // "acme/<name>" — the github URN is `github:${repo}`
  readonly pagerdutyServiceId: string;
}

export interface DemoItem {
  readonly service: string;
  readonly type: string;
  readonly externalId: string;
  readonly title: string;
  readonly body: string;
  readonly offsetMs: number;
  readonly authorKey?: string;
  readonly url?: string;
  /** Built at seed time so time-valued metadata is offset-derived too. */
  readonly metadata?: (at: At) => Record<string, unknown>;
}

export interface DemoCommit {
  readonly sha: string; // 40 hex
  readonly authorKey: string;
  readonly subject: string;
  readonly offsetMs: number;
}

export interface DemoFile {
  readonly path: string; // POSIX, relative to the workspace root
  readonly lines: readonly string[];
  /** One commit sha per line (same length as `lines`) — the blame. */
  readonly blame: readonly string[];
}

export interface DemoDeployment {
  readonly serviceId: string;
  readonly sha: string;
  readonly offsetMs: number;
  readonly status: "success" | "failure";
  readonly runId: string;
}

export interface DemoCorpus {
  readonly people: readonly DemoPerson[];
  readonly meKey: string;
  readonly services: readonly DemoService[];
  readonly commits: readonly DemoCommit[];
  readonly files: readonly DemoFile[];
  /** Written in this order — issues before PRs (the `resolves` edge), PRs/commits before messages (`mentions`). */
  readonly issues: readonly DemoItem[];
  readonly pullRequests: readonly DemoItem[];
  readonly reviews: readonly DemoItem[];
  readonly ciRuns: readonly DemoItem[];
  readonly deployments: readonly DemoDeployment[];
  readonly incidents: readonly DemoItem[];
  readonly messages: readonly DemoItem[];
  /** PagerDuty freshness: offset of `sync_state.last_sync_at` for connector `pagerduty`. */
  readonly pagerdutyLastSyncOffsetMs: number;
}
```

- [ ] **Step 2: The corpus**

`packages/gateway/src/demo/corpus/acme.ts` — write it exactly (the background section is generated deterministically; the storyline is literal):

```ts
import { createHash } from "node:crypto";

import { PAGERDUTY_INCIDENT_META_VERSION } from "../../connectors/pagerduty-attribution.ts";
import {
  DAY,
  type DemoCommit,
  type DemoCorpus,
  type DemoDeployment,
  type DemoFile,
  type DemoItem,
  type DemoPerson,
  type DemoService,
  HOUR,
  MINUTE,
} from "./types.ts";

/**
 * "Acme" — a fictional org seeded by `nimbus demo` (spec § 4.3). One connected storyline every
 * tour brief reaches from a different angle:
 *   ticket PAY-231 → PR #412 (Dana) changes src/retry/backoff.ts → merged → deployed to
 *   payment-service at T−47m → P1 at T−38m assigned to the demo persona (Sam) → chat names the
 *   service → a same-service incident 3 weeks earlier → all blame on src/retry is Dana's (bus factor 1).
 * Everything else is background so standup / expert / stats / changelog / glossary / decisions
 * have real content. Nothing here is real: every domain is `.example`.
 */

/** Deterministic 40-hex sha for a label (not a real commit). */
function sha(label: string): string {
  return createHash("sha1").update(`acme-demo:${label}`).digest("hex");
}

const person = (key: string, first: string, last: string): DemoPerson => ({
  key,
  email: `${first.toLowerCase()}.${last.toLowerCase()}@acme.example`,
  displayName: `${first} ${last}`,
  githubLogin: `${first.toLowerCase()}-${last.toLowerCase()}`,
  slackHandle: first.toLowerCase(),
});

const PEOPLE: readonly DemoPerson[] = [
  person("sam", "Sam", "Rivera"), // the demo persona ("me")
  person("dana", "Dana", "Okafor"),
  person("lee", "Lee", "Chen"),
  person("priya", "Priya", "Nair"),
  person("marco", "Marco", "Bianchi"),
  person("yuki", "Yuki", "Tanaka"),
  person("omar", "Omar", "Haddad"),
  person("ines", "Ines", "Duarte"),
];

const SERVICES: readonly DemoService[] = [
  { id: "payment-service", repo: "acme/payments", pagerdutyServiceId: "PPAYDEMO" },
  { id: "checkout-web", repo: "acme/checkout-web", pagerdutyServiceId: "PCHKDEMO" },
  { id: "ledger-worker", repo: "acme/ledger", pagerdutyServiceId: "PLEDDEMO" },
];

export const ACME_TOUR = { whyRef: "src/retry/backoff.ts:42", ownersPath: "src/retry" } as const;

const SHA_RETRY_BASE = sha("retry-base");
const SHA_412 = sha("pr-412");

const BACKOFF_LINES: readonly string[] = [
  "// Retry backoff for card-authorization calls to the payment service provider (PSP).",
  "//",
  '// Synthetic demo file: part of the fictional "Acme" org seeded by `nimbus demo`.',
  "// Nothing here is real code from any real company.",
  "",
  "export const BASE_BACKOFF_MS = 250;",
  "export const MAX_BACKOFF_MS = 8_000;",
  "export const MAX_ATTEMPTS = 6;",
  "",
  "export type RetryDecision =",
  "  | { readonly retry: true; readonly delayMs: number }",
  "  | { readonly retry: false; readonly reason: string };",
  "",
  "/**",
  " * Whether a failed PSP call is worth retrying at all. Card declines are final;",
  " * timeouts and 5xx responses are not.",
  " */",
  'export function isRetryable(status: number | "timeout"): boolean {',
  '  if (status === "timeout") return true;',
  "  return status >= 500 && status !== 501;",
  "}",
  "",
  "/**",
  " * Exponential backoff with a hard ceiling.",
  " *",
  " * History: before PAY-231 the ceiling was 60s, and a PSP brown-out turned",
  " * every in-flight charge into a minute-long retry loop. PR #412 lowered the",
  " * ceiling to 8s so a brown-out surfaces as errors instead of a stuck queue.",
  " */",
  "export function nextBackoff(",
  "  attempt: number,",
  '  status: number | "timeout",',
  "): RetryDecision {",
  "  if (!isRetryable(status)) {",
  "    return { retry: false, reason: `status ${String(status)} is final` };",
  "  }",
  "  if (attempt >= MAX_ATTEMPTS) {",
  '    return { retry: false, reason: "attempts exhausted" };',
  "  }",
  "  const base = BASE_BACKOFF_MS;",
  "  // Capped: see the history note above.",
  "  const delayMs = Math.min(base * 2 ** attempt, MAX_BACKOFF_MS);",
  "  return { retry: true, delayMs };",
  "}",
];
/** Line 42 (1-based) is the capped `delayMs` — the line the tour asks `why` about. */
const BACKOFF_412_LINES = new Set([7, 26, 27, 28, 42]);

const JITTER_LINES: readonly string[] = [
  '// Synthetic demo file: part of the fictional "Acme" org seeded by `nimbus demo`.',
  "",
  "/** Full jitter: a uniformly random delay in [0, capMs). */",
  "export function withJitter(capMs: number, random: () => number = Math.random): number {",
  "  return Math.floor(random() * capMs);",
  "}",
];

const HANDLER_LINES: readonly string[] = [
  '// Synthetic demo file: part of the fictional "Acme" org seeded by `nimbus demo`.',
  "",
  'import { nextBackoff } from "../retry/backoff.ts";',
  "",
  "export async function authorizeCharge(attempt: number, call: () => Promise<number>) {",
  "  const status = await call();",
  "  if (status < 300) return { ok: true as const };",
  "  const decision = nextBackoff(attempt, status);",
  "  return decision.retry ? { ok: false as const, retryInMs: decision.delayMs } : { ok: false as const };",
  "}",
];

const SHA_HANDLER_PRIYA = sha("handler-priya");
const SHA_HANDLER_MARCO = sha("handler-marco");
const SHA_HANDLER_LEE = sha("handler-lee");

const FILES: readonly DemoFile[] = [
  {
    path: "src/retry/backoff.ts",
    lines: BACKOFF_LINES,
    blame: BACKOFF_LINES.map((_, i) => (BACKOFF_412_LINES.has(i + 1) ? SHA_412 : SHA_RETRY_BASE)),
  },
  { path: "src/retry/jitter.ts", lines: JITTER_LINES, blame: JITTER_LINES.map(() => SHA_RETRY_BASE) },
  {
    path: "src/charges/handler.ts",
    lines: HANDLER_LINES,
    blame: HANDLER_LINES.map((_, i) =>
      i < 4 ? SHA_HANDLER_PRIYA : i < 7 ? SHA_HANDLER_MARCO : SHA_HANDLER_LEE,
    ),
  },
];

const COMMITS: readonly DemoCommit[] = [
  { sha: SHA_RETRY_BASE, authorKey: "dana", subject: "Add exponential backoff for PSP calls", offsetMs: -60 * DAY },
  { sha: SHA_412, authorKey: "dana", subject: "Cap PSP retry backoff at 8s (PAY-231)", offsetMs: -3 * HOUR },
  { sha: SHA_HANDLER_PRIYA, authorKey: "priya", subject: "Add charge authorization handler", offsetMs: -40 * DAY },
  { sha: SHA_HANDLER_MARCO, authorKey: "marco", subject: "Retry card authorization on 5xx", offsetMs: -20 * DAY },
  { sha: SHA_HANDLER_LEE, authorKey: "lee", subject: "Surface retry delay to the caller", offsetMs: -10 * DAY },
];

const PR_URL = (repo: string, n: number): string => `https://github.example/${repo}/pull/${String(n)}`;

// ---------------------------------------------------------------------------------------------
// The storyline
// ---------------------------------------------------------------------------------------------

const STORY_ISSUES: readonly DemoItem[] = [
  {
    service: "linear",
    type: "issue",
    externalId: "PAY-231",
    title: "PAY-231: retry storms on card-authorization timeouts",
    body: "During the last PSP brown-out every in-flight charge retried for up to 60s. Cap the backoff.",
    offsetMs: -9 * DAY,
    authorKey: "priya",
    metadata: (at) => ({ key: "PAY-231", state: "done", created_at_ms: at(-9 * DAY) }),
  },
];

const STORY_PRS: readonly DemoItem[] = [
  {
    service: "github",
    type: "pr",
    externalId: "acme/payments#412",
    title: "Cap PSP retry backoff at 8s (PAY-231)",
    body: "Fixes PAY-231. Lowers MAX_BACKOFF_MS from 60s to 8s so a PSP brown-out surfaces as errors instead of a stuck queue.",
    offsetMs: -3 * HOUR,
    authorKey: "dana",
    url: PR_URL("acme/payments", 412),
    metadata: (at) => ({
      number: 412,
      repo: "acme/payments",
      state: "merged",
      draft: false,
      merged: true,
      merged_at: at(-3 * HOUR),
      merge_commit_sha: SHA_412,
      additions: 18,
      deletions: 6,
      changed_files: 2,
      labels: [],
    }),
  },
];

const STORY_REVIEWS: readonly DemoItem[] = [
  {
    service: "github",
    type: "review",
    externalId: "acme/payments#412/review-1",
    title: "Review: Cap PSP retry backoff at 8s (PAY-231)",
    body: "Approved. 8s matches the PSP's own client timeout.",
    offsetMs: -(3 * HOUR + 30 * MINUTE),
    authorKey: "lee",
    metadata: () => ({ repo: "acme/payments", pr_number: 412, state: "APPROVED" }),
  },
];

const STORY_DEPLOY: DemoDeployment = {
  serviceId: "payment-service",
  sha: SHA_412,
  offsetMs: -47 * MINUTE,
  status: "success",
  runId: "7412",
};

const incident = (
  externalId: string,
  title: string,
  offsetMs: number,
  status: "triggered" | "resolved",
  assigneeKey: string,
  pagerdutyServiceId: string,
  resolvedByKey?: string,
): DemoItem => ({
  service: "pagerduty",
  type: "incident",
  externalId,
  title,
  body: status,
  offsetMs,
  metadata: (at) => ({
    incidentId: externalId,
    status,
    severity: "P1",
    urgency: "high",
    opened_at_ms: at(offsetMs),
    pagerduty_service_id: pagerdutyServiceId,
    assignee_emails: [emailOf(assigneeKey)],
    ...(resolvedByKey === undefined ? {} : { resolved_by_email: emailOf(resolvedByKey) }),
    unattributed_actors: [],
    meta_v: PAGERDUTY_INCIDENT_META_VERSION,
  }),
});

function emailOf(key: string): string {
  const p = PEOPLE.find((x) => x.key === key);
  if (p === undefined) throw new Error(`acme corpus: unknown person ${key}`);
  return p.email;
}

const STORY_INCIDENTS: readonly DemoItem[] = [
  incident("PDEMO412", "payment-service: 5xx rate above 5% on /v1/charges", -38 * MINUTE, "triggered", "sam", "PPAYDEMO"),
  incident("PDEMO301", "payment-service: charge latency p99 above 4s", -21 * DAY, "resolved", "lee", "PPAYDEMO", "lee"),
];

const message = (id: string, channel: string, authorKey: string, offsetMs: number, text: string): DemoItem => ({
  service: "slack",
  type: "message",
  externalId: `${channel}/${id}`,
  title: text.length > 80 ? `${text.slice(0, 77)}...` : text,
  body: text,
  offsetMs,
  authorKey,
  metadata: () => ({ channel }),
});

const STORY_MESSAGES: readonly DemoItem[] = [
  message("m1", "payments-incidents", "sam", -35 * MINUTE, "Paged: payment-service 5xx above 5% on /v1/charges. Looking now."),
  message("m2", "payments-incidents", "dana", -31 * MINUTE, "PR #412 (PAY-231) went out to payment-service about ten minutes before the alert. Checking whether the 8s cap is involved."),
  message("m3", "payments-incidents", "lee", -22 * MINUTE, "payment-service errors are all PSP timeouts. Same shape as the incident three weeks ago."),
];

// ---------------------------------------------------------------------------------------------
// Background (deterministic)
// ---------------------------------------------------------------------------------------------

const BACKGROUND_TITLES: readonly string[] = [
  "Add idempotency key to refund endpoint",
  "Tighten PSP timeout budget for tokenization",
  "Batch ledger writes per settlement window",
  "Remove the legacy 3DS fallback path",
  "Emit charge latency histogram per PSP",
  "Make the checkout retry banner dismissible",
  "Cache FX rates for five minutes",
  "Split refund reconciliation into its own job",
  "Reject duplicate webhook deliveries",
  "Move ledger-worker to at-least-once delivery",
  "Guard against negative settlement amounts",
  "Log PSP decline codes without card data",
];
const AUTHOR_ROTATION: readonly string[] = ["dana", "lee", "priya", "marco", "yuki", "omar", "ines", "sam"];

function background(): {
  prs: DemoItem[];
  reviews: DemoItem[];
  ciRuns: DemoItem[];
  deployments: DemoDeployment[];
  incidents: DemoItem[];
} {
  const prs: DemoItem[] = [];
  const reviews: DemoItem[] = [];
  const ciRuns: DemoItem[] = [];
  const deployments: DemoDeployment[] = [];
  const incidents: DemoItem[] = [];
  let n = 300;
  for (const [si, svc] of SERVICES.entries()) {
    for (let k = 0; k < 12; k++) {
      n += 1;
      const offsetMs = -(k * 5 + si + 1) * DAY;
      const authorKey = AUTHOR_ROTATION[(k + si) % AUTHOR_ROTATION.length] ?? "dana";
      const reviewerKey = AUTHOR_ROTATION[(k + si + 3) % AUTHOR_ROTATION.length] ?? "lee";
      const title = BACKGROUND_TITLES[(k + si * 4) % BACKGROUND_TITLES.length] ?? "Maintenance";
      const mergeSha = sha(`${svc.repo}#${String(n)}`);
      const runId = String(8000 + n);
      prs.push({
        service: "github",
        type: "pr",
        externalId: `${svc.repo}#${String(n)}`,
        title,
        body: `${title}. Part of routine ${svc.id} maintenance.`,
        offsetMs,
        authorKey,
        url: PR_URL(svc.repo, n),
        metadata: (at) => ({
          number: n,
          repo: svc.repo,
          state: "merged",
          draft: false,
          merged: true,
          merged_at: at(offsetMs),
          merge_commit_sha: mergeSha,
          additions: 20 + k * 3,
          deletions: 4 + k,
          changed_files: 1 + (k % 4),
          labels: [],
        }),
      });
      reviews.push({
        service: "github",
        type: "review",
        externalId: `${svc.repo}#${String(n)}/review-1`,
        title: `Review: ${title}`,
        body: "Looks good.",
        offsetMs: offsetMs - HOUR,
        authorKey: reviewerKey,
        metadata: () => ({ repo: svc.repo, pr_number: n, state: "APPROVED" }),
      });
      const failed = svc.id === "payment-service" && k === 2;
      ciRuns.push({
        service: "github_actions",
        type: "ci_run",
        externalId: `${svc.repo}:run-${runId}`,
        title: "Deploy production",
        body: failed ? "failure" : "success",
        offsetMs: offsetMs + 2 * HOUR,
        metadata: () => ({ conclusion: failed ? "failure" : "success", repo: svc.repo, headSha: mergeSha }),
      });
      deployments.push({
        serviceId: svc.id,
        sha: mergeSha,
        offsetMs: offsetMs + 2 * HOUR,
        status: failed ? "failure" : "success",
        runId,
      });
      if (failed) {
        incidents.push(
          incident(`PDEMO${String(n)}`, `${svc.id}: settlement job failing after deploy`, offsetMs + 2 * HOUR + 20 * MINUTE, "resolved", "omar", svc.pagerdutyServiceId, "omar"),
        );
      }
    }
  }
  return { prs, reviews, ciRuns, deployments, incidents };
}

/** "Me" in the last 24h: an open PR, a review, a ticket and chat — standup's lanes. */
const SAM_TODAY_PRS: readonly DemoItem[] = [
  {
    service: "github",
    type: "pr",
    externalId: "acme/payments#415",
    title: "Add a circuit breaker around PSP authorization",
    body: "Follow-up to PAY-231: stop calling the PSP for 30s after five consecutive timeouts.",
    offsetMs: -5 * HOUR,
    authorKey: "sam",
    url: PR_URL("acme/payments", 415),
    metadata: () => ({ number: 415, repo: "acme/payments", state: "open", draft: false, merged: false, labels: [] }),
  },
];
const SAM_TODAY_REVIEWS: readonly DemoItem[] = [
  {
    service: "github",
    type: "review",
    externalId: "acme/checkout-web#309/review-2",
    title: "Review: Make the checkout retry banner dismissible",
    body: "Approved with one nit on the copy.",
    offsetMs: -6 * HOUR,
    authorKey: "sam",
    metadata: () => ({ repo: "acme/checkout-web", pr_number: 309, state: "APPROVED" }),
  },
];
const SAM_TODAY_ISSUES: readonly DemoItem[] = [
  {
    service: "linear",
    type: "issue",
    externalId: "PAY-240",
    title: "PAY-240: alert on PSP timeout rate, not only on 5xx",
    body: "Today's page fired on 5xx; the PSP timeout rate moved ten minutes earlier.",
    offsetMs: -2 * HOUR,
    authorKey: "sam",
    metadata: (at) => ({ key: "PAY-240", state: "todo", created_at_ms: at(-2 * HOUR) }),
  },
];

/** Glossary (a term needs >= 3 source docs) and decisions (snippet extraction reads "decided"). */
const KNOWLEDGE_MESSAGES: readonly DemoItem[] = [
  message("k1", "payments-eng", "priya", -12 * DAY, "Reminder: the PSP (payment service provider) timeout budget is 8s end to end."),
  message("k2", "payments-eng", "dana", -11 * DAY, "The PSP brown-out last month is why PAY-231 exists."),
  message("k3", "payments-eng", "lee", -10 * DAY, "Every PSP call needs an idempotency key, including retries."),
  message("k4", "ledger", "omar", -9 * DAY, "An idempotency key on the ledger write lets us retry settlement safely."),
  message("k5", "checkout", "ines", -8 * DAY, "Checkout now sends the idempotency key it received from the cart service."),
  message("k6", "payments-eng", "dana", -7 * DAY, "We decided to keep the 8s retry ceiling and add a circuit breaker instead of raising it."),
  message("k7", "ledger", "omar", -6 * DAY, "We decided to move ledger-worker to at-least-once delivery and dedupe on the idempotency key."),
];

export function buildAcmeCorpus(): DemoCorpus {
  const bg = background();
  return {
    people: PEOPLE,
    meKey: "sam",
    services: SERVICES,
    commits: COMMITS,
    files: FILES,
    issues: [...STORY_ISSUES, ...SAM_TODAY_ISSUES],
    pullRequests: [...bg.prs, ...STORY_PRS, ...SAM_TODAY_PRS],
    reviews: [...bg.reviews, ...STORY_REVIEWS, ...SAM_TODAY_REVIEWS],
    ciRuns: bg.ciRuns,
    deployments: [...bg.deployments, STORY_DEPLOY],
    incidents: [...bg.incidents, ...STORY_INCIDENTS],
    messages: [...KNOWLEDGE_MESSAGES, ...STORY_MESSAGES],
    pagerdutyLastSyncOffsetMs: -2 * MINUTE,
  };
}
```

- [ ] **Step 3: Corpus hygiene tests**

`packages/gateway/src/demo/corpus/acme.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ACME_TOUR, buildAcmeCorpus } from "./acme.ts";

const corpus = buildAcmeCorpus();
const SOURCE = readFileSync(join(import.meta.dir, "acme.ts"), "utf8");
const allItems = [
  ...corpus.issues,
  ...corpus.pullRequests,
  ...corpus.reviews,
  ...corpus.ciRuns,
  ...corpus.incidents,
  ...corpus.messages,
];

describe("acme corpus hygiene", () => {
  test("no absolute timestamp anywhere in the corpus source (only offsets)", () => {
    // A 12+ digit literal would be an epoch-ms constant; Date constructors would anchor to a day.
    expect(SOURCE).not.toMatch(/\b\d{12,}\b/);
    expect(SOURCE).not.toMatch(/new Date\(|Date\.UTC\(|Date\.now\(/);
  });

  test("every email and URL is on a .example domain", () => {
    for (const p of corpus.people) expect(p.email.endsWith(".example")).toBe(true);
    for (const i of allItems) {
      if (i.url !== undefined) expect(new URL(i.url).hostname.endsWith(".example")).toBe(true);
    }
    for (const m of SOURCE.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      expect(m[1]?.endsWith(".example")).toBe(true);
    }
  });

  test("every referenced person exists", () => {
    const keys = new Set(corpus.people.map((p) => p.key));
    expect(keys.has(corpus.meKey)).toBe(true);
    for (const i of allItems) if (i.authorKey !== undefined) expect(keys.has(i.authorKey)).toBe(true);
    for (const c of corpus.commits) expect(keys.has(c.authorKey)).toBe(true);
  });

  test("every blame entry names a known commit, one per line", () => {
    const shas = new Set(corpus.commits.map((c) => c.sha));
    for (const f of corpus.files) {
      expect(f.blame).toHaveLength(f.lines.length);
      for (const s of f.blame) expect(shas.has(s)).toBe(true);
      expect(f.lines[0]).toContain("Synthetic demo file");
    }
  });

  test("the tour targets exist: why-line 42 is the capped delay, owners dir has a file", () => {
    const [file, line] = ACME_TOUR.whyRef.split(":");
    const f = corpus.files.find((x) => x.path === file);
    expect(f?.lines[Number(line) - 1]).toContain("MAX_BACKOFF_MS");
    expect(corpus.files.some((x) => x.path.startsWith(`${ACME_TOUR.ownersPath}/`))).toBe(true);
  });

  test("all blame under the owners dir is ONE author (bus factor 1)", () => {
    const authorBySha = new Map(corpus.commits.map((c) => [c.sha, c.authorKey]));
    const authors = new Set(
      corpus.files
        .filter((f) => f.path.startsWith(`${ACME_TOUR.ownersPath}/`))
        .flatMap((f) => f.blame.map((s) => authorBySha.get(s))),
    );
    expect([...authors]).toEqual(["dana"]);
  });

  test("the paging incident is assigned to me and opened after the story deploy", () => {
    const at = (o: number): number => 1_000 + o; // any base — only ordering matters
    const page = corpus.incidents.find((i) => i.externalId === "PDEMO412");
    const meta = page?.metadata?.(at);
    const me = corpus.people.find((p) => p.key === corpus.meKey);
    expect(meta?.["assignee_emails"]).toEqual([me?.email]);
    const deploy = corpus.deployments.find((d) => d.runId === "7412");
    expect((deploy?.offsetMs ?? 0) < (page?.offsetMs ?? 0)).toBe(true);
  });

  test("external ids are unique per service/type", () => {
    const ids = allItems.map((i) => `${i.service}:${i.type}:${i.externalId}`);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
```

(The test file itself uses `1_000` and `Date` nowhere as an anchor; the no-absolute-timestamp scan reads `acme.ts` only.)

Run: `bun test packages/gateway/src/demo/corpus/` → PASS. Fix the CORPUS (not the tests) if any assertion fails, and say what you changed.

- [ ] **Step 4: Verify + commit**

```bash
bun run typecheck
bunx biome check packages/gateway/src/demo/
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/demo/corpus/
git commit -m "feat(demo): the synthetic Acme corpus, offsets only, .example only"
```

---

### Task 5: The seeder — production write APIs, the demo `nimbus.toml`, the marker

**Files:**
- Create: `packages/gateway/src/demo/seed.ts`, `packages/gateway/src/demo/seed.test.ts`

**Interfaces:**
- Consumes: Task 4's `buildAcmeCorpus`, `ACME_TOUR`, types.
- Produces:
  - `export const DEMO_SEED_MARKER = "demo-seed.json";`
  - `export class DemoSeedRefusedError extends Error` (message starts `ERR_DEMO_ALREADY_SEEDED:`)
  - `export interface DemoSeedResult { readonly seededAtMs: number; readonly corpus: "acme"; readonly counts: { readonly people: number; readonly items: number; readonly blameLines: number; readonly deployments: number }; readonly tour: { readonly whyRef: string; readonly ownersPath: string }; readonly workspaceRoot: string }`
  - `export async function seedDemoCorpus(db: Database, opts: { readonly configDir: string; readonly dataDir: string; readonly nowMs: number }): Promise<DemoSeedResult>`

**Facts the code depends on (verified 2026-09-19):**
- `upsertIndexedItem(db, row)` (`index/item-store.ts`) needs `service,type,externalId,title,modifiedAt,syncedAt`, `body` (full) or `bodyPreview`; `authorId` is a person id; it runs the graph populators. Write order matters: persons → issues → commits/PRs → reviews → messages.
- `insertPerson(db, {id, displayName, canonicalEmail, githubLogin, gitlabLogin, slackHandle, linearMemberId, jiraAccountId, notionUserId, linked, metadata})` (`people/person-store.ts`) — plain INSERT; production id `uuidV5(\`email:${email}\`, NIMBUS_PERSON_NAMESPACE_UUID)` from `people/person-id.ts`.
- `upsertBlameLines(db, repoRoot, filePath, rows: {lineNo, commitSha, authorName, authorEmail, authorTimeMs}[])` (`security/blame-store.ts`); `repoRoot` must equal the configured root VERBATIM.
- `git_commit` items: `{service:"filesystem", type:"git_commit", externalId:\`${sha}_r1\`, metadata:{repoRoot, sha, subject}}` (the `why` e2e seeder's shape).
- `annotateDeployment(db, {service, provider:"github-actions", environment, sha, ref, status, started_at_ms, finished_at_ms, run_id}, nowMs)` (`deployment/annotate.ts`) writes the `deployment` item + `deployment_items` row with `nimbus_service_id = service`. It stores `ci_run_external_id = NULL`, so oncall's CI lane is honestly EMPTY for the story deploy — do not hand-craft rows to hide that.
- oncall freshness: `sync_state.last_sync_at` for `connector_id='pagerduty'` has no production writer; write it with `dbRun`.
- The TOML key is `[user] me_person_id` (NOT `mePersonId`). `[metrics.dora.<id>]` rejects unknown keys and requires `repos`.
- `runOwnershipPass(db, {nowMs, roots, config, serviceRepoUrns, spawn?})`; the ownership e2e passes `config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] }` and a `spawn` that throws — copy that shape from `packages/gateway/test/e2e/scenarios/ownership.e2e.test.ts`.
- `runGlossaryPass(db, {...cfg knobs, configDir, nowMs})` with `cfg = loadNimbusGlossaryFromConfigDir(configDir)` and NO `llm` (snippet fallback) — copy the option shape `platform/assemble.ts` builds (~676–689). `runDecisionPass(db, {nowMs, useLlm: false, maxLlmCalls: cfg.maxLlmCallsPerPass, retryCooldownMs: cfg.retryCooldownMs})` with `cfg = loadNimbusDecisionsFromConfigDir(configDir)`.
- A backslash inside a TOML basic string is an escape: write paths with forward slashes, then READ THE ROOT BACK through `loadNimbusFilesystemRootsFromConfigDir(configDir)` and use that exact string as `repoRoot`.

- [ ] **Step 1: Write the failing integration test**

`packages/gateway/src/demo/seed.test.ts` — real migrated SQLite, temp dirs only:

```ts
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { loadNimbusServiceConfigsFromConfigDir } from "../config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { DAY } from "./corpus/types.ts";
import { DEMO_SEED_MARKER, DemoSeedRefusedError, seedDemoCorpus } from "./seed.ts";

let dbs: Database[] = [];
let roots: string[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

function fresh(): { db: Database; configDir: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "nimbus-demo-seed-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  return { db, configDir, dataDir };
}

function count(db: Database, sql: string, params: unknown[] = []): number {
  const row = db.query(sql).get(...(params as [])) as { n: number } | null;
  return row?.n ?? 0;
}

describe("seedDemoCorpus", () => {
  test("seeds people, items, blame, deployments, and writes the demo nimbus.toml + marker", async () => {
    const { db, configDir, dataDir } = fresh();
    const nowMs = 5 * DAY * 365;
    const r = await seedDemoCorpus(db, { configDir, dataDir, nowMs });
    expect(r.counts.people).toBe(8);
    expect(count(db, "SELECT COUNT(*) AS n FROM item")).toBeGreaterThan(80);
    expect(count(db, "SELECT COUNT(*) AS n FROM git_blame_line")).toBeGreaterThan(40);
    expect(count(db, "SELECT COUNT(*) AS n FROM deployment_items")).toBe(r.counts.deployments);
    expect(r.tour).toEqual({ whyRef: "src/retry/backoff.ts:42", ownersPath: "src/retry" });

    // The files `why` needs on disk exist under the configured root, read back through the real loader.
    const [root] = loadNimbusFilesystemRootsFromConfigDir(configDir);
    expect(root?.path).toBe(r.workspaceRoot);
    expect(existsSync(join(r.workspaceRoot, "src", "retry", "backoff.ts"))).toBe(true);

    // The demo config parses through the REAL loaders (unknown keys would throw).
    const services = loadNimbusServiceConfigsFromConfigDir(configDir);
    expect([...services.keys()].sort()).toEqual(["checkout-web", "ledger-worker", "payment-service"]);
    const toml = readFileSync(join(configDir, "nimbus.toml"), "utf8");
    expect(toml).toContain("me_person_id");
    expect(toml).toMatch(/\[embedding\][\s\S]*enabled = false/);

    const marker = JSON.parse(readFileSync(join(dataDir, DEMO_SEED_MARKER), "utf8")) as unknown;
    expect(marker).toEqual({ corpus: "acme", version: 1, seededAtMs: nowMs });
  });

  test("the paging incident is linked to the demo persona through the graph", async () => {
    const { db, configDir, dataDir } = fresh();
    await seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 });
    const assigned = count(
      db,
      `SELECT COUNT(*) AS n FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id
         JOIN graph_entity ie ON ie.id = r.to_id
        WHERE r.type = 'assigned' AND pe.type = 'person' AND ie.external_id LIKE '%PDEMO412%'`,
    );
    expect(assigned).toBe(1);
  });

  test("refuses a non-empty index — it never truncates", async () => {
    const { db, configDir, dataDir } = fresh();
    await seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 });
    await expect(seedDemoCorpus(db, { configDir, dataDir, nowMs: 5 * DAY * 365 })).rejects.toBeInstanceOf(
      DemoSeedRefusedError,
    );
  });

  test("windows rebase: a seed seven days later has the page inside oncall's 24h window of THAT now", async () => {
    for (const nowMs of [5 * DAY * 365, 5 * DAY * 365 + 7 * DAY]) {
      const { db, configDir, dataDir } = fresh();
      await seedDemoCorpus(db, { configDir, dataDir, nowMs });
      const recent = count(
        db,
        "SELECT COUNT(*) AS n FROM item WHERE service = 'pagerduty' AND modified_at >= ? AND modified_at <= ?",
        [nowMs - DAY, nowMs],
      );
      expect(recent).toBe(1);
    }
  });
});
```

The graph column names above are verified against `index/graph-v7-sql.ts` (`graph_relation.from_id`/`to_id`/`type`, `graph_entity.type`/`external_id`). The incident entity's `external_id` format is not — if `LIKE '%PDEMO412%'` matches nothing, read how the populator keys an `incident` entity and adjust the QUERY (never the property), and say so in the report.

Run: `bun test packages/gateway/src/demo/seed.test.ts` → FAIL (module missing).

- [ ] **Step 2: Implement `seed.ts`**

Write `packages/gateway/src/demo/seed.ts` implementing, in THIS order (each step a small named function; `seedDemoCorpus` reads as the ordered list):

1. `assertEmptyIndex(db)` — `SELECT COUNT(*) AS n FROM item`; if `> 0` throw `new DemoSeedRefusedError()` with message `ERR_DEMO_ALREADY_SEEDED: the demo index already holds data. Run \`nimbus demo\`, which recreates the demo root before seeding.`
2. `const demoRoot = dirname(opts.dataDir)`; `const workspace = join(demoRoot, "workspace", "acme-payments")`; `writeWorkspaceFiles(workspace, corpus.files)` — `mkdirSync(dirname(abs), {recursive:true})` + `writeFileSync(abs, lines.join("\n") + "\n")`.
3. `writeDemoConfig(opts.configDir, corpus, workspace, meId)` — `mkdirSync(configDir, {recursive: true})`, then write `nimbus.toml` (overwrite) with exactly these sections:

```toml
# Synthetic demo config written by `nimbus demo` — the fictional "Acme" org. Not your install.
[user]
me_person_id = "<meId>"

[embedding]
enabled = false

[updater]
enabled = false
check_on_startup = false

[[filesystem.roots]]
path = "<workspace with backslashes replaced by forward slashes>"
git_aware = true

[metrics.dora.payment-service]
repos = ["github:acme/payments"]
pagerduty_services = ["PPAYDEMO"]
deploy_workflow_pattern = "^Deploy"
deploy_environments = ["prod"]
# …one block per corpus service (checkout-web / PCHKDEMO, ledger-worker / PLEDDEMO)
```

   Then `const repoRoot = loadNimbusFilesystemRootsFromConfigDir(opts.configDir)[0]?.path` — throw if undefined.
4. `insertPeople(db, corpus.people)` — `insertPerson` with `id = personIdFor(email)` (`uuidV5(\`email:${email.toLowerCase()}\`, NIMBUS_PERSON_NAMESPACE_UUID)`), `canonicalEmail` lowercased, `githubLogin`, `slackHandle`, every other login `null`, `linked: true`, `metadata: {}`.
5. `writeItems(db, items, at, syncedAt)` for `corpus.issues`, then commits as `git_commit` items (`service:"filesystem"`, `type:"git_commit"`, `externalId: \`${sha}_r1\``, `title: subject`, `bodyPreview: sha`, `authorId`, `modifiedAt: at(offsetMs)`, `metadata: {repoRoot, sha, subject}`), then `corpus.pullRequests`, `corpus.reviews`, `corpus.ciRuns`. Each `DemoItem` → `upsertIndexedItem(db, { service, type, externalId, title, body, modifiedAt: at(i.offsetMs), syncedAt: opts.nowMs, authorId: i.authorKey === undefined ? null : personIdFor(email of authorKey), url: i.url ?? null, metadata: i.metadata?.(at) ?? {} })` where `at = (o) => opts.nowMs + o`.
6. `writeDeployments(db, corpus.deployments, at, nowMs)` — `annotateDeployment(db, { service: d.serviceId, provider: "github-actions", environment: "prod", sha: d.sha, ref: "main", status: d.status, started_at_ms: at(d.offsetMs), finished_at_ms: at(d.offsetMs) + 3 * MINUTE, run_id: d.runId }, opts.nowMs)`.
7. `writeItems` for `corpus.incidents`, then `corpus.messages` (persons already exist, so `assignee_emails` resolve to them).
8. `writeBlame(db, repoRoot, corpus)` — per file, rows `{ lineNo: i + 1, commitSha, authorName, authorEmail, authorTimeMs: at(commit.offsetMs) }` via `upsertBlameLines`.
9. `dbRun(db, "INSERT INTO sync_state (connector_id, last_sync_at) VALUES (?, ?) ON CONFLICT(connector_id) DO UPDATE SET last_sync_at = excluded.last_sync_at", ["pagerduty", at(corpus.pagerdutyLastSyncOffsetMs)])`. If `sync_state` has no unique key on `connector_id`, use a plain `INSERT` (the table is empty on a fresh demo index) and say so.
10. `await runOwnershipPass(db, { nowMs, roots: [repoRoot], config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] }, serviceRepoUrns: new Map(corpus.services.map((s) => [s.id, [\`github:${s.repo}\`]])), spawn: <a spawn that throws, copied from the ownership e2e> })`.
11. `await runGlossaryPass(...)` and `await runDecisionPass(...)` with no LLM (see Facts).
12. `writeMarker(opts.dataDir, opts.nowMs)` — LAST, so an interrupted seed reads as "not seeded".
13. Return the `DemoSeedResult` (`tour: ACME_TOUR`, `workspaceRoot: repoRoot`).

Header comment on the module: what it is, that it runs ONLY behind `demo.seed` on a demo-rooted gateway (invariant I41 clause 5), that it never truncates, and that it uses production write APIs so the graph edges come from the production populators.

Run Step 1 → PASS. If a count bound is off because of real populator behaviour, fix the corpus or the bound with a stated reason — never delete an assertion.

- [ ] **Step 3: Verify + commit**

```bash
bun run typecheck
bun test packages/gateway/src/demo/
bunx biome check packages/gateway/src/demo/
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/demo/seed.ts packages/gateway/src/demo/seed.test.ts
git commit -m "feat(demo): seed the Acme corpus through production write APIs"
```

---

### Task 6: `demo.seed` — an IPC method that exists only on a demo gateway

**Files:**
- Create: `packages/gateway/src/ipc/demo-rpc.ts`, `packages/gateway/src/ipc/demo-rpc.test.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (new `tryDispatchDemoRpc`, entry in `PHASE4_PLATFORM_DISPATCHERS`)
- Modify: `packages/gateway/src/ipc/server/server.test.ts` (routing proof)
- Modify: `packages/gateway/src/ipc/lan-rpc.ts`, `packages/gateway/src/ipc/lan-rpc.test.ts`
- Modify: `packages/ui/src-tauri/src/gateway_bridge.rs` (test only)

**Interfaces:**
- Consumes: Task 5's `seedDemoCorpus`, `DemoSeedRefusedError`, `DemoSeedResult`; Task 3's `CreateIpcServerOptions.demo`.
- Produces: IPC method `demo.seed`, params `{ nowMs?: number }`, result `DemoSeedResult`; errors `-32010 ERR_DEMO_ALREADY_SEEDED`, `-32602` bad params.

- [ ] **Step 1: The inner module (test first)**

Follow `ipc/profile-rpc.ts` exactly (its `XRpcError` class + `dispatchByMethod` from `ipc/_lib/dispatch-by-method.ts`). `demo-rpc.ts` exports `DemoRpcError(rpcCode, message)`, `export type DemoRpcContext = { readonly db: Database; readonly configDir: string; readonly dataDir: string; readonly now?: () => number }`, and `dispatchDemoRpc(method, params, ctx)` handling ONLY `"demo.seed"`:
- params must be `undefined`, `{}`, or `{ nowMs: <finite positive number> }` — anything else → `DemoRpcError(-32602, "ERR_INVALID_PARAMS: demo.seed takes { nowMs?: number }")`;
- `nowMs = p.nowMs ?? (ctx.now ?? Date.now)()`;
- `return await seedDemoCorpus(ctx.db, { configDir: ctx.configDir, dataDir: ctx.dataDir, nowMs })`, mapping `DemoSeedRefusedError` → `DemoRpcError(-32010, e.message)`.

`demo-rpc.test.ts` (in-memory migrated DB + temp dirs, like Task 5's test): a `hit` whose value has `counts.people === 8`; a second call → rejects with `rpcCode === -32010`; `{ nowMs: "x" }` → `-32602`; an unrelated method → `{ kind: "miss" }`.

- [ ] **Step 2: The dispatcher — demo-only by construction**

In `dispatchers.ts`, next to `tryDispatchIndexDemoSymbolRpc`:

```ts
/**
 * `demo.*` — I41 clause (5). Claimed ONLY by a demo-rooted gateway: on a normal gateway the
 * namespace is left unclaimed and the request falls through to `Method not found`, so the seeding
 * code path is not reachable at all rather than refused at runtime.
 */
export async function tryDispatchDemoRpc(ctx: ServerCtx, method: string, params: unknown): Promise<unknown> {
  if (!method.startsWith("demo.")) return phase4RpcSkipped;
  const { demo, localIndex, configDir, dataDir } = ctx.options;
  if (demo !== true || localIndex === undefined || configDir === undefined || dataDir === undefined) {
    return phase4RpcSkipped;
  }
  try {
    const out = await dispatchDemoRpc(method, params, { db: localIndex.getDatabase(), configDir, dataDir });
    if (out.kind === "hit") return out.value;
  } catch (e) {
    if (e instanceof DemoRpcError) throw new RpcMethodError(e.rpcCode, e.message);
    throw e;
  }
  return phase4RpcSkipped;
}
```

Register it in `PHASE4_PLATFORM_DISPATCHERS` (read the table's "ORDER IS THE CONTRACT" comment; place it right after the `indexDemoSymbol` entry, adapting to the table's `(ctx, method, params, clientId)` shape). Confirm `configDir`/`dataDir` are the option field names (`ipcOpts` passes `dataDir`, `configDir`); adapt if not.

- [ ] **Step 3: Routing proof over a real socket (the layer unit tests skip)**

In `server.test.ts`, with the file's `createIpcServer` + `exchangeFirstNdjsonLine` pattern and a real `LocalIndex` over a migrated temp DB: a server created WITH `demo: true`, `configDir`, `dataDir` answers `demo.seed` with a result whose `counts.people === 8`; a server created WITHOUT `demo` answers `demo.seed` with error code `-32601` (Method not found). This is the test that catches a handler present without its routing entry.

- [ ] **Step 4: LAN + Tauri**

`lan-rpc.ts`: add `"demo"` to `FORBIDDEN_OVER_LAN` (namespace entry, with a one-line comment: "the demo seeder — local CLI only (I41)"). `lan-rpc.test.ts`: following the "clip over LAN" block, assert `checkLanMethodAllowed("demo.seed", peer)` throws `LanError` for both `writeAllowed` values with `ERR_METHOD_NOT_ALLOWED`, plus a negative control (`agents.ownership` still allowed). `gateway_bridge.rs`: add `assert!(!is_method_allowed("demo.seed"));` to the existing absence test; do NOT touch `ALLOWED_METHODS` (its size assertion stays 105). Run `cargo test` for the ui crate only if Rust is available locally (`cargo --version`); otherwise say so — CI runs it.

- [ ] **Step 5: Verify + commit**

```bash
bun run typecheck
bun test packages/gateway/src/ipc/demo-rpc.test.ts packages/gateway/src/ipc/server/ packages/gateway/src/ipc/lan-rpc.test.ts
bunx biome check packages/gateway/src/ipc/
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/ipc/demo-rpc.ts packages/gateway/src/ipc/demo-rpc.test.ts packages/gateway/src/ipc/server/dispatchers.ts packages/gateway/src/ipc/server/server.test.ts packages/gateway/src/ipc/lan-rpc.ts packages/gateway/src/ipc/lan-rpc.test.ts packages/ui/src-tauri/src/gateway_bridge.rs
git commit -m "feat(ipc): demo.seed, claimed only by a demo-rooted gateway"
```

---

### Task 7: `nimbus demo`, the banner, and stop-and-wait

**Files:**
- Modify: `packages/cli/src/lib/demo-flag.ts`, `demo-flag.test.ts`
- Create: `packages/cli/src/lib/stop-and-wait.ts`, `stop-and-wait.test.ts`
- Create: `packages/cli/src/lib/demo-banner.ts`, `demo-banner.test.ts`
- Create: `packages/cli/src/commands/demo.ts`, `demo.test.ts`
- Modify: `packages/cli/src/index.ts`, `packages/cli/src/commands/index.ts`, `packages/cli/src/commands/registry.ts`, `packages/cli/src/commands/help.ts`, `README.md`
- Modify: `scripts/parity/demo-root.parity.test.ts`

**Interfaces:**
- Consumes: IPC `demo.seed` → `DemoSeedResult` (Task 6); CLI `runStart`, `runOncallCommand`, `runWhyCli`, `runOwnersCommand`, `withGatewayIpc`, `BATCH_RPC_TIMEOUT_MS`, `readGatewayState`, `gatewayStatePath`, `isProcessAlive`.
- Produces: `runDemo(args: string[], deps?: DemoDeps): Promise<void>`; `stopAndWaitForExit(paths: CliPlatformPaths, opts?: { deadlineMs?: number }): Promise<"stopped" | "not-running">`; `demoBannerLine(marker, nowMs): string`; `readDemoSeedMarker(dataDir): { seededAtMs: number } | undefined`; `DEMO_SEED_MARKER = "demo-seed.json"`.

**CLI facts (verified):** `runStart(args)` only prints and signals failure via `process.exitCode` (it never throws for not-ready); `runStop` does NOT wait; `oncall`/`why`/`owners` print their brief to stdout with `process.stdout.write` and call `process.exit(1|2)` on error; `test/helpers/cli-mocks.ts` mocks `lib/gateway-process.ts` with a FIXED export list, so the new helper goes in a NEW file (`stop-and-wait.ts`), importing `isProcessAlive`/`gatewayStatePath`/`readGatewayState` from `gateway-process.ts`. `registry.test.ts` requires every `COMMAND_HANDLERS` key in `COMMAND_NAMES`; `help.test.ts` requires `nimbus <name>` in help; `scripts/audit/readme-cli-commands.ts` checks the README.

- [ ] **Step 1: `demo` subcommand sets `NIMBUS_DEMO` (test first)**

`demo-flag.test.ts` — add: `applyDemoFlag(["demo"], env)` → returns `["demo"]` and sets `env.NIMBUS_DEMO = "1"`; `applyDemoFlag(["demo", "stop"], env)` same; `applyDemoFlag(["--demo", "demo"], env)` → `["demo"]`; `applyDemoFlag(["status"], env)` leaves env untouched. Then in `demo-flag.ts`: compute `const out = argv.filter((a) => a !== DEMO_FLAG);`, set the env when `argv.includes(DEMO_FLAG) || out[0] === "demo"`, return `out`. Update the docblock: the `demo` subcommand also implies the demo root (it must, since it resolves paths).

- [ ] **Step 2: `stopAndWaitForExit` (test first)**

`stop-and-wait.ts`:

```ts
import { unlink } from "node:fs/promises";

import type { CliPlatformPaths } from "../paths.ts";
import { gatewayStatePath, isProcessAlive, readGatewayState } from "./gateway-process.ts";

/**
 * Signal the gateway recorded in `paths`' state file and WAIT until its process is gone, so a
 * caller can delete its directory. `nimbus stop` only signals: on Windows SIGTERM is
 * TerminateProcess and the process's handles on nimbus.db / -wal / the log are released a moment
 * later, so an immediate recursive delete fails with EBUSY/EPERM (spec § 4.4).
 */
export class StopTimeoutError extends Error {
  constructor(pid: number, ms: number) {
    super(`Gateway pid ${String(pid)} did not exit within ${String(ms)}ms; nothing was deleted.`);
    this.name = "StopTimeoutError";
  }
}

export async function stopAndWaitForExit(
  paths: CliPlatformPaths,
  opts: { readonly deadlineMs?: number; readonly pollMs?: number } = {},
): Promise<"stopped" | "not-running"> {
  const state = await readGatewayState(paths);
  if (state === undefined || !isProcessAlive(state.pid)) {
    await unlink(gatewayStatePath(paths)).catch(() => undefined);
    return "not-running";
  }
  try {
    process.kill(state.pid, "SIGTERM");
  } catch {
    /* already gone */
  }
  const deadlineMs = opts.deadlineMs ?? 15_000;
  const pollMs = opts.pollMs ?? 100;
  const start = Date.now();
  while (isProcessAlive(state.pid)) {
    if (Date.now() - start > deadlineMs) throw new StopTimeoutError(state.pid, deadlineMs);
    await new Promise((r) => setTimeout(r, pollMs));
  }
  await unlink(gatewayStatePath(paths)).catch(() => undefined);
  return "stopped";
}
```

`stop-and-wait.test.ts`: spawn a REAL long-lived child (`Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"])`), write a state file for its pid into a temp `dataDir` (`gateway.json` with `{pid, socketPath: "x"}`), call `stopAndWaitForExit` → `"stopped"`, and assert `isProcessAlive(pid) === false` and the state file is gone; with no state file → `"not-running"`; with a `deadlineMs: 1` against a child that ignores SIGTERM on POSIX (`process.on("SIGTERM", () => {})`) → rejects `StopTimeoutError` (skip that one case on win32, where SIGTERM cannot be ignored — use `test.skipIf(process.platform === "win32")` and say so). Always kill the child in `finally`.

- [ ] **Step 3: The banner (test first)**

`demo-banner.ts`:

```ts
import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Mirrors the gateway's `DEMO_SEED_MARKER` (demo/seed.ts); scripts/parity keeps them equal. */
export const DEMO_SEED_MARKER = "demo-seed.json";
/** The narrowest agent window (standup/oncall) — past it the seeded data falls out of the briefs. */
export const DEMO_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export function readDemoSeedMarker(dataDir: string): { readonly seededAtMs: number } | undefined {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dataDir, DEMO_SEED_MARKER), "utf8"));
    if (typeof raw !== "object" || raw === null) return undefined;
    const v = (raw as Record<string, unknown>)["seededAtMs"];
    return typeof v === "number" && Number.isFinite(v) ? { seededAtMs: v } : undefined;
  } catch {
    return undefined;
  }
}

function age(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60_000));
  if (m < 60) return `${String(m)}m ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${String(h)}h ago`;
  return `${String(Math.floor(h / 24))}d ago`;
}

/** The one stderr line every `--demo` command prints (spec § 5). */
export function demoBannerLine(marker: { readonly seededAtMs: number } | undefined, nowMs: number): string {
  if (marker === undefined) return "DEMO — not seeded yet · run nimbus demo";
  const elapsed = nowMs - marker.seededAtMs;
  if (elapsed > DEMO_STALE_AFTER_MS) {
    return `DEMO — synthetic "Acme" org · seeded ${age(elapsed)} (stale — briefs may be empty) · run nimbus demo to re-seed`;
  }
  return `DEMO — synthetic "Acme" org, not your data · seeded ${age(elapsed)} · nimbus demo reset to remove`;
}
```

`demo-banner.test.ts`: the three states (undefined; 2h → contains `seeded 2h ago` and `not your data`; 3 days → contains `(stale`), clock skew (`nowMs < seededAtMs` → the seeded state with `seeded 0m ago`, no throw), plus `readDemoSeedMarker` on a temp dir with a valid file / garbage / missing file. In `scripts/parity/demo-root.parity.test.ts` add: `expect(cliBanner.DEMO_SEED_MARKER).toBe(gwSeed.DEMO_SEED_MARKER)` (importing `../../packages/cli/src/lib/demo-banner.ts` and `../../packages/gateway/src/demo/seed.ts`).

`index.ts`: right after the paths try/catch in `main()` and BEFORE `intro(...)`:

```ts
  // Spec § 5: every `--demo` command says, on stderr, that it is looking at synthetic data.
  // `nimbus demo` itself prints its own framing instead.
  if (paths.demo === true && rawArgv[0] !== "demo") {
    process.stderr.write(`${demoBannerLine(readDemoSeedMarker(paths.dataDir), Date.now())}\n`);
  }
```

- [ ] **Step 4: `nimbus demo` (test first)**

`commands/demo.ts`:

```ts
import { rmSync } from "node:fs";
import { dirname } from "node:path";

import { runOncallCommand } from "./oncall.ts";
import { runOwnersCommand } from "./owners.ts";
import { runStart } from "./start.ts";
import { runWhyCli } from "./why.ts";
import { getCliPlatformPaths, type CliPlatformPaths } from "../paths.ts";
import { BATCH_RPC_TIMEOUT_MS } from "../lib/rpc-timeouts.ts";
import { stopAndWaitForExit } from "../lib/stop-and-wait.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

export interface DemoSeedSummary {
  readonly counts: { readonly people: number; readonly items: number };
  readonly tour: { readonly whyRef: string; readonly ownersPath: string };
}

export interface DemoDeps {
  readonly paths: () => CliPlatformPaths;
  readonly stop: (paths: CliPlatformPaths) => Promise<"stopped" | "not-running">;
  readonly removeDir: (dir: string) => void;
  /** Starts the demo gateway; resolves true when it is up. */
  readonly start: () => Promise<boolean>;
  readonly seed: (paths: CliPlatformPaths) => Promise<DemoSeedSummary>;
  readonly oncall: () => Promise<void>;
  readonly why: (ref: string) => Promise<void>;
  readonly owners: (dir: string) => Promise<void>;
  readonly out: (s: string) => void;
}

const USAGE = "Usage: nimbus demo [--no-tour] | nimbus demo stop | nimbus demo reset";

export const defaultDemoDeps: DemoDeps = {
  paths: getCliPlatformPaths,
  stop: (p) => stopAndWaitForExit(p),
  removeDir: (dir) => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
  start: async () => {
    const before = process.exitCode;
    await runStart(["--no-wizard"]);
    const ok = process.exitCode === undefined || process.exitCode === 0;
    if (ok) process.exitCode = before;
    return ok;
  },
  seed: (p) =>
    withGatewayIpc((c) => c.call<DemoSeedSummary>("demo.seed", {}), p, { requestTimeoutMs: BATCH_RPC_TIMEOUT_MS }),
  oncall: () => runOncallCommand([]),
  why: (ref) => runWhyCli([ref]),
  owners: (dir) => runOwnersCommand([dir]),
  out: (s) => process.stdout.write(s),
};

function header(n: number, title: string, command: string): string {
  const lead = `── [${String(n)}/3] ${title} `;
  return `\n${lead.padEnd(56, "─")}\n$ ${command}\n`;
}

export async function runDemo(args: string[], deps: DemoDeps = defaultDemoDeps): Promise<void> {
  const paths = deps.paths();
  if (paths.demo !== true) throw new Error("nimbus demo must resolve the demo root (internal error: NIMBUS_DEMO not set)");
  const demoRoot = dirname(paths.dataDir);
  const sub = args[0];

  if (sub === "stop") {
    const r = await deps.stop(paths);
    deps.out(r === "stopped" ? "Demo gateway stopped.\n" : "No demo gateway was running.\n");
    return;
  }
  if (sub === "reset") {
    await deps.stop(paths);
    deps.removeDir(demoRoot);
    deps.out(`Demo root removed: ${demoRoot}\n`);
    return;
  }
  if (sub !== undefined && sub !== "--no-tour") {
    process.stderr.write(`${USAGE}\n`);
    process.exitCode = 1;
    return;
  }

  // Re-seed on every run by RECREATING the root (spec § 4.4) — the seeder never truncates.
  await deps.stop(paths);
  deps.removeDir(demoRoot);
  if (!(await deps.start())) return; // runStart already printed why
  const seeded = await deps.seed(paths);
  deps.out(`Seeded the synthetic "Acme" org: ${String(seeded.counts.people)} people, ${String(seeded.counts.items)} items.\n`);
  // Restart so every config read (me, roots, services) sees the seeded nimbus.toml.
  await deps.stop(paths);
  if (!(await deps.start())) return;

  if (sub !== "--no-tour") {
    deps.out(header(1, "On-call triage", "nimbus --demo oncall"));
    await deps.oncall();
    deps.out(header(2, "Why this line changed", `nimbus --demo why ${seeded.tour.whyRef}`));
    await deps.why(seeded.tour.whyRef);
    deps.out(header(3, "Who owns this code", `nimbus --demo owners ${seeded.tour.ownersPath}`));
    await deps.owners(seeded.tour.ownersPath);
  }
  deps.out(
    [
      "",
      "The demo gateway is still running on the synthetic org. Try:",
      "  nimbus --demo standup",
      "  nimbus --demo expert payments",
      "  nimbus --demo decisions",
      "  nimbus --demo stats deployment-frequency --service payment-service",
      "Stop it with `nimbus demo stop`; remove everything with `nimbus demo reset`.",
      "",
    ].join("\n"),
  );
}
```

(Verified 2026-09-19: `expert` takes a free-text topic, `decisions` needs no argument, and `stats` REQUIRES `<metric> --service <id>` — a bare `nimbus --demo stats` would fail with its usage error. Task 10's e2e runs each suggested command once and asserts exit 0, so a suggestion that stops working fails the build.)

`demo.test.ts` (DI only — no real gateway): with fake deps recording calls, assert (a) default run order: `stop, removeDir(<dirname(dataDir)>), start, seed, stop, start, oncall, why("src/retry/backoff.ts:42"), owners("src/retry")` and the three headers appear in `out` in order with `$ nimbus --demo …` lines; (b) `--no-tour` skips the three brief calls; (c) `stop` calls only `stop`; (d) `reset` calls `stop` then `removeDir`; (e) a failing first `start` stops the flow before `seed`; (f) an unknown subcommand prints usage and sets `process.exitCode = 1` (reset it after); (g) `paths.demo !== true` throws.

- [ ] **Step 5: Register the command**

`commands/index.ts`: `export { runDemo } from "./demo.ts";`. `index.ts` `COMMAND_HANDLERS`: `demo: runDemo,`. `commands/registry.ts` `COMMAND_NAMES`: add `"demo"`. `commands/help.ts` under GETTING STARTED: `  nimbus demo [--no-tour|stop|reset]  Try Nimbus on a synthetic org in an isolated demo root`. `README.md`: add `nimbus demo` wherever `scripts/audit/readme-cli-commands.ts` expects commands to be listed (read the audit first).

- [ ] **Step 6: Verify + commit**

```bash
bun run typecheck
bun test packages/cli/src/lib/demo-flag.test.ts packages/cli/src/lib/stop-and-wait.test.ts packages/cli/src/lib/demo-banner.test.ts packages/cli/src/commands/demo.test.ts packages/cli/src/commands/registry.test.ts packages/cli/src/commands/help.test.ts scripts/parity/demo-root.parity.test.ts
bun run audit:readme-cli-commands
bunx biome check packages/cli/src/ scripts/parity/
git rev-parse --abbrev-ref HEAD
git add -u
git add packages/cli/src/lib/stop-and-wait.ts packages/cli/src/lib/stop-and-wait.test.ts packages/cli/src/lib/demo-banner.ts packages/cli/src/lib/demo-banner.test.ts packages/cli/src/commands/demo.ts packages/cli/src/commands/demo.test.ts
git status
git commit -m "feat(cli): nimbus demo — reset, start, seed and a three-brief tour"
```

(If the README audit's script name differs, find it with `grep -n "readme" package.json`.)

---

### Task 8: Follow-up hints that keep you in the demo

**Files:**
- Create: `packages/cli/src/lib/demo-hint.ts`, `demo-hint.test.ts`
- Modify: `packages/cli/src/commands/admin.ts` (~53–62), `commands/start.ts` (~113–115), `lib/agent-brief-render.ts` (~87), `commands/expert.ts` (~92), `commands/doctor-core.ts` (vault check ~429; `nimbus stop` hint ~782), `commands/index-health-format.ts` (~128), `commands/tui.tsx` (~29), `mcp/tool-runtime.ts` (~89–90), `mcp/adapter.ts` (`AdapterDeps`/`createProductionDeps`), `lib/gateway-not-running.test.ts` (regex + `.tsx`)
- Modify: `packages/gateway/src/engine/run-ask.ts` (`EMPTY_INDEX_GUIDANCE` ~93–102, its caller ~143–154/1036–1041) and wherever `runAsk`'s deps are built for the socket path (`gateway-main.ts` / `platform/assemble.ts`)

**Interfaces:**
- Produces: `export function nimbusCommand(rest: string, demo: boolean): string` → `demo ? \`nimbus --demo ${rest}\` : \`nimbus ${rest}\``.

**Why (spec § 11.1 + § 11.3):** a hint the user pastes must not run against the real install; and inside the demo, hints that name refused commands (`connector auth/sync`) are wrong in a second way — the demo is seeded by `nimbus demo`, not by connecting services.

- [ ] **Step 1: The helper (test first)** — `demo-hint.ts` with `nimbusCommand`; test both branches.

- [ ] **Step 2: Apply it, one site at a time, each with a test in that site's existing test file** (read each site first; keep non-demo output byte-identical):
  - `admin.ts`: the `nimbus vault get …` hint → in demo mode print instead `The demo root's vault is in-memory; it holds no admin token.` (the demo gateway's vault is an `EphemeralVault`).
  - `start.ts` first-run hints (`connector auth github` / `connector sync github` / `doctor`) → in demo mode print only `Seed the synthetic org with: nimbus demo` (connector commands are refused in the demo).
  - `agent-brief-render.ts` and `expert.ts` "No data indexed yet — run `nimbus connector sync <service>` first." → in demo mode `The demo index is empty — run nimbus demo to seed it.` (thread `demo` from the caller's `CliPlatformPaths`, never the env var).
  - `doctor-core.ts`: the vault check in demo mode prints `Vault: in-memory (demo root) — the OS credential store is not used` instead of probing the OS keyring; the `try nimbus stop …` hint uses `nimbusCommand`.
  - `index-health-format.ts`: fix the nonexistent `nimbus sync` to `nimbus connector sync <service>` (real bug, not demo-specific).
  - `init.ts`: `nimbus --demo init` REFUSES before doing anything (no gateway spawn, no `nimbus.toml` write, no wizard) with exit code 1 and `The demo root is set up by \`nimbus demo\`, not \`init\` — run \`nimbus demo\` to seed the synthetic org, or run \`nimbus init\` without --demo for your real install.` Its onboarding would call `connector auth` (refused in the demo) and write a `nimbus.toml` the seeder then overwrites. Test in `init.test.ts` with a demo `CliPlatformPaths`: refuses, and none of init's deps (spawn / write / prompt) is called.
  - `tui.tsx`: its hardcoded `Gateway is not running. Start with: nimbus start` → `gatewayNotRunningMessage(paths.demo === true)` from `lib/gateway-not-running.ts`.
  - `mcp/tool-runtime.ts`: the mid-connection-drop path returns `errorResult(GATEWAY_DOWN_MESSAGE)` — add `readonly demo?: boolean` to `AdapterDeps`, set it in `createProductionDeps` from `getCliPlatformPaths().demo === true` (as the initial-connect path already does), and return `errorResult(gatewayDownMessage(deps.demo === true))`.
  - `gateway-not-running.test.ts`: widen the guard to `/start (?:it )?with:\s*nimbus start/i` and scan `.tsx` as well as `.ts`; red-prove it (temporarily re-add a hardcoded "start it with: nimbus start" hint in a `.tsx` file, see it fail, revert).
- [ ] **Step 3: The gateway-side empty-index guidance.** In `run-ask.ts`, replace the constant with `emptyIndexGuidance(demo: boolean): string` — non-demo text unchanged; demo text: `No data indexed yet.\n\nThis is the demo root. Seed the synthetic "Acme" org with:\n  nimbus demo\n`. Thread a `demo?: boolean` through the run-ask deps object (find where `runAsk`/`runAskInner` get their deps; default `false`), and set it from `paths.demo === true` at the gateway's wiring site for the IPC path. Test: the existing empty-index test still passes; a new one with `demo: true` gets the demo text.
- [ ] **Step 4: Verify + commit**

```bash
bun run typecheck
bun test packages/cli/src packages/gateway/src/engine/run-ask.test.ts
bunx biome check packages/cli/src/ packages/gateway/src/engine/
git rev-parse --abbrev-ref HEAD
git add -u
git add packages/cli/src/lib/demo-hint.ts packages/cli/src/lib/demo-hint.test.ts
git status
git commit -m "fix(cli): follow-up hints keep a --demo user in the demo root"
```

(If `run-ask.test.ts` has another name, find the empty-index test with `grep -rn "No data indexed yet" packages/gateway/src --include=*.test.ts`.)

---

### Task 9: Invariant I41 — clauses (5) and (6)

**Files:**
- Modify: `packages/gateway/src/security-invariants.test.ts` (the I41 `describe`)
- Modify: `docs/SECURITY-INVARIANTS.md` (§ I41), `CLAUDE.md`, `GEMINI.md` (I41 bullet; keep the two byte-identical on that line)

The triple rule: this task's commit adds the doc text AND the enforcement tests for wiring Tasks 1–8 landed.

- [ ] **Step 1: Enforcement tests** — append to the I41 `describe` (use the file's `read()` helper for source pins):
  - Clause 5: a `createIpcServer` without `demo` answers `demo.seed` with `-32601` (reuse Task 6's approach, or assert on `tryDispatchDemoRpc` returning the skip sentinel for `demo: undefined` and a hit for `demo: true`); `checkLanMethodAllowed("demo.seed", …)` throws.
  - Clause 6 (inert): `new SyncScheduler(…, { syncDisabled: true }).forceSync(x)` rejects `ERR_SYNC_DISABLED`; `bootPolicyFor(demo)` is all-false and `bootPolicyFor(real)` all-true (already there — confirm the 7-field shape); source pins on `assemble.ts`: exactly one `syncScheduler.start()` and it sits inside `if (syncEnabled)`; `wireUpdaterIntoIpc` / telemetry flush / extensions auto-update each guarded by the matching `bootPolicy.*` field (match the shapes Task 2 actually wrote — read the file); `demoRefusal("connector.auth")` is an `ERR_DEMO_FORBIDDEN` and `server.ts` calls `demoRefusal` inside `if (ctx.options.demo === true)` before any dispatcher.
  - Red-prove one pin (remove the `if (syncEnabled)` guard around `start()`, see the test fail, restore).
- [ ] **Step 2: `SECURITY-INVARIANTS.md` § I41** — extend the Statement with: (5) "synthetic seed rows are written only by `demo.seed`, which only a demo-rooted gateway claims — elsewhere it is `Method not found`; it is LAN-forbidden and absent from the Tauri allowlist"; (6) "a demo-rooted gateway is inert: its sync scheduler is constructed with `syncDisabled`, has no syncable registered and is never started (a never-started scheduler alone is not enough — `forceSync` and each job's `.finally → tick()` bypass `start()`); it skips the updater's startup check, the telemetry flush, the embedding runtime and the extension auto-update daemon; and one gate at `dispatchMethod` refuses every `connector.*` method except three reads, plus `vault.set`/`vault.delete`/`data.import`/`extension.install` (`ERR_DEMO_FORBIDDEN`)". Add to the wiring line: `sync/scheduler.ts`, `ipc/server/{server,demo-gate}.ts`, `ipc/{demo-rpc,lan-rpc}.ts`, `ipc/server/dispatchers.ts`, `demo/seed.ts`, `embedding/create-embedding-runtime.ts`. Keep the Bounds paragraph true: a connector can no longer be authenticated under `--demo` (the refusal gate), so REWORD the sentence that says one can — read it and correct it.
- [ ] **Step 3: CLAUDE.md / GEMINI.md** — extend the I41 bullet with one sentence each for (5) and (6) and the new wiring files; identical in both files.
- [ ] **Step 4: Verify + commit**

```bash
bun test packages/gateway/src/security-invariants.test.ts -t "I41"
bun run audit:status-drift
bun run audit:doc-refs
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/security-invariants.test.ts docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md
git commit -m "feat(security): I41 clauses 5-6 - demo.seed is demo-only, a demo gateway is inert"
```

---

### Task 10: The whole flow, end to end, on temp roots

**Files:**
- Create: `packages/gateway/test/e2e/demo-tour.e2e.test.ts`

**Interfaces:** Consumes everything; spawns the REAL CLI entry `packages/cli/src/index.ts` (which spawns the real gateway entry) with temp OS roots. It lives in the gateway e2e tree because it spawns a gateway.

- [ ] **Step 1: Write the test** — model it on `packages/gateway/test/e2e/demo-root-isolation.e2e.test.ts` (same temp-root `dirs`, same premise check that the child's `homedir()` is the temp HOME, same env hygiene: delete `NIMBUS_CONFIG_DIR`, `NIMBUS_GATEWAY_SOCKET`, `NIMBUS_E2E_PATHS_JSON`, `NIMBUS_METRICS_PORT`, `NIMBUS_GATEWAY_LOG_PATH`, `NIMBUS_OAUTH_*`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`; set `NIMBUS_SKIP_EMBEDDING_RUNTIME=1`, `NIMBUS_TELEMETRY_ENABLED=1` and `NIMBUS_HTTP_PORT=<free port>` — the last two PROVE the demo ignores them). Helper `cli(args, timeoutMs)` runs `[process.execPath, CLI_ENTRY, ...args]` and returns `{code, stdout, stderr}`. Tests, in one `describe` with a generous timeout (the full flow boots a gateway twice):
  1. `demo` → exit 0; stdout contains the three headers in order (`[1/3] On-call triage`, `[2/3] Why this line changed`, `[3/3] Who owns this code`) and the exact `$ nimbus --demo …` lines; the on-call section mentions `payment-service` and `412`; the why section mentions `PAY-231`; the owners section mentions `Dana` (or her email); each of the three sections contains `## Gaps` (read the real renderers' headings and adjust ONLY the literal heading text if it differs, never the property).
  2. `--demo status` → exit 0 and stderr contains `DEMO — synthetic "Acme" org, not your data`; stdout does NOT contain `DEMO —`.
  3. `--demo connector auth github` → non-zero exit and output contains `ERR_DEMO_FORBIDDEN`.
  4. `--demo ask "what is going on with payment-service?"` with a 90 s timeout → it EXITS (no hang); capture exit code + first lines of output into the test log with `console.log` and assert only that it exited and printed something. Record the captured behaviour in the task report — Task 11 documents it (spec § 11.1).
  5. `NIMBUS_HTTP_PORT` is not listening (`net.createConnection` refused).
  5b. Every command in `nimbus demo`'s closing "Try:" list (`standup`, `expert payments`, `decisions`, `stats deployment-frequency --service payment-service`), each run with `--demo` → exit 0. A suggestion the tour prints must work.
  6. `demo stop` → exit 0; afterwards no `bun` process from this run is alive.
  7. Every file under the would-be REAL Nimbus directories is inside the demo root (reuse `realNimbusDirs()` / `filesUnder()` from the PR 1 e2e).
  `afterAll`: `demo stop` (ignore failures), then kill any leftover child, then `rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })` in a try/catch.

- [ ] **Step 2: Run it** — on Windows first run `bun run build:sandbox-helper:win32` (POSIX: `bun run build:sandbox-helper`) so the git-ignored helper binary is current, then `bun test packages/gateway/test/e2e/demo-tour.e2e.test.ts --timeout 600000`. If a brief assertion fails, read the real brief text first: fix the CORPUS if the story fact is genuinely missing, or the literal if only wording differs — never weaken to "non-empty".

- [ ] **Step 3: Red-prove two properties** — (a) temporarily delete the `if (ctx.options.demo === true)` gate in `server.ts`, confirm test 3 fails, restore; (b) temporarily make `bootPolicyFor` return `envSidecars: true` for demo, confirm test 5 fails, restore. `git diff` on both production files must be empty afterwards.

- [ ] **Step 4: Commit**

```bash
bunx biome check packages/gateway/test/e2e/demo-tour.e2e.test.ts
bun run typecheck:tests
git rev-parse --abbrev-ref HEAD
git add packages/gateway/test/e2e/demo-tour.e2e.test.ts
git commit -m "test(e2e): nimbus demo end to end on temp roots"
```

---

### Task 11: Docs, CHANGELOG, roadmap, full preflight

**Files:** `docs/cli-reference.md`, `docs/architecture.md`, `docs/CHANGELOG.md`, `docs/roadmap.md`, `README.md` (the "try it" line)

- [ ] **Step 1: cli-reference** — a `nimbus demo` section: what it does (recreate the demo root, start the demo gateway, seed the synthetic Acme org, restart, three-brief tour), `--no-tour`, `stop`, `reset`, the banner states, that connector/vault/import/install commands are refused in the demo (`ERR_DEMO_FORBIDDEN`), that the demo gateway makes no outbound call, and — from Task 10's capture — what `nimbus --demo ask` does on the seeded demo (state what was observed; if it needs a model, say so plainly).
- [ ] **Step 2: architecture.md** — extend the demo-root paragraph: the inert demo gateway (scheduler disabled/empty/never started, boot policy's outbound fields, the refusal gate), `demo.seed` (demo-only dispatch), the corpus (offsets + `.example`), the seeder's production write APIs, `nimbus demo`'s recreate-then-seed flow. Point at SECURITY-INVARIANTS § I41 for rationale.
- [ ] **Step 3: roadmap** — tick the First-Run row's `nimbus demo — seeded sandbox` item with a dated delivered note (#1545 + this PR) and state what did NOT ship (per-profile data roots, a volume generator, the Killer Demo's remediation flow, `nimbus wow`, desktop demo mode — spec § 8).
- [ ] **Step 4: README** — a short "Try it in a minute: `nimbus demo`" line near the install instructions, saying it runs on a synthetic org and touches nothing of yours.
- [ ] **Step 5: CHANGELOG** — a dated entry for the PR at the top of `## Post-Phase-6 deliveries`: what shipped, the § 11.2 scheduler finding (an unstarted scheduler still syncs), the boot-time outbound finding (config written by the seeder cannot switch off boot work), the honest empty CI lane in the oncall brief, the hint fixes (incl. the nonexistent `nimbus sync`). No schema migration, no new egress class; one new IPC method (`demo.seed`, demo-only).
- [ ] **Step 6: Full preflight** — build the sandbox helper first, then `bun run preflight`, `bun run typecheck:tests`, `bun run audit:platform-test-gaps`. Known local-environment reds on this machine (not this branch; prove any other red is pre-existing before calling it so): `scripts/release/nimbus-verify-ps1.test.ts` when bash resolves to WSL; `runTui — fallback to REPL` (#1389) when a real gateway is running; the `win32.test.ts` "helper absent" pair right after a fresh helper build; OAuth "missing env" tests when the machine exports `NIMBUS_OAUTH_*`; the coverage floor (CI-Linux-authoritative). Report every red with its attribution.
- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add docs/cli-reference.md docs/architecture.md docs/CHANGELOG.md docs/roadmap.md README.md
git add -u
git status
git commit -m "docs: nimbus demo - the seeded synthetic org and the inert demo gateway"
```

(Stripping `docs/superpowers/`, pushing and opening the PR happen at the finishing stage, after the final whole-branch review.)

---

## Review disposition (review of 2026-09-19, `2026-09-19-nimbus-demo-pr2-corpus-and-tour-review.md`)

Each claim was checked against the code before it was accepted.

| # | Finding | Disposition |
|---|---|---|
| 2.1 | `nimbus --demo stats` in the closing suggestions fails | **Fixed** (Task 7 Step 4). Verified: `parseStatsArgs` requires `<metric> --service <id>`. Replaced with `stats deployment-frequency --service payment-service` and added `decisions`; `expert payments` verified valid (free-text topic). **Strengthened:** Task 10 now runs every suggested command and asserts exit 0, so a suggestion that breaks later fails the build. |
| 2.2 | `graph_relation.relation_type` does not exist | **Fixed** (Task 5 Step 1). Verified in `index/graph-v7-sql.ts`: the column is `type`; `from_id`/`to_id` were right. The remaining unverified piece — the incident entity's `external_id` format — is called out for the implementer. |
| 2.3 | Wrapping only `startTelemetryFlushScheduler` leaves `telemetryStop` undeclared at the push | **Fixed** (Task 2 Step 2). Verified at `assemble.ts:4282–4290`; both statements move into one guarded block. |
| 2.4 | Decide `wireUpdaterIntoIpc` instead of leaving it to the implementer | **Fixed** (Task 2 Step 2). Verified it builds the updater, `setUpdater`s it and runs the startup check; the demo gateway skips the whole call, so `updater.*` truthfully answers "not configured". |
| 3.1 | `nimbus --demo init` | **Adopted, option 1** (Task 8): refuse before doing anything, pointing at `nimbus demo`. Option 2 (fail at the first refused RPC) was rejected: by then init would already have spawned a gateway and written a `nimbus.toml` the seeder overwrites. |
| 3.2 | Refuse `toolgen.*` / `media.allowRemote` too? | **Not adopted, as the review itself concludes.** Neither can move real data or credentials into or out of the demo: the vault is the in-memory `EphemeralVault` (I41 clause 3) and every path is inside the demo root (clause 1). Widening the gate for features no evaluator reaches in the tour is scope without a threat; the allow-list shape means a future `connector.*` write is refused anyway. |
| 3.3 | Windows path equality between blame rows and roots | **Confirmation only** — no change; the read-the-root-back rule already covers it. |
| 4.1 | Banner test for clock skew (`now < seededAt`) | **Adopted** (Task 7 Step 3). |
| 4.2 | Visual separation between briefs | **No change needed**: each header starts with a newline and every brief ends with one (the renderers write `` `${brief}\n` ``), so piped output already separates them. |
| 4.3 | Build the sandbox helper before the e2e | **Adopted** (Task 10 Step 2), in addition to the Global Constraints line. |
