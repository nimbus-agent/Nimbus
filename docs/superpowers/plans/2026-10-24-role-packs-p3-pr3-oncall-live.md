# Role packs P3 PR 3: `[oncall.push] enabled` from a pack, live — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pack can set `[oncall.push] enabled`, and installing or removing it takes effect
without a restart. The DevOps pack sets it. `nimbus doctor` reports an available pack update as
`[info]`.

**Architecture:**
- `[oncall.push] enabled` joins the pack-settable allowlist as a `reactive` key.
- The on-call push runtime stops reading `enabled` from its boot-time config. A small
  `LiveEnabled` object owns it instead. It compares the layered snapshot version on every read and
  on a 5 s timer, and when the version moved it re-reads `[oncall.push]` and reconciles the push
  store, so a re-enable records a fresh `enabled_at`.
- The runner, the `oncall.pushedList` RPC and the boot path all read through it. Its timer is
  stopped through `sidecarStops`.
- Doctor reads `pack.list`, which PR 2 shipped.

**Tech Stack:** TypeScript 7 strict, Bun test.

**Spec:** `docs/superpowers/specs/2026-10-24-role-packs-p3-the-pack-design.md` §§ 5.4 (the doctor
line), 5.9 and 5.10 (branch `dev/asaf/role-packs` only).

## Global Constraints

- **Code rules:**
  - No `any`.
  - Paths via `node:path`.
  - Biome clean.
  - Prefer dependency injection over `mock.module`.
- **Coverage:** every new or changed source file needs ≥ 85 % lines and ≥ 80 % branches
  (`audit:coverage-floor`, CI-Linux-authoritative).
- **Branch:** `dev/asafgolombek/role-packs-p3-oncall-live` from current `main`. The spec and this
  plan never land on `main`.
- **Only `enabled` becomes live.** Every other `[oncall.push]` key keeps its boot-time read, and
  `chatops_namespace` stays off the allowlist (spec § 5.9).
- **"Enabling never backfills history" stays true:**
  - a disable deletes the `oncall_push_state` row;
  - an enable inserts it with `enabled_at = now`, which is `PushStore.reconcileEnabledState` as it
    is today;
  - the runner must never see "enabled" with no reconciled row.
- **The owner's own file still wins.** `loadNimbusOncallPushFromConfigDir` already reads the
  layered snapshot (packs < base < active profile). A pack's `enabled = true` under an owner's
  `enabled = false` stays off.
- **Doctor:** an available update is `[info]` and never changes the exit code. A gateway without
  `pack.list` (`-32601`, or any error) prints nothing.
- **The DevOps pack moves to version `1.1.0`.** PR 2 shipped `1.0.0` without the line, so an
  owner who installed it sees "update available", and the re-install diff shows the one added
  scalar.

## Review Focus

1. **A pack sets `enabled = true` but the owner's `nimbus.toml` sets `enabled = false`:** push
   stays off, before and after the install (Task 2 test).
2. **Install, then remove, then install again:** each install records a NEW `enabled_at` (the one
   current at that install), so incidents opened while the pack was removed are never pushed
   (Task 2 test).
3. **A layered reload that throws** (an unreadable `nimbus.toml` mid-run): the last known value is
   kept, the error is logged once per version, and nothing throws into the sync hook (Task 1 test).
4. **Gateway shutdown:** after `stop()`, no timer is left, and a later `isEnabled()` still answers
   without reloading (Task 1 test).
5. **`nimbus doctor` against an older gateway, or with no pack installed:** no line, and the exit
   code is unchanged even when an update is available (Task 4 test).

---

### Task 1: `LiveEnabled`, the live reader for `[oncall.push] enabled`

**Files:**
- Create: `packages/gateway/src/oncall-push/push-live-enabled.ts`,
  `packages/gateway/src/oncall-push/push-live-enabled.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export const ONCALL_PUSH_RELOAD_CHECK_MS = 5_000;
  export interface LiveEnabledDeps {
    readonly version: () => number;          // the layered snapshot's version
    readonly load: () => boolean;            // re-reads [oncall.push] enabled (may throw)
    readonly reconcile: (enabled: boolean, nowMs: number) => void; // PushStore.reconcileEnabledState
    readonly now: () => number;
    readonly logger: { error(obj: Record<string, unknown>, msg: string): void };
    readonly checkMs?: number;
  }
  export interface LiveEnabled {
    isEnabled(): boolean;   // refreshes first when the version moved; never throws
    start(): void;          // idempotent; the interval is .unref()'d
    stop(): void;           // clears the interval; isEnabled keeps answering the last value
  }
  export function createLiveEnabled(deps: LiveEnabledDeps, boot: { version: number; enabled: boolean }): LiveEnabled;
  ```

