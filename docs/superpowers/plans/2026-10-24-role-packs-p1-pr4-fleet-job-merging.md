# Role packs P1 PR 4: fleet job merging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fleet jobs carry the layer they came from. An owner can silence any job, including a pack's, with an `enabled = false` stub. A bad job drops only itself, and the rest of the fleet runs.

**Architecture:** Merge by name already happens in `config/layered-merge.ts` (PR 1). This PR records which lower layers each merged job replaced. Then `[[fleet.job]]` resolution changes from "parse the merged text, throw on the first error" to "resolve each effective block on its own" into four results: scheduled jobs, disabled jobs, dropped jobs (with reasons) and per-job origins. The config layer cannot import `fleet/` or `ipc/`, so the semantic check (agent eligibility, sweep support) is injected as a `FleetJobChecker`, the same way `pack-settable.ts` takes `PackJobChecker`. The supervisor publishes the new lists and logs drops once per publish. `fleet status`/`list`, `diag.snapshot`, `nimbus doctor` and `config explain` report them.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, pino, bun:sqlite (`openMigratedMemoryDb`).

**Spec:** `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md` § 5.4, with § 5.1 (merge by name, per-file diagnostics), § 5.1 "Layer health in `diag.snapshot`" and § 7 ("A user stub with `enabled = false` silences a pack job").

## Global Constraints

- Branch `dev/asaf/role-packs-p1-merging` in worktree `C:\gitrep\Nimbus\.claude\worktrees\role-packs-p1-merging`, created with an absolute path from `origin/main` (it includes PR 3, `72a67fb6`). This plan and the spec never land on main.
- "A higher layer's job with the same name replaces the lower one **whole**, not field by field." The merge is unchanged. A dropped higher-layer job never brings the lower one back.
- "The rules that a job needs `agent` and `interval_seconds` are relaxed only for such a disabling stub. **A stub is always valid, even when nothing below it defines that name** … An orphan stub is inert: it is not an error and not a dropped job." It is shown as "disables nothing".
- Job-level errors, which drop only that job: a missing `agent` or `interval_seconds`; an ineligible agent; an unknown sweep kind, or `max_subjects` out of range or without `sweep`; `digest_min_delta` below 1; sweep combined with federation params; a duplicate name within one file, where **the later entry is dropped**. Keep each existing `FleetConfigError` message text verbatim as the drop reason.
- "**Table-level `[fleet]` errors** … keep today's fail-whole behaviour": `parseNimbusTomlFleet` still throws, and `loadFleet` still sets `configError`.
- Each dropped job is reported "at error in the boot/reload log, in `fleet status` and in `nimbus doctor`, with its layer and file".
- `diag.snapshot` is LAN-callable and renderer-exposed, so it carries file BASENAMES only, as `buildConfigLayers` already does. `fleet.*` stays LAN-forbidden and off the Tauri allowlist. No new IPC method.
- No new HITL action type, invariant, egress class or migration (spec § 6). `fleet_job_state` stays keyed by job name.
- Not breaking: no user has to change anything. A job with an `enabled` key used to pass it to the agent as a param. Now `enabled` is reserved. State this in the CHANGELOG, with no `!`.
- No `any`. Use `path.join`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run `bun run preflight:fast` before the PR.

## Review Focus

1. **The owner overrides a pack job with a broken copy.** Neither copy runs. The user's copy is reported as dropped, and the pack's copy is not resurrected. (Task 2 test `a dropped override does not resurrect the lower job`)
2. **An orphan stub after its pack is removed** is inert. It is not in `dropped`, it is listed as disabled with `replaces: []`, and the fleet still runs the other jobs. (Task 2 unit test, Task 6 integration)
3. **The only job is stubbed:** the fleet is enabled with zero scheduled jobs. No scheduler is built, `fleet status` says `running: false`, and nothing is reported as an error. `fleet run <stubbed>` says the job is disabled, not "not found". (Task 4 tests)
4. **An unrelated edit does not re-log drops.** The version moves but the fleet section is deep-equal, so the dropped-job error lines are not repeated. (Task 3 test)
5. **A duplicate whose second copy is a stub:** the first entry wins and the stub is dropped as a duplicate. An owner expecting the stub to silence the job sees why it did not, in `fleet status` and doctor. (Task 2 test)

