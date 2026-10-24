# Role packs P1 PR 5: agent visibility and the catalog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A pack can say which agents to show, the owner can show or hide single agents, and a new `catalog.list` method (with `nimbus catalog`) lists every agent and connector with descriptive metadata. The setting is presentation only; nothing refuses a call because of it.

**Architecture:** `[agents] visible` joins the pack allowlist as the first LIST key: it is checked for syntax, never conflict-checked, and unioned across packs. One pure resolver, `catalog/agent-visibility.ts`, reads `[agents] visible/show/hide` per layer from the snapshot's `EffectiveDoc` (the winner entry plus its `shadowed` values give one value per layer). It is the setting's only reader. Two hand-authored tables carry the catalog metadata. `catalog/agent-catalog.ts` is a `Record` total over the 17 brief methods. `catalog/connector-catalog-meta.ts` is total over `CONNECTOR_SERVICE_IDS ∪ GATEWAY_SYNCABLE_SERVICE_IDS`. `catalog/catalog-list.ts` joins the two tables, the visibility result, and owner-added `ext_*`/`mcp_*` servers read from the DB at query time. `config/` cannot import `catalog/`, so `config explain` gets its visibility notes through an injected callback, the same way PR 4 injected `fleetJobCheck`.

**Tech Stack:** Bun, TypeScript strict, `bun:test`, bun:sqlite (`openMigratedMemoryDb`).

**Spec:** `docs/superpowers/specs/2026-10-22-role-packs-p1-foundations-design.md` § 5.5, with § 6 (security notes), § 7 ("`catalog.list` returns every agent and connector with metadata, and `visible` follows packs plus show/hide. Every agent stays callable everywhere when hidden.") and § 8 calls 6, 8, 11, 13, 14.

## Global Constraints

- Branch `dev/asaf/role-packs-p1-catalog` in worktree `C:\gitrep\Nimbus\.claude\worktrees\role-packs-p1-catalog`, created with an ABSOLUTE path. Base it on `origin/main` if #1752 (PR 4) has merged; otherwise base it on `dev/asaf/role-packs-p1-merging` and rebase onto `origin/main` once #1752 merges, before opening the PR. Task 5 needs PR 4's `explainConfig` `opts` parameter. This plan and the spec never land on main.
- "`[agents] visible = [...]` is a pack-settable list, unioned across packs." "The user layers add `[agents] show = [...]` and `[agents] hide = [...]`."
- "Start from all agents if no active pack sets `visible`; otherwise from the union of the packs' lists."
- "The highest user layer that names an agent in `show` or `hide` decides it … Within one layer, `hide` beats `show`."
- "`visible` is read from pack layers only. A `visible` key in a user file is ignored and `config explain` says so."
- "Agent names are the **short** names used by `[[fleet.job]] agent` and the CLI … An `agents.` prefix is accepted and normalised away." "Unknown agent names are reported by `config explain`, not fatal."
- "**It is presentation only.** No gate, dispatcher, HTTP route, MCP tool, fleet or ChatOps path reads it. A test asserts that the setting has no reader outside the catalog module."
- "`AGENT_PARAM_KINDS` is **not** the source … it stays unchanged. `agents-rpc.ts`'s validators remain the only enforcement."
- "`catalog.list` … is CLI/desktop-callable and LAN-forbidden. It joins the Tauri allowlist in Project 4 … not here." "`nimbus help` is **not** filtered by visibility."
- Owner-added servers: "Both are marked as such, and their text is shown as data, never as catalog-authored prose."
- "Unifying the desktop's `DISPLAY_NAMES` and onboarding lists, and the CLI MCP `DEFS` descriptions, onto the catalog is Project 4/5 work." Do not touch them.
- "Keep it short and factual; descriptions must not overclaim." A connector description says what the SERVICE is, never what Nimbus indexes from it.
- No new HITL action type, invariant, egress class or migration (§ 6). No `any`. Use `path.join`. Not breaking, so no `!`. Commits end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Run `bun run preflight:fast` before the PR.

## Rulings (spec gaps found in recon, 2026-10-24)

