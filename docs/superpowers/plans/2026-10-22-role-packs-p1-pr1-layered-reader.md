# Role packs P1 · PR 1: the layered config reader — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route every gateway config read through one layered reader. Profiles then inherit from `nimbus.toml`, fleet jobs merge by name across layers, and `nimbus config explain` names the layer each value came from.

**Architecture:** Every section parser in the gateway is already a pure function over raw TOML text (`parse(raw: string)`). The reader therefore does not touch any parser:
1. It scans each layer file into a line-level document.
2. It merges the documents with provenance.
3. It **renders the merged result back into canonical TOML text**, which the unchanged parsers read instead of a file.

One reader per `configDir` is memoised in a module registry. Its profile is pinned when the reader is created at boot, and a content comparison on every read keeps today's live per-call behaviour.

**Tech Stack:** Bun 1.4, TypeScript strict (no `any`), `bun:test`, Biome. The hand-rolled TOML line scanner (`config/toml-primitives.ts`) is reused; no TOML library is added.

**Spec:** `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md` § 5.1, plus § 8 calls 10 (fleet merge-by-name in PR 1), 12 (profile pinned at boot) and 15 (glossary tables merge key by key). Parent: `docs/superpowers/specs/2026-10-21-role-packs-overview-design.md`. Both are branch-only.

## Global Constraints

- Layer order, low to high: `code defaults → pack layers → team baseline (empty slot) → nimbus.toml → nimbus.<profile>.toml`. PR 1 has **zero** pack layers and an empty team slot, but both exist in the layer type.
- Profile resolution order: explicit argument → `NIMBUS_PROFILE` (non-empty, not `default`) → `<configDir>/.nimbus-profile` (trimmed, not `default`) → `default`. Name rule: `/^[a-z0-9_-]{1,32}$/i`. An invalid name **throws at boot** with the offending value and its source named. The gateway pins the result for the process.
- Merge rules:
  - Scalars: the higher layer wins per key.
  - Plain tables merge key by key. This includes `[glossary.terms]`, `[glossary.synonyms]`, `[hitl.quorum.*]` and `[connectors.<id>]`.
  - Any `[[x]]` array of tables: the highest layer that defines it supplies all of it.
  - `[[fleet.job]]` instead merges by `name`, with a higher layer's job replacing a lower one whole.
  - There is no unset syntax.
- Per-file behaviour is preserved:
  - duplicate keys within one file keep today's last-wins
  - duplicate fleet job names within one file still reach the parser (still an error in PR 1)
  - unterminated or `=`-less lines still reach the parsers that report them
- No parser changes its typing, defaults, validation or error handling.
- New IPC is CLI-only and LAN-forbidden. It is not added to the Tauri allowlist.
- Non-negotiables apply:
  - no `any` (use `unknown` for external data)
  - platform equality: `path.join`/`os.tmpdir()`, no hardcoded separators
  - DI over `mock.module`
  - tests use real temp dirs and real SQLite where relevant
- Never commit on `main`. Verify `git rev-parse --abbrev-ref HEAD` is `dev/asaf/role-packs-p1-reader` (created in Task 1) before every commit. Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- After each task, run `bun run preflight:fast` and fix what it reports. The full `bun run preflight` runs at the end.
- `docs/superpowers/` files never land on `main`. The implementation worktree branches from `origin/main`, so they are never in it.

## Review Focus

1. **A profile created by copying `nimbus.toml`** (`nimbus profile create`) must not double `[[filesystem.roots]]`, `[[security.allowlist]]` or `[[connectors.workday.reports]]`, and must not produce "duplicate name" fleet errors. → Task 2, `copied profile does not duplicate arrays or fleet jobs`.
2. **Same-length rewrite inside one clock tick** (`min_confidence = 0.5` → `0.8`) must be seen by the next per-call read. → Task 3, `same-size rewrite is seen without a restart`.
3. **A gateway launched without `NIMBUS_PROFILE`** (Tauri, a service manager) while the marker says `work` must run the `work` profile; a marker containing `../x` must refuse boot rather than become a path. → Task 1 tests.
4. **CRLF files** (Windows editors) must merge identically to LF files, and a value containing `#` inside quotes must survive the render. → Task 2, `CRLF and quoted hash survive render`.
5. **No config file at all** must still give every section its defaults, and the glossary manual reader must still report `loaded: false`. → Task 5, `no files yields defaults and glossary loaded:false`.

---

### Task 1: Active-profile resolution

**Files:**
- Create: `packages/gateway/src/config/active-profile.ts`
- Test: `packages/gateway/src/config/active-profile.test.ts`
- Modify: `packages/gateway/src/config/profiles.ts`
  - export its slug regex as `PROFILE_NAME_RE` from `active-profile.ts` and reuse it
  - replace the private `readActiveMarker()` with `readProfileMarker(this.configDir)`, so the marker is parsed in exactly one gateway place
  - keep its public behaviour

**Interfaces:**
- Produces:
  - `export const PROFILE_NAME_RE: RegExp` (`/^[a-z0-9_-]{1,32}$/i`)
  - `export type ProfileSource = "argument" | "env" | "marker" | "default"`
  - `export type ResolvedProfile = { readonly name: string; readonly source: ProfileSource }` (`name` is `"default"` for the default)
  - `export class InvalidProfileNameError extends Error { readonly value: string; readonly source: ProfileSource }`
  - `export function resolveActiveProfile(opts: { configDir: string; explicit?: string; env?: (k: string) => string | undefined }): ResolvedProfile`. `env` defaults to `processEnvGet`.
  - `export function readProfileMarker(configDir: string): string | undefined`: the trimmed marker, or `undefined` for absent, empty or `default`.
  - `export function profileFilePath(configDir: string, name: string): string | null`: `null` for `default`, otherwise `join(configDir, \`nimbus.${name}.toml\`)`.

