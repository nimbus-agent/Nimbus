# Review: Role Packs P1 — PR 1 (Layered Config Reader & Provenance)

**Reviewed plan:** `docs/superpowers/plans/2026-10-22-role-packs-p1-pr1-layered-reader.md`
**Parent spec:** `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md`
**Date:** 2026-10-22

---

## Executive Summary

The overall architecture of PR 1 — synthesizing a single merged TOML document from `[pack?, base, profile?, local?]` and feeding existing section parsers through a cached `LayeredConfigReader` — is clean, surgical, and preserves parser behavior across ~25 config sections without rewriting them.

However, cross-checking the plan task-by-task against the live codebase surfaced **4 blocking implementation gaps**, **5 behavioral / edge-case questions**, and **4 concrete refinements** that should be resolved before or during execution so the steps compile cleanly and pass all gates (`test`, `typecheck`, `check-nimbus-invariants`).

---

## 1. Blocking Gaps (Must Fix in Plan / Implementation)

### 1.1 Missing `*FromConfigDir` loaders in Tasks 5 & 6 (8 functions across 6 files)

Task 6 states:
> *"Each `…FromPath` production caller switches to the matching `…FromConfigDir(configDir)`."*

However, **8 of the `*FromPath` loaders converted in Task 6 do not currently have a `*FromConfigDir` counterpart at all**, and 5 of their defining files are not listed in Task 5's `Files: Modify`:

| Config Module | Existing `*FromPath` Loader | Missing `*FromConfigDir` Needed by Task 6 | Caller in Task 6 |
|---|---|---|---|
| `config/fleet-toml.ts` | `loadNimbusFleetFromPath` | `loadNimbusFleetFromConfigDir` | `platform/assemble.ts:3263` |
| `config/notifications-toml.ts` | `loadNimbusNotificationsFromPath` | `loadNimbusNotificationsFromConfigDir` | `platform/notifications/notifications-runtime.ts:169` |
| `config/mcp-sink-toml.ts` | `loadNimbusMcpSinkFromPath` | `loadNimbusMcpSinkFromConfigDir` | `platform/assemble.ts:3310` |
| `config/telemetry-toml.ts` | `loadNimbusTelemetryFromPath` | `loadNimbusTelemetryFromConfigDir` | `telemetry/flush-scheduler.ts:192`, `ipc/server/dispatchers.ts:819` |
| `config/oncall-push-toml.ts` | `loadNimbusOncallPushFromPath` | `loadNimbusOncallPushFromConfigDir` | `oncall-push/push-runtime.ts:520` |
| `config/nimbus-toml.ts` | `loadNimbusBriefsFromPath` (L2183)<br>`loadNimbusPersonaFromPath` (L2774)<br>`loadNimbusAgentsFromPath` (L2792) | `loadNimbusBriefsFromConfigDir`<br>`loadNimbusPersonaFromConfigDir`<br>`loadNimbusAgentsFromConfigDir` | `agents/_lib/agent-synthesis-runner.ts:91,96`<br>`platform/assemble.ts:2715,3825,3831` |

**Important error-handling subtlety when adding these in Task 5:**
Do **not** route all of these blindly through `loadTomlSectionFromConfig` (which catches parse errors and returns fallback defaults):
1. **`loadNimbusFleetFromConfigDir` (`fleet-toml.ts:321`):** Must still **throw `FleetConfigError`** when `parseNimbusTomlFleet(text)` fails so `assembleFleetRuntime` (`assemble.ts:3264-3273`) catches it, logs `[fleet] config error — refusing to start any job`, and sets `configError = true` (rather than silently returning `{ enabled: false, jobs: [] }`).
2. **`loadNimbusNotificationsFromConfigDir` (`notifications-toml.ts:192`):**
   - Must still **throw `NotificationsConfigError`** on invalid `content` so `createNotificationsRuntime` (`notifications-runtime.ts:168-185`) fails closed with `disabledBy: "config_error"` (defaulting to `content = "full"` would leak notification bodies on a locked screen).
   - When `text === null`, it must still call `parseNimbusTomlNotifications("", envGet)` so `NIMBUS_NOTIFICATIONS=off` takes effect even without a `nimbus.toml` file.
