# Design Review: Role Packs — Project 1: Foundations (`2026-10-22-role-packs-p1-foundations-design.md`)

**Reviewed document:** `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md`  
**Companion document:** `docs/superpowers/specs/2026-10-21-role-packs-overview-design.md`  
**Review date:** 2026-10-22

---

## Overall Assessment

The P1 spec is tightly scoped, grounds every problem statement in real file/line citations, and decomposes the work into five cleanly ordered PRs with mechanical invariants (a new D3x static rule for `layered-config.ts`, `satisfies Record<...>` exhaustiveness for the catalogs, and explicit conflict rules for multi-pack composition).

Auditing the spec against the current Gateway and CLI implementations surfaced **3 codebase mismatches to correct in the spec**, **7 concrete design improvements/edge cases**, and **5 open questions** to settle before implementation starts.

---

## 1. Codebase Mismatches to Correct in the Spec

### 1.1 `AGENT_PARAM_KINDS` cannot be the sole source of parameter shapes for the 18-method Agent Catalog (§ 5.5)

- **Spec claim (§ 5.5, line 262):** *"Agents: a `Record` total over the agent methods (`packages/gateway/src/catalog/agent-catalog.ts`), with display name, one-line description, category, role tags, **parameter shape (derived from `AGENT_PARAM_KINDS`)** and surface eligibility (external, fleet)."*
- **Actual code (`packages/gateway/src/ipc/agent-param-kinds.ts` & `agent-param-kinds.test.ts`):**
  1. **Missing 6 of the 18 methods:** `AGENT_PARAM_KINDS` is typed as `Record<ExternalAgentName, ...>` and intentionally covers **only the 12 ChatOps-permitted agents** (`EXTERNAL_AGENT_NAMES`). It omits `changelog`, `standup`, `negotiate`, `preflight`, `premortem`, and `whyPeek` (`agent-param-kinds.ts:17-19`). Furthermore, `agent-param-kinds.test.ts:30-37` and `scripts/structure-audit/check-agent-param-kinds.ts` explicitly assert that excluded agents do **not** appear in `AGENT_PARAM_KINDS`.
  2. **Missing requiredness and `oneOf` constraints:** `AGENT_PARAM_KINDS` only maps field names to `"string" | "number" | "boolean" | "stringArray"` for flat ChatOps `key=value` coercion. It does not distinguish required parameters (`ghost.file`, `impact.fileOrPrUrl`, `conflicts.file`) from optional ones (`glossary.term`, `decisions.service`), nor does it express mutually-exclusive target unions (`expert`: `topicOrFile` vs `itemUrl`; `why`: `ref` vs `prUrl` vs `itemUrl`; `negotiate`: `personId` vs `service`) that Project 4's desktop brief page needs to render parameter inputs.
  3. **Missing URL arms on `expert` and `why`:** `AGENT_PARAM_KINDS.expert` omits `itemUrl` (`agent-param-kinds.test.ts:5-7` pins `expert` to two keys) and `AGENT_PARAM_KINDS.why` omits `itemUrl`.
- **Recommendation:** Keep `AGENT_PARAM_KINDS` unchanged as the ChatOps string-coercion table (so `check-agent-param-kinds.ts` and `agent-param-kinds.test.ts` stay green), and define rich parameter descriptors directly in `packages/gateway/src/catalog/agent-catalog.ts` (e.g., field name, kind, required/optional, `oneOf` group, label/placeholder), with a unit test verifying that for every `ExternalAgentName` key in `AGENT_PARAM_KINDS`, its primitive kind matches `agent-catalog.ts`.

### 1.2 Array-of-tables (`[[...]]`) inventory in § 5.1 lists `[[glossary.terms]]` instead of actual `[[...]]` sections

- **Spec claim (§ 5.1, line 129):** *"Arrays of tables (`[[filesystem.roots]]`, `[[glossary.terms]]`, `[[fleet.job]]`): the highest layer that defines the array supplies all of it (whole-array replacement)."*
- **Actual code (`packages/gateway/src/config/nimbus-toml-glossary-terms.ts:41-42`):**
  - `[glossary.terms]` and `[glossary.synonyms]` are **single-bracket plain tables** (`[glossary.terms]`, `[glossary.synonyms]`) mapping `term = "definition"` and `canonical = ["alias1", "alias2"]` — **not** `[[glossary.terms]]` arrays-of-tables. Treating `[glossary.terms]` as a plain table with key-by-key merging across layers is actually much better for users (a pack or base `nimbus.toml` can seed terms while a profile overrides or adds individual terms).
  - Conversely, the actual `[[...]]` arrays-of-tables across `packages/gateway/src/config/` are:
    1. `[[filesystem.roots]]` (`filesystem-toml.ts:106`) — whole-array replacement
    2. `[[fleet.job]]` (`fleet-toml.ts:303`) — keyed merge by `name` (added in PR 4, § 5.4)
    3. `[[connectors.workday.reports]]` (`nimbus-toml-workday.ts:57`) — whole-array replacement
    4. `[[security.allowlist]]` (`nimbus-toml.ts:1459`) — whole-array replacement
    5. `[[quorum.rules]]` (`nimbus-toml.ts:1633`) — whole-array replacement