- [ ] **Step 0: Worktree.** Implementation branches from `origin/main`, **not** from the design branch. That keeps the spec, review and plan off the PR without a strip step. They stay on `dev/asaf/role-packs` and are read from `C:\gitrep\Nimbus\.claude\worktrees\role-packs\docs\superpowers\`.
  - Run `git fetch origin`, then `git worktree add C:\gitrep\Nimbus\.claude\worktrees\role-packs-p1-reader -b dev/asaf/role-packs-p1-reader origin/main`. Always use the absolute path.
  - Run `bun install` in the new worktree, then build the sandbox helper per the `nimbus-preflight` skill (fresh worktrees lack it).
  - Verify with `git rev-parse --abbrev-ref HEAD`.
- [ ] **Step 1: Write failing tests** in `active-profile.test.ts`, each using a fresh `mkdtempSync` config dir and an injected `env`:
  - `explicit beats env and marker`: explicit `"a"`, env `NIMBUS_PROFILE=b`, marker `c` → `{name:"a", source:"argument"}`
  - `env beats marker`: env `b`, marker `c` → `{name:"b", source:"env"}`
  - `marker used when env unset`: marker `work\n` → `{name:"work", source:"marker"}`
  - `env "default" falls through to marker`: env `default`, marker `work` → `work`/`marker`
  - `nothing set is default`: → `{name:"default", source:"default"}`
  - `traversal in marker throws`: marker `../x` → throws `InvalidProfileNameError` with `.value === "../x"` and `.source === "marker"`
  - `over-long env name throws`: 33 chars → throws with `source "env"`
  - `profileFilePath`: `profileFilePath(dir,"default") === null`; `profileFilePath(dir,"work") === join(dir,"nimbus.work.toml")`
- [ ] **Step 2: Run** `bun test packages/gateway/src/config/active-profile.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3: Implement `active-profile.ts`** per the Interfaces. In `profiles.ts`, replace the local regex literal with the imported `PROFILE_NAME_RE`.
- [ ] **Step 4: Run** the new test plus `bun test packages/gateway/src/config/profiles` (all PASS).
- [ ] **Step 5: Commit** with `feat(config): one active-profile resolution order`.

### Task 2: Line-level layer documents and the merge

**Files:**
- Create: `packages/gateway/src/config/layered-merge.ts`
- Test: `packages/gateway/src/config/layered-merge.test.ts`

**Interfaces:**
- Consumes: `stripComment`, `hasUnterminatedString`, `isTableHeader`, `splitKeyValue`, `parseString` from `toml-primitives.ts`.
- Produces:
  - `export type LayerKind = "pack" | "team" | "base" | "profile"`
  - `export type LayerRef = { readonly kind: LayerKind; readonly id: string; readonly path: string }`. `id` is the pack id, `"team"`, `"base"`, or the profile name.
  - `export type LayerDoc = { readonly layer: LayerRef; readonly sections: readonly DocSection[] }`
  - `export type DocSection = { readonly header: string | null; readonly isArray: boolean; readonly malformed?: string; readonly lines: readonly DocLine[] }`. `malformed` holds the raw header line of a broken-header section (see the classification order below).
    - `header` is the trimmed header text without brackets (`"fleet.job"`), or `null` for keys above the first header.
    - Each `[[x]]` occurrence is its own `DocSection` with `isArray: true`.
    - Repeated `[x]` occurrences in one file stay separate entries, in order.
  - `export type DocLine = { readonly kind: "entry"; readonly key: string; readonly valRaw: string; readonly raw: string } | { readonly kind: "passthrough"; readonly raw: string }`
    - `entry` lines come from `splitKeyValue(stripComment(line).trim())` on a terminated line.
    - Every other non-blank, non-comment line is `passthrough`: an unterminated string, or a line with no `=`. `raw` is the original line without its line ending.
  - `export function parseLayerDoc(layer: LayerRef, text: string): LayerDoc`
  - `export type EffectiveEntry = { readonly key: string; readonly valRaw: string; readonly raw: string; readonly layer: LayerRef; readonly shadowed: readonly { readonly layer: LayerRef; readonly valRaw: string }[] }`
  - `export type EffectiveSection = { readonly header: string | null; readonly isArray: boolean; readonly blockLayer?: LayerRef; readonly entries: readonly EffectiveEntry[]; readonly passthrough: readonly { readonly layer: LayerRef; readonly raw: string }[] }`
  - `export type EffectiveDoc = { readonly sections: readonly EffectiveSection[] }`
  - `export function mergeLayerDocs(docs: readonly LayerDoc[]): EffectiveDoc`, where `docs` are ordered low → high.
  - `export function renderEffectiveDoc(doc: EffectiveDoc): string`, which renders canonical text with `\n` line endings.

**Line classification order** in `parseLayerDoc`:
1. Blank and comment-only lines are dropped. Parsers ignore them, so nothing is lost.
2. A line whose trimmed text starts with `[` is checked **before** `hasUnterminatedString`:
   - A well-formed `[x]` or `[[x]]` opens a section.
   - Anything else starting with `[` (`[multimodal` with no `]`, or `[hitl.quorum."x]`) **closes the current section** and opens a section with `malformed` set and `header: null`. Today's parsers (`collectSubTableKv`, multimodal's `parseSection`) end a section on any `[` line, so the keys after a broken header must never be attributed to the section before it.
3. Then come the unterminated and `=`-less `passthrough` lines, then `entry` lines.

**Merge algorithm** (spelled out because the signatures leave it open):

1. **Plain tables.** Group plain sections across all docs by `header`. The effective section's key order is first appearance, scanning layers low → high. For each key, the **winning layer** is the highest layer with at least one `entry` for that key. The section's entries for that key are **all** of the winning layer's occurrences, in that layer's order, which preserves in-file last-wins and duplicate reporting. Each emitted entry's `shadowed` lists the last occurrence's `valRaw` from each lower layer that also set the key, low → high.
2. **Passthrough lines.** Every `passthrough` line from every layer is kept on its section, in layer order, so the parsers that report malformed lines (glossary `preSkipped`) still see them.
3. **Arrays of tables, except `fleet.job`.** Group by `header`. The highest layer with at least one block for that header supplies all of its blocks, in order. Lower layers' blocks are dropped. Each effective array section has `blockLayer` set.
4. **`fleet.job`.** A block's name is `parseString(valRaw)` of its last `name` entry, or `undefined` if it has none. Walk layers low → high:
   - A named block replaces an earlier-placed block with the same name **from a lower layer** in place.
   - Two blocks with the same name in **one** layer are both kept, so the parser still raises its duplicate error.
   - Unnamed blocks are always kept, so the parser still raises "missing name".
   - New names are appended in encounter order.
5. **Rendering.**
   - The root (`header === null`) comes first.
   - Then sections appear in first-appearance order, low → high.
   - Plain sections render once as `[header]`, followed by their entries' `raw` lines and then their passthrough lines.
   - Each array block renders as `[[header]]` plus its lines.
   - Entry `raw` lines are emitted verbatim, so quoting, inline comments and `#` inside strings survive untouched.
   - Malformed-header sections are **not merged**. Each renders **after every valid section**, as its raw header line followed by its lines, in layer order. A broken line in one layer therefore cannot end a valid section early and swallow a higher layer's overrides.

