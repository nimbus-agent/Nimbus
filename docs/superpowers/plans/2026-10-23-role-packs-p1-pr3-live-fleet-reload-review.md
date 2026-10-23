# Review: Role Packs P1 — PR 3 (Live Fleet Reload)

**Reviewed plan:** `docs/superpowers/plans/2026-10-23-role-packs-p1-pr3-live-fleet-reload.md`  
**Parent spec:** `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md` § 5.3, § 7  
**Date:** 2026-10-23  

---

## Executive Summary

PR 3 introduces live reload for Nimbus's background agent fleet (`[fleet]` / `[[fleet.job]]`), enabling configuration changes from pack layers or the user's base/profile TOML to take effect without restarting the gateway process.

The overall architecture — introducing an always-wired `FleetSupervisor` that polls `LayeredConfig.snapshot().version`, retires the active `FleetScheduler` after its in-flight run settles, builds a replacement, and exposes live getters to `fleet.*` IPC handlers with `fleet.runNow` awaiting pending swaps — is elegant, surgical, and avoids adding file watchers, IPC reload events, or new schema migrations.

Cross-checking the plan against the live codebase (including PR 1 `780303ec` and PR 2 `b03e5c2f` on `origin/main`) confirms the feasibility of the plan while surfacing **4 subtle concurrency traps / edge cases**, **3 open questions / design clarifications**, and **4 concrete implementation refinements**. Addressing these points will ensure the live reload mechanism is completely race-free, leak-free, and clean across all test gates.

---

## 1. Concurrency Traps & Edge Cases (Must-Address)

### 1.1 `FleetScheduler.retire()` Idempotence & Race Windows

In Task 1, `retire()` is specified as:
> *"clears the timer, marks the instance retired, and resolves once any in-flight `runOnce` has settled (never rejects)."*
> *"Step 3: Implement. Replace the boolean-only guard with a held promise: keep `inFlight` semantics, and also keep `private running: Promise<FleetRunSummary> | undefined` set around the `execute` await. `retire()` sets `private retired = true`, calls `stop()`, then `await this.running?.catch(() => undefined)`."*

There are two subtle concurrency scenarios to handle:
1. **Concurrent or Repeated Calls to `retire()`:**
   If `retire()` is called multiple times concurrently (e.g. from an in-flight check, another check, or during shutdown `stop()`), each call must await the same settlement. If `this.running` completes between two calls, the second call might await `undefined` while the first is completing.
   - **Fix:** Memoize the retirement promise on the instance:
     ```ts
     private retirePromise?: Promise<void>;

     retire(): Promise<void> {
       if (this.retirePromise) return this.retirePromise;
       this.retired = true;
       this.stop();
       this.retirePromise = (async () => {
         await this.running?.catch(() => undefined);
       })();
       return this.retirePromise;
     }
     ```
2. **`runOnce` Race During `retire()` Assignment:**
   In `runOnce()`:
   ```ts
   if (!this.deps.config.enabled) throw new FleetDisabledError(...);
   if (this.deps.capabilityDisabled) throw new FleetDisabledError(...);
   if (this.retired) throw new FleetReloadingError("fleet is reloading its config; try again");
   ```
   Placing `if (this.retired)` immediately after the enabled/capability checks ensures that as soon as `retire()` sets `this.retired = true`, any *subsequent* call to `runOnce()` is immediately rejected with `FleetReloadingError` before probing hardware or touching the `inFlight` / `this.running` state.
   Furthermore, `this.running` must be assigned synchronously before any asynchronous suspension inside `this.execute()`:
   ```ts
   this.inFlight = true;
   const runPromise = this.execute(jobs, opts?.force === true, jobName !== undefined);
   this.running = runPromise;
   try {
     return await runPromise;
   } finally {
     this.inFlight = false;
     this.running = undefined;
   }
   ```
   Because `execute` is declared `async`, in V8 / JavaScript it executes synchronously up to the first `await` (which is `await this.deps.hostActivity.probe()`). Creating and assigning `this.running = runPromise` synchronously ensures `retire()` will reliably find and await the promise even if `retire()` is invoked in the same microtask turn.

---

### 1.2 `FleetSupervisor.check()` Intermediate Version Bumps During `retire()`

In Task 2, `check()` is described with the following sequence:
> *1. If a reload is pending, return that pending promise.*  
> *2. Read `version()`. If it equals the last version seen, return `"unchanged"`. Otherwise record it.*  
> *3. `next = load()`. If `Bun.deepEquals(next, this.loaded)`, return `"unchanged"`.*  
> *4. `await old.scheduler?.retire()`. If `stop()` ran meanwhile, publish the view with `scheduler: undefined` and return.*  
> *5. Call `build(next)` inside a try...*  
> *6. Publish the new view in ONE assignment, set `loaded = next`, and log... Return `"reloaded"`.*