- **Recommendation:** Update § 5.1 to move `[glossary.terms]` and `[glossary.synonyms]` under plain tables (key-by-key merge) and list all five real `[[...]]` sections (`[[filesystem.roots]]`, `[[fleet.job]]`, `[[connectors.workday.reports]]`, `[[security.allowlist]]`, `[[quorum.rules]]`) so `layered-config.ts` handles every `[[...]]` section in the codebase.

### 1.3 Active-profile resolution is currently split between `NIMBUS_PROFILE` env and `<configDir>/.nimbus-profile` (§ 2, § 5.1)

- **Spec claim (§ 2, line 51; § 5.1, line 125):** States that `resolveNimbusTomlForProfile` is the single helper that knows about `nimbus.<profile>.toml` and that profile files are active when a non-default profile is active.
- **Actual code:** There are currently **two disconnected mechanisms** for determining the active profile:
  1. `resolveNimbusTomlForProfile` (`packages/gateway/src/config/nimbus-toml.ts:239-246`) reads **only** `processEnvGet("NIMBUS_PROFILE")` and never checks `<configDir>/.nimbus-profile`.
  2. `ProfileManager` (`packages/gateway/src/config/profiles.ts:18-24`, backing `profile.list` and `profile.switch` IPC) and `packages/cli/src/commands/profile.ts:18-28` read and write **only** `<configDir>/.nimbus-profile` and never check `NIMBUS_PROFILE`.
  3. As a result:
     - When a user runs `nimbus profile switch work` and then runs `nimbus config list --effective` or `nimbus config explain` in the CLI (`packages/cli/src/commands/config.ts:218`), `NIMBUS_PROFILE` is **unset** in the CLI process (`start.ts` only injects `NIMBUS_PROFILE` into the spawned gateway child process).
     - When `profile.switch` is called over IPC (`packages/gateway/src/ipc/profile-rpc.ts:29`) or the gateway is launched by Tauri/service manager without `start.ts`, `.nimbus-profile` changes on disk while `process.env.NIMBUS_PROFILE` does not.
- **Recommendation:** In PR 1 (`layered-config.ts`), unify active-profile resolution into a single precedence order used by both Gateway and CLI:
  1. Explicit `profile` argument (if passed by caller/test)
  2. `NIMBUS_PROFILE` environment variable (if non-empty and not `"default"`)
  3. `<configDir>/.nimbus-profile` marker file (trimmed, if present and not `"default"`)
  4. `"default"`
  Include `<configDir>/.nimbus-profile` in the snapshot's stat fingerprint so `nimbus profile switch <name>` triggers a clean layer reload on the next read without needing a daemon restart!

---

## 2. Design Improvements & Edge Cases by PR

### PR 1 — Layered Reader & CLI Surface (§ 5.1)

1. **Unblock 2+ dot keys in `packages/cli/src/commands/config.ts` (`isNestedTableKey`):**
   - Today, `packages/cli/src/commands/config.ts:122-145` rejects any key with 2 or more dots (`key.split(".").length > 2`) with: *"Nested table keys like `<key>` are not supported by `nimbus config get|set`."*
   - However, many of the 47 loaders use parameterized sub-tables (`[connectors.<id>]`, `[metrics.dora.<service>]`, `[ci.service.<id>]`, `[llm.local.<name>]`, `[llm.remote.<vendor>]`, `[chatops.slack.workspaces.<id>]`), and § 5.4 explicitly introduces `nimbus config explain fleet.job.<name>` (which has 2 dots).
   - **Suggestion:** Specify in § 5.1 that `nimbus config explain <key>` and `nimbus config get --effective <key>` support multi-segment table paths (`<section>.<subsection>.<key>` and `fleet.job.<name>`), rather than being blocked by `isNestedTableKey`.
