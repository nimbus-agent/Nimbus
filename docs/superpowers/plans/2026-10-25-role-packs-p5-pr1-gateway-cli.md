# Role packs P5 PR 1 — onboarding: gateway + CLI — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the gateway the reads role-aware onboarding needs (`pack.list` roles/suggestions, `catalog.list` suggestions/sign-in, `decisions.status`, a pack-aware tour) and make `nimbus init` ask "What do you do?" and work outside a git repository.

**Architecture:** Additive read fields on two existing methods, one new read method in the LAN-forbidden `decisions.*` namespace, an optional visibility filter on `buildTourPlan`, and a new CLI module `init-role.ts` that runs after the existing repository step. No schema change, no invariant, no egress class, no Tauri allowlist change (that is PR 2).

**Tech Stack:** Bun 1.4, TypeScript strict, `bun:test`, `@clack/prompts`.

**Spec:** `docs/superpowers/specs/2026-10-25-role-packs-p5-onboarding-design.md` (§ 4–8, § 11 CLI half, § 12 PR 1). Branch `dev/asaf/role-packs-p5-onboarding`, worktree `C:/gitrep/Nimbus/.claude/worktrees/role-packs-p5-onboarding`.

## Global Constraints

- No code branches on a pack id (`"pm"`, `"devops"` appear only in tests and bundled JSON).
- No `any`; external/IPC data is `unknown` and validated.
- Non-interactive `nimbus init` inside a git repository without `--role` produces byte-identical output and exit codes to today (install-smoke greps `Try it:` and `indexing did not complete`).
- `catalog/` imports nothing from `ipc/`; a new importer of `catalog/` joins `CATALOG_IMPORTERS_ALLOWED` with a reason (`catalog/visibility-is-presentation-only.test.ts`).
- No file outside `ipc/agents-rpc.ts` imports `agents/<name>.ts` (D22(d)) — shared constants go in `decisions/` or `agents/_lib/`.
- Never name `readwise` in production code or comments.
- Neutral suggestions, exact order: `google_drive`, `slack`, `notion`, `gmail`, `github`, `linear`.
- Decisions default window: 90 days (`90 * 24 * 60 * 60 * 1000`), `recent` cap 5, statement cap 280 chars.
- Not a breaking change: PR title `feat(onboarding): …` with no `!`.

## Plan-time decisions that refine the spec

These follow from code the spec did not account for; the spec is updated in the same commit as this plan.

1. **The role question is asked once the gateway is up, not before the repository step.** The CLI cannot know the bundled packs without `pack.list`, and starting the gateway before appending a filesystem root would turn every first run into `restart-required` (`platform/assemble.ts` reads roots at boot). Inside a repository the question follows a successful index; outside one it follows the gateway start. `--no-sync`, `gateway-unavailable`, `restart-required` and `index-failed` never ask.
2. **`--role` syntax is checked before anything runs; its value is resolved against `pack.list` after the gateway answers.** An unknown value is reported and the run exits 1 (the repository step, if any, already succeeded and says so).
3. **Outside a repository the tour is not offered** (a fresh index has nothing to tour); `nimbus wow` still appears in the next steps.
4. **`decisions.status` drops the spec's `extraction` field** — the dispatcher cannot see whether a local model is wired, and nothing in § 7.2 reads it.
5. **Engineering ≡ today.** The "legacy" path (non-interactive, in a repository, no `--role`) and an explicit Engineering answer run the same code: today's adoption offer and tour offer.

## Review Focus

