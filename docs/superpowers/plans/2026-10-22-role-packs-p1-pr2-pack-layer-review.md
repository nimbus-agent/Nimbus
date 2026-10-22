# Review: Role Packs P1 — PR 2 (The Pack Layer)

**Reviewed plan:** `docs/superpowers/plans/2026-10-22-role-packs-p1-pr2-pack-layer.md`
**Parent spec:** `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md` (§ 5.2)
**Baseline commit:** `780303ec` (`feat(config): layered config reader; profiles inherit from nimbus.toml (#1714)`)
**Date:** 2026-10-22

---

## Executive Summary

The PR 2 plan fits cleanly onto PR 1's `LayeredConfig` / `parseLayerDoc` / `mergeLayerDocs` foundation:
- Placing `pack-job-check.ts` and `pack-layer-store.ts` in `packages/gateway/src/packs/` while keeping `pack-settable.ts` pure inside `packages/gateway/src/config/` avoids any `config/ ↔ ipc/ ↔ fleet/` dependency cycle and passes `audit:boundaries` and static rule `D35`.
- Having `PackLayerSource.read(profile)` return already-validated `text` eliminates the TOCTOU window between fragment validation and layer merging and avoids reading each pack file twice per snapshot.
- Keeping unreadable/invalid pack files in `skippedPacks` rather than `SnapshotLayer.readError` ensures `layerReadError(configDir)` stays `undefined` when a pack is tampered with, preserving the global constraint that broken pack state is never fatal to user config loaders.

Cross-checking each task against the live codebase surfaced **5 implementation traps / edge cases to guard against**, **4 open questions to settle**, and **4 concrete refinements**.

---

## 1. Implementation Traps & Edge Cases to Guard Against

### 1.1 `Number(valRaw.trim())` on `decisions.min_confidence` accepts `""` and hex/binary literals (Task 1)

Task 1 Step 4 specifies:
> - `min_confidence`: `Number(valRaw.trim())`, finite and within `[0,1]`. It is **refused, not clamped**, because the loader clamps silently.

In JavaScript:
- `Number("")` and `Number("   ")` evaluate to **`0`**, which is finite and within `[0, 1]`. (`nimbus-toml.ts:2479` explicitly guards `valRaw.trim() !== ""` for this reason.)
- `Number("0x0")`, `Number("0b0")`, and `Number("0o0")` also evaluate to `0`, whereas TOML floats are decimal.

**Recommendation:**
Require `valRaw.trim()` to match a decimal number pattern (e.g. `/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/` or at minimum `valRaw.trim() !== ""` and no `0x`/`0b`/`0o` prefix) before checking `Number.isFinite(n) && n >= 0 && n <= 1`.

---

### 1.2 `[[fleet.job]]` blocks with missing/empty `name` and duplicate error reporting between Task 1 & Task 2

In `packages/gateway/src/config/fleet-toml.ts`:
1. **Empty `[[fleet.job]]` blocks are silently ignored by `parseNimbusTomlFleetJobs` (`fleet-toml.ts:278`):**
   ```ts
   if (name === undefined && agent === undefined && intervalSeconds === undefined) return;
   ```
   A fragment containing `[[fleet.job]]\n` (or only custom params) returns `[]` from `parseNimbusTomlFleetJobs` without throwing `FleetConfigError`.
2. **`name = ""` is accepted by `parseNimbusTomlFleetJobs` (`fleet-toml.ts:172, 279`):**
   `parseString('""')` returns `""`, which is `!== undefined`, so `flush()` does not throw.
3. **Double-reporting when `name` is missing (`[[fleet.job]]\nagent = "standup"\ninterval_seconds = 60\n`):**
   - Task 1 Step 2 tests that `checkPackFragment` itself refuses a `[[fleet.job]]` block with no `name` (even when `checkJobs` is a no-op stub in `pack-settable.test.ts`).
   - Task 2's `checkPackFleetJobs` calls `parseNimbusTomlFleetJobs`, which *also* throws `FleetConfigError("[[fleet.job]] requires name")`.
   - If `checkPackFragment` records its own missing-`name` problem *and* still passes that block to `checkJobs`, the caller gets two problems for the same missing `name`.