1. **`negotiate` has no `service` parameter.** `requireNegotiateParams` accepts only `sinceMs` and `personId`. The spec's "`negotiate`'s `personId`/`service`" oneOf group does not exist. Its descriptors are two optional fields with no group. The validators are the authority (§ 5.5).
2. **An extension manifest has `name` but no `description`.** An `ext_*` catalog entry therefore carries `name` (or `null`) and no description. The name comes from `readVerifiedManifest` (`extensions/approve-run.ts`), so unverified bytes are never shown. A failed read lists the extension with `name: null`; it never fails the whole catalog.
3. **A user MCP server has no registered display name.** The registered `service_id` (`mcp_<name>`) is its name.
4. **A pack's `visible` must be a non-empty array.** An empty list from one pack would read as "this pack hides everything", which the union cannot express. It is refused at `setPackLayer`. Unknown names in a pack's list are accepted (they are reported, not fatal).
5. **`catalog.list` takes no params** and always returns both halves. The CLI filters to `agents` or `connectors`.

## Review Focus

1. **Prefixed and bare names meet.** A pack lists `agents.decisions` and the base file hides `decisions`: `decisions` is hidden. (Task 2 test `normalises the agents. prefix on both sides`)
2. **A profile un-hides what the base hides**, and the same layer listing an agent in both `show` and `hide` hides it. (Task 2 tests `the profile's show beats the base's hide` and `hide beats show within one layer`)
3. **A typo in a pack's list** (`"standpu"`) drops only that name. The rest of the pack's list applies, and explain names the unknown agent and its layer. (Task 2 test, Task 5 explain test)
4. **The last pack that sets `visible` is removed:** visibility returns to all agents, apart from the user's own `hide`. (Task 2 test `no pack sets visible: every agent starts visible`)
5. **A hidden agent is still served,** and a hostile owner-added name cannot drive the terminal. A hidden `decisions` still answers `agents.decisions` over a real socket. An extension named with an ANSI escape prints stripped in `nimbus catalog connectors`. (Task 6 e2e test, Task 6 CLI test)

---

### Task 1: `[agents] visible` is pack-settable

**Files:**
- Modify: `packages/gateway/src/config/pack-settable.ts`
- Test: `packages/gateway/src/config/pack-settable.test.ts`, `packages/gateway/src/packs/pack-layer-store.test.ts`

**Interfaces:**
- Produces:
  - `export const AGENT_NAME_IN_LIST_RE = /^(?:agents\.)?[a-z][A-Za-z]{0,63}$/`.
  - `export function parseAgentNameList(valRaw: string): readonly string[] | undefined`. It is strict: a `[`…`]` array of 1..64 double-quoted strings, each matching `AGENT_NAME_IN_LIST_RE`, comma-separated, with no trailing comma. Anything else returns `undefined`. Names are returned as written; normalisation is Task 2's job.
  - `export type PackSettableList = { section; key; consumer: PackConsumerMode; why; expect; parse: (valRaw: string) => readonly string[] | undefined }`.
  - `export const PACK_SETTABLE_LISTS: readonly PackSettableList[]`, holding one entry: `{ section: "agents", key: "visible", consumer: "per-call", why: "which agents the catalog shows; packs union, the owner's show/hide decide per agent", expect: 'a non-empty array of agent names, e.g. ["decisions", "standup"]', parse: parseAgentNameList }`.
  - `PackFragmentCheck`'s ok arm gains `readonly lists: ReadonlyMap<string, readonly string[]>`, keyed `"agents.visible"`. `checkPackFragment` accepts a list key in a plain section. List keys never enter `scalars`, so the store's `conflicts()` never compares them; that is the union rule.

- [ ] **Step 1: Write the failing tests** in `pack-settable.test.ts`:
  - `accepts [agents] visible with bare and prefixed names`: `[agents]\nvisible = ["decisions", "agents.standup"]\n` gives `ok: true` and `lists.get("agents.visible")` equal to `["decisions", "agents.standup"]`.
  - `refuses an empty visible list`: the problem includes `[agents] visible = []: expected a non-empty array of agent names`.
  - `refuses a non-array, an unquoted name, a trailing comma and a 65-name list`, one assertion each, with the problem naming `[agents] visible`.
  - `refuses other [agents] keys`: `synthesis = "local"` gives `[agents] synthesis is not pack-settable`; `show = ["x"]` and `hide = ["x"]` give the same shape.
  - `accepts an unknown but well-formed name` (`"standpu"`).
  - In `pack-layer-store.test.ts`: `two packs may both set [agents] visible`. Packs `ops` (`["oncall"]`) and `data` (`["decisions"]`) are both written, with no `PackLayerRefusedError`.