- [ ] **Step 1: Write the failing tests.** Use fake `version`/`load`/`reconcile` and a fake clock;
  do not use real timers except in the `start/stop` case (`checkMs: 5`).
  - `isEnabled returns the boot value without loading while the version is unchanged`
    (`load` call count 0).
  - `a version change reloads once and reconciles with the new value and now()`. Flip `load` to
    true, bump the version, and assert `reconcile` was called with `(true, <now>)` and
    `isEnabled()` is true.
  - `an unchanged value after a version bump reconciles nothing`. The `reconcile` count stays 0,
    so an unrelated pack change never resets `enabled_at`.
  - `a disable after enable reconciles false` (the row is deleted by the real store; here assert
    the call).
  - `a load that throws keeps the last value, logs once for that version, and does not throw`.
    Call `isEnabled()` twice at the same version and expect one log, with two `load` calls.
  - `a failed load is retried silently and recovers at the same version`. The first `load` throws
    and the second returns true at the SAME version, so `isEnabled()` becomes true, `reconcile`
    runs once and there is still only one log. A transient read error must not pin a stale value
    until the next config change.
  - `start polls; stop clears the timer and a later version change is not polled`. The
    implementation must not call `isEnabled` from the timer after `stop`, but a direct
    `isEnabled()` after `stop()` still answers (Review Focus 3, 4).

- [ ] **Step 2:** `bun test packages/gateway/src/oncall-push/push-live-enabled.test.ts`. Expected:
  FAIL (module missing).

- [ ] **Step 3: Implement.**
  - Everything is **synchronous**: `isEnabled()` and the private `refresh()` never return a
    Promise. `loadNimbusOncallPushFromConfigDir` is synchronous, so the version cannot move during
    a load and no re-check loop is needed. This differs from `FleetSupervisor`, which loops only
    because it awaits `retire()`.
  - The timer's tick calls the same `refresh()` as `isEnabled()`, so there is one code path.
  - `refresh()` reads `version()`:
    - an unchanged version returns the cached value;
    - a changed one calls `load()`. On success it records the version, and calls `reconcile` only
      when the value differs. On a throw it keeps the old value and does NOT record the version,
      so the next tick retries. It logs only when the failing version differs from the last
      version it logged for.
  - The interval is `.unref()`'d. `stop()` is idempotent.

- [ ] **Step 4:** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `feat(oncall-push): a live reader for [oncall.push] enabled`.

### Task 2: Wire it through the runtime, the runner and the RPC; make the key pack-settable

**Files:**
- Modify:
  - `packages/gateway/src/oncall-push/push-runtime.ts`
  - `packages/gateway/src/oncall-push/push-runner.ts` (`:47` `config`, `:179` the gate)
  - `packages/gateway/src/ipc/oncall-push-rpc.ts` (`:98`)
  - `packages/gateway/src/platform/assemble.ts` (add `oncallPush` to the existing
    `pushStops(sidecarStops, [...])` list at ~`:3832`)
  - every other implementer or caller of `OncallPushRuntime`. `git grep -n OncallPushRuntime` on
    `main` finds `ipc/server/dispatchers-oncall-push.test.ts` (a hand-written fake),
    `ipc/oncall-push-rpc.test.ts` (a fake), `ipc/oncall-push-rpc.contract.test.ts`,
    `ipc/demo-rpc.ts` + `demo-rpc.test.ts`, and `demo/seed.ts` + `seed.test.ts`. Every test that
    assembles a real runtime calls `rt.stop()` in `afterEach`, or in a `finally`.
  - `packages/gateway/src/config/pack-settable.ts` (`PACK_SETTABLE_KEYS`)
  - `packages/gateway/src/packs/bundled/devops.json`
  - every test that builds a runner or runtime config with `enabled` (compile errors find them)
- Test:
  - `packages/gateway/src/oncall-push/push-runtime.test.ts`, `packages/gateway/src/ipc/oncall-push-rpc.test.ts`, `packages/gateway/src/packs/pack-install.test.ts`
  - `packages/gateway/src/config/pack-settable.test.ts`
  - `packages/gateway/src/packs/bundled-packs.test.ts`
  - a new `packages/gateway/src/oncall-push/push-live-pack.integration.test.ts`

**Interfaces:**
- Consumes: Task 1 `createLiveEnabled`.
- Produces:
  - `OncallPushRuntime.config: Omit<NimbusOncallPushToml, "enabled">`. The `enabled` field is
    removed, so every stale reader is a compile error, not a silent boot-time value.
  - `OncallPushRuntime.isEnabled(): boolean` and `OncallPushRuntime.stop(): void`.
  - `OncallPushBootDeps` gains `version?: () => number`, defaulting to
    `() => getLayeredConfig(configDir).snapshot().version`, and `checkMs?: number`.
  - `OncallPushRunnerDeps.config: Omit<NimbusOncallPushToml, "enabled">` plus
    `isEnabled: () => boolean`.
  - `PACK_SETTABLE_KEYS` gains, after the fleet keys:
    `{ section: "oncall.push", key: "enabled", consumer: "reactive", why: "turns the on-call pushed brief on or off; the owner's own file still overrides it", expect: "true or false", parse: parseBool }`.
  - `devops.json`: `version` `"1.1.0"`, and its `defaults` gain a final section after the
    `[[fleet.job]]` block: a blank line, `[oncall.push]`, `enabled = true`.