---

### Task 1: merged fleet jobs record what they replaced

**Files:**
- Modify: `packages/gateway/src/config/layered-merge.ts` (`EffectiveSection`, `mergeFleetJobs`, `blockToEffective`)
- Test: `packages/gateway/src/config/layered-merge.test.ts` (extend the fleet-job merge `describe`)

**Interfaces:**
- Produces: `EffectiveSection` gains `readonly replaces?: readonly LayerRef[]`. It is set only on `[[fleet.job]]` sections, low to high and without duplicates, and lists every lower layer whose same-named job this block replaced. An absent field means it replaced nothing. `renderEffectiveDoc` ignores it.

- [ ] **Step 1: Write the failing tests**
  - `a user job replacing a pack job records the pack layer`: pack `ops` and base each define `nightly`. The base block's `replaces` deep-equals `[packRef]`.
  - `a profile job replacing base and pack records both, low to high`.
  - `two lower copies in one layer are recorded once`.
  - `an unreplaced job has no replaces field` (`toBeUndefined()`).
  - `a same-layer duplicate replaces nothing`: the second base copy has no `replaces`.
- [ ] **Step 2: Run and see them fail.** `bun test packages/gateway/src/config/layered-merge.test.ts`. Expected: `replaces` is undefined.
- [ ] **Step 3: Implement.** In `mergeFleetJobs`, collect the layer of each lower-layer copy being replaced or spliced. Carry it on the `out` entry, merged with any `replaces` that entry already had, deduped by `kind`+`id`. Pass it to `blockToEffective` through `extra`.
- [ ] **Step 4: Run and see them pass,** plus `bun test packages/gateway/src/config`.
- [ ] **Step 5: Commit** `feat(config): a merged fleet job records the layers it replaced`.

### Task 2: per-job resolution, the `enabled` key and the stub

**Files:**
- Modify: `packages/gateway/src/config/fleet-toml.ts`
- Modify: `packages/gateway/src/packs/pack-job-check.ts` (refuse a stub)
- Test: `packages/gateway/src/config/fleet-toml.test.ts`, `packages/gateway/src/config/fleet-toml.coverage.test.ts`, `packages/gateway/src/packs/pack-job-check.test.ts`
- Re-read the existing tests in `config/nimbus-toml.test.ts` and `ipc/profile-rpc.test.ts` that pin "duplicate name" or "requires agent". Update the ones that load through the config-dir door: the error now lands in `dropped`, not a throw. Tests of the strict `parseNimbusTomlFleetJobs` keep throwing.