- [ ] **Step 2: Run and see them fail:** `bun test packages/gateway/src/config/pack-settable.test.ts packages/gateway/src/packs/pack-layer-store.test.ts`. Expected: visible is "not pack-settable".
- [ ] **Step 3: Implement.** `checkPlainSection` looks a key up in `PACK_SETTABLE_KEYS` first, then in `PACK_SETTABLE_LISTS`. The `[x] is not pack-settable` empty-section test counts both tables. Duplicate-key detection covers list keys too.
- [ ] **Step 4: Run and see them pass,** plus `bun test packages/gateway/src/config packages/gateway/src/packs`.
- [ ] **Step 5: Commit** `feat(config): packs may set [agents] visible, unioned across packs`.

### Task 2: the visibility resolver

**Files:**
- Create: `packages/gateway/src/catalog/agent-visibility.ts`
- Test: `packages/gateway/src/catalog/agent-visibility.test.ts`

**Interfaces:**
- Consumes: `ConfigSnapshot` (`config/layered-config.ts`), `EffectiveEntry`/`LayerRef` (`config/layered-merge.ts`), and `parseStringArray` (`config/toml-primitives.ts`) for USER layers. Pack values reuse Task 1's `parseAgentNameList`; a pack value that fails it is skipped with a note.
- Produces:
  - `export function normaliseAgentName(raw: string): string` strips ONE leading `agents.`.
  - `export type AgentVisibilityOverride = { readonly agent: string; readonly visible: boolean; readonly layer: LayerRef }`.
  - `export type AgentVisibility = { readonly visible: ReadonlySet<string>; readonly basis: "all" | "packs"; readonly packs: readonly string[]; readonly overrides: readonly AgentVisibilityOverride[]; readonly notes: readonly string[] }`. `packs` lists the ids of the packs that set `visible`, low to high. `overrides` holds the agents a user layer decided, sorted by agent.
  - `export function resolveAgentVisibility(snapshot: Pick<ConfigSnapshot, "doc">, known: readonly string[]): AgentVisibility`.
  - `export function describeAgentVisibility(v: AgentVisibility): readonly string[]`. Its first line is either `agent visibility: all agents (no active pack sets [agents] visible)` or `agent visibility: the agents listed by packs <id>, <id>`. Then one line per override, `agent "<name>" is shown by <kind>:<id>` or `agent "<name>" is hidden by <kind>:<id>`. Then `notes`.
- Algorithm: find the non-array `agents` section in `snapshot.doc.sections`. For each of `visible`/`show`/`hide`, the per-layer values are `[...entry.shadowed, last winner entry]`, already ordered low to high. For `visible`, keep the `kind === "pack"` values and note every `base`/`profile` value. For `show`/`hide`, keep only `base` and `profile`, ranked profile above base. Normalise every name, drop unknown names with a note, and dedupe. Then build the set: all `known` names, or the union of pack lists. Apply each agent's decision from its highest naming user layer, where within a layer `hide` beats `show`.
- Note texts, verbatim:
  - `[agents] visible in <kind>:<id> is ignored: only packs set it; use show and hide`
  - `unknown agent "<name>" in <kind>:<id> [agents] <key>`
  - `[agents] <key> in <kind>:<id> is not an array of agent names; ignored`

- [ ] **Step 1: Write the failing tests.** Build snapshots with `mergeLayerDocs`/`parseLayerDoc` over pack, base and profile refs, using `known = ["catchup", "decisions", "oncall", "standup"]`:
  - `no pack sets visible: every agent starts visible`: `basis: "all"`, all four visible.
  - `packs union their lists`: pack `ops` gives `["oncall"]` and pack `data` gives `["decisions"]`. The visible set is exactly `{decisions, oncall}`, with `packs: ["ops", "data"]`.
  - `the base file hides an agent`.
  - `the profile's show beats the base's hide`: base `hide = ["decisions"]`, profile `show = ["decisions"]`. `decisions` is visible, and its override is `{ visible: true, layer: profile }`.
  - `hide beats show within one layer`.
  - `show adds an agent no pack listed`: packs list `["oncall"]` and base `show = ["standup"]` gives `{oncall, standup}`.
  - `normalises the agents. prefix on both sides`.
  - `a user-file visible is ignored and noted`: the set is unchanged, and the note text matches verbatim.
  - `an unknown name is dropped and noted; the rest applies`.
  - `a malformed show is ignored and noted` (`show = "decisions"`).
  - `describeAgentVisibility renders the summary, overrides and notes` (exact lines).
