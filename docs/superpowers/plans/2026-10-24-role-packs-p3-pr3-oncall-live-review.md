# Review: Role Packs P3 — PR 3 (`[oncall.push] enabled` from a pack, live)

**Reviewed plan:** [2026-10-24-role-packs-p3-pr3-oncall-live.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/plans/2026-10-24-role-packs-p3-pr3-oncall-live.md)  
**Parent spec:** [2026-10-24-role-packs-p3-the-pack-design.md](file:///C:/gitrep/Nimbus/.claude/worktrees/role-packs/docs/superpowers/specs/2026-10-24-role-packs-p3-the-pack-design.md) §§ 5.4, 5.9, 5.10  
**Date:** 2026-10-24  

---

## Executive Summary

PR 3 completes Project 3 of Role Packs by making `[oncall.push] enabled` pack-settable and live without a gateway restart, updating the bundled DevOps pack to version `1.1.0` with `[oncall.push] enabled = true`, and adding an `[info]` advisory line in `nimbus doctor` when pack updates are available.

The plan is well-scoped, concise, and closely follows the established `FleetSupervisor` reactive model. A detailed walkthrough of the implementation steps against the live codebase ([`push-runtime.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/oncall-push/push-runtime.ts), [`push-runner.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/oncall-push/push-runner.ts), [`push-store.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/oncall-push/push-store.ts), [`pack-install.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/packs/pack-install.ts), [`pack-prompt.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/packs/pack-prompt.ts), and [`doctor-core.ts`](file:///C:/gitrep/Nimbus/packages/cli/src/commands/doctor-core.ts)) surfaces **5 edge cases / implementation traps to guard against**, **4 open questions / clarifications**, and **4 concrete implementation refinements**.

---

## 1. Implementation Traps & Edge Cases to Guard Against (Must-Address)

### 1.1 `LiveEnabled` Error Handling & Log Flood Guard (Task 1)

In Task 1 Step 1:
> *"a load that throws keeps the last value, logs once for that version, and does not throw. Call `isEnabled()` twice at the same version and expect one log."*

**The Trap:**
- If `load()` throws (e.g. malformed TOML mid-save or disk I/O blip), `LiveEnabled` must catch the error, log via `deps.logger.error`, and keep the previous `enabled` value.
- If `lastVersion` is NOT updated upon catching an error, then:
  1. Every subsequent call to `isEnabled()` at that version will retry `load()`, throw again, and log again.
  2. More critically, the 5-second interval timer (`checkMs`) will call `refresh()` every 5 seconds, causing continuous error log spam until the user edits the configuration again!
- If `lastVersion` IS updated to the throwing version, a subsequent call to `isEnabled()` at the same version will see `version() === lastVersion` and return immediately without logging.

**Recommendation:**
In `LiveEnabled`:
```ts
let lastVersion = boot.version;
let currentEnabled = boot.enabled;
let lastLoggedErrorVersion = -1;

function refresh(): boolean {
  const v = deps.version();
  if (v === lastVersion) return currentEnabled;

  try {
    const next = deps.load();
    lastVersion = v;
    if (next !== currentEnabled) {
      deps.reconcile(next, deps.now());
      currentEnabled = next;
    }
  } catch (err) {
    if (lastLoggedErrorVersion !== v) {
      lastLoggedErrorVersion = v;
      deps.logger.error(
        { err: err instanceof Error ? err.message : String(err), version: v },
        "[oncall.push] failed to reload config; keeping previous state",
      );
    }
    // Update lastVersion so the interval tick doesn't repeat the failing load every 5s
    lastVersion = v;
  }
  return currentEnabled;
}
```

---

### 1.2 Synchronous Nature of `LiveEnabled.refresh()` vs. 3-Pass Loop (Task 1)

In Task 1 Step 3:
> *"Like `FleetSupervisor`, it loops while the version keeps moving during a load. Bound it to 3 passes, then keep the newest value."*

**The Trap:**
- In [`FleetSupervisor`](file:///C:/gitrep/Nimbus/packages/gateway/src/fleet/fleet-supervisor.ts#L161-L172), looping was necessary because `await old?.retire()` yielded execution to the JavaScript microtask/event queue while waiting for active in-flight fleet runs to settle.
- In `LiveEnabled`, [`loadNimbusOncallPushFromConfigDir`](file:///C:/gitrep/Nimbus/packages/gateway/src/config/oncall-push-toml.ts#L101) is **completely synchronous** (`readFileSync` / `layeredConfigText`).
- No async suspension occurs during `deps.load()` or `deps.reconcile()`.
- Therefore, within a single JavaScript execution turn, `deps.version()` cannot change during `deps.load()` unless `deps.load()` itself triggers a side-effect that mutates the layered store.

**Recommendation:**
Ensure the 3-pass bound is written as a clean synchronous `while` loop without `async`/`await`:
```ts
let passes = 0;
while (passes < 3) {
  passes++;
  const v = deps.version();
  if (v === lastVersion) break;
  // load and reconcile...
}
```
Clarify in the task notes that `LiveEnabled.isEnabled()` and `refresh()` are fully synchronous and must never return a `Promise`.

---

### 1.3 `PromptScalar` Current Value vs. Code Default Format (Task 2)

In Task 2 Step 1:
> *"`pack-install.test.ts`: the devops install prompt has an `oncall.push.enabled` scalar row whose current value and layer come from `explainConfig` (`false`, `default`)."*

**The Trap:**
- In [`pack-install.ts:238-243`](file:///C:/gitrep/Nimbus/packages/gateway/src/packs/pack-install.ts#L238-L243):
  ```ts
  const winner = explainConfig(reader, key).entries[0];
  rows.push({
    key,
    packValue: String(value),
    current: winner?.value,
    currentLayer: winner === undefined ? "default" : layerLabel(winner),
    userOverrides: winner?.source.kind === "layer" && isUserLayer(winner.source.layer),
  });
  ```
- When `[oncall.push] enabled` is not present in any TOML layer file (the default initial state), [`explainConfig`](file:///C:/gitrep/Nimbus/packages/gateway/src/config/config-explain.ts#L446) produces `entries: []`.
- `winner` is `undefined`. Thus `current` is `undefined`, and `currentLayer` is `"default"`.
- In [`pack-prompt.ts:150-155`](file:///C:/gitrep/Nimbus/packages/gateway/src/packs/pack-prompt.ts#L150-L155):
  ```ts
  const cur = s.current === undefined
    ? "unset"
    : `current ${visibleText(s.current)} (${visibleText(s.currentLayer ?? "unknown")})`;
  ```
- If `s.current` is `undefined`, the rendered line outputs `"oncall.push.enabled = true, unset"`, **NOT** `"current false (default)"`!
- If the test in `pack-install.test.ts` asserts `current: "false"`, it will fail unless an explicit `nimbus.toml` with `enabled = false` exists.

**Recommendation:**
Clarify in Task 2 Step 1 that for a clean environment without an explicit owner config, the expected `PromptScalar` row is:
`{ key: "oncall.push.enabled", packValue: "true", current: undefined, currentLayer: "default", userOverrides: false }`, which formats into the prompt as `unset`.

---

### 1.4 Test Isolation & Interval Timer Teardown (Task 1 & Task 2)

In Task 1 & Task 2:
- `LiveEnabled.start()` starts a `setInterval(..., checkMs)`.
- In Bun/Node test runners, uncleared intervals (even `.unref()`'d ones) can prevent tests from completing cleanly or cause asynchronous operations to run after test teardown.
- In [`push-runtime.test.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/oncall-push/push-runtime.test.ts), tests instantiate multiple runtimes using `boot()`.

**Recommendation:**
1. In `createLiveEnabled`: ensure `this.timer?.unref?.()` is safely called.
2. In `push-runtime.test.ts` and `push-live-pack.integration.test.ts`, ensure every test calls `rt.stop()` in `afterEach` or keeps a tracking list of created runtimes to stop after each test.

---

### 1.5 Test Mocking for Unresolved Identity in Integration Test (Task 2)

In Task 2 Step 1:
> *"Run `assembleOncallPushRuntime({ ..., settleImmediately: true, checkMs: 60_000 })` with a `resolveSelf` that yields no identity (the runner then reports `identity_unresolved` once enabled, which proves the gate opened)"*

**The Trap:**
- [`OncallPushBootDeps`](file:///C:/gitrep/Nimbus/packages/gateway/src/oncall-push/push-runtime.ts#L37-L60) currently does NOT accept `resolveSelf`.
- Instead, [`assembleOncallPushRuntime`](file:///C:/gitrep/Nimbus/packages/gateway/src/oncall-push/push-runtime.ts#L76-L83) constructs `resolveSelf` internally via `loadNimbusUserFromConfigDir` and [`resolveSelfPerson`](file:///C:/gitrep/Nimbus/packages/gateway/src/agents/_lib/self-person.ts).
- If a developer assumes `resolveSelf` can be passed as an argument to `assembleOncallPushRuntime`, they will hit a TypeScript compile error.

**Recommendation:**
Either:
1. Note that in a fresh temporary directory with an empty SQLite database and no user config, `resolveSelfPerson` naturally resolves to `null` (`identity_unresolved`) without any mock injection.
2. Or explicitly add optional `resolveSelf?: () => Promise<string | null>` to `OncallPushBootDeps` as a test seam.

---

## 2. Open Questions & Design Clarifications

### 2.1 Doctor Advisory String for Single vs. Multiple Updates (Task 4)

In Task 4 Step 1:
> *"`one [info] line per profile naming each pack with an update`, exact copy:  
> `[info] pack updates available (profile "default"): pm 1.0.0 -> 1.1.0, devops version unknown -> 1.1.0. Re-install with: nimbus pack install <id>`"*

**Question:**
When only one pack has an update available (e.g. only `devops`):
- Does the command hint say `Re-install with: nimbus pack install devops`?
- Or does it remain literal `<id>`: `Re-install with: nimbus pack install <id>`?

**Clarification / Recommendation:**
Always using the literal `<id>` placeholder (`Re-install with: nimbus pack install <id>`) keeps the output format uniform regardless of whether 1 or multiple packs have updates. Alternatively, if exactly one pack is listed, `nimbus pack install ${pack.id}` is friendlier to the user. Specifying this explicitly avoids test expectation discrepancies.

---

### 2.2 Client Interface for `doctorPrintPackUpdates` (Task 4)

In Task 4 Interfaces:
> *`async function doctorPrintPackUpdates(client: IPCClient): Promise<number>`*

**Clarification:**
In [`doctor-core.ts`](file:///C:/gitrep/Nimbus/packages/cli/src/commands/doctor-core.ts#L876), helper functions like `doctorPrintMigrations` and `doctorPrintExtensions` take `Pick<IPCClient, "call">`:
```ts
export async function doctorPrintMigrations(client: Pick<IPCClient, "call">): Promise<number>
```
Using `Pick<IPCClient, "call">` allows unit tests in `doctor-core.test.ts` to pass simple `{ call: async () => ... }` fakes without mocking socket handles, lifecycle methods, or auth headers.

---

### 2.3 Additional Test Fakes Impacted by Type Changes (Task 2)

In Task 2 Interfaces:
- `OncallPushRuntime.config: Omit<NimbusOncallPushToml, "enabled">`
- `OncallPushRuntime` gains `isEnabled(): boolean` and `stop(): void`.

**Clarification:**
Beyond `push-runtime.test.ts` and `oncall-push-rpc.test.ts`, [`dispatchers-oncall-push.test.ts`](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/server/dispatchers-oncall-push.test.ts#L31-L49) defines a local `fakeRuntime` implementing `OncallPushRuntime`.
Task 2 should explicitly list `packages/gateway/src/ipc/server/dispatchers-oncall-push.test.ts` in files to update so `bun run typecheck` doesn't flag unexpected errors.

---

### 2.4 Allowlist Key Ordering in `PACK_SETTABLE_KEYS` (Task 2)

In Task 2 Step 1:
> *"`pack-settable.test.ts`: the exact-set test lists `oncall.push.enabled` after `fleet.retention_days`."*

**Clarification:**
Currently, [`PACK_SETTABLE_KEYS`](file:///C:/gitrep/Nimbus/packages/gateway/src/config/pack-settable.ts#L47-L88) is structured as:
1. `fleet.enabled`
2. `fleet.min_idle_seconds`
3. `fleet.require_ac_power`
4. `fleet.retention_days`
5. `decisions.min_confidence`

Placing `oncall.push.enabled` immediately after `fleet.retention_days` inserts it between `fleet.retention_days` and `decisions.min_confidence`. Ensure `PACK_SETTABLE_KEYS` in `pack-settable.ts` and the exact-set test in `pack-settable.test.ts` match this order.

---

## 3. Concrete Implementation Suggestions & Refinements

### 3.1 Registering Shutdown in `assemble.ts` via `pushStops`

In Task 2:
> *"In `assemble.ts`, right after `createSchedulerWithMesh` returns, push `sidecarStops.push(() => oncallPush.stop())`, with the fleet supervisor's one-line comment on why."*

**Suggestion:**
In [`assemble.ts:3907-3912`](file:///C:/gitrep/Nimbus/packages/gateway/src/platform/assemble.ts#L3907-L3912), `pushStops` is already used to register sidecar stops without introducing branches (which triggers Sonar S3776 cognitive complexity limits):
```ts
pushStops(sidecarStops, [
  glossaryRefresher,
  decisionsRefresher,
  ownershipRefresher,
  premortemRefresher,
  oncallPush,
]);
```
Since `oncallPush` implements `{ stop: () => void }`, passing it directly to `pushStops` is clean and maintains 0 extra branch points.

---

### 3.2 Sanitize Doctor Dynamic Text via `stripControlChars`

In Task 4:
Ensure every field extracted from `pack.list` before interpolation into console output is sanitized:
```ts
const profileStr = stripControlChars(result.profile);
const idStr = stripControlChars(p.id);
const fromVer = p.versionUnknown ? "version unknown" : stripControlChars(p.version);
const toVer = p.bundledVersion ? stripControlChars(p.bundledVersion) : "a newer build";
```
This guarantees defense-in-depth against terminal escape character injection.

---

### 3.3 Reconcile Bypass on Identical Enabled Value

In Task 1:
When `LiveEnabled` checks a version bump, if `nextEnabled === this.currentEnabled`, it should skip calling `deps.reconcile(nextEnabled, deps.now())`.
This avoids SQLite transactions and write queries when unrelated configuration sections (such as agent visibility or glossary settings) change while `[oncall.push]` remains untouched.

---

## Summary of Recommendations

| Section | Topic | Recommendation |
|---|---|---|
| **Task 1** | Error handling & logging | Update `lastVersion` upon catching `load()` errors to prevent 5s timer log spam. |
| **Task 1** | Synchronous execution | Keep `isEnabled()` and `refresh()` fully synchronous; avoid async loops. |
| **Task 2** | `PromptScalar` formatting | Expect `current: undefined` (`"unset"`) on fresh configs rather than `false`. |
| **Task 2** | Teardown in tests | Call `rt.stop()` in `afterEach` hooks to prevent uncleared interval warnings. |
| **Task 2** | Test fakes | Include `dispatchers-oncall-push.test.ts` in type check updates for `OncallPushRuntime`. |
| **Task 4** | IPC client typing | Use `Pick<IPCClient, "call">` for `doctorPrintPackUpdates` to simplify test fakes. |
| **Task 4** | Console sanitization | Pass all profile, ID, and version strings through `stripControlChars`. |