- [ ] **Step 1: Write failing tests.** Each builds `LayerDoc`s from literal strings, runs merge and render, and asserts both the rendered text and the provenance:
  - `scalar override`: base `[decisions]\nmin_confidence = 0.3`, profile `[decisions]\nmin_confidence = 0.6`. Rendered text contains `min_confidence = 0.6` and not `0.3`. The entry's `layer.kind` is `"profile"`, and `shadowed` is `[{layer: base, valRaw: "0.3"}]`.
  - `table keys merge`: base has `[glossary.terms]\nCDR = "a"\nSLA = "b"`; profile has `[glossary.terms]\nSLA = "c"`. Rendered text contains `CDR = "a"` and `SLA = "c"`.
  - `section only in base is inherited`: base `[chatops]\nenabled = true`, profile with no `[chatops]` → rendered text contains `enabled = true`.
  - `copied profile does not duplicate arrays or fleet jobs`: identical base and profile text, each with two `[[filesystem.roots]]` blocks, one `[[security.allowlist]]` and two `[[fleet.job]]` named `a` and `b`. Rendered text has exactly two `[[filesystem.roots]]`, one `[[security.allowlist]]` and two `[[fleet.job]]`.
  - `array replaced whole`: base has two roots and profile has one → rendered text has one, with `blockLayer.kind === "profile"`.
  - `fleet merges by name`: base has jobs `a` (`interval_seconds = 60`) and `b`; profile has `a` (`interval_seconds = 120`) and `c`. Rendered job order is `a`(120), `b`, `c`.
  - `same-layer duplicate fleet name kept`: profile has two `[[fleet.job]]` blocks named `x` → both are rendered.
  - `passthrough preserved`: profile has `[glossary.terms]\nFOO = "unterminated` → rendered text contains that raw line.
  - `CRLF and quoted hash survive render`: base text uses `\r\n` and has `url = "http://h/#frag" # c`. Rendered text has no `\r` and contains `url = "http://h/#frag" # c`.
  - `root keys`: `schema_version = 1` before any header in base, `schema_version = 2` in profile → rendered text starts with `schema_version = 2`.
  - `malformed header does not swallow overrides`: base `[multimodal\nenabled = true\n[decisions]\nmin_confidence = 0.3`; profile `[decisions]\nmin_confidence = 0.6`.
    - In the rendered text, `[decisions]` with `0.6` appears **before** the raw `[multimodal` line.
    - `enabled = true` appears after `[multimodal`.
    - Running `loadNimbusDecisions`'s parser over the text gives `0.6`.
  - `unterminated quoted header is malformed, not passthrough`: `[hitl.quorum."x]` produces a section with `malformed` set.
- [ ] **Step 2: Run** `bun test packages/gateway/src/config/layered-merge.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `parseLayerDoc`, `mergeLayerDocs` and `renderEffectiveDoc` per the algorithm above.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(config): merge config layers with provenance`.

### Task 3: The reader, its registry and freshness

**Files:**
- Create: `packages/gateway/src/config/layered-config.ts`
- Test: `packages/gateway/src/config/layered-config.test.ts`

**Interfaces:**
- Consumes: Task 1 (`resolveActiveProfile`, `readProfileMarker`, `profileFilePath`, `ResolvedProfile`) and Task 2 (everything).
- Produces:
  - ```ts
    export type ConfigSnapshot = {
      readonly version: number;
      readonly layers: readonly { readonly layer: LayerRef; readonly exists: boolean }[];
      readonly doc: EffectiveDoc;
      readonly text: string | null;
    };
    ```
    `text` is `null` when no user layer file exists. Packs and team do not count toward that in PR 1.
  - `export interface PackLayerSource { list(profile: string): readonly { readonly id: string; readonly path: string }[] }`. PR 1 ships `EMPTY_PACK_LAYERS` (always `[]`), and PR 2 replaces it.
  - `export class LayeredConfig`, built by `new LayeredConfig({ configDir, profile: ResolvedProfile, packs?: PackLayerSource })`, with:
    - `readonly configDir: string`
    - `readonly profile: ResolvedProfile`
    - `snapshot(): ConfigSnapshot`: reads every layer file's bytes, and if any differs from the cached bytes (including a file appearing or disappearing) re-parses, re-merges and increments `version`; otherwise returns the cached snapshot.
    - `writeTargetPath(): string`: `profileFilePath(configDir, profile.name) ?? join(configDir, "nimbus.toml")`. For a non-default profile this is the profile file even if it does not exist yet.
    - `markerProfile(): string`: `readProfileMarker(configDir) ?? "default"`, read live.
    - `recordSectionFallback(header: string, message: string): void` and `sectionFallback(header: string): string | undefined`. Both are keyed to the current `version` and cleared when the version changes.
  - `export function initLayeredConfig(configDir: string, opts?: { explicitProfile?: string; packs?: PackLayerSource }): LayeredConfig`: resolves the profile once and registers a reader for `path.resolve(configDir)`. It throws if a reader is already registered for that dir with a **different** profile, and returns the existing reader if the profile is the same.
  - `export function getLayeredConfig(configDir: string): LayeredConfig`: returns the registered reader, or lazily runs `initLayeredConfig(configDir)` (for tests and tools that never booted).
  - `export function resetLayeredConfigsForTests(): void`
- **Freshness choice:** the plan compares file **contents** rather than the spec's `(size, mtimeMs, ctimeMs)` stat fingerprint. The cost is the same as today, because every per-call loader already reads the whole file. Content comparison has no same-tick blind spot, and no writer needs to invalidate the cache explicitly. Record this as an implementation note in the PR description.

- [ ] **Step 1: Write failing tests**, each in a fresh temp config dir, calling `resetLayeredConfigsForTests()` in `afterEach`:
  - `profile inherits base`: base `[decisions]\nmin_confidence = 0.3\n[chatops]\nenabled = true`, profile `work` with `[decisions]\nmin_confidence = 0.6`. The snapshot text contains `0.6` and `[chatops]`.
  - `profile without a file reads base and targets the profile file`: profile `work`, no `nimbus.work.toml`. The text equals the base render, and `writeTargetPath()` is `join(dir,"nimbus.work.toml")`.
  - `no files gives null text`: `snapshot().text === null`.
  - `same-size rewrite is seen without a restart`: write `min_confidence = 0.5`, call `snapshot()`, synchronously rewrite to `min_confidence = 0.8`, call `snapshot()` again. The new text contains `0.8`, and `version` went up by exactly 1.
  - `unchanged files keep the version`: two snapshots with no write in between have the same `version` and the same object.
  - `pinned profile ignores a later marker change`: init with marker `work`, then rewrite the marker to `home`. `profile.name` is still `work`, and `markerProfile()` is `home`.
  - `init twice with a different profile throws`.
  - `section fallback is cleared on change`: record a fallback for `decisions`, edit the file, take a snapshot → `sectionFallback("decisions")` is `undefined`.