- [ ] **Step 2: Run and see them fail:** `bun test packages/gateway/src/catalog/agent-visibility.test.ts`.
- [ ] **Step 3: Implement** to the interface above.
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: Commit** `feat(catalog): resolve agent visibility from packs plus the owner's show/hide`.

### Task 3: the agent catalog and its honesty checks

**Files:**
- Create: `packages/gateway/src/catalog/agent-catalog.ts`
- Test: `packages/gateway/src/catalog/agent-catalog.test.ts`
- Modify: `scripts/structure-audit/check-agent-param-kinds.ts`, `scripts/structure-audit/check-agent-param-kinds.test.ts`

**Interfaces:**
- Consumes: `type AgentMethod`, `FLEET_ELIGIBILITY` and `EXTERNAL_AGENT_NAMES` (`ipc/agents-rpc.ts`), plus `type ParamKind` (`ipc/agent-param-kinds.ts`). Import nothing else from `agents/`; D22(d) forbids emitter imports.
- Produces:
  - `export type BriefMethod = Exclude<AgentMethod, "agents.whyPeek">`.
  - `export type AgentCategory = "catch-up" | "code" | "knowledge" | "operations" | "people"`.
  - `export type AgentRoleTag = "engineer" | "manager" | "on-call" | "data"`.
  - `export type CatalogParam = { readonly name: string; readonly kind: ParamKind; readonly label: string; readonly required: boolean; readonly oneOf?: { readonly group: string; readonly arm: string; readonly required: boolean } }`. Members sharing a `group` are mutually exclusive. Members sharing `group` AND `arm` go together, like the forge triple. `required` on the param is `false` for every group member; the group's own `required` says whether one arm must be given.
  - `export type AgentCatalogEntry = { readonly displayName: string; readonly description: string; readonly category: AgentCategory; readonly roles: readonly AgentRoleTag[]; readonly params: readonly CatalogParam[] }`.
  - `export const AGENT_CATALOG = Object.freeze({ … }) satisfies Readonly<Record<BriefMethod, AgentCatalogEntry>>`.
  - `export type CatalogAgent = AgentCatalogEntry & { readonly name: string; readonly method: BriefMethod; readonly surfaces: { readonly external: boolean; readonly fleet: boolean } }`.
  - `export function listCatalogAgents(): readonly CatalogAgent[]`. `name` is the method minus `agents.`. `external` is `EXTERNAL_AGENT_NAMES.includes(name)`. `fleet` is `FLEET_ELIGIBILITY[method] === "eligible"`. Sorted with `codeUnitCompare` (`util/code-unit-compare.ts`).
  - `export const CATALOG_AGENT_NAMES: readonly string[]`, the 17 short names, sorted.
- Descriptors: read each validator in `ipc/agents-rpc.ts` and describe exactly the fields it ACCEPTS. A field it reads only to refuse is not listed. Recon found this list; the validator wins where they differ:
  - `catchup` and `changelog` (they share `requireCatchupParams`): `sinceMs`, `service`.
  - `standup`: `sinceMs`.
  - `oncall`: `incidentId` | `service` (group `target`, not required), plus `sinceMs`.
  - `expert`: `topicOrFile` | `itemUrl` (required group), plus `limit`.
  - `impact`: `fileOrPrUrl` (required), `depth`, `service`.
  - `ghost` and `conflicts`: `file` | {`service`, `repo`, `refAndPath`} (required group, arms `file` and `forge`), plus `namespace` and `namespaces` (`stringArray`).
  - `huddle`: `sinceMs`, `namespace`, `namespaces`.
  - `janitor`: `resourceRef` (required), `idleDays`, `cleanupAction`, `allowGaps` (`boolean`).
  - `preflight`: `ref` and `namespace` (both required), and `changedSurface` (take its kind from `requirePreflightParams`).
  - `why`: {`ref`, `line`} | `prUrl` | `itemUrl` (required group, arms `ref`, `prUrl`, `itemUrl`).
  - `glossary`: `term`, `limit`.
  - `decisions`: `sinceMs`, `minConfidence`, `service`, `explain` (`boolean`), `limit`.
  - `negotiate`: `sinceMs`, `personId` (Ruling 1).
  - `ownership`: `path` | `service` | `itemUrl` (group `target`, not required).
  - `premortem`: `epicRef` (required), `services` (`stringArray`), `repropose` (`boolean`).