- [ ] **Step 1: Write the failing tests.**
  - `pack-settable.test.ts`: the exact-set test lists `oncall.push.enabled` after
    `fleet.retention_days`. Add `checkPackFragment("[oncall.push]\nenabled = true\n")` ok, and
    `[oncall.push]\nchatops_namespace = "x"\n` refused.
  - `bundled-packs.test.ts`: devops is `1.1.0`, and its parsed scalars include
    `oncall.push.enabled = true`. The existing "pm and devops install together" test still passes.
  - **`push-live-pack.integration.test.ts`** (spec § 5.9's required test). Use a temp configDir, a
    real migrated DB, one `createPackLayerStore`, and `initLayeredConfig(dir, { packs: store })`.
    Run `assembleOncallPushRuntime({ ..., settleImmediately: true, checkMs: 60_000 })`.
    `OncallPushBootDeps` has no `resolveSelf` seam and none is added. With an empty `person` table
    and no `[user]` override, `resolveSelfPerson` returns null (the git and OS-username lookups
    find no person), so once push is enabled the runner reports `identity_unresolved`, which
    proves the gate opened. First assert `await runtime.identityResolved()` is false, so the test
    checks its own premise rather than passing for an unrelated reason:
    - before install: `runtime.run("pagerduty")` → `skipped: "disabled"`;
    - after `installPack({ id: "devops" }, deps, approvingGate)`, with no restart: the same call
      → `skipped: "identity_unresolved"` (not `disabled`, not `not_reconciled`), and
      `store.enabledAt()` equals the injected `now`;
    - after `removePack("devops", deps)`: back to `disabled`, and `enabledAt()` is null;
    - install again at a later `now`: `enabledAt()` is the NEW now (Review Focus 2);
    - with `nimbus.toml` holding `[oncall.push]\nenabled = false`, an install leaves `disabled`
      (Review Focus 1);
    - `runtime.stop()` is safe to call twice.

    Build the pack deps the way `pack-install.test.ts` does. Do not drive `setPackLayer` directly
    (D36 allows it in tests, but going through `installPack` proves the real path).
  - `oncall-push-rpc.test.ts`: `oncall.pushedList` `enabled` follows `runtime.isEnabled()`.
  - `pack-install.test.ts`: the devops install prompt has an `oncall.push.enabled` scalar row.
    - With no layer setting the key, `explainConfig` has no entry, so the row is
      `{ packValue: "true", current: undefined, currentLayer: "default", userOverrides: false }`
      and renders as `unset`.
    - With `nimbus.toml` holding `[oncall.push]\nenabled = false`, the row reads current `false`
      from `nimbus.toml` and is marked `(your file overrides this)`. This is the case that proves
      `explainConfig` resolves a key under a two-segment section header.
    - If it does not, fix the resolution in `config-explain.ts` with its own test, and ledger the
      ruling.

- [ ] **Step 2:** run those files. Expected: FAIL.

- [ ] **Step 3: Implement.**
  - `assembleOncallPushRuntime` builds the `LiveEnabled` with:
    - `load: () => loadNimbusOncallPushFromConfigDir(configDir).enabled`;
    - `reconcile: (e, t) => store.reconcileEnabledState(e, t)`.

    It keeps the boot reconcile, the boot prune and the comments, and calls `start()`.
  - It passes `isEnabled` to the runner, and returns `isEnabled` and `stop`.
  - In `assemble.ts`, add `oncallPush` to the existing `pushStops(sidecarStops, [...])` list.
    That adds no branch, which matters because the assembler sits at its cognitive-complexity
    limit. Add a one-line comment saying the reload timer must not outlive shutdown.
  - Grep `config.enabled`, `.config.enabled` and `enabled:` across `oncall-push/`, `ipc/`,
    `demo/` and `platform/`, and move every reader. The type change makes this a compile error,
    so `bun run typecheck` is the check.

- [ ] **Step 4:** the Step 1 files plus `bun test packages/gateway/src/oncall-push
  packages/gateway/src/packs packages/gateway/src/config`, and `bun run typecheck`. Expected:
  PASS.

- [ ] **Step 5: Commit** `feat(oncall-push): [oncall.push] enabled is pack-settable and live; the DevOps pack sets it`.

### Task 3: Docs for the live key

**Files:**
- Modify:
  - every doc that enumerates the pack-settable keys or says `[oncall.push] enabled` is read at
    boot. Re-derive the list with `rg -n "min_confidence|pack-settable|PACK_SETTABLE" docs .claude/commands`
    and `rg -n "oncall.push\] enabled|oncall\.push.*enabled" docs CLAUDE.md GEMINI.md .claude/commands`.
    Expected hits include `docs/cli-reference.md` (`nimbus pack`), `docs/architecture.md` and the
    configuration docs.
  - `docs/CHANGELOG.md` (dated entry).

- [ ] **Step 1:**
  - Name `[oncall.push] enabled` as pack-settable and live wherever the allowlist is listed.
  - Note that the DevOps pack (1.1.0) sets it, and that the owner's own file still overrides it.
  - Do NOT change the CLAUDE.md/GEMINI.md "DEFAULT OFF" statement: it stays true without a pack.
    Add one clause there only if that paragraph enumerates who can turn it on.
- [ ] **Step 2:** `bun run audit:doc-refs` and `bun run audit:status-drift`. Expected: PASS.
- [ ] **Step 3: Commit** `docs: [oncall.push] enabled is pack-settable and live`.

### Task 4: `nimbus doctor` — `[info]` for an available pack update

**Files:**
- Modify: `packages/cli/src/commands/doctor-core.ts` (a new `doctorPrintPackUpdates(client)`
  called in `doctorRunGatewayRpcs` right after `doctorPrintMigrations`), `docs/cli-reference.md`
  (the `doctor` section)
- Test: `packages/cli/src/commands/doctor-core.test.ts` (its existing fake-client style)

**Interfaces:**
- Consumes: the gateway's `pack.list` result (PR 2): `{ profile, installed: [{ id, version,
  updateAvailable, bundledVersion?, versionUnknown? }], ... }`. Declare a local structural type;
  never import gateway source.
- Produces: `export async function doctorPrintPackUpdates(client: Pick<IPCClient, "call">): Promise<number>`,
  which always returns `0`. It takes `Pick<IPCClient, "call">` like `doctorPrintMigrations`, so a
  test passes a plain `{ call }` fake.

- [ ] **Step 1: Write the failing tests.**
  - `one [info] line per profile naming each pack with an update`, exact copy:
    `[info] pack updates available (profile "default"): pm 1.0.0 -> 1.1.0, devops version unknown -> 1.1.0. Re-install with: nimbus pack install <id>`.
    - Use `version unknown` when `versionUnknown` is set.
    - Use `<installed> -> <bundledVersion>`, or `<installed> -> a different build` when
      `bundledVersion` is absent. "Update available" means the digest differs, not that the
      bundled copy is newer (PR 2's wording fix).
    - The hint is always the literal `nimbus pack install <id>`, for one pack or several, so the
      copy has one form.
  - `no line when no installed pack has updateAvailable`.
  - `no line and exit 0 when pack.list rejects (-32601 or any error)`.
  - `exit code unchanged`: with an update available the function returns 0, and `runDoctor`'s
    overall exit is unaffected (Review Focus 5).
  - Every printed field (profile, id, both versions) passes through `stripControlChars`. A test
    feeds an ESC in `profile` and an id, and asserts no `\u001b` in the output.
  - A malformed result (a non-array `installed`, or a row with a non-string `id`) prints nothing
    for that row and never throws.
- [ ] **Step 2:** `bun test packages/cli/src/commands/doctor-core.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** with a `client.call("pack.list", {})` wrapped in `.catch(() => undefined)`,
  as `index.health` is.