2. **Convert `rpcConfigValidate` (`packages/gateway/src/ipc/diagnostics-rpc.ts:198`) to `layered-config.ts`:**
   - `rpcConfigValidate` currently hardcodes `const tomlPath = join(ctx.configDir, "nimbus.toml");`.
   - Under the new D3x static rule (§ 5.1: *"forbids the literal `'nimbus.toml'` and `resolveNimbusTomlForProfile` outside `config/layered-config.ts` and the writers"*), `diagnostics-rpc.ts` will violate D3x unless updated. Moving `rpcConfigValidate` (and CLI `nimbus config validate`) onto `layered-config.ts` also ensures `nimbus config validate` validates the active profile and pack layers rather than only the base file.
3. **Preserve per-layer raw line diagnostics for `[glossary.terms]` / `[glossary.synonyms]`:**
   - `readGlossaryTermsFromNimbusToml` (`packages/gateway/src/config/nimbus-toml-glossary-terms.ts:88-108`) inspects raw lines to count `preSkipped` (unterminated strings), dotted keys in `[glossary]`, and duplicate keys within the same file so `nimbus glossary --refresh` can report `manualSkipped`.
   - Ensure `layered-config.ts` either runs the line-level scanner per file before merging keys across layers or preserves per-layer raw parse diagnostics in the snapshot so `manualSkipped` tests continue to pass.
4. **Guard the stat fingerprint against sub-millisecond / same-size edits in tests:**
   - § 5.1 proposes caching the snapshot by `(path, size, mtime)` of each layer file plus `active.json`, and tests this by editing a file mid-run and asserting the next call observes the change.
   - On Windows and Linux, a test that writes a file and re-writes a same-byte-length replacement (e.g., `0.5` → `0.8`, or `"on"` → `"no"`) within the same millisecond tick can produce the exact same `(size, mtimeMs)` tuple.
   - **Suggestion:** Have gateway writers (`setPackLayer`, `ProfileManager`, config writers) explicitly invalidate the in-process snapshot cache on write, and for external edits, include `ctimeMs` alongside `mtimeMs` + `size` (or if `Date.now() - mtimeMs < 15`, hash the file bytes — `nimbus.toml` is only a few KB).

### PR 2 — Pack Layer & Conflict Rules (§ 5.2)