**Interfaces:**
- Consumes: `EffectiveSection.replaces` (Task 1).
- Produces, all exported from `config/fleet-toml.ts`:
  ```ts
  export type FleetJobOrigin = { readonly layer: LayerRef; readonly replaces: readonly LayerRef[] };
  export type FleetDisabledJob = { readonly name: string; readonly agent: string | null; readonly origin: FleetJobOrigin };
  export type FleetDroppedJob = { readonly name: string | null; readonly layer: LayerRef; readonly reason: string };
  /** The check config/ cannot do itself (agent eligibility, sweep support). A reason string drops the job. */
  export type FleetJobChecker = (job: NimbusFleetJobToml) => string | undefined;
  export type FleetJobsResolved = {
    readonly jobs: NimbusFleetJobToml[];                       // enabled and valid: what the scheduler runs
    readonly origins: ReadonlyMap<string, FleetJobOrigin>;     // one per entry in `jobs`
    readonly disabled: FleetDisabledJob[];
    readonly dropped: FleetDroppedJob[];
  };
  export type NimbusFleetLoad = { config: NimbusFleetToml } & FleetJobsResolved;
  export function resolveFleetJobs(sections: readonly EffectiveSection[], check?: FleetJobChecker): FleetJobsResolved;
  export function loadNimbusFleetFromConfigDir(configDir: string, check?: FleetJobChecker): NimbusFleetLoad;
  export function loadNimbusFleetFromPath(tomlPath: string, check?: FleetJobChecker): NimbusFleetLoad;
  ```
  - `resolveFleetJobs` reads only sections with `isArray && header === "fleet.job"` and a `blockLayer`, in document order.
  - Per block, the order is: skip an empty block (no name, agent or interval, as today); if an earlier block already carried this name, drop this block with reason `[[fleet.job]] duplicate name: <name>`, whether that earlier block was accepted or dropped (after the merge, only same-layer copies can share a name, so "the later entry is dropped" holds even when the first copy is broken); parse the block; on a `FleetConfigError`, drop it; a block with `enabled = false` goes to `disabled` (the checker is NOT run on it); otherwise run `check`, and a reason drops the job; otherwise schedule it.
  - `enabled` joins `JOB_RESERVED`. A value `parseBool` cannot read is a job error: `[[fleet.job]] <name> enabled must be true or false`.
  - With `enabled = false`, `agent` and `interval_seconds` become optional. Every other present field is still validated, and an error drops the block.
  - Validation runs after the whole block is read, so `digest_min_delta` written before `name` now names the job, and the "(unnamed)" comment in `applyJobKey` goes.
  - `parseNimbusTomlFleetJobs(source)` stays strict for the pack check. It returns enabled and full disabled jobs, and throws on the first block error, a duplicate, or a stub (`[[fleet.job]] <name> requires agent`).
  - `loadNimbusFleetFromConfigDir` gets jobs from `getLayeredConfig(configDir).snapshot().doc.sections`, and the `[fleet]` table from `layeredConfigText` as today. A table-level throw keeps today's `onFallback` + rethrow.
  - `loadNimbusFleetFromPath` builds its sections with `mergeLayerDocs([parseLayerDoc({ kind: "base", id: "base", path: tomlPath }, text)])`.
- `pack-job-check.ts` still refuses any problem `parseNimbusTomlFleetJobs` throws. A full pack job with `enabled = false` is accepted, and a pack stub is refused.

- [ ] **Step 1: Write the failing tests** (in `fleet-toml.test.ts`, building sections with `mergeLayerDocs` and `parseLayerDoc`, with a `pack`, a `base` and a `profile` `LayerRef`):
  - `a good job beside a bad one schedules the good one`: `a` is complete, and `b` lacks `interval_seconds`. `jobs` names `a`, and `dropped` is `[{ name: "b", layer: baseRef, reason: "[[fleet.job]] b requires interval_seconds > 0" }]`.
  - `each listed job-level error drops only its job`: one table-driven case each for missing agent, unknown sweep, `max_subjects = 0`, `max_subjects` without sweep, `digest_min_delta = 0`, and a checker that returns `"not eligible"`. Assert that the exact existing message is the reason.
  - `a stub disables the pack job`: the pack has a full `nightly`, and base has `name = "nightly"` and `enabled = false` only. `jobs` is empty, and `disabled` is `[{ name: "nightly", agent: null, origin: { layer: baseRef, replaces: [packRef] } }]`.
  - `an orphan stub is inert`: a base stub with no lower job is in `disabled` with `replaces: []`, and `dropped` is empty.
  - `a dropped override does not resurrect the lower job`: the pack has a full `x`, and base has `x` with no `interval_seconds`. `jobs` is empty, and `dropped[0].name === "x"`.
  - `a duplicate in one file drops the later entry, even a stub`: base has `d` complete, then `d` as a stub. `jobs` names `d`, and `dropped` holds one entry with the duplicate reason.
  - `a duplicate after a broken first copy is still dropped`: base has `d` with no interval, then a complete `d`. `jobs` is empty, and `dropped` holds two entries.
  - `the checker does not run on a disabled job`: a checker spy is called only for enabled jobs.
  - `enabled = "no" drops the job with its reason`.
  - `origins carries each scheduled job's layer and replaces`.
  - `digest_min_delta before name names the job`.
  - `a bad [fleet] table still throws` (`allow_remote = true` with no budget), through `loadNimbusFleetFromPath`.
  - In `pack-job-check.test.ts`: `a pack stub is refused` and `a full pack job with enabled = false is accepted`.