- [ ] **Step 4:** the same command, then `bun test packages/cli/src`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): nimbus doctor notes an available role-pack update`.

### Task 5: Verify and open the PR

- [ ] **Step 1:** `bun run preflight:fast`. Expected: PASS.
- [ ] **Step 2:** `bun test packages/gateway/src/oncall-push packages/gateway/src/packs packages/gateway/src/config packages/gateway/src/ipc/oncall-push-rpc.test.ts packages/cli/src/commands/doctor-core.test.ts packages/gateway/src/security-invariants.test.ts`.
  Expected: 0 fail.
- [ ] **Step 3:** Coverage ≥ 85 % lines / 80 % branches for `push-live-enabled.ts`,
  `push-runtime.ts`, `push-runner.ts` and `doctor-core.ts`, measured as PR 2's Task 8 did
  (istanbul preload, merged lcov).
- [ ] **Step 4:** `git diff --name-only origin/main...HEAD | grep superpowers` prints nothing.
- [ ] **Step 5:** Push and open the PR titled
  `feat(oncall-push): a role pack can turn the pushed brief on, live`. The body states:
  - what changed;
  - that only `enabled` is live;
  - the DevOps pack `1.1.0` and why it bumped;
  - the doctor line;
  - that this closes Project 3;
  - the attribution line.