5. **Path-traversal / slug validation on `profile` and `packId`:**
   - Because `<configDir>/packs/<profile>/<pack-id>.toml` and `<configDir>/nimbus.<profile>.toml` construct file paths from `profile` and `packId`, validate both identifiers against a strict slug pattern (matching `ProfileManager`'s `/^[a-z0-9_-]{1,32}$/i` in `profiles.ts:56`) in both `layered-config.ts` and `setPackLayer`. This prevents path traversal even if `NIMBUS_PROFILE`, `.nimbus-profile`, or `active.json` is hand-edited with `../`.
6. **Malformed `active.json` or missing `<pack-id>.toml` resilience:**
   - § 5.2 specifies that a pack file containing a non-allowlisted key is skipped, logged at error, and surfaced in `nimbus doctor` and `config explain`.
   - Extend that same fail-open contract to a malformed `active.json` or an entry in `active.json` whose `<pack-id>.toml` file is missing on disk: skip the broken entry, log at error, and surface it in `nimbus doctor` and `config explain` rather than throwing during gateway boot.

### PR 3 & PR 4 — Live Reload, `FleetRpcCtx`, and Disabling Stubs (§ 5.3, § 5.4)

7. **Fleet supervisor must back all of `FleetRpcCtx` (`status`, `list`, `run`, `digest`), not only `fleet.list`:**
   - In `packages/gateway/src/ipc/fleet-rpc.ts:40-47`, `FleetRpcCtx` holds `readonly scheduler?: FleetScheduler`, `readonly config: NimbusFleetToml`, and `readonly jobs?: readonly NimbusFleetJobToml[]`. All four RPC handlers (`fleet.status`, `fleet.list`, `fleet.run`, and `fleet.digest` via `buildFleetDigest`) read from `FleetRpcCtx`.
   - Furthermore, if `[fleet] enabled` starts as `false` at gateway boot and a user later activates a pack or edits `nimbus.toml` to set `[fleet] enabled = true` (or vice versa), `assembleFleetRuntime` (`packages/gateway/src/platform/assemble.ts:3256`) currently early-returns `{ config }` without creating a scheduler if `!config.enabled` at boot!
   - **Suggestion:** Note in § 5.3 that `assembleFleetRuntime` always wires the Fleet supervisor (even when `[fleet] enabled` is initially `false`), registers a single shutdown callback on `deps.sidecarStops`, and dynamically supplies the current `{ scheduler, config, jobs, droppedJobs }` to all four `FleetRpcCtx` handlers (`status`, `list`, `run`, `digest`).
8. **Orphan disabling stubs (`enabled = false`) when a pack is removed (§ 5.4):**
   - § 5.4 states: *"To silence a pack job, the owner writes `[[fleet.job]] name = "<same>"` with `enabled = false` in their own file. The rules that a job needs `agent` and `interval_seconds` are relaxed only for such a disabling stub."*
   - Consider what happens when the user later **removes the pack** (Overview Goal 3: *"Removing a pack restores Nimbus; the user's own config is never edited"*): the user's `nimbus.toml` still has `[[fleet.job]] name = "eng-digest" enabled = false` without `agent` or `interval_seconds`, and no lower layer defines `"eng-digest"` anymore!
   - **Recommendation:** Specify in § 5.4 that a disabling stub (`name` + `enabled = false` with no `agent`/`interval_seconds`) is **always valid**, even when no lower layer currently defines a job with that `name` (in which case it simply produces a disabled/inert entry or is omitted from active scheduling without raising a `droppedJobs` validation error in `nimbus doctor` or `fleet status`).

---

## 3. Open Questions for the Author

1. **Should `agents.whyPeek` be in the user-facing Agent Catalog, or marked `kind: "peek"` / excluded (§ 5.5)?**
   - `AGENTS_RPC_HANDLERS` has 18 methods: 17 brief agents plus `agents.whyPeek` (an inline editor hover helper excluded from both Fleet and ChatOps: `FLEET_ELIGIBILITY["agents.whyPeek"] = "excluded_shape"`).
   - Should `catalog/agent-catalog.ts` key over `Exclude<keyof typeof AGENTS_RPC_HANDLERS, "agents.whyPeek">` (the 17 user-facing briefs), or include `whyPeek` with a `surfaceEligibility` / `kind: "brief" | "peek"` flag so `nimbus catalog agents` and Project 4's desktop brief page don't list `whyPeek` as a runnable brief?
2. **Short agent names vs. RPC method names in `[agents] visible` / `show` / `hide` (§ 5.5):**
   - Does `[agents] visible` / `show` / `hide` use short names (`["decisions", "standup"]`, matching `[[fleet.job]] agent = "decisions"` and CLI `nimbus <agent>`) or RPC method names (`["agents.decisions", "agents.standup"]`)?
   - Accepting short names canonically (and normalizing `"agents.<name>"` → `"<name>"` if a user writes the prefix) would keep `[agents]` consistent with `[[fleet.job]]`.
3. **Environment variable overrides (`NIMBUS_*`) in `config.explain` (§ 5.1):**
   - Today, `nimbus config list` and `nimbus config get` (`packages/cli/src/commands/config.ts:79,146`) annotate keys when a `NIMBUS_*` environment variable overrides the TOML value.
   - Should `config.explain` also include an `envOverride?: { varName: string; value: unknown }` field when an environment variable overrides all TOML layers in the running gateway process, so `nimbus config explain` never disagrees with what the gateway is actually enforcing?
4. **How `nimbus doctor` receives pack-layer and fleet-job diagnostics over IPC (§ 5.2, § 5.4):**
   - `nimbus doctor` in the CLI queries `diag.snapshot` (`packages/gateway/src/ipc/diagnostics-rpc.ts:710`).
   - Should `diag.snapshot` include a `configLayers?: { activeProfile: string; activePacks: string[]; skippedPacks: Array<{ packId: string; reason: string }>; droppedFleetJobs: Array<{ name: string; file: string; reason: string }> }` payload so both `nimbus doctor` and the Desktop app (Project 4) can render layer health from one RPC call?
5. **Exact union for `connector-catalog-meta.ts` and user-registered MCP connectors (`mcp_*`) (§ 5.5):**
   - Note that `CONNECTOR_SERVICE_IDS` (`packages/gateway/src/connectors/connector-catalog.ts:38`) already contains `"obsidian"` and `"openapi"`, while `LOCAL_ONLY_SYNC_SERVICES` (`sync-Dispatch.ts:47`) contains `["filesystem", "blame", "openapi", "obsidian"]` (so the net addition to `CONNECTOR_SERVICE_IDS` is `"filesystem" | "blame"`).
   - For `catalog.list`, § 5.5 mentions merging installed `ext_*` extensions at query time; should `catalog.list` also merge user-registered MCP connectors (`mcp_*` from `user_mcp_connector`) or only `ext_*` extensions?