- [ ] **Step 2: Run and see them fail.** `bun test packages/gateway/src/config/fleet-toml.test.ts packages/gateway/src/packs/pack-job-check.test.ts`.
- [ ] **Step 3: Implement** as specified in the Interfaces block. Split `parseNimbusTomlFleetJobs`'s `flush` into `parseFleetJobBlock(lines): { job: NimbusFleetJobToml; enabled: boolean } | { stub: { name: string; agent: string | null } } | undefined` (undefined for an empty block; throws `FleetConfigError`), shared by the strict parser and `resolveFleetJobs`.
- [ ] **Step 4: Run** `bun test packages/gateway/src/config packages/gateway/src/packs packages/gateway/src/ipc/profile-rpc.test.ts`, then `bun run typecheck`. `assemble.ts` should still compile: it reads only `.config` and `.jobs`.
- [ ] **Step 5: Commit** `feat(fleet): a bad fleet job drops only itself, and enabled = false disables one`.

### Task 3: the fleet runtime uses the checker and publishes the lists

**Files:**
- Create: `packages/gateway/src/fleet/fleet-job-check.ts`
- Modify: `packages/gateway/src/fleet/fleet-sweep-support.ts` (per-job `fleetSweepProblem`; `validateFleetSweepJobs` becomes a throwing wrapper over it, unchanged for its callers)
- Modify: `packages/gateway/src/fleet/fleet-supervisor.ts` (`FleetLoad`, `FleetView`, the drop log)
- Modify: `packages/gateway/src/platform/assemble.ts` (`loadFleet`, the `FleetRuntime` getters, `ipcOpts.fleetRpcCtx`)
- Test: `packages/gateway/src/fleet/fleet-job-check.test.ts`, `packages/gateway/src/fleet/fleet-supervisor.test.ts`, `packages/gateway/src/platform/assemble-fleet.test.ts`

**Interfaces:**
- Consumes: `FleetJobChecker`, `FleetJobOrigin`, `FleetDisabledJob`, `FleetDroppedJob` (Task 2).
- Produces:
  - `export function fleetSweepProblem(job: NimbusFleetJobToml): string | undefined` (`fleet-sweep-support.ts`), with the same three messages `validateFleetSweepJobs` throws today.
  - `export const checkFleetJob: FleetJobChecker` (`fleet-job-check.ts`). It returns `[[fleet.job]] <name> agent "<agent>" is not fleet-eligible` when `resolveFleetAgentMethod(job.agent) === null`, and otherwise `fleetSweepProblem(job)`. The invoker's own eligibility refusal stays as defence in depth.
  - `FleetLoad` and `FleetView` both gain `readonly origins: ReadonlyMap<string, FleetJobOrigin>`, `readonly disabled: readonly FleetDisabledJob[]` and `readonly dropped: readonly FleetDroppedJob[]`. On `configError` all three are empty.
  - `FleetRuntime` gains getters `origins`, `disabled` and `dropped` over `supervisor.current()`.
  - The supervisor logs each dropped job at **error** when it publishes a view, which is in the constructor and at `check()` step 7. It never logs in `load()`. The message is `[fleet] job "<name ?? "(unnamed)">" dropped (<layer.kind> <layer.id>, <layer.path>): <reason>`, with structured fields `{ job, layer: kind, layerId, file, reason }`.
- `loadFleet` calls `loadNimbusFleetFromConfigDir(dir, checkFleetJob)` and no longer calls `validateFleetSweepJobs`. Re-grep its remaining callers before deciding whether to keep the wrapper; `pack-job-check.ts` uses it.

- [ ] **Step 1: Write the failing tests**
  - `fleet-job-check.test.ts`: `an ineligible agent is a reason`; `a sweep the agent cannot do is a reason` (the existing message); `a valid job passes` (`undefined`).
  - `fleet-supervisor.test.ts`:
    - `boot logs each dropped job once`: count error lines with a recording logger.
    - `a reload that changes drops logs the new ones`.
    - `an unrelated edit does not re-log drops`: bump the version, `load` returns a deep-equal load, and the error count is unchanged.
    - `current() carries disabled and dropped`.
  - `assemble-fleet.test.ts`:
    - `one bad user job no longer disables the fleet`: `nimbus.toml` with `[fleet] enabled = true`, a valid `catchup` job and a job with an ineligible agent. `runtime.scheduler` is defined, `runtime.jobs` names only the valid one, and `runtime.dropped` names the other.
    - `a stub that silences the only job builds no scheduler`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** as specified in the Interfaces block. Update `loadFleet`'s doc-comment item 2: table-level errors still disable the fleet, and job-level errors drop only that job.