3. **`loadNimbusMcpSinkFromConfigDir` (`mcp-sink-toml.ts:191`):** Must return `McpSinkConfigLoad` (`{ ok: true, config } | { ok: false, error }`), catching `McpSinkConfigError` rather than returning a default config.
4. **`loadNimbusTelemetryFromConfigDir` (`telemetry-toml.ts:207`) & `loadNimbusUpdaterFromConfigDir` (`nimbus-toml.ts:1475`):** When `text === null` (no layer files exist), both must still apply their `processEnvGet` overrides (`applyTelemetryEnvOverrides({...}, envGet)` and `parseNimbusUpdaterToml("")`).
5. **`loadNimbusPagerdutyFromConfigDir` (`nimbus-toml.ts:1577`):** Currently logs `[pagerduty] invalid [pagerduty] in nimbus.toml — using defaults: …` to `process.stderr` on parse error rather than silently swallowing.

---

### 1.2 Task 9 Invariant D35 Regex False Positives on Prose & `config/profiles.ts`

Task 9 specifies D35 as flagging:
> - *the literal `/["'`]nimbus\.toml["'`]/` anywhere except `config/layered-config.ts`, `config/active-profile.ts` and `demo/seed.ts`*

Running this regex against `packages/gateway/src` and `packages/cli/src` reveals two issues:

1. **Backtick-quoted `` `nimbus.toml` `` inside user-facing prose strings:**
   Because the character class `["'`]` includes backtick (`` ` ``), any double-quoted string containing `` "`nimbus.toml`" `` matches `/["'`]nimbus\.toml["'`]/`! There are currently **6 production files** with backtick-wrapped `` `nimbus.toml` `` in user-facing markdown/remediation prose:
   - `packages/gateway/src/agents/brief-disclosures.ts:331` (`"- _Authored in \`nimbus.toml\`; verify against live roster._"`)
   - `packages/gateway/src/glossary/changelog.ts:120` (`"No glossary changelog entries yet. Edit \`[[glossary.terms]]\` in \`nimbus.toml\` and restart the gateway."`)
   - `packages/gateway/src/glossary/ownership.ts:109` (`"Each lacks \`owner\` on its \`[[glossary.terms]]\` entry in \`nimbus.toml\`."`)
   - `packages/gateway/src/glossary/render.ts:1001` (`"_Owned terms declared in \`nimbus.toml\` whose \`owner\` could not be resolved..._"`)
   - `packages/cli/src/commands/config.ts:452,487`
   - `packages/cli/src/commands/profile.ts:76`
2. **Exact string literal `"nimbus.toml"` in `packages/gateway/src/config/profiles.ts:39`:**
   - `ProfileManager.list()` has `if (n.startsWith(PROFILE_PREFIX) && n.endsWith(PROFILE_SUFFIX) && n !== "nimbus.toml")` to exclude `nimbus.toml` when scanning `configDir` for `nimbus.<name>.toml`.

**Recommendation:**
- Change the D35 regex to match **string literals whose entire content is `nimbus.toml` or ends in `/nimbus.toml`** (or require the opening and closing quote to match and not be nested inside a larger prose string, e.g. `/(?:^|[^\w\\])(["'`])nimbus\.toml\1/`), **or** remove `` ` `` from the delimiter set if template literals without interpolation aren't used for filenames.
- Either exempt `packages/gateway/src/config/profiles.ts` in D35 alongside `active-profile.ts` / `layered-config.ts`, or export `BASE_CONFIG_FILENAME = "nimbus.toml"` from `layered-config.ts` and import that constant in `profiles.ts` and `diagnostics-rpc.ts`.

---

### 1.3 `POLICY_CONSTRAINED_PATHS` Key Naming & Dynamic Sub-tables (Task 4)

In Task 4:
1. **Key name mismatch in test vs. loader:**
   - Task 4's test (line 251) asserts `` `audit.retention_days` → `policyMayRestrict === true` ``.
   - In `packages/gateway/src/config/nimbus-toml.ts:1408`, the `[audit]` TOML key is actually **`audit.tool_call_log_retention_days`**, not `audit.retention_days`.
   - Meanwhile, `[fleet]` *does* have **`fleet.retention_days`** (`fleet-toml.ts:206`), which `assemble.ts:3277` also floors with `policyGate.enforced().retentionMinDays`! Both `audit.tool_call_log_retention_days` and `fleet.retention_days` should be marked policy-constrained.