- Wording: each `description` is one sentence of at most 120 characters, saying what the brief reports from the local index. It never promises a section the brief discloses as a gap. Use the agent's doc comment in `agents/<name>.ts` as the source.
- Audit extension:
  - `VALIDATOR_AGENT_OVERRIDES` gains `requireCatchupParams: ["catchup", "changelog"]` and `requireWhyRefParams: ["why"]`. The existing `AGENT_PARAM_KINDS` check is unaffected (`changelog` is not in that map, and `why.ref`/`why.line` already match).
  - New `export function checkCatalogParams(parsed, catalog: Readonly<Record<string, readonly { name: string; kind: ParamKind }[]>>): ParamKindsFinding[]`, with rule `missing-in-catalog`. Every field a validator type-checks, for EVERY agent the walker maps (all 17, not only the 12 external ones), must appear in that agent's catalog params with the same kind. It is one-directional, like `checkAgentParamKinds`, and below `VALIDATOR_FLOOR` it is `indeterminate`.
  - `ParamKindsFinding` gains the `missing-in-catalog` arm. `import.meta.main` reports both checks.

- [ ] **Step 1: Write the failing tests** in `agent-catalog.test.ts`:
  - `covers exactly the 17 brief methods`: the keys equal `Object.keys(FLEET_ELIGIBILITY)` minus `agents.whyPeek`, with length 17.
  - `every external agent's descriptors agree with AGENT_PARAM_KINDS`: for each agent in `AGENT_PARAM_KINDS`, every field there is a catalog param with the same kind.
  - `surfaces derive from the existing tables`: `standup` gives `{ external: false, fleet: true }`; `decisions` gives `{ external: true, fleet: true }`; `preflight` gives `{ external: false, fleet: false }`.
  - `oneOf groups are well formed`: every group has at least two arms, and no group member is `required: true`.
  - `display names and descriptions are short and single-line` (≤ 40 and ≤ 120 characters, no `\n`).
  - In `check-agent-param-kinds.test.ts`:
    - `checkCatalogParams flags a validator field missing from the catalog` (a synthetic parsed validator with a `bogus` field).
    - `checkCatalogParams passes on the real tree`: it parses the real `agents-rpc.ts` against the real catalog and returns `[]`.
    - The existing overrides pin is updated to the new override table.
- [ ] **Step 2: Run and see them fail:** `bun test packages/gateway/src/catalog/agent-catalog.test.ts scripts/structure-audit/check-agent-param-kinds.test.ts`.
- [ ] **Step 3: Implement** the table, `listCatalogAgents`, and the audit extension.
- [ ] **Step 4: Run and see them pass,** plus `bun run audit:agent-param-kinds` (expected: exit 0, nothing missing) and `bun test packages/gateway/src/ipc/agent-param-kinds*`.
- [ ] **Step 5: Commit** `feat(catalog): an agent catalog total over the 17 briefs, checked against the validators`.

### Task 4: connector metadata and the catalog builder

**Files:**
- Create: `packages/gateway/src/catalog/connector-catalog-meta.ts`, `packages/gateway/src/catalog/catalog-list.ts`
- Test: `packages/gateway/src/catalog/connector-catalog-meta.test.ts`, `packages/gateway/src/catalog/catalog-list.test.ts`

