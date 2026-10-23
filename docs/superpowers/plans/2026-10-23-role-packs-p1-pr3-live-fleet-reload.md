# Role packs P1 PR 3: live fleet reload — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A change to the effective `[fleet]` / `[[fleet.job]]` config (from a pack layer or the owner's own file) takes effect in the running gateway without a restart.

**Architecture:** A new always-wired `FleetSupervisor` owns the fleet's current `{scheduler, config, jobs}`. On a short interval it compares the layered snapshot's `version`. When the version moved, it reloads the fleet section, and when the loaded result differs from the current one, it retires the old scheduler, waiting for any in-flight run, and builds a new one. The `fleet.*` handlers read the supervisor's current state through getters, and `fleet.runNow` waits for a pending swap. Job state survives because it is keyed by job name in `fleet_job_state`.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, pino, bun:sqlite (`openMigratedMemoryDb`).

**Spec:** `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md` § 5.3 (and § 7's "A pack layer that enables the fleet and adds a job causes that job to run without a restart. Removing it stops the fleet again.").

## Global Constraints

- Branch `dev/asaf/role-packs-p1-reload` in worktree `C:\gitrep\Nimbus\.claude\worktrees\role-packs-p1-reload`, created with an absolute path from `origin/main` (which includes PR 2, `b03e5c2f`). This plan and the spec never land on main.
- "No IPC event, file watcher or `config.reload` method is added in v1." (spec § 5.3). No new IPC method, HITL action type, invariant, egress class or migration (spec § 6).
- "Which loaders stay per-call and which stay boot-time is unchanged": only the fleet becomes reactive. `[decisions] min_confidence` is already per call.
- "it waits for any in-flight run (`runOnce`'s `inFlight` guard), stops the scheduler, and rebuilds it from the new snapshot." No run may start twice, and no two schedulers may run at once.
- "The supervisor is **always** wired, even when `[fleet] enabled` is false at boot" and "owns the one shutdown callback on `sidecarStops`".
- The four handlers `fleet.status`, `fleet.list`, `fleet.runNow` and `fleet.digest` read the supervisor's current state. `droppedJobs` is PR 4's; do not add it.
- Boot behaviour stays: the boot prune runs once, unconditionally. A `[fleet]` parse error logs at error, names the files and disables the fleet; it never fails boot. The retention policy floor (`effectiveRetentionDays`) applies to every load, boot and reload alike.
- I38 is unchanged: each scheduler generation gets ONE `createFleetRemoteBudget` instance, shared by that scheduler and its invoker.
- `fleet.*` stays LAN-forbidden and off the Tauri allowlist (no allowlist change).
- No `any`. Use `path.join`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run `bun run preflight:fast` before the PR.

## Review Focus

1. **`nimbus fleet run` during a reload:** it waits for the swap and runs on the new scheduler, never on the retired one. Neither scheduler runs while the other is still in flight. (Task 1 and Task 3 tests)
2. **An unrelated edit** (for example `[decisions]`) moves the snapshot version but must not restart the scheduler. A restart would drop its tick phase for no reason. (Task 2 test `unchanged fleet section is not a reload`)
3. **An owner edit that breaks `[fleet]` mid-run:** the in-flight run finishes, the fleet stops and logs once, and fixing the file brings it back. (Task 2 test, Task 4 integration)
4. **Gateway shutdown during a pending swap:** no new scheduler starts after `stop()`. (Task 2 test)
5. **A reload keeps the org retention floor:** a pack's `retention_days = 1` under a 30-day policy floor reloads as 30. (Task 4 test)

---

### Task 1: `FleetScheduler.retire()`

**Files:**
- Modify: `packages/gateway/src/fleet/fleet-scheduler.ts`
- Test: `packages/gateway/src/fleet/fleet-scheduler.test.ts` (new `describe("FleetScheduler.retire")`, using the file's existing `build(...)` fixture)

**Interfaces:**
- Produces:
  - `export class FleetReloadingError extends Error {}`
  - `FleetScheduler.retire(): Promise<void>`: clears the timer, marks the instance retired, and resolves once any in-flight `runOnce` has settled (never rejects).
  - After `retire()` has been called, `runOnce` throws `FleetReloadingError("fleet is reloading its config; try again")`. The check sits after the config-enabled and policy checks, so their messages are unchanged.

- [ ] **Step 1: Write the failing tests**
  - `retire waits for the in-flight run`: an `invoke` that blocks on a deferred promise. Start `runOnce({ force: true })`, call `retire()`, and assert `retire()` has not resolved until the deferred is released. Then the run's summary has `jobsAttempted === 1`, and `retire()` resolves.
  - `a retired scheduler refuses new runs`: after `await retire()`, `runOnce()` rejects with `FleetReloadingError`, and `invoke` is not called again (count the calls).
  - `retire stops the tick`: `build({ tickMs: 10, ... })`, `start()`, `await retire()`, sleep 50 ms; `invoke` was never called.
  - `retire with nothing in flight resolves at once`.
- [ ] **Step 2: Run them and see them fail.** `bun test packages/gateway/src/fleet/fleet-scheduler.test.ts`. Expected: `retire is not a function`.
- [ ] **Step 3: Implement.** Replace the boolean-only guard with a held promise: keep `inFlight` semantics, and also keep `private running: Promise<FleetRunSummary> | undefined` set around the `execute` await. `retire()` sets `private retired = true`, calls `stop()`, then `await this.running?.catch(() => undefined)`. Update the `inFlight` doc comment to name `retire()` as the second reader.
- [ ] **Step 4: Run them and see them pass,** plus the whole file.
- [ ] **Step 5: Commit** `feat(fleet): a scheduler can be retired after its in-flight run`.

### Task 2: `FleetSupervisor`

**Files:**
- Create: `packages/gateway/src/fleet/fleet-supervisor.ts`
- Test: `packages/gateway/src/fleet/fleet-supervisor.test.ts`

**Interfaces:**
- Consumes: `FleetScheduler.retire()` from Task 1.
- Produces:
  ```ts
  export const FLEET_RELOAD_CHECK_MS = 5_000;
  export type FleetLoad = {
    readonly config: NimbusFleetToml;          // retention already floored by policy
    readonly jobs: readonly NimbusFleetJobToml[];
    readonly configError: boolean;             // the loader logged it; the fleet is off
  };
  export type FleetView = {
    readonly scheduler: FleetScheduler | undefined;
    readonly config: NimbusFleetToml;
    readonly jobs: readonly NimbusFleetJobToml[];
  };
  export interface FleetSupervisorDeps {
    readonly version: () => number;            // the layered snapshot's version
    readonly load: () => FleetLoad;            // never throws
    /** Undefined when the fleet should not run (configError, !enabled, no jobs). Not started. */
    readonly build: (load: FleetLoad) => FleetScheduler | undefined;
    readonly logger: Logger;
    readonly checkMs?: number;                 // test seam; production uses FLEET_RELOAD_CHECK_MS
  }
  export class FleetSupervisor {
    /** `boot` is the load the caller already made (and pruned with), read AFTER `bootVersion`; builds and starts the first scheduler. */
    constructor(deps: FleetSupervisorDeps, boot: { readonly version: number; readonly load: FleetLoad });
    current(): FleetView;
    start(): void;                             // the check interval, unref'd
    stop(): void;                              // sync (sidecarStops): clears the check timer, stops the current scheduler, and no later build happens
    check(): Promise<"unchanged" | "reloaded">;  // the timer body and the test seam; single-flight
    settled(): Promise<void>;                  // resolves when no reload is pending
  }
  ```
- `check()` algorithm. The steps are not obvious from the signature, so they are stated here:
  1. If a reload is pending, return that pending promise.
  2. Read `version()`. If it equals the last version seen, return `"unchanged"`. Otherwise record it.
  3. `next = load()`. If `Bun.deepEquals(next, this.loaded)`, return `"unchanged"`.
  4. `await old.scheduler?.retire()`. If `stop()` ran meanwhile, publish the view with `scheduler: undefined` and return.
  5. Call `build(next)` inside a try. A throw is logged at error and gives `scheduler: undefined`. Then `start()` the new scheduler.
  6. Publish the new view in ONE assignment, set `loaded = next`, and log at info: `[fleet] config changed; reloaded (enabled=<b>, jobs=<n>, running=<b>)`. Return `"reloaded"`.

- [ ] **Step 1: Write the failing tests.** Use fakes: `version` and `load` as mutable closures, and `build` returning a real `FleetScheduler` from a small fixture, or a recording stub cast to `FleetScheduler` with `start`/`stop`/`retire` spies.
  - `boot builds and starts when enabled with jobs`; `boot builds nothing when disabled` (`current().scheduler` undefined, `build` called once and returned undefined).
  - `boot does not load again`: `load` is never called by the constructor (the boot load is passed in, so a boot config error is logged once).
  - `same version is not even loaded`: `load` call count stays 0 after `check()` with an unchanged version.
  - `unchanged fleet section is not a reload`: bump the version, `load` returns a deep-equal new object; result `"unchanged"`, no `retire`, no second `build`.
  - `enable after boot starts a scheduler`: boot disabled, then `load` returns enabled with one job, bump the version; `"reloaded"`, `current().scheduler` defined and started.
  - `disable retires the running scheduler`: `retire` called once, and `current().scheduler` is undefined.
  - `a job change swaps schedulers after the old one retires`: `retire` is a deferred. Assert `current()` is still the old view while it is pending, and the new one after it resolves. `build` is called after `retire` resolved (record the order).
  - `a config error stops the fleet and recovery restarts it`: `load` returns `configError: true`, then a good load.
  - `concurrent checks share one reload`: two `check()` calls during a pending retire give `build` called once.
  - `stop during a pending swap builds nothing`: `stop()` while `retire` is pending, then resolve it; `build` is not called again, and `current().scheduler` is undefined.
  - `a throwing build leaves the fleet off and logs`.
  - `settled waits for a pending reload`.
- [ ] **Step 2: Run them and see them fail** (`Cannot find module './fleet-supervisor.ts'`).
- [ ] **Step 3: Implement** `fleet-supervisor.ts`, with a header comment naming spec § 5.3 and why the version check comes before the load.
- [ ] **Step 4: Run them and see them pass.**
- [ ] **Step 5: Commit** `feat(fleet): a supervisor that rebuilds the fleet when its config changes`.

### Task 3: `fleet.*` handlers read the current fleet

**Files:**
- Modify: `packages/gateway/src/ipc/fleet-rpc.ts`
- Test: `packages/gateway/src/ipc/fleet-rpc.test.ts` (extend)

**Interfaces:**
- Consumes: `FleetReloadingError` (Task 1).
- Produces: `FleetRpcCtx` gains `readonly settled?: () => Promise<void>`. The existing fields stay. Production supplies `scheduler`/`config`/`jobs` as getters (Task 4), so each handler must read them in ONE synchronous destructuring (`const { scheduler, config, jobs } = ctx;`) after its last `await` and before any later one. A swap publishes in one assignment, so a synchronous read cannot see half of two generations.

- [ ] **Step 1: Write the failing tests**
  - `handlers read the ctx at call time`: a ctx whose `config`/`jobs` getters read a mutable variable. Change it between two `fleet.list` calls and assert that the second result shows the new jobs. Do the same for `fleet.status` (`jobsConfigured`, `enabled`) and `fleet.digest` (it uses the new job list).
  - `runNow waits for a pending reload`: `settled` returns a deferred, and `scheduler` is a getter that flips from scheduler A to scheduler B when the deferred resolves. Assert that `runOnce` is called on B only.
  - `runNow on a retired scheduler is a clear error`: `runOnce` rejects with `FleetReloadingError`, and the call is refused with code `-32000` and message `fleet is reloading its config; try again`.
- [ ] **Step 2: Run them and see them fail** (the `settled` test, and the error mapping).
- [ ] **Step 3: Implement.** `handleRunNow` first does `await ctx.settled?.()`, then reads `scheduler`; it maps `FleetReloadingError` like `FleetDisabledError`. `handleStatus` reads the ctx after `await ctx.hostActivity.probe()`. `handleList` and `handleDigest` destructure once. Update the `FleetRpcCtx` doc comment: in production these are live getters over the supervisor.
- [ ] **Step 4: Run** `bun test packages/gateway/src/ipc/fleet-rpc.test.ts packages/gateway/src/ipc/server/dispatchers-fleet.test.ts`.
- [ ] **Step 5: Commit** `feat(fleet): fleet IPC reads the current fleet, and runNow waits for a reload`.

### Task 4: wire the supervisor at boot, with the end-to-end proof and docs

**Files:**
- Modify: `packages/gateway/src/platform/assemble.ts` (`FleetBootDeps`, `FleetRuntime`, `assembleFleetRuntime` and its doc comment, the `fleetRuntime` call site, `ipcOpts.fleetRpcCtx`, `assignIfPresent(services, "fleetScheduler", …)`)
- Modify: `packages/gateway/src/platform/types.ts` (drop `fleetScheduler`; see the Ruling below)
- Test: `packages/gateway/src/platform/assemble-fleet.test.ts` (extend)
- Create: `packages/gateway/test/integration/fleet/fleet-live-reload.test.ts`
- Modify docs: `docs/architecture.md` (the fleet subsection, and the layered-config paragraph at "The reader compares file content for freshness…"), `docs/cli-reference.md` (`nimbus fleet` intro: config changes apply within about 5 s, no restart), `docs/CHANGELOG.md` (one entry in the file's style)

**Interfaces:**
- Consumes: `FleetSupervisor`, `FleetLoad`, `FLEET_RELOAD_CHECK_MS` (Task 2); `FleetRpcCtx.settled` (Task 3).
- Produces:
  ```ts
  export interface FleetRuntime {
    readonly supervisor: FleetSupervisor;
    readonly store: FleetStore;
    readonly scheduler: FleetScheduler | undefined;   // getter → supervisor.current()
    readonly config: NimbusFleetToml;                 // getter
    readonly jobs: readonly NimbusFleetJobToml[];     // getter
  }
  ```
  `FleetBootDeps` gains `readonly checkMs?: number` (test seam only, passed through to the supervisor).
- **Ruling:** `PlatformServices.fleetScheduler` has no reader in `packages/` (verified on `b03e5c2f`). A boot-time copy would go stale after the first reload, so remove the field and its `assignIfPresent` line rather than keep a value that lies. Re-grep before deleting it.

- [ ] **Step 1: Write the failing tests**
  - In `assemble-fleet.test.ts`:
    - `the supervisor is wired even when the fleet is off at boot`: no `[fleet]` block; `stops` grows by exactly 1, `runtime.scheduler` is undefined, and `runtime.supervisor` is defined.
    - `an owner edit enables the fleet without a restart`: boot with no `[fleet]`, write `[fleet] enabled = true` plus one job to `nimbus.toml`, then `await runtime.supervisor.check()`. Assert `"reloaded"`, `runtime.scheduler` defined, and `runtime.jobs` names the job.
    - `a boot config error is logged once`: a broken `[fleet]` at boot gives exactly one error log line (count with a recording logger).
    - `a reload keeps the org retention floor`: policy `retentionMinDays: 30`, file `retention_days = 1`; after a reload, `runtime.config.retentionDays === 30`.
    - `a broken [fleet] after boot stops the fleet, and fixing it restarts it`: `allow_remote = true` with no budget.
    - Existing tests keep passing unchanged. They read `.scheduler`, now a getter.
  - In `test/integration/fleet/fleet-live-reload.test.ts` (spec § 7):
    - Setup: a temp `configDir` and `initLayeredConfig(dir, { packs: createPackLayerStore({ configDir: dir }) })` BEFORE `assembleFleetRuntime`, with the same deps shape as `assemble-fleet.test.ts`. `forgetLayeredConfigForTests(dir)` in `afterEach`.
    - `a pack that enables the fleet and adds a job runs it without a restart`:
      1. Boot with no user file; the fleet is off.
      2. `store.setPackLayer("default", "ops", "[fleet]\nenabled = true\n\n[[fleet.job]]\nname = \"pack-nightly\"\nagent = \"catchup\"\ninterval_seconds = 3600\n")`, then `await runtime.supervisor.check()`.
      3. `runtime.scheduler` is defined, and `await runtime.scheduler.runOnce({ force: true })` gives `jobsAttempted === 1`.
      4. `new FleetStore(db).loadJobState("pack-nightly")?.lastAttemptAt` is not null. Assert the attempt, not success: the stubbed index may make the agent fail, and that is still a run.
    - `removing the pack stops the fleet again`: `removePackLayer("default", "ops")`, `check()`; `runtime.scheduler` is undefined.
    - `job state survives a reload`: after a run, change only `interval_seconds` in the pack (remove, then set). The reloaded fleet's `loadJobState("pack-nightly")` keeps its `lastAttemptAt`.
    - `the user's files are untouched`: hash `nimbus.toml` before and after; with no user file, assert it still does not exist.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement.**
  - Split `assembleFleetRuntime` into three parts: `loadFleet(deps): FleetLoad` (today's try/catch, error log and retention floor), the boot prune (unchanged, run once on the boot load, which is read right after `bootVersion = getLayeredConfig(...).snapshot().version`), and `buildFleetScheduler(deps, load): FleetScheduler | undefined` (today's construction, minus `start()` and minus the `sidecarStops` push).
  - Construct `new FleetSupervisor({ version: () => getLayeredConfig(deps.paths.configDir).snapshot().version, load: () => loadFleet(deps), build: (l) => buildFleetScheduler(deps, l), logger: deps.logger, checkMs: deps.checkMs }, { version: bootVersion, load: bootLoad })`. Call `start()` and push `() => supervisor.stop()` onto `sidecarStops`.
  - Return the runtime with getters.
  - At the call site, `ipcOpts.fleetRpcCtx` uses getters over `fleetRuntime` plus `settled: () => fleetRuntime.supervisor.settled()`.
  - Rewrite item 4 of the doc comment: still called exactly once per boot, and the supervisor is now what holds the live scheduler.
- [ ] **Step 4: Run** `bun test packages/gateway/src/platform/assemble-fleet.test.ts packages/gateway/test/integration/fleet packages/gateway/src/fleet packages/gateway/src/ipc/fleet-rpc.test.ts`, then `bun run typecheck`.
- [ ] **Step 5: Docs.** Add one CHANGELOG entry: fleet config changes, from the owner's file or a pack layer, now apply to a running gateway within about 5 seconds; this includes owner-only keys such as `allow_remote`; a run in progress finishes first. Mirror that sentence in architecture and cli-reference. Update the architecture's layered-config paragraph: of the boot-time consumers, only the fleet reloads.
- [ ] **Step 6: Commit** `feat(fleet): fleet config changes apply without a restart`.

### Task 5: preflight and PR

- [ ] **Step 1:** `bun run preflight:fast`, then the fleet, ipc and platform test trees. If the worktree is fresh, build the sandbox helper first: `& (Get-Process -Id $PID).Path -NoProfile -File scripts/build-sandbox-helper-win32.ps1`.
- [ ] **Step 2:** Confirm that `git diff origin/main --stat` lists no `docs/superpowers/` file.
- [ ] **Step 3:** Open a PR titled `feat(fleet): fleet config changes apply without a restart` (no `!`, since no user must act). In the body, cover the summary and the stated consequence (owner `[fleet]` edits, including `allow_remote`, now go live). Also say what is not included: no IPC/event/watcher, no `enabled = false` stub (PR 4), no `[agents] visible` (PR 5). Give the verification evidence, and end with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".