2. **Dynamic sub-tables under `[hitl.quorum."<action>"]` and `[connectors.<id>]`:**
   - `LocalBaseline` in `policy/policy-gate.ts` enforces quorum floors (`hitl.quorum.<action>.approvers`, `hitl.quorum.<action>.window_seconds`) and connector allowlists (`connectors.<id>.*`).
   - Because `<action>` and `<id>` are user-chosen sub-table keys, `POLICY_CONSTRAINED_PATHS` cannot be checked via `Set.has(path)` alone.
   - **Suggestion:** Support prefix/pattern matching in `isPolicyConstrainedPath(path)` (e.g. exact set `{ "audit.tool_call_log_retention_days", "fleet.retention_days", "code_execution.enabled", "computer_use.enabled", "tool_generation.enabled", "multimodal.enabled", "fleet.enabled", "mcp_sink.enabled" }` plus prefix match `path.startsWith("hitl.quorum.")`).

---

### 1.4 `NIMBUS_NOTIFICATIONS` Missing from `CONFIG_ENV_OVERRIDES` (Task 4)

Task 4 lists 6 entries in `CONFIG_ENV_OVERRIDES` and proposes a drift test that scans `packages/gateway/src/config/*.ts` for `processEnvGet("NIMBUS_…")`.
- However, `packages/gateway/src/config/notifications-toml.ts:55` defines:
  ```ts
  export const NOTIFICATIONS_ENV_VAR = "NIMBUS_NOTIFICATIONS";
  ```
  and reads `envGet(NOTIFICATIONS_ENV_VAR)` (where `envGet` defaults to `processEnvGet`)!