**The Race Window:**
- Suppose version is 1.
- At $t_0$, user edits TOML $\to$ version becomes 2.
- `check()` runs: records `lastVersion = 2`, calls `load()`, and begins `await old.scheduler?.retire()`. Retiring `old.scheduler` can take several seconds if an LLM job or sweep subject is actively in flight.
- At $t_1$ (while `retire()` is still awaiting): user edits TOML again $\to$ version becomes 3.
- At $t_2$: another `check()` is triggered (by the 5s interval timer or by an automated test).
  - Step 1 returns the pending reload promise!
  - Step 4 completes for version 2. Version 2 is built and published.
  - Caller receives `"reloaded"`, but the published state reflects version 2, not version 3!
- In production, the 5-second interval timer will eventually catch version 3 on its next tick because `version()` (3) $\neq$ `lastVersion` (2).
- **However, in unit/integration tests**, a test that makes multiple edits and awaits `check()` could observe a stale intermediate configuration if `check()` returns the promise of a check that started *before* the latest edit was made.
- **Refinement:**
  In `check()`, if another check was requested while a reload was in-flight, or if `this.deps.version() !== this.lastVersion` upon waking from `retire()`, `check()` should loop or re-run to ensure the latest snapshot is applied before declaring settlement:
  ```ts
  async check(): Promise<"unchanged" | "reloaded"> {
    if (this.pendingReload) return this.pendingReload;
    this.pendingReload = this.doCheck();
    try {
      return await this.pendingReload;
    } finally {
      this.pendingReload = undefined;
    }
  }
  ```
  Inside `doCheck()`: after `retire()` finishes, if `this.deps.version() !== versionSeen`, re-evaluating `load()` ensures the newly built scheduler immediately reflects the most current TOML without requiring an extra 5-second interval wait.

---

### 1.3 `settled()` Exception Safety

Task 2 specifies:
> `settled(): Promise<void>; // resolves when no reload is pending`

In Task 3, `handleRunNow` does:
```ts
await ctx.settled?.();
```
- If an unhandled exception were to occur during `check()` (e.g. an unexpected file system permission error or memory error in `load()`), `this.pendingReload` must not reject in a way that permanently breaks `settled()` or future `check()` calls.
- `doCheck()` must catch unexpected errors internally, log them, ensure `this.pendingReload` is cleared in a `finally` block, and `settled()` should always resolve (`await this.pendingReload?.catch(() => undefined)`).
- This guarantees `nimbus fleet run` will never fail with an unhandled rejection because of a background supervisor error.

---

### 1.4 Eliminating Generational Tearing in `FleetRpcCtx`

Task 3 states:
> *"Production supplies `scheduler`/`config`/`jobs` as getters (Task 4), so each handler must read them in ONE synchronous destructuring (`const { scheduler, config, jobs } = ctx;`) after its last `await` and before any later one. A swap publishes in one assignment, so a synchronous read cannot see half of two generations."*

Let's inspect the existing handlers in `packages/gateway/src/ipc/fleet-rpc.ts`:
1. **`handleStatus`:**
   Currently probes host activity first:
   ```ts
   async function handleStatus(_params: unknown, ctx: FleetRpcCtx): Promise<FleetStatusResult> {
     const probe = await ctx.hostActivity.probe();
     const { config, scheduler, jobs } = ctx; // MUST destructure AFTER the probe await
     return {
       enabled: config.enabled,
       running: scheduler !== undefined,
       allowRemote: config.allowRemote,
       ...
       jobsConfigured: jobs?.length ?? 0,
       probe,
     };
   }
   ```
   Destructuring after `await ctx.hostActivity.probe()` guarantees that `running`, `enabled`, and `jobsConfigured` are sampled synchronously from the same generation.
2. **`handleList`:**
   In `handleList`, `rotationExceedsRetention` computes:
   ```ts
   Math.ceil(total / j.sweep.maxSubjects) * j.intervalSeconds * 1000 > ctx.config.retentionDays * 86_400_000
   ```
   If `ctx.jobs` and `ctx.config` were read separately, a reload swap between the loop and the config read could compare job intervals against a different generation's retention window. Destructuring `{ config, jobs, store } = ctx;` at the top of `handleList` prevents this.
3. **`handleDigest`:**
   Similarly, `const { config, jobs, store } = ctx;` at the start of `handleDigest` ensures the jobs list passed to `buildFleetDigest` matches the `config.retentionDays` parameter.

---

## 2. Open Questions & Architectural Clarifications