**Interfaces:**
- Consumes:
  - `CONNECTOR_SERVICE_IDS`/`ConnectorServiceId` (`connectors/connector-catalog.ts`) and `GATEWAY_SYNCABLE_SERVICE_IDS`/`GatewaySyncableServiceId` (`connectors/gateway-syncable-ids.ts`).
  - `listExtensions` (`automation/extension-store.ts`) and `listRunGrants` (`extensions/run-grant-store.ts`, for `service_id`).
  - `readVerifiedManifest` (`extensions/approve-run.ts`) and `listUserMcpConnectors` (`connectors/user-mcp-store.ts`).
  - Task 2's `resolveAgentVisibility`/`describeAgentVisibility` and Task 3's `listCatalogAgents`/`CATALOG_AGENT_NAMES`.
- Produces:
  - `export type ConnectorCategory = "storage" | "email" | "calendar" | "chat" | "meetings" | "code" | "ci-cd" | "issues" | "docs" | "cloud" | "observability" | "security" | "feature-flags" | "gitops" | "data" | "ml" | "deploy" | "finance" | "support" | "sales" | "design" | "hr" | "reading" | "research" | "local"`.
  - `export type ConnectorMeta = { readonly displayName: string; readonly category: ConnectorCategory; readonly description: string }`.
  - `export const CONNECTOR_CATALOG_META = Object.freeze({ … }) satisfies Readonly<Record<ConnectorServiceId | GatewaySyncableServiceId, ConnectorMeta>>`. Each `description` says what the service is (`"Atlassian's issue and project tracker"`), at most 100 characters. `packages/docs` connector pages are a good source for names and wording.
  - `export type CatalogConnector`:
    - `{ kind: "builtin"; id: string; displayName: string; category: ConnectorCategory; description: string }`
    - `| { kind: "extension"; id: string; serviceId: string | null; name: string | null; category: "extension" }`
    - `| { kind: "user-mcp"; id: string; name: string; category: "user-mcp" }`
  - `export type CatalogListResult = { readonly agents: readonly (CatalogAgent & { readonly visible: boolean })[]; readonly connectors: readonly CatalogConnector[]; readonly visibility: { readonly basis: "all" | "packs"; readonly packs: readonly string[]; readonly notes: readonly string[] } }`. `notes` is `describeAgentVisibility`'s output.
  - `export function buildCatalogList(deps: { readonly db: Database; readonly snapshot: () => Pick<ConfigSnapshot, "doc"> }): CatalogListResult`. Builtins come first, sorted by id, then extensions, then user MCP servers, each sorted by id. An extension's `name` is the verified manifest's `name`, cut to 200 characters, and `null` when absent or when `readVerifiedManifest` throws. `serviceId` comes from the extension's run grant, or is `null`. A user MCP entry's `name` is its `service_id`. Strings are returned raw; terminal stripping is the CLI's job (Task 6).