- Because it passes the constant `NOTIFICATIONS_ENV_VAR` instead of a string literal directly to `processEnvGet(...)`, a regex scanning only `processEnvGet\("NIMBUS_..."\)` will miss it.
- **Fixes needed:**
  1. Add `{ envVar: "NIMBUS_NOTIFICATIONS", path: "notifications.enabled" }` as the 7th entry in `CONFIG_ENV_OVERRIDES` (or explicitly document why it's excluded).
  2. In the drift test, scan `packages/gateway/src/config/*.ts` for **any string literal `/["']NIMBUS_[A-Z0-9_]+["']/`** rather than only `processEnvGet("NIMBUS_…")` calls, so constants like `NOTIFICATIONS_ENV_VAR` are caught automatically.
  3. **Value-conditional env overrides (Anti-Goal #4 compliance):**
     - `NIMBUS_UPDATER_DISABLE` only overrides `updater.enabled` when its value is `"1"` (`nimbus-toml.ts:798`), and sets `updater.enabled` to `"false"` (not `"1"`). Setting `NIMBUS_UPDATER_DISABLE=0` does **not** override the file!
     - `NIMBUS_NOTIFICATIONS` only overrides `notifications.enabled` to `"false"` when its value is `"off"`, `"0"`, or `"false"` (`notifications-toml.ts:165`). Setting `NIMBUS_NOTIFICATIONS=on` does **not** override `enabled = false` in the file!
     - `NIMBUS_TELEMETRY_ENABLED` only overrides when its value is `"1"`, `"true"`, `"0"`, or `"false"` (`telemetry-toml.ts:183`).
     - If `explainConfig` treats *any* non-empty env var value as overriding the file and copies the raw env var string as `value`, `nimbus config explain updater.enabled` with `NIMBUS_UPDATER_DISABLE=1` will report `value: "1"` (or with `NIMBUS_UPDATER_DISABLE=0` will claim `env` won when the loader actually ignored it), violating Spec § 3 Anti-Goal #4 (*"Explain gives an answer that differs from what the loader actually used"*).
     - **Suggestion:** Add an optional `resolveEnvValue?: (raw: string) => string | undefined` to each `CONFIG_ENV_OVERRIDES` descriptor that returns the effective TOML-formatted value when the env var actually triggers an override, or `undefined` when the loader ignores that env value.

---

## 2. Open Questions & Behavioral Edge Cases

### Q1. Active profile without `nimbus.<profile>.toml`: should `config.validate` warn or stay green?

In Task 7:
> - *a profile name that is active but has no file is a warning, not an error*

And in `packages/cli/src/commands/doctor-core.ts:456-477` (`doctorPrintConfigValidation`):
> Every warning returned by `config.validate` prints `[warn] Config: …` and **sets `nimbus doctor`'s exit code to `1`**.

**Question:** Suppose a user has a valid `nimbus.toml` and switches to a profile (`nimbus profile use work` or `NIMBUS_PROFILE=work`), or puts their overrides in `nimbus.local.toml` without creating `nimbus.work.toml`. Task 3 explicitly tests that *"profile without a file reads base"*.
- If `config.validate` emits a warning whenever `activeProfile` has no `nimbus.<profile>.toml`, then `nimbus doctor` will exit `1` (`[warn]`) for that profile until the user creates an empty `nimbus.work.toml`.
- On the other hand, if `NIMBUS_PROFILE=work` is set with a typo (`NIMBUS_PROFILE=wrok`), a notice is helpful.
- **Options:**
  1. Keep it as a `config.validate` warning (accepted that `nimbus doctor` warns when an active profile has no `nimbus.<profile>.toml` file).
  2. Only warn in `config.validate` if `activeProfile` comes from `NIMBUS_PROFILE` (likely a typo if the file doesn't exist), or surface missing profile file in `config.layers` / `doctor` as `[ok]`/`[info]` rather than a `config.validate` warning.

---

### Q2. How does `sectionFallback` get populated when `config.explain` runs before a section's loader?

In Task 4 & Task 5:
- `LayeredConfigReader` stores `fallbacks: Map<string, string>` keyed by `sectionHeader`, cleared whenever `snapshot()` rebuilds on an `mtime` change.
- `loadTomlSectionFromConfig` records a fallback into `reader.recordSectionFallback(sectionHeader, message)` when a section parser throws.
- `explainConfig` checks `reader.sectionFallback(header)` to populate `sectionFallback?: string`.

**Two edge cases to consider:**
1. **Timing / cache invalidation:** Suppose the user edits `nimbus.toml` (introducing a syntax/range error in `[audit]`) and immediately runs `nimbus config explain audit.tool_call_log_retention_days`.
   - `explainConfig` calls `reader.snapshot()`, which sees the new `mtime`, rebuilds the snapshot, and **clears `fallbacks`**.
   - Unless `loadNimbusAuditFromConfigDir` has been called *after* `snapshot()` rebuilt, `reader.sectionFallback("audit")` will be `undefined` during `explainConfig`!
2. **Coverage across throwing parsers:** Today, only `[audit]` and `[extensions]` use `loadTomlSection` with a throwing parser. Other parsers that reject invalid sections (`[pagerduty]`, `[multimodal]`, `[fleet]`, `[notifications]`, `[mcp_sink]`, `[metrics.dora.*]`) have their own `try/catch` or throw to their caller.

**Recommendation:**
- Either have `recordSectionFallback` also called by `loadNimbusPagerdutyFromConfigDir`, `loadMultimodalConfigFromDir`, `loadNimbusFleetFromConfigDir`, `loadNimbusNotificationsFromConfigDir`, and `loadNimbusMcpSinkFromConfigDir` on catch, **and** have `explainConfig` run the relevant section validator (or a lightweight table of section validators for the queried section) so `sectionFallback` is deterministic even right after a file edit on disk.

---

### Q3. How does `parseLayerDoc` handle malformed table headers (e.g. `[multimodal` or `[hitl.quorum."x]`)?

In Task 2:
- `isTableHeader(trimmed)` checks `trimmed.startsWith("[") && trimmed.endsWith("]")`.
- `entry` lines come from terminated `key = value` lines, and *"every other non-blank, non-comment line is `{ kind: 'passthrough', raw }`"*.
- **Problem:** In existing parsers (`collectSubTableKv` in `nimbus-toml.ts:489` and `parseSection` in `multimodal-config.ts:293`), **any line starting with `[`** (even if missing a closing `]` like `[multimodal` or having an unterminated quote like `[hitl.quorum."x]`) terminates the current section so subsequent keys do not leak into the previous section.
- If `parseLayerDoc` treats `[bad_header` (missing `]`) as a `passthrough` line inside the *preceding* `DocSection`, and then `renderEffectiveDoc` appends another layer's valid keys to that `DocSection` *after* the `passthrough` line, the malformed `[bad_header` in layer 1 will prematurely close the section in the rendered effective TOML and break layer 2's keys!
- Conversely, if `[hitl.quorum."x]` has `hasUnterminatedString(line) === true`, checking `hasUnterminatedString` *before* `trimmed.startsWith("[")` would classify it as `passthrough` instead of starting a new section.

**Recommendation:**
- In `parseLayerDoc`:
  1. Check `trimmed.startsWith("[")` **before** `hasUnterminatedString(line)`.
  2. If a line starts with `[` but is not a valid closed `[section]` or `[[array]]` header (e.g. missing closing `]` or has an unterminated string), have it **close the current `DocSection`** and emit into a malformed/anonymous section (or emit the `passthrough` line *after* all valid merged `entry` lines of the section in `renderEffectiveDoc`) so a broken line in `nimbus.toml` can never swallow a valid override from `nimbus.local.toml`.

---

### Q4. How does `explainConfig` split paths for quoted sub-table headers?

Several Nimbus config sections use quoted sub-table keys that contain dots:
- `[hitl.quorum."slack.post_message"]` → key `approvers`
- `[federation.preflight."prod.eu"]` → key `url`
- `[ci.service."checkout.api"]` → key `workflows`
- `[metrics.dora."payments.core"]` → key `production_environments`

Task 4 says:
> *Split `path` on `"."`. The last segment is `key`; the leading segments joined by `"."` are `header`.*

If a user runs `nimbus config explain 'hitl.quorum."slack.post_message".approvers'`, a naive `path.split(".")` will split inside `"slack.post_message"`!
**Recommendation:**
- Split `path` on `.` **outside quotes** (you already have quote-scanning logic in `toml-primitives.ts`), so `hitl.quorum."slack.post_message".approvers` splits into `header = 'hitl.quorum."slack.post_message"'` and `key = "approvers"`.
- Even better: if no exact `header` match is found and `header` starts with `hitl.quorum.`, `federation.preflight.`, `ci.service.`, or `metrics.dora.`, also try matching with quotes around the dynamic segment so `nimbus config explain hitl.quorum.slack.post_message.approvers` works without requiring shell-escaped quotes!

---

### Q5. Should `explainConfig(reader)` with `path === undefined` (`nimbus config list --effective`) include `blocks`?

In Task 4:
- When `path === undefined`, `explainConfig` returns `entries` (all scalar/inline keys across plain `[section]` tables), while `blocks` is only mentioned when `path` matches an array-of-tables header (`filesystem.roots`, `fleet.job`, `security.allowlist`, `connectors.workday.reports`, `glossary.terms`).
- **Question:** When a user runs `nimbus config list --effective` (or `--json`), should `blocks` also be populated with all effective array-of-tables blocks (and rendered after scalar entries in the CLI), so `[[filesystem.roots]]` and `[[fleet.job]]` aren't invisible in `nimbus config list --effective`?

---

## 3. Additional Suggestions & Minor Improvements

1. **Deduplicate `.nimbus-profile` marker reading in `ProfileManager` (`packages/gateway/src/config/profiles.ts`):**
   - `ProfileManager` (lines 18-24) has its own `private readActiveMarker()` that reads `.nimbus-profile` without `isValidProfileName` validation or `NIMBUS_PROFILE` awareness.
   - Having `ProfileManager` delegate to `readProfileMarker(this.configDir)` (or `resolveActiveProfile`) from `config/active-profile.ts` keeps `.nimbus-profile` parsing in one place across the whole repo.
2. **Doctor implementation file path in Task 7:**
   - Task 7 lists `packages/cli/src/commands/doctor.ts` under `Files: Modify`.
   - Note that `doctor.ts` is only the thin CLI entry wrapper; all RPC orchestration and output formatting live in **`packages/cli/src/commands/doctor-core.ts`** (`doctorRunGatewayRpcs` at line 901) and its tests are in `packages/cli/src/commands/doctor.test.ts`.
   - Also consider whether `config.layers` should be embedded in `config.validate`'s return payload (which `doctorRunGatewayRpcs` already calls on line 906!) or fetched via a separate `config.layers` RPC call (with `-32601` `isMethodNotFound` fallback for older gateways, matching `index.health` and `extension.list` in `doctor-core.ts`).
3. **Preserve `comments` / blank lines ordering in `renderEffectiveDoc`:**
   - Since existing parsers ignore comments and blank lines, `renderEffectiveDoc` doesn't even need to emit `passthrough` lines that are pure comments/blanks — only non-comment `passthrough` lines (so malformed lines still trigger errors in strict parsers like `[multimodal]`, `[fleet]`, `[audit]`, and `config.validate`). Making sure `passthrough` lines are emitted *before* valid overridden keys (except for malformed `[header` lines, per Q3 above) is worth calling out in a unit test.
4. **Update `loadTomlSectionFromConfig` `sectionHeader` convention in Task 5:**
   - In `nimbus-toml.ts`, `forEachSectionEntry(text, "[audit]", ...)` passes bracketed `"[audit]"`, whereas `DocSection.header` in Task 2 and `sectionFallback("audit")` in Task 5 use unbracketed `"audit"`.
   - Standardize `loadTomlSectionFromConfig(configDir, sectionHeader, ...)` to accept unbracketed `"audit"` (or strip leading/trailing `[]` internally) so callers can't accidentally mismatch the key looked up by `explainConfig`.

---

## 4. Summary Checklist for Plan Updates

- [ ] **Task 2 (`layered-config.ts`):** Handle lines starting with `[` before `hasUnterminatedString` in `parseLayerDoc` so malformed `[section` headers don't stay inside the previous section and corrupt overrides from higher-precedence layers.
- [ ] **Task 4 (`config-explain.ts`):**
  - Add `NIMBUS_NOTIFICATIONS` (`notifications.enabled`) to `CONFIG_ENV_OVERRIDES`, widen the drift test regex to `/["']NIMBUS_[A-Z0-9_]+["']/`, and respect value-conditional env overrides (`NIMBUS_UPDATER_DISABLE=1`, `NIMBUS_NOTIFICATIONS=off|0|false`, `NIMBUS_TELEMETRY_ENABLED=1|true|0|false`).
  - Fix `audit.retention_days` → `audit.tool_call_log_retention_days` + `fleet.retention_days` in `POLICY_CONSTRAINED_PATHS`, and add prefix matching for `hitl.quorum.*`.
  - Split `path` on `.` outside quotes so `hitl.quorum."<action>".approvers` and `metrics.dora."<service>".*` resolve cleanly.
- [ ] **Task 5 & Task 6 (`*FromConfigDir` loaders):** Add `loadNimbusFleetFromConfigDir`, `loadNimbusNotificationsFromConfigDir`, `loadNimbusMcpSinkFromConfigDir`, `loadNimbusTelemetryFromConfigDir`, `loadNimbusOncallPushFromConfigDir`, `loadNimbusBriefsFromConfigDir`, `loadNimbusPersonaFromConfigDir`, and `loadNimbusAgentsFromConfigDir`, preserving each loader's error-throwing and `text === null` env-override behavior.
- [ ] **Task 7 (`doctor-core.ts` & `diagnostics-rpc.ts`):** Point the plan at `packages/cli/src/commands/doctor-core.ts`, handle `-32601` gracefully if calling `config.layers`, and decide whether an active profile with no `nimbus.<profile>.toml` file should warn in `config.validate` (causing `nimbus doctor` to exit `1`) or only report in `config.layers`.
- [ ] **Task 9 (`check-nimbus-invariants.ts`):** Refine the D35 regex so backtick-wrapped `` `nimbus.toml` `` inside user-facing prose strings (`brief-disclosures.ts`, `glossary/*.ts`, `cli/src/commands/*.ts`) and `config/profiles.ts` do not trigger false-positive invariant failures.
