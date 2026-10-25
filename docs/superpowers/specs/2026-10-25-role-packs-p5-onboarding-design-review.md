# Antigravity review — P5 onboarding spec (2026-10-25)

Reviewer: Google Antigravity CLI (`agy --mode plan`), read-only bundle of origin/main fd292567 + the spec. Two earlier runs produced no output (a 15-minute timeout on a too-large bundle; a denied shell call); this is the third run, verbatim.

Here is the audit of [`plan/2026-10-25-role-packs-p5-onboarding-design.md`](file:///C:/gitrep/Nimbus/plan/2026-10-25-role-packs-p5-onboarding-design.md) evaluated against the Nimbus codebase.

---

### Category 1: Correctness & Security Traps

#### 1. [Critical] `pack.install` omitted from `NO_TIMEOUT_METHODS` in Tauri bridge
- **File & Line**: [`packages/ui/src-tauri/src/gateway_bridge.rs:236, 428-444, 929-946`](file:///C:/gitrep/Nimbus/packages/ui/src-tauri/src/gateway_bridge.rs#L236-L245)
- **Problem**: Default Tauri bridge RPC calls enforce a 30-second timeout (`DEFAULT_RPC_TIMEOUT_MS = 30_000`). Methods requiring interactive HITL consent prompts (like `agents.brief`, `connector.auth`, etc.) must be listed in `NO_TIMEOUT_METHODS`. Calling `pack.install` initiates an interactive HITL consent popup. If the user inspects the pack config for >30s before clicking "Allow", Tauri bridge aborts with `ERR_TIMEOUT`, leaving the gateway's pending HITL prompt orphaned (violating I47 single-pending-prompt lifecycle). The spec (§ 9) adds `pack.install` to `ALLOWED_METHODS` (116 → 118) but completely overlooks `NO_TIMEOUT_METHODS` (7 → 8).
- **Concrete Fix**:
  1. Add `"pack.install"` to `NO_TIMEOUT_METHODS` in `gateway_bridge.rs`.
  2. Bump `const NO_TIMEOUT_METHODS_COUNT: usize = 8;`.
  3. Add `assert!(is_no_timeout_method("pack.install"));` in unit tests.
  4. Update `docs/SECURITY-INVARIANTS.md:1614` documenting I46/I47 bridge timeout exemptions.

---

#### 2. [Critical] Rust test `allowlist_pack_list_only` panics on `pack.install`
- **File & Line**: [`packages/ui/src-tauri/src/gateway_bridge.rs:826-842`](file:///C:/gitrep/Nimbus/packages/ui/src-tauri/src/gateway_bridge.rs#L826-L842)
- **Problem**: Rust test `allowlist_pack_list_only` iterates over all methods starting with `"pack."` in `ALLOWED_METHODS` and explicitly asserts:
  ```rust
  assert_eq!(*m, "pack.list");
  assert!(!is_method_allowed("pack.install"));
  ```
  Adding `pack.install` to `ALLOWED_METHODS` without updating this test causes `cargo test` in Tauri CI to fail immediately.
- **Concrete Fix**: Rename the test to `allowlist_pack_methods_only`, update it to verify that `m` is either `"pack.list"` or `"pack.install"`, assert `is_method_allowed("pack.install")`, and verify destructive/maintenance verbs remain denied (`assert!(!is_method_allowed("pack.remove")); assert!(!is_method_allowed("pack.show"));`).

---

#### 3. [Critical] Rust test `allowlist_decisions_brief_only` fails when adding `decisions.status`
- **File & Line**: [`packages/ui/src-tauri/src/gateway_bridge.rs:655-667`](file:///C:/gitrep/Nimbus/packages/ui/src-tauri/src/gateway_bridge.rs#L655-L667)
- **Problem**: The unit test `allowlist_decisions_brief_only` asserts:
  ```rust
  assert!(!is_method_allowed("decisions.refresh"));
  assert!(!is_method_allowed("decisions.status")); // fails when decisions.status is allowed
  ```
  Spec § 9 adds `decisions.status` to `ALLOWED_METHODS` but forgets to specify updating this invariant test.
- **Concrete Fix**: Update `allowlist_decisions_brief_only` (or rename to `allowlist_decisions_methods`) to assert `assert!(is_method_allowed("decisions.status"))`, while verifying mutating maintenance verbs (`decisions.refresh`, `decisions.rebuild`) remain forbidden.

---

#### 4. [Critical] `tryDispatchDecisionsRpc` skips `decisions.status` when `refresher` is unset
- **File & Line**: [`packages/gateway/src/ipc/server/dispatchers.ts:1651-1670`](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/server/dispatchers.ts#L1651-L1670)
- **Problem**: In `dispatchers.ts`, `tryDispatchDecisionsRpc` starts with:
  ```typescript
  const refresher = deps.decisionRefresher;
  if (refresher === undefined) {
    return phase4RpcSkipped; // returns null -> throws -32601 Method not found
  }
  ```
  If decisions are disabled via configuration (`[decisions].enabled = false`) or during early onboarding before background passes initialize, calling `decisions.status` will throw `-32601 Method not found` instead of returning `{ enabled: false, state: "disabled", ... }`.
- **Concrete Fix**: Move the handling of `decisions.status` *above* the `if (refresher === undefined)` check. When `refresher === undefined` or `localIndex === undefined`, return `{ enabled: false, state: "disabled", sources: [], shown: 0, candidates: { pending: 0, extracted: 0, vetoed: 0 } }`.

---

#### 5. [Critical] Decisions status B1 candidate counts clash with 90-day brief window
- **File & Line**: [`packages/gateway/src/decisions/decision-store.ts:340-363`](file:///C:/gitrep/Nimbus/packages/gateway/src/decisions/decision-store.ts#L340-L363), [`packages/gateway/src/agents/decisions.ts:254`](file:///C:/gitrep/Nimbus/packages/gateway/src/agents/decisions.ts#L254), and Spec § 7.1–7.2
- **Problem**: `decisionStore.countByStatus()` runs `SELECT status, count(*) FROM decision_record GROUP BY status` across the entire database history with no `sinceMs` cutoff. Meanwhile, `agents.decisions` briefs filter records strictly within a 90-day window (`cutoffMs = now - 90 * 86_400_000`). If older candidates exist from >90 days ago, `candidates.extracted > 0` but the 90-day window has 0 decisions. Under Spec § 7.2 rule B1 (2), the UI would display: *"N possible decisions were too uncertain to show (below your confidence floor)"*, which is false and contradictory because the candidates were outside the time window, not filtered by confidence.
- **Concrete Fix**: Add an optional `sinceMs?: number` parameter to `countByStatus(sinceMs)` in `decision-store.ts` and pass `cutoffMs = Date.now() - 90 * 86_400_000` in `decisions.status`, ensuring candidate counts and shown counts share an identical time horizon.

---

#### 6. [Important] `dispatchPackRpc` lacks `fromRenderer` argument to enforce `ERR_PACK_RENDERER_FILE`
- **File & Line**: [`packages/gateway/src/ipc/pack-rpc.ts:118-124`](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/pack-rpc.ts#L118-L124), [`packages/gateway/src/ipc/server/dispatchers.ts:2306-2337`](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/server/dispatchers.ts#L2306-L2337)
- **Problem**: Spec § 9 specifies: *"Renderer callers (`fromRenderer: true`) MUST NOT pass `filePath` or `fileText`; if passed, return `ERR_PACK_RENDERER_FILE`"*. However, `dispatchPackRpc(method, params, deps, gate)` does not receive `fromRenderer` or `clientKind`. The dispatcher in `dispatchers.ts` has `ctx.getClientKind(clientId)` available, but fails to forward it.
- **Concrete Fix**:
  1. Add `fromRenderer: boolean` to `dispatchPackRpc` signature or to `PackRpcDeps`.
  2. In `dispatchers.ts` line 2315, pass `fromRenderer: ctx.getClientKind(clientId) === "ui"`.
  3. In `pack-rpc.ts:dispatchPackRpc`, throw `ERR_PACK_RENDERER_FILE` if `fromRenderer && (params.filePath || params.fileText)`.

---

#### 7. [Important] Connect page polling auto-navigates on `anyConnected`, breaking multi-step flows
- **File & Line**: [`packages/ui/src/pages/onboarding/Connect.tsx:111-126`](file:///C:/gitrep/Nimbus/packages/ui/src/pages/onboarding/Connect.tsx#L111-L126)
- **Problem**: Current `Connect.tsx` has an effect that triggers `navigate("/onboarding/syncing")` immediately when `anyConnected` becomes true:
  ```typescript
  if (anyConnected) {
    navigate("/onboarding/syncing");
  }
  ```
  Spec § 10 claims *"Connect step: continues to let users link Jira/GitHub/Linear... Continue button becomes enabled when at least one connector is healthy"*. If the user connects Jira first and is entering a GitHub token, or if a connector becomes healthy while the user reads instructions, the existing auto-navigation forcibly ejects them to `/onboarding/syncing`.
- **Concrete Fix**: Delete the auto-navigation `useEffect` from `Connect.tsx`. Enable the "Continue" / "Next" button when `anyConnected` is true, allowing the user to connect additional sources or proceed when ready.

---

#### 8. [Important] `role_pack_card_dismissed` in `ALLOWED_META_KEYS` assigned to wrong PR boundary
- **File & Line**: [`packages/gateway/src/index/local-index.ts:286`](file:///C:/gitrep/Nimbus/packages/gateway/src/index/local-index.ts#L286), Spec § 12
- **Problem**: Spec § 12 puts *"db.getMeta/setMeta: role_pack_card_dismissed"* under PR 2 (Desktop). However, `ALLOWED_META_KEYS` is defined and validated in `packages/gateway/src/index/local-index.ts`. If desktop in PR 2 attempts to write `role_pack_card_dismissed` against a gateway built from PR 1, `db.setMeta` will reject the key with an invalid key error (invariant I20).
- **Concrete Fix**: Move the addition of `role_pack_card_dismissed` in `ALLOWED_META_KEYS` (`local-index.ts:286`) into PR 1 (Gateway/CLI foundation).

---

#### 9. [Important] `BriefRunView` does not parse URL search parameters for window widening
- **File & Line**: [`packages/ui/src/pages/BriefRun.tsx:90-100`](file:///C:/gitrep/Nimbus/packages/ui/src/pages/BriefRun.tsx#L90-L100), Spec § 7.2
- **Problem**: Spec § 7.2 states the next action for empty decisions is *"Widen the window (opens `/briefs/decisions` with `sinceMs` = 365 days)"*. `BriefRun.tsx` only calls `useParams<{ agent: string }>()` and ignores `useSearchParams()`. Navigating to `/briefs/decisions?sinceMs=...` will ignore the query param and fall back to the 90-day default.
- **Concrete Fix**: In `BriefRun.tsx`, use `const [searchParams] = useSearchParams()`, extract `searchParams.get("sinceMs")`, and initialize the `sinceMs` form input with that value if present.

---

### Category 2: Missed Callers & Changed Shapes

#### 10. [Important] UI test fixtures broken by non-optional `suggestedConnectors` in `CatalogListResult`
- **File & Line**: [`packages/ui/test/briefs/pack-sections.test.ts:19`](file:///C:/gitrep/Nimbus/packages/ui/test/briefs/pack-sections.test.ts#L19), [`packages/ui/test/pages/Briefs.test.tsx:37`](file:///C:/gitrep/Nimbus/packages/ui/test/pages/Briefs.test.tsx#L37), [`packages/cli/src/commands/catalog.test.ts:10-50`](file:///C:/gitrep/Nimbus/packages/cli/src/commands/catalog.test.ts#L10-50)
- **Problem**: Spec § 3 adds `suggestedConnectors: readonly string[]` as a mandatory field on `CatalogListResult["entries"][number]`. Multiple test suites across `packages/ui` and `packages/cli` construct mock catalog entries without this field.
- **Concrete Fix**: In [`packages/ui/src/ipc/types.ts:600`](file:///C:/gitrep/Nimbus/packages/ui/src/ipc/types.ts#L600) and [`packages/gateway/src/ipc/catalog-rpc.ts:15`](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/catalog-rpc.ts#L15), define `suggestedConnectors?: readonly string[]` as optional on client interfaces, or update the mock helpers in `catalog.test.ts`, `pack-sections.test.ts`, and `Briefs.test.tsx` to provide `suggestedConnectors: []`.

---

#### 11. [Important] UI test fixtures broken by missing `roles` in `PackListResult["installed"]`
- **File & Line**: [`packages/ui/test/briefs/pack-sections.test.ts:23-32`](file:///C:/gitrep/Nimbus/packages/ui/test/briefs/pack-sections.test.ts#L23-L32)
- **Problem**: Spec § 3 adds `roles: readonly RoleId[]` to installed pack rows. In `pack-sections.test.ts`, the mock generator `pack(id)` constructs:
  ```typescript
  { id, name: id, version: "0.1.0", enabled: true, source: "bundled", agentIds: [...] }
  ```
  Omitting `roles` will cause TypeScript compilation failures in UI tests if `roles` is required.
- **Concrete Fix**: Mark `roles?: readonly RoleId[]` as optional on `PackListResult["installed"][number]` in UI types, or update `pack(id)` in `pack-sections.test.ts` to include `roles: []`.

---

#### 12. [Important] `InitPlan` type definition and tests broken by `InitOutcome` overhaul
- **File & Line**: [`packages/cli/src/commands/init.ts:32-35, 147-151`](file:///C:/gitrep/Nimbus/packages/cli/src/commands/init.ts#L32-L35), [`packages/cli/src/commands/init.test.ts:80, 94, 617, 627`](file:///C:/gitrep/Nimbus/packages/cli/src/commands/init.test.ts#L80)
- **Problem**: `init.ts` distinguishes between `InitPlan` (the planned actions) and `InitOutcome` (the execution result). Spec § 5.3 replaces `not-a-repo` with `no-repo` on `InitOutcome`, but does not mention `InitPlan.kind`. Furthermore, `init.test.ts` contains direct assertions on `{ kind: "not-a-repo" }`.
- **Concrete Fix**: Explicitly document `InitPlan` changes: replace `{ kind: "not-a-repo" }` with `{ kind: "no-repo" }` across both `InitPlan` and `InitOutcome`, and update `init.test.ts` lines 80, 94, 617, and 627 to expect `kind: "no-repo"` with exit code 0.

---

#### 13. [Important] `buildTourPlan` caller breaks across 12 unit tests
- **File & Line**: [`packages/gateway/src/agents/_lib/tour-plan.test.ts:20-45`](file:///C:/gitrep/Nimbus/packages/gateway/src/agents/_lib/tour-plan.test.ts#L20-L45)
- **Problem**: `tour-plan.test.ts` calls `buildTourPlan(ctx, { steps, demo, selectors })` in 12 distinct tests without passing `installedPacks` or role metadata. If `buildTourPlan` is modified to require pack context without a default fallback, all 12 tests will fail.
- **Concrete Fix**: Make the role pack configuration optional in `TourPlanOptions`:
  ```typescript
  export interface TourPlanOptions {
    readonly steps?: readonly TourStepId[];
    readonly demo?: boolean;
    readonly selectors?: TourSelectors;
    readonly installedPacks?: readonly string[];
  }
  ```
  If `installedPacks` is omitted, default to revealing all agents/features to preserve existing tests.

---

#### 14. [Important] `DecisionRefresher` lacks `status()` delegate method
- **File & Line**: [`packages/gateway/src/decisions/decision-refresh.ts:26-37`](file:///C:/gitrep/Nimbus/packages/gateway/src/decisions/decision-refresh.ts#L26-L37)
- **Problem**: Spec § 7.1 delegates `decisions.status` state calculation to `decisionRefresher.status()`. However, `DecisionRefresher` only exposes `trigger(cause)`, `dispose()`, and private `scheduler`. It does not expose a `status()` method.
- **Concrete Fix**: Add a public `status()` method to `DecisionRefresher`:
  ```typescript
  public status(): PassSchedulerStatus {
    return this.scheduler.status();
  }
  ```

---

### Category 3: Claims About Current Code

#### 15. [Important] Missing Onboarding subroutes in `App.tsx` and hardcoded `STEPS`
- **File & Line**: [`packages/ui/src/App.tsx:55-60`](file:///C:/gitrep/Nimbus/packages/ui/src/App.tsx#L55-L60), [`packages/ui/src/pages/Onboarding.tsx:3-7`](file:///C:/gitrep/Nimbus/packages/ui/src/pages/Onboarding.tsx#L3-L7)
- **Problem**: In `App.tsx`, the `/onboarding` route only defines child routes for `welcome`, `connect`, and `syncing`. Spec § 10 introduces three new screens (`role`, `pack`, `decisions`), but doesn't mention modifying `App.tsx`. Furthermore, `Onboarding.tsx` contains a static `const STEPS = ["welcome", "connect", "syncing"]` stepper header that will break breadcrumbs and progression if not updated.
- **Concrete Fix**:
  1. Add `<Route path="role" element={<RoleSelect />} />`, `<Route path="pack" element={<PackSelect />} />`, and `<Route path="decisions" element={<DecisionsPreview />} />` to `App.tsx`.
  2. Update `STEPS` in `Onboarding.tsx` to `["welcome", "role", "pack", "connect", "syncing", "decisions"]`.

#### 16. [Minor] CLI `HELP_LINES` documents Exit Code 1 as "not a git repo"
- **File & Line**: [`packages/cli/src/commands/init.ts:138-144`](file:///C:/gitrep/Nimbus/packages/cli/src/commands/init.ts#L138-L144)
- **Problem**: `init.ts` defines `HELP_LINES` displayed during `nimbus init --help`. Line 142 explicitly documents:
  ```text
  1  Fatal error (e.g. not a git repository)
  ```
  Spec § 5.3 changes "not a git repo" from exit code 1 to exit code 0 (`no-repo`).
- **Concrete Fix**: Update `HELP_LINES` in `init.ts` to document exit code 0 as success (including clean exit outside git repo) and exit code 1 as fatal error / usage error (e.g. invalid `--role`).

---

#### 17. [Minor] Invariant I41 demo repo refusal precedence over `--role`
- **File & Line**: [`packages/cli/src/commands/init.ts:581-585`](file:///C:/gitrep/Nimbus/packages/cli/src/commands/init.ts#L581-L585)
- **Problem**: In `init.ts`, if running inside a demo repository, `DEMO_INIT_REFUSAL` immediately aborts with exit code 1. Spec § 5.2 defines `--role` validation but does not state the evaluation order relative to `isDemoPinned()`.
- **Concrete Fix**: Explicitly state in Spec § 5.2 that the demo repository check (`isDemoPinned()`) executes before argument parsing and role prompts, immediately printing `DEMO_INIT_REFUSAL` and exiting 1.

---

#### 18. [Minor] Terminal sign-in requirement for GitHub and Linear connectors
- **File & Line**: [`packages/gateway/src/ipc/connector-rpc-handlers/auth.ts:814-816`](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/connector-rpc-handlers/auth.ts#L814-L816)
- **Problem**: Jira supports OAuth / browser login, whereas GitHub and Linear PATs are configured via terminal (`signIn: "terminal"`). Spec § 6.2 correctly lists GitHub and Linear as suggested connectors for Devops/Eng leads, but does not clarify that the UI cannot trigger an in-app browser popup for them.
- **Concrete Fix**: Note in Spec § 10 that when GitHub or Linear is selected on the Connect step, the UI renders a copyable CLI command (e.g. `nimbus connect github`) instead of opening an in-app OAuth window.

---

### Category 4: Contradictions & Gaps a Builder Would Ask About

#### 19. [Important] HITL Consent window dimensions and scroll container in Tauri
- **File & Line**: [`packages/ui/src-tauri/src/hitl_popup.rs:13`](file:///C:/gitrep/Nimbus/packages/ui/src-tauri/src/hitl_popup.rs#L13), [`packages/ui/src/components/hitl/HitlPopupPage.tsx:57-59, 93-95`](file:///C:/gitrep/Nimbus/packages/ui/src/components/hitl/HitlPopupPage.tsx#L57-L59)
- **Problem**: `hitl_popup.rs` hardcodes the popup window size to `480.0 x 360.0` non-resizable. `HitlPopupPage.tsx` displays prompt text in a simple `<p>` element with no `overflow-y: auto`. The consent prompt for `pack.install` (§ 4.2) prints full pack metadata, agents, and multi-line YAML defaults (`defaults: ...`). This content exceeds 360px and overflows outside the window, cutting off the "Allow" and "Reject" buttons.
- **Concrete Fix**: Wrap the prompt description in `HitlPopupPage.tsx` with a scrollable container (`max-h-48 overflow-y-auto font-mono text-xs bg-slate-900 p-2 rounded`), ensure default focus is on "Reject" (or neutral), and set `resizable(true)` or increase initial height in `hitl_popup.rs` to 440px.

---

#### 20. [Important] `agents.decisions` brief does not record `lastRunMs`
- **File & Line**: [`packages/gateway/src/agents/decisions.ts:310-340`](file:///C:/gitrep/Nimbus/packages/gateway/src/agents/decisions.ts#L310-L340), [`packages/gateway/src/ipc/decisions-rpc.ts:35-50`](file:///C:/gitrep/Nimbus/packages/gateway/src/ipc/decisions-rpc.ts#L35-L50)
- **Problem**: Spec § 7.1 specifies that `decisions.status` returns `lastRunMs: number | null` (when the decisions brief last ran or refreshed). `agents.decisions` generates markdown output on the fly via `run()` and does not update `decisionRefresher` or store a brief execution timestamp in `LocalIndex`.
- **Concrete Fix**: In `decisions.ts:run()`, record the completion timestamp via `localIndex.setMeta("brief_decisions_last_run", String(Date.now()))`. `decisions.status` reads this key or `refresher.lastPassMs()` to populate `lastRunMs`.

---

#### 21. [Minor] Non-interactive init role-prompt bypass specification
- **File & Line**: [`packages/cli/src/commands/init.ts:460-480`](file:///C:/gitrep/Nimbus/packages/cli/src/commands/init.ts#L460-L480), Spec § 5.2
- **Problem**: Spec § 5.2 specifies: *"Non-interactive (e.g. CI): if `--role` is passed, install it. If not, skip role selection and proceed with default init (preserves existing behavior)"*. However, the spec doesn't specify what happens if `--role` is passed with an invalid identifier in non-interactive mode.
- **Concrete Fix**: State clearly: In non-interactive mode, if `--role <invalid>` is passed, print error `"Unknown role: <role>. Valid roles: eng-lead, pm, devops, custom"` to stderr and exit with code 1. If `--role` is omitted, do not prompt; continue init with role selection skipped.

---

#### 22. [Minor] Missing `pack.install` error mapping for bundled pack name mismatches
- **File & Line**: [`packages/gateway/src/packs/pack-install.ts:75-100`](file:///C:/gitrep/Nimbus/packages/gateway/src/packs/pack-install.ts#L75-L100), Spec § 4.2
- **Problem**: Spec § 4.2 defines `pack.install({ name })` to install bundled packs. However, `pack-install.ts` currently expects `source: { kind: "bundled", name }` or `filePath`. Calling `pack.install` with a `name` that is not bundled must produce a typed error code.
- **Concrete Fix**: Specify that if `name` is not in `BUNDLED_PACKS`, `pack.install` returns `{ ok: false, error: "ERR_PACK_NOT_FOUND", message: "Bundled pack '<name>' does not exist" }`.

---

### Summary Checklist for Builder

| ID | Severity | Area | Breaking Consequence If Unfixed |
|---|---|---|---|
| 1 | **Critical** | Tauri Bridge / Invariant I46/I47 | `pack.install` HITL prompt times out after 30s |
| 2 | **Critical** | Tauri Rust Tests | `allowlist_pack_list_only` panics in CI |
| 3 | **Critical** | Tauri Rust Tests | `allowlist_decisions_brief_only` fails in CI |
| 4 | **Critical** | Gateway RPC Dispatcher | `decisions.status` throws `-32601` when decisions disabled |
| 5 | **Critical** | Decisions Store vs Brief | Inconsistent decision candidate counts across time windows |
| 6 | **Important** | Pack RPC / Security | Renderer can pass unauthorized file paths to `pack.install` |
| 7 | **Important** | Desktop Onboarding | `Connect.tsx` auto-navigation steals user focus |
| 8 | **Important** | Gateway / LocalIndex | Desktop cannot persist `role_pack_card_dismissed` in PR 1 |
| 9 | **Important** | Desktop Brief View | Widen window link ignores `sinceMs` parameter |
| 10 | **Important** | UI & CLI Test Fixtures | `suggestedConnectors` breaks existing `catalog.list` mocks |
| 11 | **Important** | UI Test Fixtures | `roles` missing on mock installed packs |
| 12 | **Important** | CLI Init Types & Tests | `InitPlan` / `InitOutcome` kind mismatch across tests |
| 13 | **Important** | Gateway Tour Plan | `buildTourPlan` calls fail without optional pack config |
| 14 | **Important** | Decision Refresher | `refresher.status()` method missing |
| 15 | **Important** | Desktop React Router | `/onboarding/role|pack|decisions` routes 404 |
| 16 | **Minor** | CLI Help Docs | `init --help` reports obsolete exit code 1 for no-repo |
| 17 | **Minor** | CLI Demo Check | Demo repo ordering undefined relative to `--role` |
| 18 | **Minor** | Desktop Auth UI | In-app OAuth popup invoked for CLI-only connectors |
| 19 | **Minor** | Tauri HITL Popup | Long pack install defaults clip action buttons |
| 20 | **Minor** | Decisions Brief Timestamp | `lastRunMs` cannot be resolved by `decisions.status` |
| 21 | **Minor** | CLI Non-Interactive | Exit code undefined for invalid `--role` non-interactive |
| 22 | **Minor** | Pack RPC Error Handling | Untyped error returned for non-existent bundled pack |

## Disposition

Every finding was checked against the code before acting.

| # | Finding | Disposition |
|---|---|---|
| 1 | `pack.install` missing from `NO_TIMEOUT_METHODS` | **Fixed** — confirmed (`gateway_bridge.rs:246`, 7 entries); § 9 adds it (7 → 8). |
| 2 | `allowlist_pack_list_only` asserts `!pack.install` | **Fixed** — confirmed (`:831-840`); § 9 names the Rust tests that change. |
| 3 | `allowlist_decisions_brief_only` asserts `!decisions.status` | **Partly wrong** — it asserts only `!refresh`/`!rebuild` (`:665-666`); § 9 still names it, to gain a positive `decisions.status` assertion. |
| 4 | `decisions.status` skipped when no refresher | Already in the spec (§ 7.1 "handles it before its no-refresher skip"); kept. |
| 5 | `countByStatus` is unwindowed | **Fixed** — confirmed (`decision-store.ts:340`); § 7.1 now defines a windowed sibling under the same visibility filter. |
| 6 | `dispatchPackRpc` cannot see the client kind | **Fixed** — § 9 now names the `fromRenderer` argument and where it is filled. |
| 7 | Connect auto-navigates on the first connection | **Fixed** — confirmed (`Connect.tsx:111-126`); § 6.3 removes it. |
| 8 | Meta key belongs in the gateway PR | **Fixed** — § 12 PR 1 carries it. |
| 9 | `BriefRun` ignores query params | **Fixed** — confirmed (`BriefRun.tsx:49`, `useParams` only); § 7.2 adds prefill. |
| 10–11 | Fixtures lack the new fields | **Fixed** — the client types declare them optional (§ 4.1, § 6.1). |
| 12 | `InitPlan.not-a-repo` | **Fixed** — § 5.3 renames it in both types. |
| 13 | `buildTourPlan` callers | **Fixed** — § 8 makes `visible` optional. |
| 14 | `DecisionRefresher` has no `status()` | Already in § 7.1 ("the refresher grows `status()`"); kept. The reviewer's class syntax is wrong (it is a factory returning an object), noted for the plan. |
| 15 | Routes and the static `STEPS` header | Already in § 10 ("the step header becomes data-driven"); the plan names `App.tsx`. |
| 16 | HELP_LINES exit code 1 text | Already in § 5.3; kept. |
| 17 | Demo refusal vs `--role` order | **Fixed** — § 4.2 states the order. |
| 18 | GitHub/Linear are terminal sign-in | Already § 6.2/6.3 (`terminal` tiles show a command). The claim "Jira supports OAuth" is wrong — Jira is the Atlassian form. |
| 19 | HITL popup 480×360, not resizable | **Fixed** — confirmed (`hitl_popup.rs:13-14`); § 9 adds a bounded scroll container and makes the window resizable. |
| 20 | `lastRunMs` | **Declined** — the spec has no `lastRunMs`; it reads `decision_pass_state.last_pass_at`. |
| 21 | Invalid `--role` non-interactive | Already § 4.2 (exit 1 on any terminal); made explicit. |
| 22 | `pack.install({ name })` error | **Declined** — the method takes `{ id }`, and an unknown id is already refused by `installPack`'s resolve step. |