- [ ] **Step 4: Run** `bun test packages/gateway/src/fleet packages/gateway/src/platform/assemble-fleet.test.ts packages/gateway/test/integration/fleet`, then `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(fleet): the fleet drops a bad job and keeps running the rest`.

### Task 4: `fleet status`, `fleet list` and `fleet run` report layers, stubs and drops

**Files:**
- Modify: `packages/gateway/src/ipc/fleet-rpc.ts`
- Modify: `packages/cli/src/commands/fleet.ts`
- Create: `packages/cli/src/lib/strip-control-chars.ts`. Move `doctor-core.ts`'s private `stripControlChars` here unchanged and import it in both files. Grep `packages/cli/src/lib` for an existing equivalent first, and reuse it if there is one.
- Test: `packages/gateway/src/ipc/fleet-rpc.test.ts`, `packages/cli/src/commands/fleet.test.ts` (or the file that tests `fleet list` rendering today; find it with `git grep -l "fleet.list" packages/cli/src`)

**Interfaces:**
- Consumes: the `FleetRuntime` getters (Task 3).
- Produces:
  - `FleetRpcCtx` gains `readonly origins?: ReadonlyMap<string, FleetJobOrigin>`, `readonly disabled?: readonly FleetDisabledJob[]` and `readonly dropped?: readonly FleetDroppedJob[]`. Read them in the same single synchronous destructuring as `scheduler`/`config`/`jobs`.
  - `type FleetLayerWire = { readonly kind: LayerKind; readonly id: string; readonly path: string }`.
  - `FleetStatusResult` gains `jobsDisabled: number` and `droppedJobs: readonly { name: string | null; layer: FleetLayerWire; reason: string }[]`.
  - `FleetJobListEntry` gains `layer: FleetLayerWire | null`, which is null only in a ctx with no `origins`, so unit tests keep working.
  - The `fleet.list` result gains `disabled: readonly { name: string; agent: string | null; layer: FleetLayerWire; disables: readonly FleetLayerWire[] }[]`. An empty `disables` means it disables nothing.
  - `fleet.runNow` with `job` naming a disabled job refuses `-32602` with `fleet: job "<name>" is disabled by enabled = false in <layer.path>`. This check comes after `awaitSettled` and before the "not running" refusal, so it also fires when every job is stubbed.
  - CLI (all new fields are optional in the CLI shapes, read with `== null`, for version skew):
    - `fleet list` appends `  layer=<kind>:<id>` to each job row.
    - After the job rows, each disabled job prints one line: `<name>  disabled (enabled = false, layer=<kind>:<id>)  disables <kind>:<id>[, …]` or `… disables nothing`.
    - `fleet status` adds `  jobs disabled:      <n>`. Each drop prints `  [error] job <name ?? "(unnamed)"> dropped (<kind>:<id>, <path>): <reason>`.
    - Every name, agent and reason goes through `stripControlChars`.

- [ ] **Step 1: Write the failing tests**
  - In `fleet-rpc.test.ts`:
    - `status reports disabled and dropped`.
    - `list carries each job's layer and the disabled jobs with what they disable`.
    - `an orphan stub lists disables: []`.
    - `runNow on a disabled job names it`: no scheduler; the call is refused with `-32602` and the message above.
  - CLI:
    - `list prints the layer and a disabled line`.
    - `list prints disables nothing for an orphan stub`.
    - `status prints each dropped job`.
    - `an older gateway's response without the new fields still renders`.
    - `control characters in a job name are stripped`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** as specified in the Interfaces block, and wire the three getters into `ipcOpts.fleetRpcCtx` in `assemble.ts`.
- [ ] **Step 4: Run** `bun test packages/gateway/src/ipc/fleet-rpc.test.ts packages/gateway/src/ipc/server/dispatchers-fleet.test.ts packages/cli/src/commands`.
- [ ] **Step 5: Commit** `feat(fleet): fleet status and list show each job's layer, disabled jobs and drops`.

