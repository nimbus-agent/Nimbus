# Role packs P1 · PR 2: the pack layer — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the gateway stack pack-contributed TOML fragments under the user's own files through an internal API that writes only allowlisted keys, refuses conflicts between packs, and skips any tampered or broken pack state on read instead of failing.

**Architecture:** PR 1 (merged, `780303ec`) already merges `kind: "pack"` layers below `nimbus.toml`, and `LayeredConfig` already takes an injected `PackLayerSource`. Nothing implements that source yet. PR 2 has four parts:
1. A pure allowlist module, `config/pack-settable.ts`.
2. A fleet-job checker under a new `packs/` directory. It lives there because it needs `ipc/agents-rpc.ts` and `fleet/`, and `config/layered-config.ts` must not import them, or a cycle forms.
3. A file-backed store, `packs/pack-layer-store.ts`. It implements the source and adds `setPackLayer`/`removePackLayer`.
4. The skipped-pack reporting through `diag.snapshot`, `nimbus doctor` and `config explain`.

The source hands the reader each pack's validated **text**, so a pack file is read once per snapshot and the text that was checked is the text that merges, with no window between the check and the read.

**Tech Stack:** Bun 1.4, TypeScript strict (no `any`), `bun:test`, Biome. Reuse `config/toml-primitives.ts`, `config/layered-merge.ts`'s `parseLayerDoc`, and `config/toml-section-writer.ts`'s `writeUtf8FileAtomicReplace`. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md` § 5.2, plus § 3 (two packs never silently override each other), § 4 anti-goals 2 and 3, § 6 and § 8 calls 2 and 3. Parent: `docs/superpowers/specs/2026-10-21-role-packs-overview-design.md`. Both are branch-only.

## Global Constraints

- Storage: `<configDir>/packs/<profile>/<pack-id>.toml` plus `<configDir>/packs/<profile>/active.json`. The profile is `default` when none is active, and the profile name is used as given, matching `profileFilePath`. Only the gateway writes these files.
- Pack id rule: `/^[a-z0-9][a-z0-9_-]{0,63}$/`. It is checked by `setPackLayer`/`removePackLayer` and again on every read. An `active.json` entry that fails it is never turned into a path. Profile names are checked against `PROFILE_NAME_RE` (`config/active-profile.ts`).
- `active.json` format, our call: `{"version":1,"packs":["<id>", ...]}`. The order is install order and is used only for display.
- The v1 allowlist is **exactly** what § 5.2 lists, minus `[agents] visible`, which PR 5 adds with its union rule:
  - `[fleet]`: `enabled`, `min_idle_seconds`, `require_ac_power`, `retention_days`
  - `[[fleet.job]]`
  - `[decisions] min_confidence`
  
  Every other key, section and array is refused.
- A refusal is whole-layer: one bad key refuses the whole fragment on write and skips the whole file on read. A pack is never partly applied.
- Conflict rule: `setPackLayer` refuses when another active pack in the same profile sets the same allowlisted scalar to a different **parsed** value, or contributes a `[[fleet.job]]` with the same `name`. Every conflict is named. A pack never conflicts with its own previous version.
- Broken state is never fatal. These are skipped and reported:
  - a malformed `active.json` (no packs applied)
  - an entry that fails the id rule, is listed twice, or whose file is missing, unreadable, too large or fails the fragment check
- Adding or removing a pack never writes `nimbus.toml` or a profile file.
- **No IPC method or CLI command writes a pack layer** (§ 5.2). Tests drive the store directly. No new HITL action type, invariant, egress class or migration (§ 6).
- Reasons in `diag.snapshot` never contain an absolute path, because that call is LAN-callable and renderer-exposed. `config.explain` is LAN-forbidden and may carry full paths.
- Non-negotiables apply:
  - no `any` (use `unknown` for parsed JSON)
  - `path.join` everywhere, no hardcoded separators
  - DI over `mock.module`
  - real temp dirs in tests
- Implementation worktree: `C:\gitrep\Nimbus\.claude\worktrees\role-packs-p1-packs`, branch `dev/asaf/role-packs-p1-packs` from `origin/main` (created in Task 1 with an **absolute** path). Verify `git rev-parse --abbrev-ref HEAD` before every commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- After each task, run `bun run preflight:fast` and fix what it reports. New files must clear the coverage floor (≥85% line, ≥80% branch). The full `bun run preflight` runs at the end.

## Review Focus

1. **A pack setting a value that would take the whole fleet down** (`retention_days = 0`, `enabled = "yes"`). A bad `[fleet]` table disables every user job, and § 5.4 relies on packs only ever setting validated `[fleet]` values. It must be refused on write and skipped on read. → Task 1, `refuses a value its loader would reject or misread`.
2. **A tampered pack file that mixes an allowlisted key with a forbidden one** (`[decisions] min_confidence` plus `[llm.remote.openai] enabled = true`). It must be skipped whole: the allowlisted key must not apply either. → Task 4, `a tampered file is skipped whole`.
3. **`active.json` naming `../../nimbus`, `PM` or `pm` twice.** None may become a path, and the duplicate must be skipped rather than merged twice. → Task 4, `hostile active.json entries never become paths`.
4. **A pack-only install, with packs present but no `nimbus.toml`.** Pack values must still apply, and the glossary manual reader must still say `loaded: false`. Otherwise its desired-state pass deletes every authored term. → Task 3, `pack-only config renders and glossary stays unloaded`.
5. **Re-installing the same pack, two packs agreeing on a value, and `0.7` against `0.70`.** None of these is a conflict. → Task 4, `equal values and self-updates do not conflict`.

---

### Task 1: The allowlist and the fragment check

**Files:**
- Create: `packages/gateway/src/config/pack-settable.ts`
- Test: `packages/gateway/src/config/pack-settable.test.ts`

**Interfaces:**
- Produces:
  - `export const PACK_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/`
  - `export const PACK_FRAGMENT_MAX_BYTES = 65_536`. This is our call: it bounds a tampered file. It is measured in UTF-8 bytes.
  - `export type PackConsumerMode = "per-call" | "reactive"` (§ 5.3: every entry declares how its consumer sees a change)
  - `export type PackScalar = boolean | number`
  - `export type PackSettableKey = { readonly section: string; readonly key: string; readonly consumer: PackConsumerMode; readonly why: string; readonly expect: string; readonly parse: (valRaw: string) => PackScalar | undefined }`
  - `export const PACK_SETTABLE_KEYS: readonly PackSettableKey[]`
  - `export const PACK_SETTABLE_ARRAYS: readonly { readonly header: "fleet.job"; readonly consumer: "reactive"; readonly why: string }[]`
  - `export type PackJobChecker = (jobsText: string) => readonly string[]`: problems, empty when fine
  - `export type PackFragmentCheck = { readonly ok: true; readonly scalars: ReadonlyMap<string, PackScalar>; readonly jobNames: readonly string[] } | { readonly ok: false; readonly problems: readonly string[] }`. The `scalars` keys are `"<section>.<key>"`.
  - `export function checkPackFragment(text: string, checkJobs: PackJobChecker): PackFragmentCheck`

- [ ] **Step 1: Create the worktree.**

```bash
git -C C:/gitrep/Nimbus fetch origin
git -C C:/gitrep/Nimbus worktree add -b dev/asaf/role-packs-p1-packs C:/gitrep/Nimbus/.claude/worktrees/role-packs-p1-packs origin/main
```

Then run `bun install` and build the sandbox helper there, the same way as the PR 1 worktree.

- [ ] **Step 2: Write the failing tests** in `pack-settable.test.ts`:
  - `the allowlist is exactly the v1 set`. Assert `PACK_SETTABLE_KEYS.map(k => \`${k.section}.${k.key}\`)` equals `["fleet.enabled","fleet.min_idle_seconds","fleet.require_ac_power","fleet.retention_days","decisions.min_confidence"]`, and `PACK_SETTABLE_ARRAYS.map(a => a.header)` equals `["fleet.job"]`. Also assert every entry has a non-empty `why` and a `consumer`: `decisions.min_confidence` is `"per-call"` and every `fleet.*` entry is `"reactive"`.
  - `accepts an allowlisted fragment`. For `"[fleet]\nenabled = true\nretention_days = 7\n[decisions]\nmin_confidence = 0.7\n"`, the result is `ok`, and `scalars` maps `fleet.enabled → true`, `fleet.retention_days → 7` and `decisions.min_confidence → 0.7`.
  - `names every off-list key` (Review Focus 2). For `"[decisions]\nmin_confidence = 0.7\n[llm.remote.openai]\nenabled = true\n[fleet]\nallow_remote = true\n"`, the result is not ok. `problems` contains `"[llm.remote.openai] enabled is not pack-settable"` and `"[fleet] allow_remote is not pack-settable"`.
  - `refuses a value its loader would reject or misread` (Review Focus 1):
    - `retention_days = 0` produces a problem containing `"[fleet] retention_days = 0: expected an integer >= 1"`
    - `enabled = "yes"` produces one with `"expected true or false"`
    - `min_idle_seconds = -1` and `min_confidence = 1.5` are each refused
  - `refuses shapes the allowlist cannot express`, one problem each:
    - a root-level key (`"x = 1\n"`)
    - a malformed header (`"[fleet\n"`)
    - a `=`-less line inside `[fleet]`
    - `[[filesystem.roots]]`
    - the same key set twice in one fragment
    - a `[[fleet.job]]` block with no `name`, an empty `[[fleet.job]]` block, and `name = ""` (the fleet parser drops an empty block silently and accepts `""`, so the fragment check must refuse both itself)
    - the same key twice inside one `[[fleet.job]]` block (the fleet parser keeps the last one silently)
    - a bare off-list header with no keys (`"[llm.remote.openai]\n"`)
    - text over `PACK_FRAGMENT_MAX_BYTES`
  - `reports each problem once`:
    - a malformed header followed by keys (`"[fleet\nenabled = true\n"`) gives exactly one problem, for the header; its lines are not also reported as root keys
    - a duplicate key whose first value was invalid still reports the duplicate (track seen keys in their own set, not via `scalars`)
    - a `[[fleet.job]]` block with no `name` gives one problem, and the spy checker never receives that block
  - `min_confidence must be a plain decimal`. `""`, `"   "`, `0x0`, `0b0` and `1e-1` are each refused (`Number()` reads the first four as `0`); `0`, `1`, `0.70` and `+0.5` are accepted.
  - `a comment-only fragment is a no-op layer`. `"# nothing\n"` is `ok`, with empty `scalars` and `jobNames`. A pack may contribute no config; refusing it would make Project 3 special-case such packs.
  - `hands every fleet job block to the job checker`. A spy checker receives text that contains both `[[fleet.job]]` blocks, and its problems are returned verbatim. `jobNames` is `["a","b"]` when the checker returns `[]`.
  - `PACK_ID_RE`: accepts `pm`, `devops-1` and `a_b`; rejects `PM`, `-pm`, `../x`, `pm.toml`, `""` and 65 characters.

- [ ] **Step 3: Run them and see them fail.** Run `bun test packages/gateway/src/config/pack-settable.test.ts`. Expected: FAIL, module not found.

- [ ] **Step 4: Implement `pack-settable.ts`.**
  - Parse with `parseLayerDoc({ kind: "pack", id: "check", path: "" }, text)`.
  - Parsers, from `toml-primitives.ts`:
    - bools: `parseBool`
    - `min_idle_seconds`: `parseIntDec`, integer ≥ 0
    - `retention_days`: `parseIntDec`, integer ≥ 1
    - `min_confidence`: `valRaw.trim()` must match `/^[+-]?\d+(?:\.\d+)?$/`, and then `Number(...)` must be within [0,1]. It is **refused, not clamped**, because the loader clamps silently. The pattern is stricter than TOML (no exponent); refusing more is safe.
  - A refused value's message is `"[<section>] <key> = <valRaw>: expected <expect>"`.
  - A section with `malformed` set gives one problem and is skipped (`continue`), children included. Check `header` against the allowlist even when `lines` is empty.
  - Each `[[fleet.job]]` block is checked structurally first: a non-empty `name` (after `parseString`), no passthrough lines, no key repeated. Only blocks that pass are rendered to the checker, as one text: `"[[fleet.job]]\n"` plus each block's raw lines. The checker is not called when no block passes.
  - Each `why` is one factual line. Example: `"fleet master switch; the owner's own file still overrides it"`.

- [ ] **Step 5: Run the tests.** Expected: PASS.

- [ ] **Step 6: Commit.** Run `bun run preflight:fast` first, then commit with message `feat(config): pack-settable allowlist and fragment check`.

---

### Task 2: The fleet-job checker

**Files:**
- Create: `packages/gateway/src/packs/pack-job-check.ts`
- Test: `packages/gateway/src/packs/pack-job-check.test.ts`

**Interfaces:**
- Consumes:
  - `PackJobChecker` (Task 1)
  - `parseNimbusTomlFleetJobs`, `FleetConfigError` (`config/fleet-toml.ts`)
  - `resolveFleetAgentMethod` (`ipc/agents-rpc.ts`): `null` when the agent is not served or not fleet-`eligible`
  - `validateFleetSweepJobs` (`fleet/fleet-sweep-support.ts`)
- Produces: `export const checkPackFleetJobs: PackJobChecker`

- [ ] **Step 1: Write the failing tests:**
  - `accepts an eligible job`. `agent = "standup"`, `interval_seconds = 86400` gives `[]`.
  - `refuses an ineligible or unknown agent`. A problem names the job and contains `is not fleet-eligible`. Use `agent = "nope"`, plus one agent whose `FLEET_ELIGIBILITY` is not `"eligible"`; read that agent from the table rather than hardcoding it.
  - `refuses federation params`. `namespace = "x"` and `namespaces = "a,b"` each give a problem containing `namespace/namespaces are not allowed in a pack job`, with or without `sweep`.
  - `refuses what the fleet parser refuses`. A missing `agent`, `interval_seconds = 0`, `max_subjects` without `sweep`, and a duplicate name within the text each give that parser's `FleetConfigError` message as the problem.
  - `refuses an unsupported sweep`. Use one agent/kind pair that `validateFleetSweepJobs` refuses.
  - `one cause, one problem`:
    - an ineligible agent with `sweep` set gives only the `is not fleet-eligible` problem, not a second `cannot sweep`
    - `sweep` plus `namespace` gives only the pack `namespace/namespaces are not allowed` problem, not the sweep validator's federation message
  - `collects problems across jobs`. Two jobs, each with an unsupported sweep, give two problems (`validateFleetSweepJobs` throws on its first job, so it is called per job).

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement `checkPackFleetJobs`.**
  - A `FleetConfigError` thrown by the parser becomes one problem, and checking stops there: the parser stops at its first error.
  - Every other check runs per job and collects all of its problems, in this order: the federation params (`namespace`/`namespaces`) on `job.params`, then eligibility via `resolveFleetAgentMethod`. Only an eligible job goes on to `validateFleetSweepJobs([copy])`, where `copy` is the job with `namespace`/`namespaces` removed from `params`; catch its `FleetConfigError` as that job's problem.

- [ ] **Step 4: Run the tests and `bun run audit:boundaries`.** Expected: both PASS, with no cycle. `packs/` is imported by nothing in `config/`.

- [ ] **Step 5: Commit** `feat(packs): fleet-job check for pack fragments`.

---

### Task 3: The reader takes pack text and reports skips

**Files:**
- Modify:
  - `packages/gateway/src/config/layered-config.ts`
  - `packages/gateway/src/config/nimbus-toml-glossary-terms.ts`
  - `packages/gateway/src/config/nimbus-toml.ts` (the `[lan]` fallback)
- Test:
  - `packages/gateway/src/config/layered-config.test.ts` (extend)
  - `packages/gateway/test/integration/config/layer-read-error.test.ts` (extend)

**Interfaces:**
- Produces. These replace PR 1's `PackLayerSource.list`, which has no other implementer or caller:
  - `export type PackLayerText = { readonly id: string; readonly path: string; readonly text: string }`
  - `export type SkippedPack = { readonly packId: string; readonly reason: string }`
  - `export type PackLayersRead = { readonly layers: readonly PackLayerText[]; readonly skipped: readonly SkippedPack[]; readonly listError?: string }`
  - `export interface PackLayerSource { read(profile: string): PackLayersRead }`, and `EMPTY_PACK_LAYERS` returns `{ layers: [], skipped: [] }`
  - `ConfigSnapshot` gains `readonly activePacks: readonly string[]` (ids in order), `readonly skippedPacks: readonly SkippedPack[]` and `readonly packListError?: string`
  - `ConfigSnapshot.text` is `null` only when **no** layer file exists, pack layers included. A pack-only config renders.
  - `ConfigSnapshot` gains `readonly hasUserLayer: boolean`: whether a base or profile file was read.
  - `export function layeredHasUserLayer(configDir: string): boolean`
  - `export function peekLayeredConfig(configDir: string): LayeredConfig | undefined`: the registered reader, never creating one
- Modify: `packages/gateway/src/config/nimbus-toml-glossary-terms.ts`.
  - `loadGlossaryManualFromConfigDir` returns `{ loaded: false }` when `layerReadError(configDir)` is set (recording it through `sectionFallbackSink(configDir, "glossary.terms")`, as `filesystem-toml.ts` does), and when `!layeredHasUserLayer(configDir)`.
  - The read-error half closes a hazard already on `main`: terms authored in an unreadable profile file are read as "no terms", and the sync pass deletes them.
  - **Why this is load-bearing:** `loaded: true` with zero terms makes `glossary-manual.ts`'s desired-state pass delete every authored term. Today a missing `nimbus.toml` gives `null` text and so `loaded: false`. Once a pack-only config renders, the same missing file would otherwise read as "no terms" and wipe them. Glossary is not pack-settable, so it comes from user layers only.
- Modify: `loadNimbusLanFromPath` and `loadNimbusLanFromConfigDir` pass `parseNimbusLanToml("")` as the fallback instead of `DEFAULT_NIMBUS_LAN_TOML`, matching the updater loader. Otherwise `NIMBUS_LAN_PORT` is ignored with no file but honoured on a pack-only render: the one loader whose `null` and pack-only results differ.
- Modify: `initLayeredConfig` throws when `opts.packs` is given and the registered reader already exists with a different pack source (for example, `getLayeredConfig` ran first). Today it returns the existing reader and silently drops `opts.packs`.

- [ ] **Step 1: Write the failing tests** (a fake `PackLayerSource` that returns fixed texts):
  - `a pack layer sits below base and profile`. A pack sets `[decisions] min_confidence = 0.5`, base sets `0.6`, profile `work` sets `0.7`. The effective value is `0.7`, and the shadowed values list base then pack.
  - `pack-only config renders and glossary stays unloaded` (Review Focus 4). No base or profile file exists, and the pack sets `[decisions] min_confidence = 0.5`. `text` is non-null, `hasUserLayer` is `false`, `loadNimbusDecisionsFromConfigDir(dir).minConfidence` is `0.5`, and `loadGlossaryManualFromConfigDir(dir)` returns `{ loaded: false }`. Red-check: revert the glossary guard and this test must fail with `loaded: true`.
  - `an unreadable profile layer leaves glossary unloaded` (in `layer-read-error.test.ts`). Base readable, profile file a directory: `loadGlossaryManualFromConfigDir(dir)` is `{ loaded: false }` and `sectionFallback("glossary.terms")` names the file. Red-check it by reverting the guard.
  - `NIMBUS_LAN_PORT applies with no config file`. With the env set and no file, `loadNimbusLanFromConfigDir(dir).port` is the env value.
  - `init after an implicit reader refuses a pack source`. `getLayeredConfig(dir)` then `initLayeredConfig(dir, { packs })` throws.
  - Other loaders whose "no file" branch matters: grep every `layeredConfigText(` caller for a `=== null` branch. Confirm that for each one, reading a pack-only render rather than `null` gives the same result. The plan review audited all 16 call sites at `780303ec` and found only `[lan]` differs (fixed above); re-run the grep, since the list may have moved, and record it in the task report.
  - `skips and list errors are carried on the snapshot`. A source that returns `skipped: [{packId:"bad",reason:"r"}]` and `listError: "e"` produces a snapshot with both, and `activePacks` lists only the merged ids.
  - `a pack text change rebuilds; an identical read reuses the snapshot`. The version increases only when a pack text or the skipped set changes.
  - `peekLayeredConfig` returns `undefined` before init and the reader after it.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - `snapshot()` calls `this.packs.read(this.profile.name)` once and builds the pack refs from `layers`.
  - It uses each pack's `text` instead of `readLayer`. Base and profile still go through `readLayer`.
  - The cache check also compares pack texts, `skipped` (via `JSON.stringify`) and `listError`.
  - Update the class's header comment to say pack text comes from the source.

- [ ] **Step 4: Run the tests, then the whole config directory** (`bun test packages/gateway/src/config packages/gateway/test/integration/config`). Expected: PASS, with no PR 1 regression.

- [ ] **Step 5: Commit** `feat(config): pack layers arrive as validated text; snapshot reports skipped packs`.

---

### Task 4: The pack-layer store

**Files:**
- Create: `packages/gateway/src/packs/pack-layer-store.ts`
- Test: `packages/gateway/src/packs/pack-layer-store.test.ts`

**Interfaces:**
- Consumes:
  - `PACK_ID_RE`, `PACK_FRAGMENT_MAX_BYTES`, `checkPackFragment` (Task 1)
  - `checkPackFleetJobs` (Task 2)
  - `PackLayerSource`, `PackLayersRead`, `peekLayeredConfig` (Task 3)
  - `PROFILE_NAME_RE` (`config/active-profile.ts`)
  - `writeUtf8FileAtomicReplace(path, content)` (`config/toml-section-writer.ts`)
- Produces:
  - `export class PackLayerRefusedError extends Error { readonly problems: readonly string[] }`. The message joins `problems` with `"; "`. **Every** refusal from `setPackLayer`/`removePackLayer` throws this class: a bad profile or id, a malformed `active.json`, a fragment problem, a conflict. Callers handle one error class.
  - `export type PackWriteResult = { readonly path: string; readonly snapshotVersion: number | null }`. `snapshotVersion` is set only when `profile` is the running profile and something was written; a remove of an absent pack returns `null` and does not call `onChange`.
  - `export type PackLayerStore = PackLayerSource & { setPackLayer(profile: string, packId: string, fragment: string): PackWriteResult; removePackLayer(profile: string, packId: string): PackWriteResult & { readonly removed: boolean } }`
  - `export function createPackLayerStore(opts: { configDir: string; checkJobs?: PackJobChecker; onChange?: (profile: string) => number | null }): PackLayerStore`
    - `checkJobs` defaults to `checkPackFleetJobs`.
    - `onChange` defaults to this: if `peekLayeredConfig(configDir)` exists and its `profile.name === profile`, return `.snapshot().version`; otherwise return `null`.
  - The store is a factory-returned object, not exported functions: Project 3's `pack.install` is its only intended caller (§ 5.2).

- [ ] **Step 1: Write the failing tests.** Every test runs in a fresh `mkdtempSync` dir and calls `initLayeredConfig(dir, { packs: store })` where it reads effective values.
  - `set writes the file and active.json, and the value applies`. Afterwards `packs/default/pm.toml` exists, `active.json` is `{"version":1,"packs":["pm"]}`, `snapshotVersion` is a number, and the decisions loader sees the pack's value.
  - `never touches the user's files`. Hash `nimbus.toml` and `nimbus.work.toml` (sha256 of the bytes) before and after a set and a remove. The hashes are equal, and neither file's mtime changed.
  - `refuses off-list keys, naming them`. A `PackLayerRefusedError` names the keys, and nothing is written.
  - `refuses conflicts, naming them`:
    - pack `a` sets `retention_days = 7` and pack `b` sets `14`: refused with a problem containing `"[fleet] retention_days: pack a sets 7"`
    - two packs with a `[[fleet.job]]` named `daily`: refused with `"[[fleet.job]] daily is also set by pack a"`
    - a conflict is refused even when the user's file sets that key
  - `equal values and self-updates do not conflict` (Review Focus 5). Two packs both set `enabled = true`, `0.7` against `0.70` passes, and re-setting `a` with a changed value passes.
  - `refuses a bad id or profile`. Pack ids `../x` and `PM`, and profile `../w`, are refused before any filesystem write.
  - `remove drops the entry, then the file`. `removed: true`. Removing an absent pack returns `removed: false` and writes nothing.
  - `a tampered file is skipped whole` (Review Focus 2). Hand-edit `pm.toml` to add `[llm]\nprefer_local = false`. `read("default").skipped` is `[{packId:"pm", reason: <names "[llm] prefer_local">}]`, and the pack's allowlisted `min_confidence` does **not** apply.
  - `hostile active.json entries never become paths` (Review Focus 3). Entries `"../../nimbus"`, `"PM"`, `"pm"`, `"pm"` and `"ghost"` give these skips: one invalid-id skip each for the first two, `pm` merged once plus a `listed twice` skip, and `ghost` skipped as `missing`. A filesystem spy, or a planted `../../nimbus.toml` sentinel, shows that no path built from the bad entries was read.
  - `malformed active.json applies no packs`. For non-JSON, `version: 2`, and `packs` not being a string array, `listError` is set and `layers` is empty. `setPackLayer` and `removePackLayer` then **refuse** rather than overwrite the owner's file.
  - `an unreadable or oversized pack file is skipped`. A directory at `pm.toml`, or a file over the cap, is skipped with a reason.
  - `reasons carry no absolute path`. No `skipped[].reason` or `listError` contains `configDir`, including for a directory at `active.json` (`EISDIR`).
  - `every refusal is a PackLayerRefusedError`. Bad id, bad profile, malformed `active.json`, fragment problem and conflict each throw that class.
  - `remove tolerates a missing file`. Delete `pm.toml` by hand, then `removePackLayer("default","pm")` returns `removed: true` and `active.json` no longer lists it.
  - `a pack for another profile is stored but not applied`. Set on `work` while the reader runs `default`: `snapshotVersion` is `null` and the effective config is unchanged.

- [ ] **Step 2: Run them and see them fail.**

- [ ] **Step 3: Implement.**
  - `createPackLayerStore` resolves `configDir` once (`resolve(opts.configDir)`), so the path it strips from `fs` error messages matches theirs on Windows. Any absolute path in a message, `active.json`'s included, is replaced by its basename.
  - **`read(profile)`:**
    - A missing `packs/<profile>/` or `active.json` gives no packs and no error.
    - Entries are checked in list order: id rule, duplicates, then `statSync` size against the cap (so an oversized file is never read into memory), then reading the file (ENOENT means `missing`; any other error gives its message with the path replaced by the basename), then `checkPackFragment`, which re-checks the byte cap on what was actually read. If `profile` itself fails `PROFILE_NAME_RE`, return `listError`.
  - **`setPackLayer` order:**
    1. Validate the profile and id.
    2. Read `active.json`, refusing on `listError`.
    3. Run `checkPackFragment`, refusing with its problems.
    4. Check for conflicts against every other listed pack that currently reads clean, comparing `scalars` by value and `jobNames` by name.
    5. `mkdirSync(..., { recursive: true })`, then write `<id>.toml` atomically, then write `active.json` atomically (append the id if absent).
    6. Return `onChange(profile)`.
  
    A crash between the two writes leaves an unlisted file, which is inert.
  - **`removePackLayer`:** rewrite `active.json` without the id first, then delete the file (ignoring `ENOENT`), then call `onChange`.

- [ ] **Step 4: Run the tests and check coverage** on `pack-layer-store.ts` (≥85% line, ≥80% branch). Expected: PASS.

- [ ] **Step 5: Commit** `feat(packs): file-backed pack-layer store with allowlist and conflict refusal`.

---

### Task 5: Wire the store at boot

**Files:**
- Modify: `packages/gateway/src/platform/assemble.ts:3369`
- Test: `packages/gateway/test/integration/config/pack-layer.test.ts` (create)

**Interfaces:**
- Consumes: `createPackLayerStore` (Task 4) and `initLayeredConfig(configDir, { packs })` (PR 1)

- [ ] **Step 1: Write the failing integration test.** It uses real loaders over a temp `configDir` and calls `initLayeredConfig(dir, { packs: createPackLayerStore({ configDir: dir }) })`.
  - Base enables the fleet with user job `mine`. A pack adds job `pack-daily` and sets `[decisions] min_confidence = 0.4`. `loadNimbusFleetFromConfigDir(dir).jobs` names both jobs, and the decisions loader reads `0.4`.
  - The user file sets `min_confidence = 0.9`, which wins. `explainConfig(reader, "decisions.min_confidence")` shows it from base, shadowing `0.4` from `pack pm`.
  - The user adds a job named `pack-daily`. The user's job replaces the pack's (PR 1's merge by name), and there is still only one `pack-daily`.
  - `removePackLayer` puts everything back to the user-only values.
- [ ] **Step 2: Run it and see it fail** (the store is not wired).
- [ ] **Step 3: Implement.** Pass `{ packs: createPackLayerStore({ configDir: paths.configDir }) }` to the existing `initLayeredConfig(paths.configDir)` call, and leave the boot comment's ordering note intact. Right after the existing `config: profile …` info line, take one snapshot and log at `error` one line per `skippedPacks` entry and one for `packListError` (spec § 5.2 lists the log among the four places a skip is reported). Put the line-building in a small exported helper (`packSkipLogLines(snapshot): string[]` in `pack-layer-store.ts`) and unit-test it there; reload-time logging is PR 3's.
- [ ] **Step 4: Run the integration test, then `bun test packages/gateway/test/e2e` filtered to gateway boot** (for example, the explain-last and config e2e files). Expected: PASS, and boot works with no `packs/` dir.
- [ ] **Step 5: Commit** `feat(config): the gateway reads pack layers`.

---

### Task 6: Report active and skipped packs

**Files:**
- Modify:
  - `packages/gateway/src/ipc/diagnostics-rpc.ts` (`buildConfigLayers`)
  - `packages/gateway/src/config/config-explain.ts` (`explainConfig` notes)
  - `packages/cli/src/commands/doctor-core.ts` (`doctorPrintProfile`)
  - `docs/architecture.md` § Layered config
  - `docs/cli-reference.md` (`nimbus doctor` and `config explain`)
  - `docs/CHANGELOG.md`
- Test (extend):
  - `packages/gateway/src/ipc/diagnostics-rpc.test.ts`
  - `packages/gateway/src/config/config-explain.test.ts`
  - `packages/cli/src/commands/doctor-core.test.ts`

**Interfaces:**
- Consumes: `ConfigSnapshot.activePacks`, `.skippedPacks` and `.packListError` (Task 3)
- Produces:
  - `diag.snapshot.configLayers` changes:
    - `activePacks: string[]` and `skippedPacks: {packId, reason}[]` are now real; PR 1 always sent them empty
    - new optional `packListError: string`
    - every string is basename-safe
  - Explain notes: `pack "<id>" skipped: <reason>` per skip, and `packs for profile "<p>" not applied: <listError>`

- [ ] **Step 1: Write the failing tests:**
  - diag: a store with one good and one tampered pack gives `activePacks: ["pm"]` and one `skippedPacks` entry. No string in `configLayers` contains the temp dir.
  - explain: with no path and with any path, the notes include the skip line and the list-error line.
  - doctor: `doctorPrintProfile` prints `[warn] pack "x" skipped: <reason>` and `[warn] packs not applied: <listError>`, each returning exit 1. It prints `[info] packs active: pm, devops` with exit 0. An older gateway's payload without these fields prints nothing new, and malformed values (`activePacks` not an array, a `skippedPacks` entry missing `packId` or `reason`) are filtered out the same way `isLayerRecord` filters `layers`. `[info] packs active` prints only when the filtered list is non-empty.
- [ ] **Step 2: Run them and see them fail.**
- [ ] **Step 3: Implement**, then update the docs:
  - architecture: one paragraph on the pack layer covering storage, the allowlist module, read-side skipping, the conflict rule and "no IPC writes it"
  - cli-reference: the new doctor lines and explain notes
  - CHANGELOG: one entry in the file's existing style, saying the gateway now reads pack layers (none exist until a later release installs one) and that `nimbus doctor` reports skipped ones. Also note the two Task 3 fixes: `NIMBUS_LAN_PORT` now applies when no config file exists, and glossary terms in an unreadable profile file are no longer treated as deleted
- [ ] **Step 4: Run the tests, `bun run audit:doc-refs` and `bun run audit:status-drift`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(config): report active and skipped packs in diag, doctor and explain`.

---

### Task 7: Final verification and PR

- [ ] **Step 1:** Run `bun run preflight` in full. Fix any failure that comes from the branch. For one that doesn't (for example, the pwsh-on-Bash-PATH installer tests), record it with evidence that it fails on `main` too.
- [ ] **Step 2:** Run the whole-branch review (subagent-driven flow), fix, and run `preflight:fast` again.
- [ ] **Step 3:** Push and open the PR.
  - Title: `feat(config): pack layers under the user's config, allowlisted and conflict-checked`. No `!`: no user has to change anything.
  - The body states what is NOT here: no IPC/CLI writer, no `pack.install`, no live fleet reload (PR 3), no `enabled = false` stub (PR 4), no `[agents] visible` (PR 5).
  - End the body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