**Recommendation:**
- In `checkPackFragment`, require every `[[fleet.job]]` block to have a non-empty `name` (after `parseString`) and no `passthrough` (`=`-less or unterminated string) lines.
- Only invoke `checkJobs(jobsText)` when the `[[fleet.job]]` blocks pass `checkPackFragment`'s own structural check (or only include structurally valid blocks in `jobsText`), so missing `name` is reported once.
- Also refuse duplicate `key` entries within a single `[[fleet.job]]` block (e.g. two `name` or two `agent` lines in the same block), which `applyJobKey` in `fleet-toml.ts` otherwise overwrites last-wins.

---

### 1.3 `validateFleetSweepJobs` throws on first job and overlaps with eligibility & federation checks (Task 2)

In `packages/gateway/src/fleet/fleet-sweep-support.ts:86-110`:
1. `validateFleetSweepJobs(jobs)` loops over `jobs` and **throws `FleetConfigError` on the first failing job**. Task 2 Step 3 states: *"Every other check runs per job and collects all of its problems."*
   - **Fix:** Call `validateFleetSweepJobs([job])` inside the per-job loop rather than once on the full `jobs` array.
2. **Overlap with `resolveFleetAgentMethod(job.agent)`:**
   - Inside `validateFleetSweepJobs`, `sweepParamFor(job.agent, kind)` calls `resolveFleetAgentMethod(job.agent)` (`fleet-sweep-support.ts:71`). When `job.agent` is unknown or ineligible, `sweepParamFor` returns `null` and `validateFleetSweepJobs` throws `[[fleet.job]] <name> agent "<agent>" cannot sweep "<kind>"`.
   - **Fix:** Only call `validateFleetSweepJobs([job])` if `resolveFleetAgentMethod(job.agent) !== null`, so an ineligible agent with `sweep` only reports `is not fleet-eligible` instead of a second bogus `"cannot sweep"` message.
3. **Overlap with federation parameters (`namespace` / `namespaces`) when `sweep` is set:**
   - Task 2 Step 1 specifies: *"`namespace = 'x'` and `namespaces = 'a,b'` each give a problem containing `namespace/namespaces are not allowed in a pack job`, **with or without `sweep`**."*
   - However, `validateFleetSweepJobs` (`fleet-sweep-support.ts:103-108`) also checks `FEDERATION_PARAMS` when `job.sweep !== null` and throws `"[[fleet.job]] <name> combines sweep with namespace/namespaces; a sweep stays local..."`.
   - **Fix:** Check `namespace`/`namespaces` on `job.params` in `checkPackFleetJobs` for all jobs, and strip `namespace`/`namespaces` from the `job.params` copy passed to `validateFleetSweepJobs([job])` so a pack job with both `sweep` and `namespace` emits only the `"namespace/namespaces are not allowed in a pack job"` problem.

---

### 1.4 `loadGlossaryManualFromConfigDir` when one user layer exists and another has `readError` (Task 3)

Task 3 adds `layeredHasUserLayer(configDir)` to `loadGlossaryManualFromConfigDir` (`packages/gateway/src/config/nimbus-toml-glossary-terms.ts:222`) so a pack-only config (`hasUserLayer === false`, `text !== null`) returns `{ loaded: false }` instead of wiping authored terms.

However, look at what happens when **both `nimbus.toml` and `nimbus.<profile>.toml` exist**, the user authored their `[glossary.terms]` in `nimbus.<profile>.toml`, and `nimbus.<profile>.toml` is temporarily unreadable (`readError !== undefined`):
- `hasUserLayer` is `true` (because `nimbus.toml` read cleanly).
- `layeredConfigText(configDir)` returns `nimbus.toml`'s text (which has no `[glossary.terms]`).
- Because `loadGlossaryManualFromConfigDir` does not currently check `layerReadError(configDir)` (unlike `filesystem-toml.ts:140` and `multimodal-config.ts:121`), it returns `{ loaded: true, terms: [] }`, causing `glossary-manual.ts`'s desired-state pass to delete every term authored in the profile!
- Furthermore, `parseGlossaryManualToml` never throws, so the `catch` block in `loadGlossaryManualFromConfigDir` (`sectionFallbackSink(configDir, "glossary.terms")`) is currently unreachable dead code unless `layerReadError` is checked.