1. A pack whose installed record is unreadable — `pack.list` rows must still parse (`roles: []`, `suggestedConnectors: []`) and `catalog.list` must still answer (that pack contributes no suggestions). → Task 1, Task 2 tests.
2. `decisions.status` with `[decisions] enabled = false` (no refresher) must answer `enabled: false`, not `Method not found`. → Task 3 test.
3. A decision older than the window must count in neither `candidates` nor `shown` (B1's "too uncertain" reason must not fire for old rows). → Task 3 test.
4. A user `[agents] hide = ["decisions"]` with no packs hides the tour's decisions step (skip reason `hidden in your config`). → Task 4 test.
5. `nimbus init` in a repo, non-TTY, no flags — output identical to today; and `--role bogus` in a repo exits 1 after indexing, saying the repository was indexed. → Task 6 tests.

---

### Task 1: `pack.list` rows carry `roles` and `suggestedConnectors`; active-pack suggestions; meta key

**Files:**
- Modify: `packages/gateway/src/packs/pack-install.ts` (`PackListResult` :82, `listPacks` :443, `installedEntry`)
- Modify: `packages/gateway/src/index/local-index.ts:286` (`ALLOWED_META_KEYS`)
- Test: `packages/gateway/src/packs/pack-install.test.ts`, `packages/gateway/src/index/local-index.test.ts` (or wherever `ALLOWED_META_KEYS` is already tested — `rg ALLOWED_META_KEYS packages/gateway/src`)

**Interfaces:**
- Produces: `PackListResult.installed[number]` and `.available[number]` gain `roles: readonly string[]`, `suggestedConnectors: readonly string[]` (from the record's manifest for installed, the bundled manifest for available; `[]` when the record is unreadable).
- Produces: `export function activePackSuggestedConnectors(deps: Pick<PackDeps, "store" | "configDir">): readonly string[]` — union over the active profile's listed packs in `store.read(profile).layers` order, each record's `manifest.suggestedConnectors` in order, first occurrence wins; an unreadable record contributes nothing; an unreadable `active.json` returns `[]`.

- [ ] **Step 1: Failing tests** — in `pack-install.test.ts`:
  - `listPacks: available rows carry the bundled manifest's roles and suggestedConnectors` → for the bundled `pm` fixture expect `roles: ["product"]`, `suggestedConnectors: ["slack","jira","notion","google_drive"]`.
  - `listPacks: an installed row carries its RECORD's roles and suggestions, not the bundled copy's` (install a file pack whose manifest differs from the bundled one, as the existing `visibleAgents` record test does).
  - `listPacks: a version-unknown installed row has roles [] and suggestedConnectors []`.
  - `activePackSuggestedConnectors: unions active packs in active order, first occurrence wins` (two packs `a: [slack, jira]`, `b: [jira, pagerduty]` → `[slack, jira, pagerduty]`).
  - `activePackSuggestedConnectors: [] with no packs, and an unreadable record contributes nothing`.
  - `local-index`: `setMeta("role_pack_card_dismissed", …)` round-trips; an unknown key is still refused.
- [ ] **Step 2: Run** `bun test packages/gateway/src/packs/pack-install.test.ts packages/gateway/src/index/local-index.test.ts` → the new tests FAIL.
- [ ] **Step 3: Implement** the two fields in `installedEntry` (both arms) and the `available` map; add `activePackSuggestedConnectors`; add `"role_pack_card_dismissed"` to `ALLOWED_META_KEYS`. Also update the CLI's structural `InstalledPackRow`/`AvailablePackRow` in `packages/cli/src/commands/pack.ts` with the two fields as optional, and `packages/ui/src/ipc/types.ts` `PackListResult` installed rows with optional `roles?`/`suggestedConnectors?` (available stays `unknown[]` there).
- [ ] **Step 4: Run** the same tests → PASS; `bun run typecheck` → clean.
- [ ] **Step 5: Commit** `feat(packs): pack.list rows carry roles and suggested connectors`.

### Task 2: `catalog.list` gains `suggestedConnectors` and per-connector `signIn`

**Files:**
- Modify: `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` (export `connectorSignInKind`)
- Modify: `packages/gateway/src/catalog/catalog-list.ts` (`CatalogConnector` builtin arm, `CatalogListResult`, `buildCatalogList` deps)
- Modify: `packages/gateway/src/ipc/catalog-rpc.ts` (`CatalogRpcContext`), `packages/gateway/src/ipc/server/dispatchers.ts` (catalog dispatcher ~:997 passes the pack store)
- Test: `packages/gateway/src/ipc/connector-rpc-handlers/auth.test.ts`, `packages/gateway/src/catalog/catalog-list.test.ts`, `packages/gateway/src/ipc/catalog-rpc.test.ts`

**Interfaces:**
- Consumes: `activePackSuggestedConnectors` (Task 1).
- Produces: `export type ConnectorSignInKind = "browser" | "atlassian" | "terminal";` and `export function connectorSignInKind(id: string): ConnectorSignInKind` in `auth.ts` — `"atlassian"` for `jira`/`confluence`; `"terminal"` for any id that is not a `ConnectorServiceId`, has a `PAT_CONNECTOR_AUTH_HANDLERS` entry, or for which `connectorAuthUnavailableMessage` is non-null; `"browser"` otherwise.
- Produces: builtin `CatalogConnector` gains `readonly signIn: ConnectorSignInKind`; `CatalogListResult` gains `readonly suggestedConnectors: readonly string[]`; `buildCatalogList(deps: { db; snapshot; signInFor: (id: string) => ConnectorSignInKind; packSuggestions: readonly string[] })`; `export const NEUTRAL_SUGGESTED_CONNECTORS = ["google_drive","slack","notion","gmail","github","linear"] as const` in `catalog-list.ts`.
- Produces: `CatalogRpcContext` gains `packSuggestions: () => readonly string[]` (the dispatcher passes `() => store === undefined ? [] : activePackSuggestedConnectors({ store, configDir })`).

- [ ] **Step 1: Failing tests**
  - `auth.test.ts` — `connectorSignInKind`: `slack` → `browser`, `google_drive` → `browser`, `notion` → `browser`, `jira` → `atlassian`, `confluence` → `atlassian`, `github` → `terminal`, `linear` → `terminal`, `pagerduty` → `terminal`, `not_a_service` → `terminal`; plus a totality test: for every id in `CONNECTOR_SERVICE_IDS`, `connectorSignInKind(id) === "browser"` iff `PAT_CONNECTOR_AUTH_HANDLERS[id] === undefined && connectorAuthUnavailableMessage(id) === null` (export a test-only accessor only if needed; prefer asserting via `handleConnectorAuth` arm choice already covered — keep the property test over public functions).
  - `catalog-list.test.ts` — `suggestedConnectors is the neutral default with no pack suggestions`; `pack suggestions replace the neutral default, in order`; `an id not in the catalog is dropped` (`["slack","no_such","jira"]` → `["slack","jira"]`); `every builtin row carries signIn from signInFor`.
  - `catalog-rpc.test.ts` — the RPC passes `packSuggestions()` through (fake returning `["jira"]` → result `suggestedConnectors: ["jira"]`).
- [ ] **Step 2: Run** those three files → FAIL.
- [ ] **Step 3: Implement.** Suggestions: `packSuggestions.length > 0 ? packSuggestions : NEUTRAL_SUGGESTED_CONNECTORS`, then filter to ids present as a builtin `id` or an extension `serviceId` in the same result, preserving order. `catalog-rpc.ts` supplies `signInFor: connectorSignInKind` (ipc → ipc import, allowed). Update the CLI structural catalog type in `packages/cli/src/commands/catalog.ts` and `packages/ui/src/ipc/types.ts` `CatalogListResult` with `suggestedConnectors?` and builtin `signIn?` optional.
- [ ] **Step 4: Run** the tests + `bun test packages/gateway/src/catalog` (presentation-only rules) + `bun run typecheck` → PASS.
- [ ] **Step 5: Commit** `feat(catalog): catalog.list suggests connectors from the active packs and says how each signs in`.

### Task 3: `decisions.status`

**Files:**
- Create: `packages/gateway/src/decisions/decision-status.ts`
- Modify: `packages/gateway/src/decisions/decision-store.ts` (two windowed counters), `decisions/decision-types.ts` (window constant), `agents/decisions.ts` (import the constant instead of its local `DEFAULT_WINDOW_MS`), `decisions/decision-refresh.ts` (`status()`), `ipc/decisions-rpc.ts`, `ipc/server/dispatchers.ts` (`tryDispatchDecisionsRpc` :1651)
- Test: `packages/gateway/src/decisions/decision-status.test.ts` (real migrated SQLite, as `decision-store.test.ts` does), `decisions/decision-refresh.test.ts`, `ipc/decisions-rpc.test.ts`, `ipc/lan-rpc.test.ts` (one case: `decisions.status` is LAN-forbidden)

**Interfaces:**
- Produces in `decision-types.ts`: `export const DECISIONS_DEFAULT_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;`
- Produces in `decision-store.ts`: `countByStatusSince(db, mapping, sinceMs): { pending; extracted; vetoed }` (same SQL as `countByStatus` plus `d.decided_at >= ?`); `countShown(db, { sinceMs, minConfidence, mapping }): number` (the `listDecisions` WHERE, `COUNT(*)`).
- Produces in `decision-refresh.ts`: `DecisionRefresher.status: () => "idle" | "running" | "stopped" | "disabled"` (the scheduler's).
- Produces in `decision-status.ts`:
  ```ts
  export interface DecisionStatusResult {
    readonly enabled: boolean;
    readonly state: "idle" | "running" | "stopped" | "disabled";
    readonly lastPassAt: number | null;
    readonly minConfidence: number;
    readonly windowDays: number;
    readonly sources: readonly { service: string; type: string; kind: string; items: number }[];
    readonly candidates: { readonly pending: number; readonly extracted: number; readonly vetoed: number };
    readonly shown: number;
    readonly recent: readonly { statement: string; service: string; at: number }[];
  }
  export function readDecisionStatus(db: Database, opts: {
    mapping: SourceMapping; nowMs: number; minConfidence: number;
    refresherState: DecisionStatusResult["state"] | undefined; // undefined = no refresher
  }): DecisionStatusResult
  ```
  `sources`: for each `serviceType` in `mapping.typesFor("decisions")`, `COUNT(*) FROM item WHERE service = ? AND type = ? AND modified_at >= ?` (use the V74 `idx_item_service_type_modified` index), keep `items > 0`, kind from `mapping.kindOf`, sort items desc then `serviceType` by code unit. `recent`: `listDecisions(db, { sinceMs, minConfidence, limit: 5, mapping })`, statement `?? cueText` truncated to 280, `service` = the source item's `service` (one `SELECT service FROM item WHERE id IN (…)`; a missing item → `"unknown"`), `at = decidedAt`. `enabled = refresherState !== undefined`; `state = refresherState ?? "disabled"`.
- Produces in `decisions-rpc.ts`: `export function handleDecisionsStatus(params: unknown, ctx: { db: Database; configDir: string | undefined; refresher: DecisionRefresher | undefined; nowMs: () => number }): DecisionStatusResult` — refuses non-empty params (`-32602`), reads `loadNimbusDecisionsFromConfigDir(configDir).minConfidence` (0 when `configDir` undefined, mirroring `tour-rpc.ts`) and `sourceMappingFor(configDir)` fresh per call.

- [ ] **Step 1: Failing tests** (`decision-status.test.ts`, real DB with `item` + `decision_record` rows):
  - `counts only effective decision source types with items in the window` (a `slack:message` in window, a `slack:message` older than 90 d, a `jira:issue` in window → `sources` = slack 1, jira 1, no zero rows).
  - `candidates and shown use the window: a 100-day-old extracted row counts in neither`.
  - `shown counts extracted rows at or above minConfidence only`.
  - `recent is newest first, capped at 5, statement truncated to 280`.
  - `refresherState undefined → enabled false, state "disabled"`.
  - `decision-refresh.test.ts`: `status() reports running during a pass and idle after`.
  - `decisions-rpc.test.ts`: `decisions.status answers with no refresher`; `refuses params`.
  - `lan-rpc.test.ts`: `decisions.status is LAN-forbidden`.
  - A dispatcher-level test (`ipc/server/dispatchers` test file that already covers `tryDispatchDecisionsRpc`, else `decisions-rpc.test.ts` through `tryDispatchDecisionsRpc` with a fake `ServerCtx`): `decisions.status routes when decisionsRefresher is undefined`; `decisions.refresh still skips (Method not found) when it is undefined`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** In `tryDispatchDecisionsRpc`, before the `refresher === undefined` return: `if (method === "decisions.status")` → require `ctx.options.localIndex` (else `-32603`), call `handleDecisionsStatus`. `agents/decisions.ts` imports `DECISIONS_DEFAULT_WINDOW_MS`.
- [ ] **Step 4: Run** `bun test packages/gateway/src/decisions packages/gateway/src/ipc/decisions-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts packages/gateway/src/agents/decisions.test.ts` → PASS.
- [ ] **Step 5: E2E routing proof** (memory: an IPC method needs ROUTING, not just a handler): add one case to an existing gateway e2e that boots a real gateway (e.g. `packages/gateway/test/e2e/explain-last.e2e.test.ts`'s harness) calling `decisions.status` over the socket and asserting `typeof result.enabled === "boolean"`. Run it.
- [ ] **Step 6: Commit** `feat(decisions): decisions.status reports what the pass read and found`.

### Task 4: the tour follows agent visibility

**Files:**
- Modify: `packages/gateway/src/catalog/agent-visibility.ts` (export `visibleAgentNames`), `packages/gateway/src/agents/_lib/tour-plan.ts` (`opts.visible`, kind→agent map), `packages/gateway/src/ipc/tour-rpc.ts`, `packages/gateway/src/catalog/visibility-is-presentation-only.test.ts` (`CATALOG_IMPORTERS_ALLOWED` += `ipc/tour-rpc.ts`, with a reason line)
- Test: `agents/_lib/tour-plan.test.ts`, `ipc/tour-rpc.test.ts`

**Interfaces:**
- Produces: `export function visibleAgentNames(snapshot: Pick<ConfigSnapshot, "doc">): { readonly visible: ReadonlySet<string>; readonly basis: "all" | "packs" }` (wraps `resolveAgentVisibility(snapshot, CATALOG_AGENT_NAMES)`).
- Produces: `export const TOUR_KIND_AGENT: Readonly<Record<TourStepKind, string>>` in `tour-plan.ts` — `why: "why", owners: "ownership", oncall: "oncall", standup: "standup", decisions: "decisions", glossary: "glossary"` (verify each against `CATALOG_AGENT_NAMES`).
- Produces: `buildTourPlan(ctx, opts: { steps; demo; selectors?; visible?: { set: ReadonlySet<string>; basis: "all" | "packs" } })` — a kind whose agent is not in `visible.set` is skipped with reason `"hidden by your role packs"` (basis `packs`) or `"hidden in your config"` (basis `all`), and its selector is NOT run.

- [ ] **Step 1: Failing tests**
  - `tour-plan.test.ts`: `with no visible option every kind is evaluated (unchanged)`; `a kind whose agent is hidden is skipped with the packs reason and its selector never runs` (selector spy count 0); `basis all → "hidden in your config"`; `TOUR_KIND_AGENT names only catalog agents` (`every value ∈ CATALOG_AGENT_NAMES` — import from `catalog/agent-catalog.ts` in the TEST only).
  - `tour-rpc.test.ts`: `a configDir whose nimbus.toml has [agents] hide = ["decisions"] skips decisions`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `tour-rpc.ts` computes `visibleAgentNames(getLayeredConfig(configDir).snapshot())` when `configDir` is defined (otherwise no `visible` option). Demo: `demo/seed.ts` does not call `buildTourPlan` (verify with `rg buildTourPlan`); no change there.
- [ ] **Step 4: Run** `bun test packages/gateway/src/agents/_lib packages/gateway/src/ipc/tour-rpc.test.ts packages/gateway/src/catalog` and `bun scripts/release/assert-demo-tour.ts --help`-style self-check if it has one (else its own test file under `scripts/release/`) → PASS.
- [ ] **Step 5: Commit** `feat(tour): nimbus wow skips agents your packs or config hide`.

### Task 5: `nimbus pack list` tip

**Files:**
- Modify: `packages/cli/src/commands/pack.ts` (`listLines`)
- Test: `packages/cli/src/commands/pack.test.ts`

- [ ] **Step 1: Failing tests**: `list ends with a tip when nothing is installed and something is available` → last line exactly `Tip: nimbus pack install <id> sets Nimbus up for a role (Product, DevOps).` built from the available rows' `name`s in order (fixture names); `no tip when a pack is installed`; `no tip when listError is set`; `no tip with --json`.
- [ ] **Step 2: Run** `bun test packages/cli/src/commands/pack.test.ts` → FAIL.
- [ ] **Step 3: Implement** in `listLines` (names via `clean`).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(cli): nimbus pack list suggests a role pack when none is installed`.

### Task 6: `nimbus init` — role question, `--role`, outside a repository

**Files:**
- Create: `packages/cli/src/commands/init-role.ts`
- Modify: `packages/cli/src/commands/init.ts` (`InitPlan`, `InitOutcome`, `INIT_EXIT` docs, `HELP_LINES`, `initOutcome`, `reportOutcome`, `runInit`, `InitDeps`, `defaultInitDeps`)
- Test: `packages/cli/src/commands/init-role.test.ts`, `packages/cli/src/commands/init.test.ts`

**Interfaces:**
- Produces in `init-role.ts`:
  ```ts
  export type RoleAnswer =
    | { kind: "pack"; packId: string; name: string; installed: boolean; visibleAgents: readonly string[] }
    | { kind: "engineering" } | { kind: "design" } | { kind: "other" };
  export interface RoleChoice { readonly value: string; readonly label: string; readonly hint?: string }
  /** `--role` syntax: /^[a-z][a-z0-9_-]{0,31}$/; undefined when absent; throws RoleFlagError on bad syntax or a missing value. */
  export function parseRoleFlag(args: readonly string[]): string | undefined;
  /** From a raw `pack.list` reply (unknown, validated): one choice per pack (installed first, then available, list order, deduped by id) labelled `name`, hint `description`, value `pack:<id>`; then engineering/design/other. */
  export function roleChoices(packList: unknown): readonly RoleChoice[];
  /** Resolve a `--role` value or a chosen `value`: `pack:<id>`, a pack id, a pack role tag (first pack whose `roles` contains it), or engineering|design|other; undefined when unknown. */
  export function resolveRole(value: string, packList: unknown): RoleAnswer | undefined;
  /** Suggested connectors with state: from raw `catalog.list` + raw `connector.listStatus`; connected = a status row whose healthState is defined and not "unauthenticated" (Connect.tsx's rule). */
  export function connectorSuggestions(catalog: unknown, statuses: unknown):
    readonly { id: string; displayName: string; signIn: "browser" | "atlassian" | "terminal"; connected: boolean }[];
  export interface RoleStepDeps {
    readonly interactive: boolean;
    readonly log: (l: string) => void; readonly error: (l: string) => void;
    readonly call: (method: string, params?: unknown) => Promise<unknown>;
    readonly selectRole: (choices: readonly RoleChoice[]) => Promise<string | undefined>; // undefined = cancelled
    readonly installPack: (id: string) => Promise<number>;      // exit code of the pack-install path
    readonly confirmConnect: (displayName: string) => Promise<boolean>;
  }
  /** Ask (or take `flagRole`), then run the pack step and the connector step. Returns the answer, or "unknown-role". */
  export async function runRoleStep(flagRole: string | undefined, deps: RoleStepDeps): Promise<RoleAnswer | "unknown-role">;
  ```
- Connector step lines (exact copy): header `Connectors for <label>:` (label = pack name, or `getting started` for neutral); per row `  <displayName>  connected` or `  <displayName>  not connected — nimbus connector auth <id>`; the browser offer prompt `Connect <displayName> now? (opens your browser)`; after a pack whose `visibleAgents` include `decisions`: `Nimbus looks for decisions after your connectors sync: nimbus decisions`.
- Pack step lines: not installed + interactive → `The <name> pack sets Nimbus up for this role. You'll be asked to approve exactly what it changes.` then `installPack(id)`; non-zero → `The <name> pack was not installed; continuing without it.`; already installed → `The <name> pack is already installed.`; non-interactive → `Next: nimbus pack install <id>`.
- `InitPlan`: `not-a-repo` → `no-repo`. `InitOutcome`: remove `not-a-repo`; add `{ kind: "no-repo"; gatewayUp: boolean }` (exit 0). `INIT_EXIT.usage` stays 1 and now documents "an invalid --role".
- `InitDeps` gains `role: RoleStepDeps` (the `interactive`/`log`/`error` inside it are the same values as the top-level ones) — tests fake it whole.

- [ ] **Step 1: Failing tests, `init-role.test.ts`** (pure functions, raw fixtures shaped like the gateway's real `listPacks` output — build them from Task 1's `PackListResult`, not by hand-inventing fields):
  - `roleChoices lists one choice per pack then Engineering, Design, Something else`; labels `Product`, `DevOps`, `Engineering`, `Design`, `Something else`.
  - `roleChoices tolerates a malformed reply` (non-object → only the three fixed choices).
  - `resolveRole: "product" → the pm pack via its roles tag; "pm" → the pm pack by id; "sre" → devops; "engineering"; "bogus" → undefined`.
  - `parseRoleFlag: --role product → "product"; absent → undefined; "--role" with no value or "--role Bad!" → throws`.
  - `connectorSuggestions keeps catalog order and marks connected from listStatus`.
  - `runRoleStep with a pack answer not installed, interactive: installs, then lists the pack's suggestions, offers browser sign-in only for not-connected browser connectors, prints the decisions line`.
  - `runRoleStep non-interactive with a pack flag: never calls installPack, prints Next: nimbus pack install <id>`.
  - `runRoleStep: a declined install (installPack → 1) prints the not-installed line and still lists connectors`.
  - `runRoleStep: cancelled select → other (neutral)`.
  - `runRoleStep: design → neutral header "Connectors for getting started:", no pack calls`.
  - `runRoleStep: unknown flag value → "unknown-role" and no pack/auth calls`.
- [ ] **Step 2: Failing tests, `init.test.ts`** (extend `fakeDeps` with a recording `role` fake; reuse `withCiUnset`):
  - Replace `exits non-zero outside a git repository` with `outside a git repository: starts the gateway, writes no root, exits 0` (`rec.synced === 0`, no `nimbus.toml` root, `process.exitCode === 0`).
  - `outside a repo, --no-sync: starts nothing, exits 0, asks no role`.
  - `outside a repo, gateway never ready: exit 2, no role step`.
  - `in a repo, non-interactive, no --role: output and calls identical to today` — assert the exact `rec.out` lines of the existing happy-path test and that `role` was never called.
  - `in a repo, interactive, Engineering: today's adoption offer and tour offer run; no pack calls`.
  - `in a repo, interactive, Product: no adoption offer; role step runs after indexing; tour offer still runs` (assert `rec.order`).
  - `--role bogus in a repo: indexes, then reports the unknown role, exit 1` (error names the accepted values).
  - `--role Bad! is a usage error before anything runs` (no start, no sync, exit 1).
  - `--demo still refuses before --role is parsed`.
  - `restart-required / index-failed / gateway-unavailable never run the role step`.
  - Update `initPlan` / `initExitCode` tests for `no-repo`; `--help documents every exit code` now expects `--role` in usage and the new exit-1 wording.
- [ ] **Step 3: Run** `bun test packages/cli/src/commands/init.test.ts packages/cli/src/commands/init-role.test.ts` → FAIL.
- [ ] **Step 4: Implement.**
  - `runInit` order: `--help` → demo refusal → `parseRoleFlag` (catch → usage error, exit 1) → `initOutcome` → `reportOutcome` → if outcome is `indexed` or (`no-repo` and `gatewayUp`): decide the path — legacy when `!interactive && flag === undefined && outcome.kind === "indexed"`; otherwise `runRoleStep` (interactive and not `CI=true`, or a flag given). Adoption offer: legacy, Engineering, or Engineering outside a repo (outside a repo first log `No git repository here; run nimbus init inside one to index code.`). Tour offer: today's rule unchanged (`indexed` with `demo !== null`, not `CI=true`, interactive), for every answer — spec § 5.2. `unknown-role` → error `nimbus init: unknown --role "<v>". Use one of: <pack ids and role tags>, engineering, design, other.` + `The repository was indexed.` when `indexed`, exit 1.
  - `defaultInitDeps().role`: `call` = `withGatewayIpc((c) => c.call(method, params), paths)`; `selectRole` = `@clack/prompts` `select({ message: "What do you do?", options })`, `isCancel` → undefined; `installPack(id)` = run `runPackWith(["install", id], REAL_IO-equivalent, call)` on a client that registered `registerConsentPromptHandler` — extract `runPack`'s client setup into an exported `withPackClient<T>(fn: (call) => Promise<T>): Promise<T>` in `pack.ts` and reuse it (never `withGatewayIpc`, whose script consent handler must not answer a pack approval — memory P3 PR 2 lesson); `confirmConnect` = `confirm`.
  - `HELP_LINES` + `Exit codes:` block: usage line `nimbus init [--no-sync] [--no-detect] [--role <role>]`, flag line `--role      skip the "What do you do?" question (a pack role or id, engineering, design, other)`, exit `0` adds "or there is no git repository here (nothing to index)", exit `1` becomes "usage error (an invalid --role)".
- [ ] **Step 5: Run** both files → PASS; then `bun test packages/cli/src` (catches structural-type users) → PASS.
- [ ] **Step 6: Commit** `feat(cli): nimbus init asks what you do and works outside a git repository`.

### Task 7: docs

**Files:** `docs/cli-reference.md` (`nimbus init` § 41: role question, `--role`, outside-repo, exit table; `nimbus pack list` tip; `nimbus wow` hidden kinds), `docs/architecture.md` (IPC catalogue: `decisions.status`; `catalog.list` `suggestedConnectors`/`signIn`; `pack.list` rows; the pack-layers paragraph :2621 gains the two row fields), `docs/roadmap.md` (Project 5 row: PR 1 shipped, PR 2 desktop next — find the role-packs row with `rg -n "Role packs" docs/roadmap.md`), `docs/CHANGELOG.md` (dated entry at the top of Post-Phase-6, same style as 2b's), `packages/docs/src/content/docs/**` page for `nimbus init` if one exists (`rg -l "nimbus init" packages/docs/src/content`).

- [ ] **Step 1:** Write the entries. Changelog line says: no schema change, no invariant, no egress class; `nimbus init` outside a repository now exits 0.
- [ ] **Step 2: Run** `bun run audit:doc-refs` and `bun run audit:status-drift` → PASS.
- [ ] **Step 3: Commit** `docs: role-aware onboarding (gateway + CLI)`.

### Task 8: verification before the PR

- [ ] `bun run preflight:fast` → green.
- [ ] `bun run typecheck:tests` → 0 new.
- [ ] Take the full-suite lock (`mkdir …/scratchpad/full-test.lock`), run `bun test packages/gateway/src`, `bun test packages/cli/src`, `bun test scripts`, `bun test packages/gateway/test/e2e/<the file touched in Task 3>` → green (known pre-existing failures named in memory are compared against `main`, not ignored); release the lock.
- [ ] Antigravity end-result review (bundle at branch HEAD + `branch.diff` + `callers.txt`); verify every finding; fix; put the disposition table in the PR description.
