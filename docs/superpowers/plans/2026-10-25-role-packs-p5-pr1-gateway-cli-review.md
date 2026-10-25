# Antigravity review — P5 PR 1 plan (2026-10-25)

Reviewer: Google Antigravity CLI (`agy --mode plan`), read-only bundle of origin/main + spec + plan. Verbatim below. Execution had started in parallel (Tasks 1–6 were committed before the review returned); each finding was checked against the code as built.

### 1. [Critical] Missing `visibleAgents` on `available` packs in `PackListResult` breaks role resolution and next steps
- **Evidence:** [`packages/gateway/src/packs/pack-install.ts:455-457`](file:///packages/gateway/src/packs/pack-install.ts#L455-L457), [`packages/cli/src/commands/pack.ts:33-38`](file:///packages/cli/src/commands/pack.ts#L33-L38), `plan Task 1:53`, `plan Task 6:180-189, 204`
- **Issue:** Task 1 adds `roles` and `suggestedConnectors` to `PackListResult.available[number]`, but omits `visibleAgents`. Task 6 defines `RoleAnswer` as `{ kind: "pack"; packId: string; name: string; installed: boolean; visibleAgents: readonly string[] }`. When a new user picks an available pack during `nimbus init`, `resolveRole` cannot read `visibleAgents` from `available`. Consequently, `visibleAgents` resolves empty, and the check in Task 6 line 204 (`after a pack whose visibleAgents include decisions: Nimbus looks for decisions after your connectors sync: nimbus decisions`) will **never** fire for newly installed packs. Furthermore, Spec § 10 requires the desktop Pack step to show "the pack's suggestions and visible agents as a readable summary" before installation.
- **Fix:** In `packages/gateway/src/packs/pack-install.ts:457`, when mapping `deps.bundled.values()` into `available`, include `visibleAgents: packVisibleAgents(m.defaults)`. Add `readonly visibleAgents: readonly string[]` to `PackListResult.available` in Task 1 and `AvailablePackRow` in `packages/cli/src/commands/pack.ts`.

---

### 2. [Critical] Premature developer output (`reportIndexed`) in `runInit` before role and pack steps
- **Evidence:** [`packages/cli/src/commands/init.ts:456-465, 587-588`](file:///packages/cli/src/commands/init.ts#L456-L465), `plan Task 6:235`, `spec § 5.2, § 5.5`
- **Issue:** Task 6 Step 4 defines `runInit` execution order as:
  `--help → demo refusal → parseRoleFlag → initOutcome → reportOutcome → if outcome is indexed or (no-repo and gatewayUp): decide the path`
  When inside a repo, `outcome.kind === "indexed"`. `reportOutcome` unconditionally calls `reportIndexed(deps, outcome.demo)`, which immediately prints developer instructions (`Try it: nimbus why <file>:<line> # <name>\n  nimbus wow`). Only *after* those lines appear in the console does `runInit` ask the role question or install the pack. A PM selecting the Product pack is greeted with code-blame instructions before being asked what role they perform, contradicting Spec § 1 and § 5.2.
- **Fix:** In `runInit`, do not call `reportOutcome(outcome, deps)` before path resolution. Only invoke `reportIndexed` on the legacy path (`!interactive && flag === undefined`) and the explicit `Engineering` path. For pack roles and neutral paths, log that indexing completed, run `runRoleStep`, and allow the connector step to output the role-appropriate next steps.

---

### 3. [Critical] Exit code overwrite in `runInit` when `--role` is unknown
- **Evidence:** [`packages/cli/src/commands/init.ts:616`](file:///packages/cli/src/commands/init.ts#L616), `plan Task 6:235`
- **Issue:** In [`packages/cli/src/commands/init.ts:616`](file:///packages/cli/src/commands/init.ts#L616), `process.exitCode = initExitCode(outcome)` executes unconditionally at the end of `runInit`. When `--role bogus` is passed inside a git repository, `initOutcome` succeeds (`outcome.kind === "indexed"`). `runRoleStep` returns `"unknown-role"`, logs the error, and sets `exit 1`. However, falling through to line 616 evaluates `initExitCode({ kind: "indexed", ... })`, which returns `0`, clobbering `process.exitCode = 1` back to `0`.
- **Fix:** In Task 6 Step 4, when `runRoleStep` returns `"unknown-role"`, explicitly set `process.exitCode = INIT_EXIT.usage; return;` to prevent reaching the unconditional exit assignment at line 616.

---

### 4. [Critical] Import ban violation: `catalog/` cannot import `ConnectorSignInKind` from `ipc/`
- **Evidence:** [`packages/gateway/src/catalog/catalog-list.ts:25`](file:///packages/gateway/src/catalog/catalog-list.ts#L25), [`packages/gateway/src/ipc/connector-rpc-handlers/auth.ts`](file:///packages/gateway/src/ipc/connector-rpc-handlers/auth.ts), `plan line 18`, `plan Task 2:78-79`
- **Issue:** Task 2 declares `export type ConnectorSignInKind` in `ipc/connector-rpc-handlers/auth.ts` and updates `CatalogConnector` in `catalog/catalog-list.ts` to `readonly signIn: ConnectorSignInKind`. Global constraint line 18 explicitly enforces: "`catalog/` imports nothing from `ipc/`". Having `catalog/catalog-list.ts` import `ConnectorSignInKind` from `ipc/` violates this architectural boundary and will fail `packages/gateway/src/catalog/visibility-is-presentation-only.test.ts`.
- **Fix:** Define `export type ConnectorSignInKind = "browser" | "atlassian" | "terminal";` in `packages/gateway/src/catalog/catalog-list.ts`. Have `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` import `ConnectorSignInKind` from `catalog/catalog-list.ts` instead.

---

### 5. [Critical] Breaking existing callers of `buildCatalogList` in tests
- **Evidence:** [`packages/gateway/src/catalog/catalog-list.ts:85`](file:///packages/gateway/src/catalog/catalog-list.ts#L85), [`packages/gateway/src/catalog/catalog-list.test.ts:66, 93, 113, 122, 131, 150, 159`](file:///packages/gateway/src/catalog/catalog-list.test.ts#L66), `plan Task 2:79`
- **Issue:** Task 2 changes `buildCatalogList`'s signature to `deps: { db; snapshot; signInFor: (id: string) => ConnectorSignInKind; packSuggestions: readonly string[] }` with required properties. There are 7 existing test calls in [`catalog-list.test.ts`](file:///packages/gateway/src/catalog/catalog-list.test.ts) that invoke `buildCatalogList({ db, snapshot: snapshotOf(...) })`. Making `signInFor` and `packSuggestions` required without defaults breaks compilation across the entire test suite.
- **Fix:** Make `signInFor` and `packSuggestions` optional in `buildCatalogList`'s parameter type:
  `signInFor?: (id: string) => ConnectorSignInKind; packSuggestions?: readonly string[];`
  Default them inside `buildCatalogList`: `const signInFor = deps.signInFor ?? (() => "terminal"); const packSuggestions = deps.packSuggestions ?? [];`.

---

### 6. [Important] Broken test callers of `dispatchCatalogRpc` and missing runtime guard
- **Evidence:** [`packages/gateway/src/ipc/catalog-rpc.ts:22, 42`](file:///packages/gateway/src/ipc/catalog-rpc.ts#L22), `callers.txt:239-245`, `plan Task 2:80`
- **Issue:** Task 2 adds `packSuggestions: () => readonly string[]` as a required field on `CatalogRpcContext`. In `catalog-rpc.test.ts`, 7 test calls pass a `ctx` object without `packSuggestions`. Furthermore, in [`catalog-rpc.ts:42`](file:///packages/gateway/src/ipc/catalog-rpc.ts#L42), calling `ctx.packSuggestions()` directly will throw a runtime `TypeError` whenever `packSuggestions` is omitted in test harnesses.
- **Fix:** Declare `packSuggestions?: () => readonly string[]` as optional on `CatalogRpcContext`. In `catalog-rpc.ts`, safely call `ctx.packSuggestions?.() ?? []`.

---

### 7. [Important] Ambiguous `sinceMs` parameter and timestamp units in `readDecisionStatus`
- **Evidence:** [`packages/gateway/src/decisions/decision-store.ts:324, 331`](file:///packages/gateway/src/decisions/decision-store.ts#L324), [`packages/gateway/src/agents/decisions.ts:230-237`](file:///packages/gateway/src/agents/decisions.ts#L230-L237), `plan Task 3:100, 115-120`
- **Issue:** In [`agents/decisions.ts:230-237`](file:///packages/gateway/src/agents/decisions.ts#L230-L237), `query.sinceMs` represents an absolute epoch millisecond floor (`cutoffMs = nowMs - windowMs`), not a relative duration. In Task 3, `readDecisionStatus` takes `nowMs: number`, and invokes `countByStatusSince(db, mapping, sinceMs)`, `countShown(db, { sinceMs, minConfidence, mapping })`, and `modified_at >= ?`. If an implementer passes `DECISIONS_DEFAULT_WINDOW_MS` (relative ~7.77e9 ms) directly as `sinceMs`, SQLite queries evaluate `decided_at >= 7776000000` (April 1970) and match all records.
- **Fix:** In Task 3, explicitly specify that `readDecisionStatus` computes `const cutoffMs = opts.nowMs - DECISIONS_DEFAULT_WINDOW_MS;` and passes `cutoffMs` as the absolute timestamp floor to `countByStatusSince`, `countShown`, `listDecisions`, and the `item.modified_at >= ?` query.

---

### 8. [Important] Tie-breaking discrepancy in `readDecisionStatus.sources` sort order
- **Evidence:** `plan/2026-10-25-role-packs-p5-onboarding-design.md:223`, `plan Task 3:120`
- **Issue:** Spec § 7.1 states that `sources` rows must be "ordered by items desc then type". Task 3 line 120 states: "sort items desc then serviceType by code unit". Since `serviceType` is formatted as `"service:type"` (e.g. `"slack:message"`), sorting by `serviceType` sorts by the service name first rather than the item type, deviating from the spec.
- **Fix:** Change Task 3 line 120 to sort items descending, then by `type` ascending (code unit order), and then by `service` ascending.

---

### 9. [Important] Disconnect between `dispatchDecisionsRpc` and `tryDispatchDecisionsRpc` for `decisions.status`
- **Evidence:** [`packages/gateway/src/ipc/decisions-rpc.ts:5-8, 61-70`](file:///packages/gateway/src/ipc/decisions-rpc.ts#L5-L8), `callers.txt:60-63`, `plan Task 3:121, 134`
- **Issue:** Task 3 Step 3 handles `decisions.status` directly inside `tryDispatchDecisionsRpc` before checking `refresher === undefined`. However, Task 3 Step 1 expects `decisions-rpc.test.ts` to assert that `decisions.status answers with no refresher`. Today, `dispatchDecisionsRpc` in [`decisions-rpc.ts`](file:///packages/gateway/src/ipc/decisions-rpc.ts) requires a `DecisionsRpcContext` where `refresher: DecisionRefresher` is non-optional and lacks `db`. If `tryDispatchDecisionsRpc` bypasses `dispatchDecisionsRpc`, `decisions.status` is not routed through the RPC dispatcher.
- **Fix:** Update `DecisionsRpcContext` in [`packages/gateway/src/ipc/decisions-rpc.ts`](file:///packages/gateway/src/ipc/decisions-rpc.ts) to include `readonly db: Database; readonly configDir?: string; readonly refresher?: DecisionRefresher; readonly nowMs: () => number;` and add `"decisions.status"` to `dispatchDecisionsRpc`. Let `tryDispatchDecisionsRpc` delegate to `dispatchDecisionsRpc`.

---

### 10. [Important] `DecisionRefresher` fakes in existing tests will fail typechecking
- **Evidence:** [`packages/gateway/src/decisions/decision-refresh.ts:26-37`](file:///packages/gateway/src/decisions/decision-refresh.ts#L26-L37), `callers.txt:196-207`, `plan Task 3:101`
- **Issue:** Task 3 adds `status: () => "idle" | "running" | "stopped" | "disabled"` to `DecisionRefresher`. Existing unit test fakes in `decision-refresh.test.ts` or `decisions-rpc.test.ts` that create objects matching `{ trigger, run, stop }` without `status` will fail strict TypeScript typechecking.
- **Fix:** Explicitly state in Task 3 that existing test fakes implementing `DecisionRefresher` must include `status: () => "idle"`.

---

### 11. [Important] `withPackClient` needs injectable `paths` for CLI tests
- **Evidence:** [`packages/cli/src/commands/pack.ts:283`](file:///packages/cli/src/commands/pack.ts#L283), [`packages/cli/src/commands/init.ts:670`](file:///packages/cli/src/commands/init.ts#L670), `plan Task 6:236`
- **Issue:** In [`pack.ts:283`](file:///packages/cli/src/commands/pack.ts#L283), `runPack` hardcodes `paths = getCliPlatformPaths()`. In [`init.ts:670`](file:///packages/cli/src/commands/init.ts#L670), `defaultInitDeps` accepts an injectable `paths` parameter so tests can redirect socket communication to temporary directories. If `withPackClient` does not accept `paths?: CliPlatformPaths`, `defaultInitDeps` cannot forward `paths` to `withPackClient`, causing tests to attempt communicating with whatever live gateway is running on the machine.
- **Fix:** In `packages/cli/src/commands/pack.ts`, export `withPackClient<T>(fn: (call: PackCall) => Promise<T>, paths: CliPlatformPaths = getCliPlatformPaths()): Promise<T>`. In `defaultInitDeps`, pass `paths` to `withPackClient`.

---

### 12. [Important] Missing `applyInitPlan` test update in `init.test.ts`
- **Evidence:** [`packages/cli/src/commands/init.test.ts:94`](file:///packages/cli/src/commands/init.test.ts#L94), `callers.txt:4`, `plan Task 6:206, 232`
- **Issue:** Task 6 changes `InitPlan`'s `"not-a-repo"` to `"no-repo"`. Line 94 of `init.test.ts` calls `applyInitPlan({ kind: "not-a-repo" }, opts)`. While Task 6 Step 2 notes updating `initPlan` and `initExitCode` tests, it omits line 94, which will fail typechecking when `"not-a-repo"` is removed from `InitPlan`.
- **Fix:** Add updating `packages/cli/src/commands/init.test.ts:94` to `applyInitPlan({ kind: "no-repo" }, opts)` in Task 6 Step 2.

---

### 13. [Important] Non-interactive `nimbus init` outside a git repo outputs nothing
- **Evidence:** `plan/2026-10-25-role-packs-p5-onboarding-design.md:107, 125`, `plan Task 6:204, 235`
- **Issue:** Spec § 5.1 specifies that non-interactive `nimbus init` outside a git repo should run a "Neutral start (§ 5.3)", which includes printing neutral connector suggestions and terminal commands. In Task 6 Step 4, `runInit` only calls `runRoleStep` when `interactive && !CI` or when `--role` is passed. When non-interactive outside a repo with no `--role`, `runRoleStep` is skipped, `reportOutcome` has no output for `no-repo`, and `nimbus init` exits 0 with zero output.
- **Fix:** In Task 6 Step 4, when `outcome.kind === "no-repo"` in a non-interactive shell with no flag, run `runRoleStep(undefined, { ...deps.role, interactive: false })` so it outputs the neutral connector suggestions and next steps.

---

### 14. [Important] Misleading diagnostic in `reportGatewayUnavailable` outside a git repository
- **Evidence:** [`packages/cli/src/commands/init.ts:419`](file:///packages/cli/src/commands/init.ts#L419), `plan Task 6:206`
- **Issue:** When the gateway fails to start outside a git repository, `initOutcome` returns `{ kind: "gateway-unavailable" }` (exit code 2). `reportOutcome` calls `reportGatewayUnavailable(deps)`, which unconditionally logs:
  `deps.error("  The nimbus.toml edit above is done — re-running init will not repeat it.");`
  Outside a git repository, no `nimbus.toml` edit was performed, making this message inaccurate.
- **Fix:** In `reportGatewayUnavailable`, conditionally omit the `nimbus.toml edit above is done` line when running outside a git repository.

---

### 15. [Important] Non-existent test file reference: `local-index.test.ts`
- **Evidence:** `callers.txt:50-53`, `plan Task 1:50, 63`
- **Issue:** Task 1 lists `packages/gateway/src/index/local-index.test.ts` as an existing test file to modify and run with `bun test`. No such file exists in `packages/gateway/src/index/`.
- **Fix:** Specify creating `packages/gateway/src/index/local-index.test.ts` to test `ALLOWED_META_KEYS` with `getMeta` and `setMeta`, or locate the existing `LocalIndex` test file.

---

### 16. [Important] Non-existent test file reference: `tour-rpc.test.ts`
- **Evidence:** `callers.txt:64-65`, `plan Task 4:142, 143, 151, 155`
- **Issue:** Task 4 lists `packages/gateway/src/ipc/tour-rpc.test.ts` under "Test:" and instructs adding a test to it. This test file does not exist in the codebase.
- **Fix:** In Task 4 Files, explicitly list `Create: packages/gateway/src/ipc/tour-rpc.test.ts` and define its test structure.

---

### 17. [Important] Missing `tour-selectors.ts` update to use shared `DECISIONS_DEFAULT_WINDOW_MS`
- **Evidence:** [`packages/gateway/src/agents/_lib/tour-selectors.ts:55-56`](file:///packages/gateway/src/agents/_lib/tour-selectors.ts#L55-L56), `callers.txt:162`, `plan Task 3:95, 99`
- **Issue:** [`tour-selectors.ts:55-56`](file:///packages/gateway/src/agents/_lib/tour-selectors.ts#L55-L56) currently defines:
  `/** Mirrors agents/decisions.ts DEFAULT_WINDOW_MS — the brief's own default window. */ const DECISIONS_WINDOW_MS = 90 * DAY_MS;`
  Task 3 exports `DECISIONS_DEFAULT_WINDOW_MS` from `decisions/decision-types.ts` to eliminate duplicate definitions per D22(d). However, Task 3 modifies `agents/decisions.ts` but leaves `tour-selectors.ts` duplicating the constant.
- **Fix:** Add `packages/gateway/src/agents/_lib/tour-selectors.ts` to Task 3 Files and replace `DECISIONS_WINDOW_MS` with an import of `DECISIONS_DEFAULT_WINDOW_MS` from `../../decisions/decision-types.ts`.

---

### 18. [Important] Handling extension connectors in `connectorSuggestions`
- **Evidence:** [`packages/gateway/src/catalog/catalog-list.ts:34-39`](file:///packages/gateway/src/catalog/catalog-list.ts#L34-L39), `plan Task 2:79`, `plan Task 6:191`
- **Issue:** Task 2 adds `signIn` only to builtin connectors in `CatalogConnector`. Extension connectors have `name: string | null` and no `displayName` or `signIn`. In Task 6, `connectorSuggestions` maps catalog items to `{ id, displayName, signIn, connected }`. If an active pack suggests an extension connector, `c.displayName` and `c.signIn` are undefined.
- **Fix:** In `connectorSuggestions`, derive display name as `connector.displayName ?? connector.name ?? id` and default `signIn` to `"terminal"` when missing on extension connectors.

---

### 19. [Minor] Service and type splitting in Task 3 `sources` query
- **Evidence:** [`packages/gateway/src/sources/source-mapping.ts:54`](file:///packages/gateway/src/sources/source-mapping.ts#L54), `plan Task 3:120`
- **Issue:** Task 3 specifies: `for each serviceType in mapping.typesFor("decisions"), COUNT(*) FROM item WHERE service = ? AND type = ? AND modified_at >= ?`. `typesFor("decisions")` returns strings formatted as `"service:type"` (e.g. `"slack:message"`). The query requires splitting on `":"` to bind `service` and `type` separately.
- **Fix:** Clarify in Task 3 line 120 that `const [service, type] = serviceType.split(":")` is executed before parameter binding.

---

### 20. [Minor] Preserving `--no-detect` and `CI` flags on `Engineering` adoption offer
- **Evidence:** [`packages/cli/src/commands/init.ts:592`](file:///packages/cli/src/commands/init.ts#L592), `plan Task 6:235`
- **Issue:** Task 6 Step 4 states: `Adoption offer: legacy, Engineering, or Engineering outside a repo`. It omits explicitly stating that `offerLocalAuth` must still be skipped when `--no-detect` is provided or `process.env["CI"] === "true"`.
- **Fix:** Clarify in Task 6 Step 4 that the adoption offer runs only if `!hasFlag(args, "--no-detect") && process.env["CI"] !== "true"`.

## Disposition

| # | Finding | Disposition |
|---|---|---|
| 1 | `available` rows lack `visibleAgents` | **Fixed** — added (the desktop pack step needs it). The CLI's decisions line already worked: it re-reads `pack.list` after the install and uses the installed row. |
| 2 | `Try it:` prints before the role question | **Declined** — inside a repository the repository was indexed for every role, so `nimbus why` is a true next step whatever the answer; the role step's lines follow it. Recorded as a call. |
| 3 | Exit code clobbered on unknown `--role` | Already handled — `runInit` returns right after setting exit 1. |
| 4 | `catalog/` importing an `ipc/` type | Already handled — the type lives in `catalog/catalog-list.ts`; `auth.ts` imports it type-only. |
| 5–6 | Required deps break callers | Already handled — tests pass the deps; `CatalogRpcContext.packSuggestions` is optional. |
| 7 | Absolute vs relative `sinceMs` | Already handled — `readDecisionStatus` computes `nowMs - DECISIONS_DEFAULT_WINDOW_MS`. |
| 8 | Sort tie-break | **Declined** — `service:type` code-unit order is deterministic and what the plan says; the spec's "then type" meant the service:type key. |
| 9 | Route `decisions.status` through `dispatchDecisionsRpc` | **Declined** — that dispatcher's context requires a refresher by design; `handleDecisionsStatus` is exported and called by `tryDispatchDecisionsRpc` before the refresher check, and a chain test proves it is reached through `tryDispatchPhase4Rpc`. |
| 10 | Fakes lack `status` | Already handled. |
| 11 | `withPackClient` paths | **Fixed** — takes `paths`; `defaultInitDeps` passes its own. |
| 12 | `applyInitPlan` test | Already handled. |
| 13 | Non-interactive outside a repo prints nothing | Already handled — `no-repo` always runs the (neutral) role step. |
| 14 | "nimbus.toml edit above is done" outside a repo | **Fixed** — `gateway-unavailable` carries `outsideRepo`, and the line is omitted; tested. |
| 15–16 | `local-index.test.ts` / `tour-rpc.test.ts` "do not exist" | **Wrong** — both exist; they were not in the bundle. |
| 17 | `tour-selectors.ts` duplicates the 90-day constant | **Fixed** — imports `DECISIONS_DEFAULT_WINDOW_MS`. |
| 18 | Extension connectors in suggestions | Already handled — `displayName ?? name ?? id`, sign-in defaults to `terminal`. |
| 19–20 | Split / `--no-detect` + CI | Already handled. |