- [ ] **Step 1: Write the failing tests:**
  - `connector meta covers every catalog and gateway-syncable id`: the keys equal the union of the two arrays, with no extras.
  - `descriptions are single-line and at most 100 chars; display names at most 40`.
  - In `catalog-list.test.ts` (`openMigratedMemoryDb`, rows inserted through the stores' own writers or the same SQL their tests use, in a temp dir):
    - `lists every agent with visible from the snapshot`: a snapshot whose base hides `decisions` leaves `decisions` listed with `visible: false`, and the agent count is 17.
    - `lists builtins, then extensions, then user MCP servers`.
    - `an extension whose manifest fails verification is listed with name null` (manifest bytes changed after install).
    - `an approved extension carries its run grant's service id`.
- [ ] **Step 2: Run and see them fail:** `bun test packages/gateway/src/catalog`.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run and see them pass.**
- [ ] **Step 5: Commit** `feat(catalog): connector metadata and the catalog builder`.

### Task 5: `catalog.list`, LAN refusal, explain notes and the no-reader guard

**Files:**
- Create: `packages/gateway/src/ipc/catalog-rpc.ts`, `packages/gateway/src/ipc/catalog-rpc.test.ts`, `packages/gateway/src/catalog/visibility-is-presentation-only.test.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (a `tryDispatchCatalogRpc` beside `tryDispatchLocalityRpc`, plus its entry in the dispatcher list near line 1805), `packages/gateway/src/ipc/lan-rpc.ts` (`"catalog"` in `FORBIDDEN_OVER_LAN`, with a comment), `packages/gateway/src/config/config-explain.ts`, `packages/gateway/src/ipc/diagnostics-rpc.ts`
- Test: `packages/gateway/src/ipc/lan-rpc.test.ts`, `packages/gateway/src/config/config-explain.test.ts`, `packages/gateway/src/ipc/diagnostics-rpc.test.ts`

**Interfaces:**
- Consumes: Task 4's `buildCatalogList`, Task 2's `resolveAgentVisibility`/`describeAgentVisibility`, Task 3's `CATALOG_AGENT_NAMES`, and `getLayeredConfig(configDir).snapshot()`.
- Produces:
  - `export class CatalogRpcError extends Error { readonly rpcCode: number }`.
  - `export function dispatchCatalogRpc(method: string, params: unknown, ctx: { readonly db: Database; readonly configDir: string }): { kind: "hit"; value: CatalogListResult } | { kind: "skip" }`. Only `catalog.list` is served. `params` must be `undefined`, `null` or `{}`; anything else raises `-32602`, `catalog.list takes no params`.
  - `tryDispatchCatalogRpc` throws `-32603`, `catalog.list requires LocalIndex`, when `localIndex` is absent, mirroring `tryDispatchLocalityRpc`.
  - `explainConfig`'s `opts` gains `readonly agentVisibilityNotes?: () => readonly string[]`. It is called only when the path is `agents` or starts with `agents.`, and its lines are appended to `notes` after the fleet notes. `diagnostics-rpc.ts` supplies it as `() => describeAgentVisibility(resolveAgentVisibility(reader.snapshot(), CATALOG_AGENT_NAMES))`. Import `catalog/` directly here (ipc may import catalog). Then confirm `bun run audit:boundaries` and the circular-dependency check still pass.
- The guard test (`visibility-is-presentation-only.test.ts`) scans every non-test `.ts` file under `packages/gateway/src`:
  - (a) `resolveAgentVisibility` is named only in `catalog/agent-visibility.ts`, `catalog/catalog-list.ts` and `ipc/diagnostics-rpc.ts`.
  - (b) No file under `ipc/agents-rpc.ts`, `ipc/http-*.ts`, `fleet/`, `chatops/`, `agent-runs/`, `engine/` or `mcp-sink/` imports from `catalog/`.
  - (c) `parseNimbusAgentsToml` returns exactly the keys `synthesis` and `synthesisTimeoutMs` (a `Object.keys` pin), so the `[agents]` loader never starts reading `show`/`hide`/`visible`.
  - It must be red-proven: add a temporary `resolveAgentVisibility` reference to `ipc/agents-rpc.ts`, see the test fail, then revert.

- [ ] **Step 1: Write the failing tests:**
  - `catalog-rpc.test.ts`:
    - `catalog.list returns 17 agents and every builtin connector`.
    - `rejects params`.
    - `skips other methods`.
    - `visible follows a profile's show over the base's hide`, with a real temp configDir holding base and profile files, through `initLayeredConfig`, with `forgetLayeredConfigForTests` in `afterEach`.
  - `lan-rpc.test.ts`: `catalog.list is LAN-forbidden`.
  - `config-explain.test.ts`:
    - `agents paths append the visibility notes`.
    - `other paths do not call agentVisibilityNotes` (the callback throws if called).
  - `diagnostics-rpc.test.ts`: `config.explain agents.visible names an unknown pack agent`.
  - The guard test, as above.
- [ ] **Step 2: Run and see them fail:** `bun test packages/gateway/src/ipc/catalog-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts packages/gateway/src/config/config-explain.test.ts packages/gateway/src/ipc/diagnostics-rpc.test.ts packages/gateway/src/catalog`.
- [ ] **Step 3: Implement.** Do not add `catalog.list` to `gateway_bridge.rs`'s `ALLOWED_METHODS` (spec § 8 call 8). If a test classifies every served method for renderer exposure, list it there as NOT exposed.
- [ ] **Step 4: Run and see them pass,** plus `bun test packages/gateway/src/ipc packages/gateway/src/config packages/gateway/src/catalog`.
- [ ] **Step 5: Commit** `feat(ipc): catalog.list, LAN-forbidden; config explain reports agent visibility`.

### Task 6: `nimbus catalog`, the end-to-end proof and the docs

**Files:**
- Create: `packages/cli/src/commands/catalog.ts`, `packages/cli/src/commands/catalog.test.ts`, `packages/gateway/test/e2e/catalog-list.e2e.test.ts`
- Modify: `packages/cli/src/index.ts` (`COMMAND_HANDLERS`), `packages/cli/src/commands/help.ts`, `docs/cli-reference.md`, `docs/architecture.md` (§ Layered config and the IPC method catalogue), `docs/CHANGELOG.md`, and any `[agents]` configuration reference that documents `synthesis` (grep for it)

**Interfaces:**
- Consumes: `catalog.list` (Task 5) over the CLI's IPC client, mirroring an existing read command such as `stats.ts`. Also `stripControlChars` (`packages/cli/src/lib/strip-control-chars.ts`).
- Produces: `nimbus catalog [agents|connectors] [--json]`.
  - With no subcommand it prints both lists. An unknown subcommand prints the usage and exits 1.
  - `--json` prints the raw `CatalogListResult`, filtered to the half that was asked for.
  - The agents table has the columns `name`, `shown`, `category` and `description`. A hidden agent shows `hidden`, and the visibility summary line comes first.
  - The connectors table has `id`, `name` and `category`, with owner-added servers after the builtins. Every extension and user MCP string goes through `stripControlChars` before printing, and an absent name prints `(no name)`.
  - The help line reads `nimbus catalog [agents|connectors] [--json]   List agents and connectors with descriptions`. Help is not filtered.

- [ ] **Step 1: Write the failing tests:**
  - `catalog.test.ts`, with an injected IPC fake in the style of the neighbouring command tests:
    - `prints hidden agents as hidden`.
    - `--json prints only the requested half`.
    - `strips control characters from an extension name`: the name `"evil\u001b[2Jname"` is printed, and the output contains `evil` and no `\u001b`.
    - `unknown subcommand exits 1`.
  - `catalog-list.e2e.test.ts` boots a real gateway subprocess in the style of `test/e2e/explain-last.e2e.test.ts`, with a temp configDir whose `nimbus.toml` holds `[agents]\nhide = ["decisions"]`:
    - `catalog.list routes over the real socket and reports decisions hidden`.
    - `a hidden agent still answers`: `agents.decisions` returns a `sessionId`.
- [ ] **Step 2: Run and see them fail:** `bun test packages/cli/src/commands/catalog.test.ts packages/gateway/test/e2e/catalog-list.e2e.test.ts`.
- [ ] **Step 3: Implement the command and write the docs:**
  - `cli-reference.md`: a `nimbus catalog` section, plus `[agents] show`/`hide`/pack `visible` under the agents configuration, including the per-agent precedence rule and that visibility never refuses a call.
  - `architecture.md`: visibility and the catalog in § Layered config, and `catalog.list` in the IPC catalogue as LAN-forbidden and not renderer-exposed yet.
  - `CHANGELOG.md`: a dated entry.
- [ ] **Step 4: Run and see them pass,** plus `bun test packages/cli/src/commands` and `bun run audit:doc-refs`.
- [ ] **Step 5: Commit** `feat(cli): nimbus catalog lists agents and connectors; docs`.

### Task 7: preflight and PR

- [ ] **Step 1:** Run `bun run preflight:fast`, then the catalog, config, packs, ipc and CLI command test trees, plus the new e2e file. If the worktree is fresh, build the sandbox helper first: `& (Get-Process -Id $PID).Path -NoProfile -File scripts/build-sandbox-helper-win32.ps1`.
- [ ] **Step 2:** Confirm that `git diff origin/main --stat` lists no `docs/superpowers/` file, and that the branch is based on `origin/main` (rebase if it was stacked on PR 4).
- [ ] **Step 3:** Open a PR titled `feat(catalog): agent visibility and a catalog of agents and connectors` (no `!`). The body covers:
  - the summary, and that visibility is presentation only;
  - the five rulings above;
  - that `catalog.list` is LAN-forbidden and not yet on the Tauri allowlist;
  - what is not included: desktop and onboarding adoption (Projects 4/5), and `pack.install` (Project 3).

  Include the verification evidence, and end the body with "🤖 Generated with [Claude Code](https://claude.com/claude-code)".