**Recommendation:**
In `loadGlossaryManualFromConfigDir(configDir)`:
```ts
const readError = layerReadError(configDir);
if (readError !== undefined) {
  sectionFallbackSink(configDir, "glossary.terms")(readError);
  return { loaded: false };
}
if (!layeredHasUserLayer(configDir)) return { loaded: false };
```

---

### 1.5 Task 3 Step 1 Audit of `layeredConfigText` Callers: `loadNimbusLanFromConfigDir` `null` Fallback

Task 3 Step 1 asks to grep every `layeredConfigText(` caller for a `=== null` branch and confirm that reading a pack-only render gives the same result as `null` for non-pack-settable sections.

Checking all 16 `layeredConfigText` call sites in `origin/main` (`780303ec`):
- 13 non-pack-settable loaders (`filesystem-toml.ts`, `mcp-sink-toml.ts`, `nimbus-toml-connectors.ts`, `nimbus-toml-workday.ts`, `notifications-toml.ts`, `oncall-push-toml.ts`, `service-config-toml.ts`, `session-toml.ts`, `telemetry-toml.ts`, `multimodal-config.ts`, `loadNimbusPagerdutyFromConfigDir`, `loadNimbusServiceConfigsFromConfigDir`, and all `loadTomlSectionFromConfig` callers except `lan`) produce the exact same result on a pack-only render as on `null`.
- **One exception:** `loadNimbusLanFromConfigDir` (`packages/gateway/src/config/nimbus-toml.ts:961`) passes `DEFAULT_NIMBUS_LAN_TOML` as its `null` fallback instead of `parseNimbusLanToml("")` (contrast with `loadNimbusUpdaterFromConfigDir` at `nimbus-toml.ts:876`, which passes `parseNimbusUpdaterToml("")`).
  - When `NIMBUS_LAN_PORT` is set in the environment and no user config file exists: `text === null` returns `DEFAULT_NIMBUS_LAN_TOML` (`port: 7475`, ignoring `NIMBUS_LAN_PORT`), whereas a pack-only config (`text !== null`) calls `parseNimbusLanToml(text)` and honors `NIMBUS_LAN_PORT`!
  - **Fix:** Pass `parseNimbusLanToml("")` as the fallback in `loadNimbusLanFromPath` / `loadNimbusLanFromConfigDir` (matching `loadNimbusUpdaterFromConfigDir`).

---

## 2. Open Questions

### Q1. Should skipped packs / `packListError` also be logged at `error` on gateway boot?
- **Spec § 5.2 (lines 204 & 228):** States that broken/tampered pack state is *"skipped and reported at error (**log**, `diag.snapshot`, `nimbus doctor`, `config explain`) instead of failing boot or a read"*.
- **Plan (Tasks 4–6):** Covers `diag.snapshot`, `nimbus doctor`, and `config explain`, but does not log `skippedPacks` or `packListError` to `syncLogger.error(...)` in `platform/assemble.ts:3375`.
- **Question:** Should Task 5 log one `syncLogger.error(...)` line per skipped pack / `packListError` right after `syncLogger` is created in `assemble.ts`, or is log emission deferred to PR 3's reload supervisor?

### Q2. Should all refusals in `setPackLayer` and `removePackLayer` throw `PackLayerRefusedError`?
- Task 4 defines `PackLayerRefusedError` with `readonly problems: readonly string[]`.
- There are four refusal triggers across `setPackLayer` / `removePackLayer`:
  1. Invalid `profile` (`!PROFILE_NAME_RE.test(profile)`) or invalid `packId` (`!PACK_ID_RE.test(packId)`)
  2. Malformed/unreadable `active.json` (`listError !== undefined`)
  3. Fragment check failures (`!check.ok`)
  4. Scalar or fleet-job name conflicts with another active pack