### 2.1 Supervisor Timer Lifecycle & `.unref()` Behavior

- In Task 2:
  ```ts
  start(): void; // the check interval, unref'd
  ```
- **Clarification:** In Bun/Node, `setInterval(..., checkMs).unref()` keeps the timer from holding the process open when all connections and servers close.
- When `stop()` is called (registered on `deps.sidecarStops`):
  ```ts
  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.stopped = true;
    this.view.scheduler?.stop();
  }
  ```
- Because `sidecarStops` callbacks are executed during gateway shutdown in `gateway-main.ts` (`disposeSidecars()`), stopping the supervisor's interval and stopping the live scheduler's tick timer synchronously prevents any dangling timers.

---

### 2.2 Boot Prune vs. Reload Prune

- Task 4 Step 3 notes:
  > *"Split `assembleFleetRuntime` into three parts: `loadFleet(deps): FleetLoad` (today's try/catch, error log and retention floor), the boot prune (unchanged, run once on the boot load, which is read right after `bootVersion = getLayeredConfig(...).snapshot().version`), and `buildFleetScheduler(deps, load): FleetScheduler | undefined`"*
- **Confirming Invariant:**
  - The boot prune (`store.pruneRuns(...)` and `store.pruneBriefs(...)`) runs **once** at process boot using `bootLoad.config.retentionDays`.
  - When the fleet reloads later due to a config change, should `pruneRuns` be triggered again?
  - **Answer from Spec & Scheduler design:** No. In `FleetScheduler`, `execute()` already calls `store.pruneRuns(...)` and `store.pruneBriefs(...)` at the completion of every run. Running a database prune on every TOML edit or pack toggle is unnecessary and could add I/O latency to the supervisor loop. Pruning once at boot + at the end of each run is the correct contract.

---

### 2.3 Policy Retention Floor Dynamic Re-evaluation

- When `loadFleet(deps)` is called on each reload:
  ```ts
  const config: NimbusFleetToml = {
    ...fleet.config,
    retentionDays: effectiveRetentionDays(
      fleet.config.retentionDays,
      deps.policyGate.enforced().retentionMinDays,
    ),
  };
  ```
- Because `deps.policyGate.enforced()` is evaluated dynamically inside `loadFleet(deps)`, if an organization installs a tighter signed policy via `policyGate.applyVerified(...)` while the gateway is running, the next fleet reload will immediately respect the updated `retentionMinDays` floor.
- This aligns with the lazy policy reading pattern already used in `capabilityDisabled` (`fleet-scheduler.ts:3316`).

---

## 3. Concrete Implementation Refinements

### 3.1 `FleetScheduler.retire()` Pattern (Task 1)

```ts
export class FleetReloadingError extends Error {
  constructor(message = "fleet is reloading its config; try again") {
    super(message);
    this.name = "FleetReloadingError";
  }
}

export class FleetScheduler {
  private retired = false;
  private running: Promise<FleetRunSummary> | undefined;
  private retirePromise: Promise<void> | undefined;

  async runOnce(opts?: FleetRunOptions): Promise<FleetRunSummary> {
    if (!this.deps.config.enabled) {
      throw new FleetDisabledError("fleet is disabled ([fleet] enabled = false)");
    }
    if (this.deps.capabilityDisabled) {
      throw new FleetDisabledError("fleet is disabled by org policy");
    }
    if (this.retired) {
      throw new FleetReloadingError();
    }

    const jobName = opts?.jobName;
    const jobs =
      jobName === undefined ? this.deps.jobs : this.deps.jobs.filter((j) => j.name === jobName);
    if (jobName !== undefined && jobs.length === 0) {
      throw new FleetJobNotFoundError(`no such fleet job: ${jobName}`);
    }

    if (this.inFlight) {
      return {
        runId: null,
        outcome: "deferred",
        jobsAttempted: 0,
        jobsCompleted: 0,
        jobsUnattempted: jobs.length,
        jobsSkippedNotDue: 0,
        subjectsInScope: 0,
        subjectsAttempted: 0,
        subjectsCompleted: 0,
      };
    }

    this.inFlight = true;
    const runPromise = this.execute(jobs, opts?.force === true, jobName !== undefined);
    this.running = runPromise;
    try {
      return await runPromise;
    } finally {
      this.inFlight = false;
      this.running = undefined;
    }
  }

  retire(): Promise<void> {
    if (this.retirePromise) return this.retirePromise;
    this.retired = true;
    this.stop();
    this.retirePromise = (async () => {
      await this.running?.catch(() => undefined);
    })();
    return this.retirePromise;
  }
}
```

---

### 3.2 `FleetSupervisor` Implementation Blueprint (Task 2)