### Task 5: `diag.snapshot`, `nimbus doctor` and `config explain`

**Files:**
- Modify: `packages/gateway/src/ipc/diagnostics-rpc.ts` (`DiagnosticsRpcContext`, `buildConfigLayers`, the `config.explain` call at about line 227)
- Modify: `packages/gateway/src/config/config-explain.ts` (`explainConfig`)
- Modify: `packages/gateway/src/platform/assemble.ts` (supply the two new ctx fields)
- Modify: `packages/cli/src/commands/doctor-core.ts` (`doctorPrintFleetJobs`, called from `doctorPrintProfile`'s return chain like `doctorPrintPacks`)
- Test: `packages/gateway/src/ipc/diagnostics-rpc.test.ts`, `packages/gateway/src/config/config-explain.test.ts`, `packages/cli/src/commands/doctor-core.test.ts`

**Interfaces:**
- Consumes: `resolveFleetJobs`, `FleetJobChecker`, `FleetDroppedJob` (Task 2); `checkFleetJob` and the runtime's `dropped` getter (Task 3).
- Produces:
  - `DiagnosticsRpcContext` gains `readonly fleetDroppedJobs?: () => readonly FleetDroppedJob[]` and `readonly fleetJobCheck?: FleetJobChecker`. Both are injected from `assemble.ts`, not imported into `ipc/`, which keeps `diagnostics-rpc.ts` free of a `fleet/` import cycle.
  - `buildConfigLayers`'s placeholder becomes `droppedFleetJobs: { name: string | null; layerKind: LayerKind; layerId: string; file: string; reason: string }[]`. `file` is `basename(layer.path)`, and `reason` has the full path replaced by the basename, the same rule as `readError`. It reads the supervisor's current drops, which are what the running fleet used. Delete the "always empty for now" comment.
  - `explainConfig(reader, path, env = processEnvGet, opts: { readonly fleetJobCheck?: FleetJobChecker } = {})`. It runs `resolveFleetJobs(snap.doc.sections, opts.fleetJobCheck)` (the loader's own function, so explain cannot disagree with it) and adds notes for every job when `path` is undefined or is `fleet.job`, or for the one job when `path` is `fleet.job.<name>`:
    - a disabled job that replaced something: `fleet job "<n>" is disabled (enabled = false); it disables <kind> "<id>"[, …]`
    - an orphan stub: `fleet job "<n>" is disabled (enabled = false); it disables nothing`
    - a scheduled job that replaced something: `fleet job "<n>" from <kind> "<id>" replaces <kind> "<id>"[, …]`
    - a dropped job: `fleet job "<n ?? "(unnamed)">" is dropped: <reason>`
  - `doctorPrintFleetJobs(c: { droppedFleetJobs?: unknown }): number` prints `[warn] fleet job "<name>" dropped (<file>): <reason>` per entry through `stripControlChars`, and returns 1 if any. It skips malformed entries and is silent when the field is absent (an older gateway).

- [ ] **Step 1: Write the failing tests**
  - `diagnostics-rpc.test.ts`: `configLayers.droppedFleetJobs carries basenames only`. The ctx's `fleetDroppedJobs` returns a drop whose layer path is absolute and whose reason quotes it. Neither `file` nor `reason` in the response contains the directory.
  - `config-explain.test.ts`:
    - `explain fleet.job.<name> says what a stub disables`.
    - `an orphan stub disables nothing`.
    - `a replacing job names the layer it replaces`.
    - `a dropped job names its reason`, using a checker that refuses.
    - `explain without a checker still reports syntax drops`.
  - `doctor-core.test.ts`:
    - `doctor warns per dropped fleet job and exits 1`.
    - `doctor is silent without the field`.
    - `doctor strips control characters from a dropped job`.
- [ ] **Step 2: Run and see them fail.**
- [ ] **Step 3: Implement** as specified in the Interfaces block. `diagnostics-rpc.ts` passes `{ fleetJobCheck: ctx.fleetJobCheck }` to `explainConfig`.
- [ ] **Step 4: Run** `bun test packages/gateway/src/ipc/diagnostics-rpc.test.ts packages/gateway/src/config packages/cli/src/commands/doctor-core.test.ts`, then `bun run typecheck`.
- [ ] **Step 5: Commit** `feat(fleet): doctor, diag.snapshot and config explain report fleet job drops and stubs`.

### Task 6: the end-to-end proof and the docs

**Files:**
- Create: `packages/gateway/test/integration/fleet/fleet-job-merging.test.ts`
- Modify docs:
  - `docs/cli-reference.md`: the `[[fleet.job]]` key table (find it by `digest_min_delta`), plus the `fleet list`/`status` output
  - `docs/architecture.md`: the fleet subsection
  - `docs/CHANGELOG.md`: one entry in the file's style

**Interfaces:**
- Consumes: everything above. The setup is the same as `fleet-live-reload.test.ts`: `createPackLayerStore({ configDir: dir })`, then `initLayeredConfig(dir, { packs })` before `assembleFleetRuntime`, and `forgetLayeredConfigForTests(dir)` in `afterEach`.

- [ ] **Step 1: Write the tests** (spec § 7: "A user stub with `enabled = false` silences a pack job"):
  - `a user stub silences a pack job without a restart`:
    1. `packs.setPackLayer("default", "ops", <[fleet] enabled = true + job "pack-nightly", agent "catchup", interval 3600>)`, then `check()`. The scheduler runs `pack-nightly`.
    2. Write `[[fleet.job]]\nname = "pack-nightly"\nenabled = false\n` to `nimbus.toml`, then `check()` gives `"reloaded"`.
    3. `runtime.scheduler` is undefined, and `runtime.disabled[0].origin.replaces[0].kind === "pack"`.
  - `removing the pack leaves the stub inert`: after the step above, `packs.removePackLayer("default", "ops")`, then `check()`. `runtime.disabled[0].origin.replaces` is `[]`, and `runtime.dropped` is empty.
  - `a broken user job does not stop a pack job`: the pack has `pack-nightly`. The user file adds `[[fleet.job]] name = "mine"` with no interval. `runOnce({ force: true })` gives `jobsAttempted === 1`, and `runtime.dropped[0].layer.kind === "base"`.
  - `job state survives stubbing and unstubbing`: run `pack-nightly`, stub it, remove the stub, then `check()`. `loadJobState("pack-nightly")?.lastAttemptAt` is unchanged and not null.
- [ ] **Step 2: Run** `bun test packages/gateway/test/integration/fleet`. Expected: PASS. Tasks 1–5 have landed, so a failure here is a wiring bug, not a missing feature.
- [ ] **Step 3: Docs.**
  - `cli-reference.md`: document `enabled` on a job (default `true`), the stub (name plus `enabled = false`, valid with nothing below it, and listed as "disables nothing"), that a higher layer's job replaces a lower one whole, and that a bad job is dropped and reported in `fleet status` and `nimbus doctor` while a bad `[fleet]` table still turns the fleet off.
  - `architecture.md`: mirror that in the fleet subsection, and name `FleetJobChecker` as the seam.
  - `CHANGELOG.md`: one entry. Say that one bad `[[fleet.job]]` no longer disables the whole fleet, that `enabled = false` silences a job (including a pack's), and that `enabled` is now a reserved job key and no longer passed to the agent as a param.
- [ ] **Step 4: Commit** `test(fleet): a user stub silences a pack job end to end; docs`.

### Task 7: preflight and PR

- [ ] **Step 1:** Run `bun run preflight:fast`, then the config, fleet, packs, ipc, platform and CLI command test trees. If the worktree is fresh, build the sandbox helper first: `& (Get-Process -Id $PID).Path -NoProfile -File scripts/build-sandbox-helper-win32.ps1`.
- [ ] **Step 2:** Confirm that `git diff origin/main --stat` lists no `docs/superpowers/` file.
- [ ] **Step 3:** Open a PR titled `feat(fleet): a bad fleet job drops only itself, and enabled = false disables one` (no `!`).
  - The body covers: the summary; the behaviour change (other jobs now run beside a bad one; table-level errors still disable the fleet); the reserved `enabled` key; and what is not included (no `[agents] visible` or catalog, which is PR 5, and no pack install, which is Project 3).
  - Include the verification evidence, and end with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".