- **Suggestion:** Have all four throw `PackLayerRefusedError` so callers (and Project 3's `pack.install`) only need to handle one error class for any refusal.

### Q3. What should `removePackLayer` return for `snapshotVersion` when the pack was absent (`removed: false`)?
- Task 4 states:
  - `PackWriteResult = { readonly path: string; readonly snapshotVersion: number | null }`. `snapshotVersion` is set only when `profile` is the running profile.
  - *"Removing an absent pack returns `removed: false` and writes nothing."*
- **Question:** When `removed: false` and `profile` is the running profile, should `snapshotVersion` be `null` (because no write/change occurred) or the running profile's current `snapshot().version` (by still calling `onChange(profile)`)?

### Q4. Should an empty or comment-only pack fragment be allowed or refused by `checkPackFragment`?
- If `checkPackFragment("# comment only\n", checkJobs)` is called, `scalars` is empty and `jobNames` is `[]`.
- If allowed, a pack with an empty fragment on a machine with no `nimbus.toml` sets `ConfigSnapshot.text = ""` (non-null).
- **Question:** Should a pack fragment with zero allowlisted scalars and zero `[[fleet.job]]` blocks be accepted as a no-op layer or refused by `checkPackFragment`?

---

## 3. Additional Refinements & Suggestions

1. **Handle malformed headers, empty off-list sections, and repeated keys in `checkPackFragment` (Task 1):**
   - **Lines after a malformed header:** In `parseLayerDoc` (`layered-merge.ts:99`), a malformed header like `"[fleet\nenabled = true\n"` creates a section with `malformed: "[fleet"`, `header: null`, and `lines: [enabled = true]`. When `section.malformed !== undefined`, emit one problem for the malformed header and `continue` so its child lines are not also reported as root-level keys.
   - **Empty off-list sections:** A bare `[llm.remote.openai]\n` with no keys produces `lines: []`. Check `section.header` against allowlisted plain sections even when `section.lines.length === 0`.
   - **Duplicate keys where the first value was invalid:** Track seen `"<section>.<key>"` in a separate `Set<string>` rather than checking `scalars.has(fullKey)` (since `scalars` only stores values whose `parse()` succeeded).
2. **Guard `initLayeredConfig` when an entry already exists in `registry` without `packs` (Task 3):**
   - In `layered-config.ts:158`, if `getLayeredConfig(dir)` was called before `initLayeredConfig(dir, { packs: store })`, `initLayeredConfig` currently returns `existing` and silently ignores `opts.packs`. Either update `existing`'s pack source (and clear `cached`) when `opts.packs` is provided, or throw an error so misordered initialization in tests cannot fail silently.
3. **Check file size via `statSync` before `readFileSync` and normalize `configDir` in `createPackLayerStore` (Task 4):**
   - Call `const root = resolve(opts.configDir)` once in `createPackLayerStore` so Windows path separators in `join(root, ...)` always match what `node:fs` puts in `err.message` when stripping paths to basenames.
   - Also strip `activeJsonPath` (replaced with `"active.json"`) if reading `active.json` fails with a non-`ENOENT` `fs` error (e.g. `EISDIR`).
   - In `read(profile)`, check `statSync(filePath).size > PACK_FRAGMENT_MAX_BYTES` before `readFileSync` (while keeping the UTF-8 byte check inside `checkPackFragment` for `setPackLayer`) so an oversized file on disk is skipped without reading it into memory first.
   - In `removePackLayer`, ignore `ENOENT` on `unlinkSync(<id>.toml)` so removing a pack whose `.toml` file is already missing on disk still cleans up `active.json` and returns `removed: true`.
4. **Defensive parsing in `doctorPrintProfile` (Task 6):**
   - In `packages/cli/src/commands/doctor-core.ts:906`, guard `activePacks` (`Array.isArray(c.activePacks)` with string filter, printing `[info] packs active: ...` only when non-empty) and `skippedPacks` (filtering for `{ packId: string, reason: string }`), matching the existing `isLayerRecord` defensive check tested in `doctor-core.test.ts:1045`.