```ts
export class FleetSupervisor {
  private lastVersion: number;
  private loaded: FleetLoad;
  private view: FleetView;
  private timer?: Timer;
  private stopped = false;
  private pendingReload?: Promise<"unchanged" | "reloaded">;

  constructor(
    private readonly deps: FleetSupervisorDeps,
    boot: { readonly version: number; readonly load: FleetLoad },
  ) {
    this.lastVersion = boot.version;
    this.loaded = boot.load;
    const scheduler = deps.build(boot.load);
    scheduler?.start();
    this.view = {
      scheduler,
      config: boot.load.config,
      jobs: boot.load.jobs,
    };
  }

  current(): FleetView {
    return this.view;
  }

  start(): void {
    if (this.timer !== undefined || this.stopped) return;
    const ms = this.deps.checkMs ?? FLEET_RELOAD_CHECK_MS;
    this.timer = setInterval(() => {
      this.check().catch((err) => {
        this.deps.logger.error({ err: err instanceof Error ? err.message : String(err) }, "[fleet] supervisor check failed");
      });
    }, ms);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    this.stopped = true;
    this.view.scheduler?.stop();
  }

  settled(): Promise<void> {
    if (!this.pendingReload) return Promise.resolve();
    return this.pendingReload.catch(() => undefined).then(() => undefined);
  }

  async check(): Promise<"unchanged" | "reloaded"> {
    if (this.pendingReload) return this.pendingReload;
    const p = this.runCheck();
    this.pendingReload = p;
    try {
      return await p;
    } finally {
      this.pendingReload = undefined;
    }
  }

  private async runCheck(): Promise<"unchanged" | "reloaded"> {
    const v = this.deps.version();
    if (v === this.lastVersion) return "unchanged";
    this.lastVersion = v;

    const next = this.deps.load();
    if (Bun.deepEquals(next, this.loaded)) return "unchanged";

    const oldScheduler = this.view.scheduler;
    await oldScheduler?.retire();

    if (this.stopped) {
      this.view = { scheduler: undefined, config: next.config, jobs: next.jobs };
      this.loaded = next;
      return "reloaded";
    }

    let nextScheduler: FleetScheduler | undefined;
    try {
      nextScheduler = this.deps.build(next);
      nextScheduler?.start();
    } catch (err) {
      this.deps.logger.error(
        { err: err instanceof Error ? err.message : String(err) },
        "[fleet] supervisor failed to build scheduler from new config",
      );
      nextScheduler = undefined;
    }

    this.view = {
      scheduler: nextScheduler,
      config: next.config,
      jobs: next.jobs,
    };
    this.loaded = next;

    this.deps.logger.info(
      `[fleet] config changed; reloaded (enabled=${String(next.config.enabled)}, jobs=${String(next.jobs.length)}, running=${String(nextScheduler !== undefined)})`,
    );
    return "reloaded";
  }
}
```

---

### 3.3 Integration Test Setup Pattern (Task 4)

In `packages/gateway/test/integration/fleet/fleet-live-reload.test.ts`:
Ensure `initLayeredConfig` is passed the exact `PackLayerStore` instance:
```ts
const dir = makeTempConfigDir();
const packStore = createPackLayerStore({ configDir: dir });
const layered = initLayeredConfig(dir, { packs: packStore });
```
In `afterEach`:
```ts
forgetLayeredConfigForTests(dir);
```
This guarantees the pack store registered on the layered reader receives the mutated pack layers during the test.

---

## 4. Invariants & Safety Verification

| Invariant / Rule | Status | Verification Detail |
|---|---|---|
| **I5 (LAN RPC forbidden)** | Compliant | `fleet.*` namespace remains LAN-forbidden in dispatchers. |
| **I7 (Tauri allowlist)** | Compliant | `fleet.*` remains strictly off the Tauri renderer allowlist. |
| **I33 (Kill switch & org policy before work)** | Compliant | `FleetScheduler.runOnce()` checks local kill-switch and org policy before checking `this.retired`. |
| **I38 (One budget per generation)** | Compliant | `buildFleetScheduler` creates a fresh `createFleetRemoteBudget` for each new generation, shared by that generation's scheduler and invoker. |
| **D35 (Layered config reader only)** | Compliant | `loadNimbusFleetFromConfigDir` is used; no path constructing to `nimbus.toml`. |

---

## Conclusion & Recommendation

The PR 3 implementation plan is exceptionally thorough and addresses a high-value functionality without introducing architectural sprawl. Incorporating the **idempotent `retirePromise`**, **exception-safe `settled()`**, and **synchronous getter destructuring** detailed above will ensure execution proceeds smoothly without flakes or regressions. Proceed with implementation as planned.