- [ ] **Step 2: Run** `bun test packages/gateway/src/config/layered-config.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement** `layered-config.ts`. The layer list is pack layers from `packs.list(profile)` (`kind:"pack"`), then the team slot (none in PR 1), then `base`, then `profile` when the name is not `default`.
- [ ] **Step 4: Run** the tests. Expected: PASS.
- [ ] **Step 5: Commit** with `feat(config): layered config reader with live per-call freshness`.

### Task 4: Explain, environment overrides and policy notes

**Files:**
- Create: `packages/gateway/src/config/config-env-overrides.ts`, `packages/gateway/src/config/config-explain.ts`
- Test: `packages/gateway/src/config/config-env-overrides.test.ts`, `packages/gateway/src/config/config-explain.test.ts`

**Interfaces:**
- Consumes: Task 3 (`LayeredConfig`, `ConfigSnapshot`) and Task 2 types.
- Produces:
  - `export type EnvOverride = { readonly envVar: string; readonly path: string; readonly effective: (raw: string) => string | undefined }`. `effective` mirrors exactly what the loader does with that variable. It returns the TOML-formatted value the loader applies, or `undefined` when the loader ignores this value.
  - `export const CONFIG_ENV_OVERRIDES: readonly EnvOverride[]` with exactly these seven entries. Copy the conditions from the loaders named:

    | Variable | Path | Applied when (`effective` returns) | Loader |
    |---|---|---|---|
    | `NIMBUS_UPDATER_URL` | `updater.url` | non-empty → `"<raw>"` (quoted) | `nimbus-toml.ts:794` |
    | `NIMBUS_UPDATER_DISABLE` | `updater.enabled` | `=== "1"` → `false`, otherwise `undefined` | `:798` |
    | `NIMBUS_LAN_PORT` | `lan.port` | `parseInt` not NaN → that number | `:884` |
    | `NIMBUS_TELEMETRY_ENABLED` | `telemetry.enabled` | `1`/`true` → `true`, `0`/`false` → `false` (trimmed, case-insensitive), otherwise `undefined` | `telemetry-toml.ts:104` |
    | `NIMBUS_TELEMETRY_ENDPOINT` | `telemetry.endpoint` | trimmed non-empty → quoted | `:111` |
    | `NIMBUS_TELEMETRY_FLUSH_SECONDS` | `telemetry.flush_interval_seconds` | finite and `> 0` → clamped to `[60, 86400]` | `:115` |
    | `NIMBUS_NOTIFICATIONS` | `notifications.enabled` | `off`/`0`/`false` (case-insensitive) → `false`, otherwise `undefined` | `notifications-toml.ts` `notificationsDisabledByEnv` |

    Where a loader has a named predicate (`notificationsDisabledByEnv`), `effective` **calls** it rather than restating it.
  - `export function isPolicyConstrainedPath(path: string): boolean`. It is true for the exact set `audit.tool_call_log_retention_days`, `fleet.retention_days`, `code_execution.enabled`, `computer_use.enabled`, `tool_generation.enabled`, `multimodal.enabled`, `fleet.enabled` and `mcp_sink.enabled`, plus any path starting `hitl.quorum.` or `connectors.` (the policy connector allowlist).
    - **Verify each exact key against its loader before writing it.** The `[audit]` key is `tool_call_log_retention_days`, not `retention_days`, and `fleet.retention_days` is floored by `policyGate.enforced().retentionMinDays` at `assemble.ts:3279`.
  - ```ts
    export type ExplainSource =
      | { readonly kind: "layer"; readonly layer: LayerRef }
      | { readonly kind: "env"; readonly envVar: string };
    ```
  - ```ts
    export type ExplainEntry = {
      readonly path: string;
      readonly value: string;
      readonly source: ExplainSource;
      readonly shadowed: readonly { readonly source: ExplainSource; readonly value: string }[];
    };
    ```
  - ```ts
    export type ExplainResult = {
      readonly runningProfile: string;
      readonly markerProfile: string;
      readonly layers: readonly { readonly layer: LayerRef; readonly exists: boolean }[];
      readonly entries: readonly ExplainEntry[];
      readonly blocks?: readonly { readonly header: string; readonly layer: LayerRef; readonly entries: readonly ExplainEntry[] }[];
      readonly policyMayRestrict: boolean;
      readonly sectionFallback?: string;
      readonly notes: readonly string[];
    };
    ```
  - `export function explainConfig(reader: LayeredConfig, path: string | undefined, env?: (k: string) => string | undefined): ExplainResult`
- **Path resolution.** Split `path` on `.` **outside double quotes**, so `hitl.quorum."slack.post_message".approvers` gives three segments.
  - If `undefined`, return every effective entry **and every array block** in `blocks`, so `list --effective` shows `[[filesystem.roots]]` and `[[fleet.job]]`.
  - Root keys match a one-segment path.
  - Otherwise, the **longest** effective plain-section header that equals a prefix of the segments is the section, and the remaining segments joined with `.` are the key. This handles `connectors.github.depth`, `llm.remote.openai.enabled` and dotted keys.
  - Headers and path prefixes are compared **with double quotes removed from both**, so `hitl.quorum.slack.post_message.approvers` also resolves without shell-escaped quotes. If two headers tie after quote removal, the exact (quoted) match wins.
  - For array headers, `fleet.job.<name>` selects the block with that name, and `<header>` alone (e.g. `filesystem.roots`) returns every block in `blocks`.
  - When a `CONFIG_ENV_OVERRIDES` variable is set **and its `effective(raw)` is defined**, the entry's `source` becomes `env`, its `value` is `effective(raw)` (never the raw string), and the file value moves to the front of `shadowed`. When `effective` returns `undefined`, the file value stands and a note says `NIMBUS_X is set to "<raw>" but does not override this value`.
  - `sectionFallback` is filled by Task 5's `probeSection`; Task 4 leaves the field unset.
  - Add a `notes` line when the running profile differs from the marker: `profile switched to "<marker>" on disk; restart the gateway to apply`.
  - Add a `notes` line for an unknown path: `no layer sets <path>; the code default applies`.

- [ ] **Step 1: Write failing tests:**
  - `config-env-overrides.test.ts`:
    - `every NIMBUS_ variable a config loader names is declared`. It reads every non-test `.ts` under `packages/gateway/src/config/` plus `multimodal/multimodal-config.ts`, and collects **every string literal** matching `/["'`](NIMBUS_[A-Z0-9_]+)["'`]/`. That catches constants like `NOTIFICATIONS_ENV_VAR`, not only direct `processEnvGet("…")` calls. It excludes `NIMBUS_PROFILE` and expects the set to equal the `envVar` set of `CONFIG_ENV_OVERRIDES`.
    - `effective mirrors the loaders`: for each entry, a table of raw values, each with the loader's actual result. For example:
      - `NIMBUS_UPDATER_DISABLE=0` → `undefined`, and `parseNimbusUpdaterToml("")` keeps `enabled` at its default
      - `NIMBUS_NOTIFICATIONS=on` → `undefined`
      - `NIMBUS_TELEMETRY_FLUSH_SECONDS=10` → `60`

      Each case asserts both the `effective` result and the loader's own output, so the two cannot drift.
  - `config-explain.test.ts`:
    - `names the winning layer and the shadowed value`: base 0.3, profile 0.6 for `decisions.min_confidence` → `source.layer.kind === "profile"`, `shadowed[0].value === "0.3"`
    - `multi-segment table path`: `connectors.github.depth`
    - `fleet job by name`: `fleet.job.a` → one block, `layer.kind` set
    - `env override is the top source`: env `NIMBUS_LAN_PORT=9999` plus file `[lan]\nport = 7475` → `source.kind === "env"`, `value === "9999"`, `shadowed[0].value === "7475"`
    - `ignored env value is not a source`: `NIMBUS_UPDATER_DISABLE=0` plus file `[updater]\nenabled = true` → `source.kind === "layer"`, plus the "does not override" note
    - `policy flag`: `audit.tool_call_log_retention_days`, `fleet.retention_days` and `hitl.quorum."x".approvers` → `policyMayRestrict === true`; `decisions.min_confidence` → `false`
    - `quoted sub-table path`: header `[hitl.quorum."slack.post_message"]` with `approvers = 2` resolves from both `hitl.quorum."slack.post_message".approvers` and `hitl.quorum.slack.post_message.approvers`
    - `no path lists blocks`: two `[[filesystem.roots]]` → `blocks.length === 2`
    - `marker differs note`
    - `unknown path note`
- [ ] **Step 2: Run** both test files. Expected: FAIL.
- [ ] **Step 3: Implement** both modules.
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(config): config explain over the layered reader`.

### Task 5: Every `…FromConfigDir` loader reads the reader

**Files:**
- Modify:
  - `packages/gateway/src/config/nimbus-toml.ts`: every `load*FromConfigDir`, plus `loadTomlSection`
  - `config/nimbus-toml-connectors.ts`
  - `config/nimbus-toml-workday.ts`
  - `config/nimbus-toml-glossary-terms.ts`
  - `config/filesystem-toml.ts`
  - `config/service-config-toml.ts`
  - `config/session-toml.ts`
  - `multimodal/multimodal-config.ts`
  - `config/fleet-toml.ts`, `config/notifications-toml.ts`, `config/mcp-sink-toml.ts`, `config/telemetry-toml.ts`, `config/oncall-push-toml.ts`: each gains a new `…FromConfigDir`
  - `platform/assemble.ts`: `loadOpenapiConfig`
  - `config/config-explain.ts`: `probeSection`
- Test: `packages/gateway/test/integration/config/profile-inheritance.test.ts` (new), `packages/gateway/src/config/config-explain.test.ts` (extend)

**Interfaces:**
- Consumes: `getLayeredConfig` (Task 3).
- **Section ids are unbracketed** (`"audit"`, `"hitl.quorum"`), matching `DocSection.header` and `sectionFallback`. Any helper that needs the bracketed form builds it internally.
- **One text core per loader, shared by both doors.** Each loader's existing `…FromPath` body is split into a `…FromText(text: string | null, …)` core. `null` means "no file". The core keeps **exactly** what the `FromPath` does today on a missing file and on a parse error. `…FromPath(p)` then becomes `…FromText(existsSync(p) ? readFileSync(p,"utf8") : null)`, and `…FromConfigDir(dir)` becomes `…FromText(getLayeredConfig(dir).snapshot().text)`. The two cannot diverge, because there is one body. This replaces a generic `loadTomlSectionFromConfig` for every loader whose `FromPath` does anything beyond defaults-on-error. Cases this covers, each with a test asserting the `FromConfigDir` result equals the `FromPath` result for the same text:
  - `[fleet]` still **throws `FleetConfigError`**, which `assembleFleetRuntime` catches to refuse every job.
  - `[notifications]` still throws `NotificationsConfigError`, and on `null` still parses `""`, so `NIMBUS_NOTIFICATIONS=off` applies with no file.
  - `[mcp_sink]` still returns `McpSinkConfigLoad` (`{ok:false, error}` on `McpSinkConfigError`).
  - `[telemetry]` and `[updater]` still apply their env overrides on `null`.
  - `[pagerduty]` still writes its stderr warning on a parse error.
  - The glossary manual reader still returns `{loaded:false}` on `null` or a throw.
- **New `…FromConfigDir` functions** (they do not exist today):
  - `loadNimbusFleetFromConfigDir`, `loadNimbusNotificationsFromConfigDir(configDir, envGet?)`, `loadNimbusMcpSinkFromConfigDir`, `loadNimbusTelemetryFromConfigDir`, `loadNimbusOncallPushFromConfigDir`
  - in `nimbus-toml.ts`: `loadNimbusBriefsFromConfigDir`, `loadNimbusPersonaFromConfigDir`, `loadNimbusAgentsFromConfigDir`

  Delete the comment in `fleet-toml.ts:313-330` that says a `FromConfigDir` variant is deliberately not provided: the reason it gives (profile blindness) no longer exists.
- **Recording fallbacks.** Every core's catch that swallows, logs or converts an error calls `getLayeredConfig(dir).recordSectionFallback("<section>", message)` when it was reached through `FromConfigDir`. Pass an optional `onFallback?: (message: string) => void` into the core; `FromPath` passes none. A core that rethrows records first and then rethrows.
- **`probeSection(reader: LayeredConfig, sectionId: string): string | undefined`** in `config-explain.ts` makes `sectionFallback` deterministic right after an edit:
  - It runs the section's own `…FromConfigDir` loader, from a `SECTION_LOADERS: Readonly<Record<string, (configDir: string) => unknown>>` map in the same file.
  - It catches a throw as `refused: <message>`.
  - It then returns `reader.sectionFallback(sectionId)`.
  - `explainConfig` calls it for the section of the queried path.
  - A test asserts that `SECTION_LOADERS` has a key for every section id passed to `onFallback` anywhere in `config/`. It greps the call sites' literal ids.
- Every existing `load*FromConfigDir(configDir)` keeps its **name and signature**, so its ~40 call sites do not change.
- `loadTomlSection`'s simple cases (defaults on missing or throw) may use a small `loadTomlSectionFromConfig(configDir, sectionId, fallback, parse)` helper. It is exported from `nimbus-toml.ts`, records the fallback, and is equivalent to a core whose only behaviour is defaults.
- `load*FromPath` functions stay as single-file readers for tests. Task 9's static rule forbids production calls to them.
- Loaders with no production caller (`loadNimbusEmbeddingFromConfigDir`, `loadNimbusVoiceFromConfigDir`, the session/negotiate wrappers, `loadNimbusDoraFromConfigDir`) are converted the same way, not deleted.

- [ ] **Step 1: Write the failing integration test** `profile-inheritance.test.ts`. It uses a real temp config dir, `initLayeredConfig(dir, { explicitProfile: "work" })`, and `resetLayeredConfigsForTests()` in `afterEach`.
  - **Base `nimbus.toml`** sets a non-default value in every section that used to be profile-blind:
    - `[decisions]`, `[glossary]`, `[glossary.terms]`
    - `[user]`, `[chatops]`, `[federation]`, `[lan]`
    - `[connectors.github]`, `[[filesystem.roots]]`, `[workday]` with `[[connectors.workday.reports]]`
    - `[metrics.dora.svc]`, `[multimodal]`, `[openapi]`
  - **`nimbus.work.toml`** overrides only `[decisions] min_confidence` and adds one `[glossary.terms]` entry.
  - **Assertions:**
    - each section's loader returns the base value
    - `loadNimbusDecisionsFromConfigDir(dir).minConfidence` is the profile's value
    - the glossary manual terms contain both the base term and the profile's term
  - Test `no files yields defaults and glossary loaded:false`: an empty dir → `loadNimbusDecisionsFromConfigDir` deep-equals `DEFAULT_NIMBUS_DECISIONS_TOML`, and `loadGlossaryManualFromConfigDir(dir)` is `{ loaded: false }`.
  - Test `swallowed parse error is recorded`: `[audit]` with a value that today makes its parser throw (use the range error at `nimbus-toml.ts:1400`) → the loader returns defaults, and `getLayeredConfig(dir).sectionFallback("audit")` is defined.
  - Test `door parity`: for fleet (a duplicate job name → both doors throw `FleetConfigError`), notifications (`content = "bogus"` → both throw; no file plus env `off` → both return `enabled:false`), mcp_sink (bad value → both return `ok:false`) and telemetry (no file plus `NIMBUS_TELEMETRY_ENABLED=1` → both `enabled:true`), the `FromConfigDir` result or throw equals the `FromPath` one.
  - Test (in `config-explain.test.ts`) `fallback is reported right after an edit`: write a bad `[audit]` value and call `explainConfig(reader, "audit.tool_call_log_retention_days")` **without** calling the loader first → `sectionFallback` is defined.
- [ ] **Step 2: Run** `bun test packages/gateway/test/integration/config/profile-inheritance.test.ts`. Expected: FAIL (the base values are read, but the profile override and term union are missing; the fallback is not recorded).
- [ ] **Step 3: Convert the loaders** as described in Interfaces.
- [ ] **Step 4: Run** the new test, then `bun test packages/gateway/src/config packages/gateway/src/multimodal`. All PASS. Fix existing tests that relied on reading `nimbus.toml` from a reused dir across cases by adding `resetLayeredConfigsForTests()`; do not change their assertions.
- [ ] **Step 5: Commit** with `refactor(config): every config-dir loader reads the layered snapshot`.

### Task 6: Production callers, boot pinning and the gateway writer

**Files:**
- Modify:
  - `packages/gateway/src/platform/assemble.ts`: the `activeTomlPath` block near line 3417, and the `…FromPath` calls at ~529, 1903, 3257/3264, 3448, 3451, 3515 and 3884
  - `telemetry/flush-scheduler.ts`
  - `platform/notifications/notifications-runtime.ts`
  - `oncall-push/push-runtime.ts`
  - `config/persona.ts`
  - `agents/_lib/agent-synthesis-runner.ts`
  - `ipc/server/dispatchers.ts` (~line 165)
  - `config/nimbus-toml.ts`: delete `resolveNimbusTomlForProfile`
- Test: extend `packages/gateway/src/ipc/llm-rpc.test.ts` (or its existing equivalent)

**Interfaces:**
- Consumes: `initLayeredConfig`, `getLayeredConfig`, `LayeredConfig.writeTargetPath()`.
- Each `…FromPath` production caller switches to the matching `…FromConfigDir(configDir)`. Where a dependency object carries `tomlPath: string` only for config reads (flush scheduler, notifications runtime, push runtime, persona, synthesis runner), replace that field with `configDir: string`.
- `assemble.ts` calls `initLayeredConfig(paths.configDir)` **before the first config read** and logs `config: profile "<name>" (from <source>)` at info. An `InvalidProfileNameError` propagates and stops boot, with the message naming the value and the source.
- `dispatchers.ts` passes `tomlPath: getLayeredConfig(configDir).writeTargetPath()` to `dispatchLlmRpc`, so `llm.use` writes the profile file, creating it if needed.

- [ ] **Step 1: Write failing tests:**
  - In the llm-rpc test file, `llm.use writes the active profile file and the next read sees it`. Init a reader with profile `work` and no `nimbus.work.toml`, call `llm.use` through the dispatcher, and assert that `nimbus.work.toml` now exists with the `[llm.tasks]` pin, that `nimbus.toml` is unchanged (compare bytes), and that `getLayeredConfig(dir).snapshot().text` contains the pin.
  - A test in `packages/gateway/src/config/active-profile.test.ts`: `resolveNimbusTomlForProfile is gone`. It reads `nimbus-toml.ts`'s source and expects it not to contain `resolveNimbusTomlForProfile`.
- [ ] **Step 2: Run both.** Expected: FAIL.
- [ ] **Step 3: Implement** the caller switches, boot pinning and writer target. Delete `resolveNimbusTomlForProfile`, and update its imports (grep the whole repo, including `packages/gateway/test/`).
- [ ] **Step 4: Run** `bun run typecheck`, `bun run typecheck:tests`, and `bun test packages/gateway/src/platform packages/gateway/src/telemetry packages/gateway/src/oncall-push packages/gateway/src/ipc/server packages/gateway/src/agents/_lib`. All PASS.
- [ ] **Step 5: Commit** with `refactor(gateway): read config by config dir; pin the profile at boot`.

### Task 7: IPC: `config.explain`, `config.validate` and `diag.snapshot`

**Files:**
- Modify:
  - `packages/gateway/src/ipc/diagnostics-rpc.ts`: add `config.explain`, rewrite `rpcConfigValidate`, add `configLayers` to `rpcDiagSnapshot`
  - `packages/gateway/src/ipc/lan-rpc.ts`: add `"config.explain"` to `FORBIDDEN_OVER_LAN`
  - `packages/gateway/test/e2e/_fixtures/real-gateway-client.ts`: give `startRealGateway` an optional `opts?: { configFiles?: Record<string, string>; env?: Record<string, string> }`, writing each file into `paths.configDir` and merging `env` into the child env
- Test: `packages/gateway/src/ipc/diagnostics-rpc.test.ts` (extend), `packages/gateway/src/ipc/lan-rpc.test.ts` (extend), `packages/gateway/test/e2e/config-explain.e2e.test.ts` (new)

**Interfaces:**
- Consumes: `explainConfig`, `getLayeredConfig`, `parseLayerDoc`.
- `config.explain` params are `{ path?: string }`. A non-string `path` is a `-32602` error. The result is the `ExplainResult` from Task 4. The method is already routed, because `tryDispatchDiagnosticsRpc` matches the `config.` prefix. The e2e test proves that.
- `config.validate` returns the same `{ ok, errors, warnings }` shape:
  - for each **existing** user-layer file, the `schema_version` warning now names the file
  - an active profile with no file is **neither a warning nor an error**. Every `config.validate` warning makes `nimbus doctor` exit 1 (`doctor-core.ts` `doctorPrintConfigValidation`), and running on base settings alone is a legitimate state. It is reported in `diag.snapshot.configLayers` instead (the profile layer has `exists: false`), and doctor prints it as an info line.
  - no user layer file at all keeps today's `ok:false` / `"nimbus.toml not found"`
- `diag.snapshot` gains:
  ```ts
  configLayers: {
    runningProfile: string;
    markerProfile: string;
    layers: { kind: LayerKind; id: string; path: string; exists: boolean }[];
    activePacks: string[];
    skippedPacks: { packId: string; reason: string }[];
    droppedFleetJobs: { name: string; file: string; reason: string }[];
  }
  ```
  In PR 1, `activePacks`, `skippedPacks` and `droppedFleetJobs` are always `[]`.

- [ ] **Step 1: Write failing tests:**
  - Unit `config.explain returns the profile layer`.
  - Unit `config.explain rejects a non-string path` (code `-32602`).
  - Unit `config.validate names the profile file in its warning`.
  - Unit `config.validate is clean for an active profile with no file` (base has `schema_version`, profile `work` has no file → `warnings` is empty).
  - Unit `diag.snapshot carries configLayers`, with `runningProfile` and `markerProfile` asserted.
  - lan-rpc `config.explain is LAN-forbidden`, plus `config.validate is still LAN-callable` (unchanged).
  - e2e `config.explain over a real socket`: `startRealGateway("config-explain", { configFiles: { "nimbus.toml": "[decisions]\nmin_confidence = 0.3\n", "nimbus.work.toml": "[decisions]\nmin_confidence = 0.6\n" }, env: { NIMBUS_PROFILE: "work" } })`, then `client.call("config.explain", { path: "decisions.min_confidence" })`. Expect `entries[0].value === "0.6"` and `runningProfile === "work"`.
- [ ] **Step 2: Run** the unit files and `bun test packages/gateway/test/e2e/config-explain.e2e.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run.** Expected: PASS.
- [ ] **Step 5: Commit** with `feat(ipc): config.explain, layered config.validate and diag.snapshot configLayers`.

### Task 8: CLI: profile-aware `nimbus config`, `--effective`, `explain` and doctor

**Files:**
- Create: `packages/cli/src/lib/active-profile.ts`
- Modify:
  - `packages/cli/src/commands/config.ts`: the target path, `--effective`, the `explain` subcommand, help text
  - `packages/cli/src/commands/profile.ts`: reuse `readProfileMarker` from the new lib
  - `packages/cli/src/commands/doctor-core.ts`: `doctorRunGatewayRpcs` already calls `diag.snapshot`, so read its **optional** `configLayers`. An older gateway omits the field, and doctor stays silent. Add the mismatch `[warn]` line and the "profile has no file" info line. Tests go in `packages/cli/src/commands/doctor.test.ts`.
  - `packages/cli/src/commands/help.ts` if the `config` usage line lists subcommands
- Test:
  - `packages/cli/src/lib/active-profile.test.ts` (new)
  - `packages/cli/src/commands/config.test.ts` (extend)
  - `packages/gateway/src/config/profiles-cli-parity.test.ts` (extend)

**Interfaces:**
- Produces, in `cli/src/lib/active-profile.ts` (the CLI cannot import the gateway):
  - `export const PROFILE_NAME_RE = /^[a-z0-9_-]{1,32}$/i`
  - `export function resolveCliActiveProfile(configDir: string, env?: (k: string) => string | undefined): string`. Order: env, then marker, then `"default"`. An invalid name throws `Error` naming the value.
  - `export function cliWriteTargetPath(configDir: string): string`, with the same rule as `LayeredConfig.writeTargetPath()`.
- `runConfig` behaviour:
  - `set`, `get`, `list` and `edit` use `cliWriteTargetPath`.
  - `set` creates the profile file if it is missing. Its confirmation line names the file.
  - `get --effective <path>` and `list --effective [--json]` call `config.explain` through `withGatewayIpc`. With no gateway running they print `the effective view needs a running gateway — start it with \`nimbus start\`` and exit 1.
  - `explain <path> [--json]` calls `config.explain`. It prints the value and its source (`profile work (…/nimbus.work.toml)`, `env NIMBUS_LAN_PORT`, …), each shadowed value, `org policy may further restrict this` when flagged, the section-fallback line, and the `notes`.
  - `--effective` and `explain` accept multi-segment paths, while plain `get` and `set` keep `refuseNestedKey`.
- `nimbus doctor` prints `[warn] profile: marker says "<m>" but the gateway runs "<r>" — restart to apply` when the two differ. It prints `[info] profile "<p>" has no nimbus.<p>.toml; running on nimbus.toml alone` when the profile layer does not exist. The info line does not change the exit code.

- [ ] **Step 1: Write failing tests:**
  - `active-profile.test.ts`: the CLI copies of the Task 1 order and slug cases, run against a temp dir.
  - `config.test.ts`:
    - `set writes the active profile file`: marker `work`, `set decisions.min_confidence 0.6` → `nimbus.work.toml` contains it, and `nimbus.toml`'s bytes are unchanged.
    - `explain renders source and shadowed`: inject a fake IPC client returning a fixed `ExplainResult`, and assert the printed lines.
    - `--effective without a gateway explains itself`: the `withGatewayIpc` fake throws its no-gateway error, and the message above is printed.
    - `plain get still refuses nested keys`.
  - Parity test: both `config/active-profile.ts` and `cli/src/lib/active-profile.ts` contain `/^[a-z0-9_-]{1,32}$/i`.
- [ ] **Step 2: Run** `bun test packages/cli/src/lib/active-profile.test.ts packages/cli/src/commands/config.test.ts packages/gateway/src/config/profiles-cli-parity.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.** Use DI for the IPC client and the spawn function, matching `runConfigEdit`'s existing `spawnFn` seam, not `mock.module`.
- [ ] **Step 4: Run.** Expected: PASS. Then run `bun test packages/cli/src/commands`.
- [ ] **Step 5: Commit** with `feat(cli): profile-aware nimbus config, --effective and explain`.

### Task 9: Static rule D35, docs and release note

**Files:**
- Modify:
  - `scripts/structure-audit/check-nimbus-invariants.ts`: new `checkConfigReaderConfinement`, wired where the other `check*` functions are aggregated
  - `scripts/structure-audit/check-nimbus-invariants.test.ts`
  - `docs/architecture.md`: the IPC catalogue (`config.explain`, the `diag.snapshot.configLayers` field) and a short "Layered config" paragraph under config
  - `docs/cli-reference.md`: `nimbus config explain`, `--effective`, the profile file target, and profile inheritance
  - `docs/CHANGELOG.md`: a dated entry with the **behaviour change** sentence
  - `CLAUDE.md` and `GEMINI.md`: one clause adding D35 to the static-complement paragraph
  - any page under `packages/docs/` that describes profiles as replacing `nimbus.toml` (find them with `grep -rn "nimbus\.\(<\|\w\+\)\.toml\|profile" packages/docs/src`)
- Test: `scripts/structure-audit/check-nimbus-invariants.test.ts`

**Interfaces:**
- **D35 (`config-reader-confined`)** applies to non-test files under `packages/gateway/src/`, with comments stripped. It raises a violation for:
  - **(a)** **building a path** to the file: a `join(`/`resolve(` call whose argument list contains the literal, matched per occurrence by `/\b(?:join|resolve)\s*\([^()]*["'`]nimbus\.toml["'`]/`. This applies everywhere except `config/layered-config.ts`, `config/active-profile.ts` and `demo/seed.ts`. A bare literal is **not** a violation: there are ~6 production prose strings that say `` `nimbus.toml` `` to users (`agents/_lib/brief-disclosures.ts`, `agents/changelog.ts`, `glossary/*`), plus `profiles.ts`'s `n !== "nimbus.toml"` list filter, and none of those reads a file.
  - **(b)** any `\bresolveNimbusTomlForProfile\b`
  - **(c)** a **call** matching `/(?<!function\s)\bload\w+FromPath\s*\(/` outside `packages/gateway/src/config/`

  It is tied to no invariant, like D24/D30/D31. Stated bound: a dynamically composed path or file name evades it.
- **CHANGELOG sentence** (exact): "Profiles now inherit from `nimbus.toml`: a profile file overrides only the keys it sets, and a section it leaves out now comes from `nimbus.toml` rather than from built-in defaults. Previously about two-thirds of settings ignored the active profile entirely; every setting now follows it."
- No `!` in the PR title. No user action is required, because existing profiles are copies of `nimbus.toml` (CLAUDE.md § "A `!` means a USER must act").

- [ ] **Step 1: Write failing rule tests:**
  - `D35 flags a nimbus.toml literal outside the reader`, with a fixture at `packages/gateway/src/ipc/x.ts` containing `join(d, "nimbus.toml")` → 1 violation
  - `D35 allows the reader`, with the same text at `config/layered-config.ts` → 0
  - `D35 flags a FromPath call in production`: `loadNimbusFleetFromPath(p)` in `platform/assemble.ts` → 1
  - `D35 ignores the definition`: `export function loadNimbusFleetFromPath(p: string)` in `config/fleet-toml.ts` → 0
  - `D35 ignores nimbus.openapi.toml`
  - `D35 ignores prose`: `"Edit \`[ci.service.<id>]\` in \`nimbus.toml\`"` in `agents/x.ts` → 0, and `n !== "nimbus.toml"` → 0
  - `D35 catches resolve()`: `resolve(dir, "nimbus.toml")` → 1
  - `D35 is green on the repo`: run the real repo scan and expect zero D35 violations
- [ ] **Step 2: Run** `bun test scripts/structure-audit/check-nimbus-invariants.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement the rule.** Follow `checkMigrationConfinement`'s shape (`stripComments`, `push(rule, …)`).
- [ ] **Step 4: Update the docs** listed above. Then run `bun run audit:doc-refs` and `bun run audit:status-drift`, and fix what they report.
- [ ] **Step 5: Run** `bun test scripts/structure-audit` and `bun run preflight:fast`. All PASS.
- [ ] **Step 6: Commit** with `chore(audit): D35 confines config reads to the layered reader; docs`.

### Task 10: Full verification and PR

- [ ] **Step 1:** Run `bun run preflight`. All gates must be green. Run `bun run audit:platform-test-gaps` and note any test that cannot run on Windows.
- [ ] **Step 2:** Run `bun run verify:docker --changed` to reproduce the Linux leg for the touched tests.
- [ ] **Step 3:** Confirm that `git diff origin/main --stat -- docs/superpowers` is empty. The design docs live only on `dev/asaf/role-packs`.
- [ ] **Step 4:** Push and open the PR. The title is `feat(config): layered config reader; profiles inherit from nimbus.toml`. The body states:
  - the behaviour change
  - the content-comparison freshness choice (and why it differs from the spec's stat fingerprint)
  - D35
  - that PR 2–5 follow

  It ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- [ ] **Step 5:** Watch CI to green (`bun run verify:pr`). Merging is the owner's call.
