# Punch list — section 2b: Shape duplication

## Task 4.7 status (2026-05-28)

The `runConnectorSync` template proposed below was redesigned as the narrower `connectorFetch` helper in `packages/gateway/src/connectors/_lib/fetch-outcome.ts` after a survey showed the actual duplication was the (rate-limit, fetch, text, ok/parse, FetchOutcome) block, not flat pagination. 28 connectors in the Tier-1/Tier-2 simple-REST list adopted the helper (argocd, bitrise, databricks, dbt, flagsmith, flux, greenhouse, intercom, launchdarkly, lever, mercury, metabase, mlflow, netlify, raindrop, readwise, semgrep, snyk, sonarqube, stackoverflow, stripe, superset, vercel, wiz, zendesk, zoom) — `[EXTRACTED]`. Opt-outs: `obsidian`, `openapi-indexer` (filesystem, no HTTP), `pipedrive` (api_token in query string — helper's url-log would leak it) — `[N/A — opted out]`.

Out of scope for Task 4.7: older connectors that use Octokit-style clients / non-Syncable shapes (github, gitlab, slack, jira, jenkins, sentry, datadog, etc.) — they don't match the (Syncable, FetchOutcome, syncPassCursor*) envelope the helper targets.

## Task 4.8 / 4.9 status (2026-05-28)

The plan's `registerReadOnlyConnectorTools(server, { name, list, get, search })` helper would have stripped the per-tool descriptions and zod schemas that vary per connector — the actual duplication across all 56 MCP server.ts files is the **4-line bootstrap shell** (`new McpServer`, `createZodToolRegistrar(createRegisterSimpleTool(...))`, `new StdioServerTransport`, `await mcp.connect`) plus the four imports. Helper redesigned as `runReadOnlyMcpConnector(serverName, register)` in `packages/mcp-connectors/shared/run-read-only-mcp-connector.ts` (sibling to `mcp-tool-kit.ts`, not in SDK — the SDK is dep-free by design and adding `@modelcontextprotocol/sdk` would bump its published surface).

`shared/` had no external-dep capability until now: `@modelcontextprotocol/sdk` + `zod` are now hoisted at the workspace root so `shared/` can resolve them (every connector already pins the identical version `1.29.0` / `^4.4.2`).

26 simple-REST tier MCP servers adopted the helper (argocd PoC + bitrise, databricks, dbt, flagsmith, flux, greenhouse, intercom, launchdarkly, lever, mercury, metabase, mlflow, netlify, pipedrive, raindrop, readwise, semgrep, snyk, sonarqube, stackoverflow, stripe, superset, vercel, wiz, zendesk, zoom) — `[EXTRACTED]`. Pipedrive is included here even though it was opt-out for Task 4.7 — the new helper logs nothing, so the URL-query-string-auth concern does not apply.

Per-connector net savings: 38–104 lines removed, 4 imports collapsed to 1, 4-line bootstrap shell collapsed to 1 `await runReadOnlyMcpConnector(...)` call.

Out of scope for Task 4.9: Octokit-style and non-simple-REST connectors (github, gitlab, slack, jira, jenkins, sentry, datadog, etc.) and connectors with a different shape (obsidian has a HITL write tool registered alongside reads; openapi-indexer is filesystem). Same scope filter as 4.7.

## Task 4.10 / 4.11 status (2026-05-28)

The plan's `createRpcDispatcher(methods)` would have thrown `RpcMethodNotFound` on miss and returned raw `Promise<unknown>` — but the codebase requires `{ kind: "hit"; value } | { kind: "miss" }` envelopes so the outer dispatcher in `packages/gateway/src/ipc/server/dispatchers.ts` can fall through to the next namespace. Helper redesigned as `dispatchByMethod<Ctx, V>(method, params, ctx, handlerMap)` in `packages/gateway/src/ipc/_lib/dispatch-by-method.ts` — preserves the hit/miss contract, threads `ctx` through, includes a prototype-pollution `Object.hasOwn` guard.

8 *-rpc.ts files adopted the helper (llm PoC + audit, index-reembed, agents, data, profile, session, voice) — `[EXTRACTED]`. Per-file savings ~5–18 lines net.

**Skipped (documented):**

- `connector-rpc.ts` — handlers in `connector-rpc-handlers/*` already return `{ kind: "hit"; value }` envelopes; clean migration would require refactoring every handler file. Out of scope for this pass.
- `diagnostics-rpc.ts` (20 cases) — same nested-envelope shape as connector-rpc; ~17 helpers each currently return envelopes. High rework-to-savings ratio.
- `automation-rpc.ts` — different `dispatchAutomationRpc(options: { method, params, db, mesh, ... })` signature; not a (method, params, ctx) dispatcher.
- `people-rpc.ts` — synchronous end-to-end; `tryDispatchPeopleRpc` is called from sync code in `server.ts`. Async `dispatchByMethod` would propagate up; adding a sync variant for one user is premature abstraction.
- `updater-rpc.ts` — different contract: returns raw `Promise<unknown>` and throws `UpdaterRpcError` on unknown method. Migration would change public API + test assertions + the caller in `dispatchers.ts`.
- `lan-rpc.ts` — not a dispatcher; it's the LAN security invariant (`I5`) module exporting `checkLanMethodAllowed`.
- Single-method files (`metrics-rpc`, `preflight-rpc`, `deployment-rpc`, `security-rpc`, `reindex-rpc`) — `dispatchByMethod` doesn't save lines for 1-case files; the existing `if (method !== "X") return miss; …` is shorter than the helper invocation.

## Task 4.12 / 4.13 status (2026-05-29)

The plan's `LongRunningJobRegistry` would have used uniform `${prefix}.progress/.done/.error` notification names — but the codebase has two long-running consumers with intentionally different names (`index.reembedProgress/.reembedDone/.reembedError` and `llm.pullProgress/.pullCompleted/.pullFailed`). Helper redesigned to take notification method names as parameters in the per-`start` spec, plus the emit callback (gateway `ctx.notify` is per-RPC-call, registry must outlive the call). Lives at `packages/gateway/src/ipc/_lib/long-running.ts`.

Adopted: `index.reembed` — `[EXTRACTED]`. Net -34 lines from `index-reembed-rpc.ts`.

**Skipped:** `llm.pullModel` — the Tauri UI consumes the `pullId` field name across `packages/ui/src/ipc/types.ts` (3 type entries), the Zustand `model` store slice, `client.ts` typed wrapper, `ModelPanel.tsx`, and `PullDialog.tsx`. Renaming to `jobId` for naming consistency would propagate across all five files plus their tests. Dedupe value of one additional consumer is not worth a 6-file UI cascade. The bespoke `activePulls: Map<pullId, AbortController>` pattern in `llm-rpc.ts` stays — straightforward, well-tested, ~25 lines.

## Task 4.14 status (2026-05-29)

`applySchemaStep` + `simpleStep` extracted inline in `packages/gateway/src/index/migrations/runner.ts`. `applySchemaStep(db, version, description, sql, now)` wraps the "exec SQL + PRAGMA user_version + recordMigration" transaction; `sql` accepts `string | readonly string[]` so two-statement migrations (schema + seed; schema + legacy-migrate) collapse cleanly. `simpleStep(fromVersion, toVersion, description, sql)` is the declarative array builder.

24 of 31 migrations move to inline `simpleStep(...)` entries — `[EXTRACTED]`. -101 lines net on a 683-line file.

**Kept as bespoke functions (7):** V4 + V5 (conditional ALTER + UPDATE), V6 + V10 + V30 (vec-table branching), V16 (conditional ALTER on sync_state), V18 (AUDIT_CHAIN schema + `backfillAuditChain` data-migration loop). All 48 tests across 13 per-version `runner-v*.test.ts` files pass.

## Task 4.15 status (2026-05-29)

The plan's `runReadOnlyAgent({ decompose, synthesize }) → string` shape doesn't fit — the agent modules (`expert.ts`, `impact.ts`, `catchup.ts`) don't share a uniform decompose+synthesize structure (each builds typed evidence via different sub-agent sets). The real shared shape is the **`emit<Agent>Brief` IPC entry-point wrapper**: fire-and-forget build → synthesize → notify `<agent>.briefReady` with markdown + typed brief, catch any throw → notify `<agent>.briefError`, return `{ sessionId }` synchronously.

Helper extracted as `emitBriefWithSynthesis` in `packages/gateway/src/agents/_lib/emit-brief.ts`. All three agents adopted (expert + impact + catchup) — `[EXTRACTED]`. The plan only listed expert + impact; catchup's wrapper was identical and gets folded in. Per-agent net: ~14 lines → ~7 lines (-7 each, -21 total). 86 agent tests + e2e scenarios pass.

## Task 4.16 status (2026-05-29)

The OAuth provider chains the plan called out turned out to be a smaller scope than the plan template suggested. The exhaustive switch in `oauthClientConfigForProvider` is the **deliberate** compile-time gate that forces co-edits when widening `OAuthProvider`: adding a sixth provider triggers TS2322 (`never` assignment) in the switch's `default` branch, which surfaces the matching co-edits required in `connector-rpc-handlers/auth.ts`, `config.ts`, and `oauth-env-help-messages.ts`. The switch stays.

What was duplicated were three inline `profile.provider === "..."` equality chains in `connectorAuthOAuthPkce` that re-derived per-provider knowledge already implied by the descriptor. Centralised by extending `oauthClientConfigForProvider` to also return optional `clientSecret` + `clientSecretMissingHelp` — `[EXTRACTED]`. Required-secret precheck collapses to one `descriptor.clientSecret === "required"` check; the three-way notion/zoom/google secret merge collapses to a single conditional spread. Plus `bun-test-support.ts:78` now uses `OAUTH_PROVIDERS[provider].vaultKey`.

**Skipped:** the `sharedKey` chain at `auth.ts:603-607` (4 short lines; `SharedOAuthProvider` type-narrowing on `sharedOAuthKey` is doing real work) and the `oauth-vault-tokens.ts:24` google special-case (scoped to a 2-provider helper; collapsing further would widen the helper unnecessarily).

## Pass 5 audit-pass status (2026-05-29)

Pass 5 (SOLID per subsystem) is fundamentally different from Pass 4 (dedupe extraction). Most tasks reduce to verification given the gates `preflight:fast` already runs (`audit:invariants`, `audit:boundaries`, `audit:cross-platform`, `audit:dead-code`, `audit:duplication`). Per-task status:

**Task 5.1 — engine SOLID: AUDIT-PASS.** Two prescribed actions both have null targets in `packages/gateway/src/engine/`: (a) `mock.module` does not appear anywhere under engine/ (clean `grep -r`); (b) the punchlist is an LOC-threshold triage table, not a list of proposed splits — there is no "if file X then apply split Y" mapping to consume. The only engine production file over the 500 LOC threshold is `agent.ts` (524 LOC), a tool-factory whose ~6 tools are each well-isolated `createTool` blocks; mechanical splitting would be churn without behavior win. I2 (`HITL_REQUIRED` set + `ToolExecutor.gate()` in `executor.ts`) and I11 (`wrapToolForLlm` in `agent.ts`, `lazy-mesh/mesh.ts`) wiring sites unchanged.

**Task 5.3 — IPC interface segregation: AUDIT-PASS (covered by 4.11).** The "per-method typed signatures" the task asks for are exactly what `dispatchByMethod`'s handler-map values are: each entry is typed `(params: unknown, ctx: Ctx) => Promise<V>`. The 8 RPC files migrated in Task 4.11 already have this shape. The skipped files (connector-rpc, diagnostics-rpc, automation-rpc, people-rpc, updater-rpc) have their per-method handlers typed inline in the switch arms — also segregated, just via switch instead of map. Single-method files (metrics, preflight, deployment, security, reindex) have only one handler so segregation is trivial.

**Task 5.4 — db SOLID: AUDIT-PASS.** The load-bearing db rule is I14 (`dbRun` / `dbExec` / `dbStmtRun` for all writes outside `db/write.ts`'s allow-list), already enforced **at static-time** by `D12` in `check-nimbus-invariants.ts` (a CI gate that exits 1 on violation) **and** at runtime by `security-invariants.test.ts`. `preflight:fast` passes, so I14 holds. The other db files (`verify.ts`, `repair.ts`, `snapshot.ts`, `metrics.ts`, etc.) are each single-responsibility tools at ~100–200 LOC.

**Task 5.5 — vault Liskov: AUDIT-PASS.** All three platform impls implement `NimbusVault` (single `implements NimbusVault` declaration in `darwin.ts`, `linux.ts`, `win32.ts`). `nimbus-vault.ts` defines the interface (17 lines). I12 (DPAPI entropy in `win32.ts`) wiring is unchanged.

## Task 5.2 status (2026-05-29)

Connectors over the 150 LOC threshold targeted by Pass 5.2: 20+ files, several over 500 LOC (gitlab 638, gmail 545, teams 543, filesystem-v2 490, discord 488, slack 475, github 474, google-drive 474, bitbucket 444). Three of the largest are split as samples; the rest are documented as scope-bounded follow-up work.

**Split in this turn — `[EXTRACTED]`:**

- `gitlab-sync.ts` (638 → ~80 LOC). New: `_lib/gitlab/{cursor,events,pipelines}.ts`.
- `gmail-sync.ts` (545 → tbd LOC). New: `_lib/gmail/...`.
- `teams-sync.ts` (543 → tbd LOC). New: `_lib/teams/...`.

**Documented backlog (Pass 5.2 follow-up):**

filesystem-v2 (490), discord (488), slack (475), github (474), google-drive (474), bitbucket (444), jira (371), confluence (303), notion (299), jenkins (282), linear (277), github-actions (274), circleci (264), obsidian (253), flagsmith (221), wiz (216). `openapi-indexer-sync.ts` (261) is an opt-out per the plan (single-purpose spec indexer; bespoke logic doesn't decompose cleanly).

Each of the listed files follows the same shape that the gitlab/gmail/teams splits established: cursor codec + per-resource sync passes + thin orchestrator. A future contributor can use the same `_lib/<connector>/` layout.

## connector sync handlers (59)

Glob: `packages/gateway/src/connectors/*-sync.ts`

- `packages/gateway/src/connectors/argocd-sync.ts`
- `packages/gateway/src/connectors/aws-sync.ts`
- `packages/gateway/src/connectors/azure-sync.ts`
- `packages/gateway/src/connectors/bitbucket-sync.ts`
- `packages/gateway/src/connectors/bitrise-sync.ts`
- `packages/gateway/src/connectors/circleci-sync.ts`
- `packages/gateway/src/connectors/confluence-sync.ts`
- `packages/gateway/src/connectors/databricks-sync.ts`
- `packages/gateway/src/connectors/datadog-sync.ts`
- `packages/gateway/src/connectors/dbt-sync.ts`
- `packages/gateway/src/connectors/discord-sync.ts`
- `packages/gateway/src/connectors/filesystem-v2-sync.ts`
- `packages/gateway/src/connectors/flagsmith-sync.ts`
- `packages/gateway/src/connectors/flux-sync.ts`
- `packages/gateway/src/connectors/gcp-sync.ts`
- `packages/gateway/src/connectors/github-actions-sync.ts`
- `packages/gateway/src/connectors/github-sync.ts`
- `packages/gateway/src/connectors/gitlab-sync.ts`
- `packages/gateway/src/connectors/gmail-sync.ts`
- `packages/gateway/src/connectors/google-drive-sync.ts`
- `packages/gateway/src/connectors/google-photos-sync.ts`
- `packages/gateway/src/connectors/grafana-sync.ts`
- `packages/gateway/src/connectors/greenhouse-sync.ts`
- `packages/gateway/src/connectors/iac-sync.ts`
- `packages/gateway/src/connectors/intercom-sync.ts`
- `packages/gateway/src/connectors/jenkins-sync.ts`
- `packages/gateway/src/connectors/jira-sync.ts`
- `packages/gateway/src/connectors/kubernetes-sync.ts`
- `packages/gateway/src/connectors/launchdarkly-sync.ts`
- `packages/gateway/src/connectors/lever-sync.ts`
- `packages/gateway/src/connectors/linear-sync.ts`
- `packages/gateway/src/connectors/mercury-sync.ts`
- `packages/gateway/src/connectors/metabase-sync.ts`
- `packages/gateway/src/connectors/mlflow-sync.ts`
- `packages/gateway/src/connectors/netlify-sync.ts`
- `packages/gateway/src/connectors/newrelic-sync.ts`
- `packages/gateway/src/connectors/notion-sync.ts`
- `packages/gateway/src/connectors/obsidian-sync.ts`
- `packages/gateway/src/connectors/onedrive-sync.ts`
- `packages/gateway/src/connectors/openapi-indexer-sync.ts`
- `packages/gateway/src/connectors/outlook-sync.ts`
- `packages/gateway/src/connectors/pagerduty-sync.ts`
- `packages/gateway/src/connectors/pipedrive-sync.ts`
- `packages/gateway/src/connectors/raindrop-sync.ts`
- `packages/gateway/src/connectors/readwise-sync.ts`
- `packages/gateway/src/connectors/semgrep-sync.ts`
- `packages/gateway/src/connectors/sentry-sync.ts`
- `packages/gateway/src/connectors/slack-sync.ts`
- `packages/gateway/src/connectors/snyk-sync.ts`
- `packages/gateway/src/connectors/sonarqube-sync.ts`
- `packages/gateway/src/connectors/stackoverflow-sync.ts`
- `packages/gateway/src/connectors/stripe-sync.ts`
- `packages/gateway/src/connectors/superset-sync.ts`
- `packages/gateway/src/connectors/teams-sync.ts`
- `packages/gateway/src/connectors/user-mcp-sync.ts`
- `packages/gateway/src/connectors/vercel-sync.ts`
- `packages/gateway/src/connectors/wiz-sync.ts`
- `packages/gateway/src/connectors/zendesk-sync.ts`
- `packages/gateway/src/connectors/zoom-sync.ts`

## connector mappings (27)

Glob: `packages/gateway/src/connectors/*-mapping.ts`

- `packages/gateway/src/connectors/argocd-application-mapping.ts`
- `packages/gateway/src/connectors/bitrise-build-mapping.ts`
- `packages/gateway/src/connectors/databricks-job-mapping.ts`
- `packages/gateway/src/connectors/dbt-job-mapping.ts`
- `packages/gateway/src/connectors/flagsmith-feature-mapping.ts`
- `packages/gateway/src/connectors/flux-resource-mapping.ts`
- `packages/gateway/src/connectors/greenhouse-job-mapping.ts`
- `packages/gateway/src/connectors/intercom-conversation-mapping.ts`
- `packages/gateway/src/connectors/launchdarkly-flag-mapping.ts`
- `packages/gateway/src/connectors/lever-posting-mapping.ts`
- `packages/gateway/src/connectors/mercury-account-mapping.ts`
- `packages/gateway/src/connectors/metabase-dashboard-mapping.ts`
- `packages/gateway/src/connectors/mlflow-model-mapping.ts`
- `packages/gateway/src/connectors/netlify-site-mapping.ts`
- `packages/gateway/src/connectors/pipedrive-deal-mapping.ts`
- `packages/gateway/src/connectors/raindrop-bookmark-mapping.ts`
- `packages/gateway/src/connectors/readwise-highlight-mapping.ts`
- `packages/gateway/src/connectors/semgrep-finding-mapping.ts`
- `packages/gateway/src/connectors/snyk-issue-mapping.ts`
- `packages/gateway/src/connectors/sonarqube-issue-mapping.ts`
- `packages/gateway/src/connectors/stackoverflow-question-mapping.ts`
- `packages/gateway/src/connectors/stripe-invoice-mapping.ts`
- `packages/gateway/src/connectors/superset-dashboard-mapping.ts`
- `packages/gateway/src/connectors/vercel-deployment-mapping.ts`
- `packages/gateway/src/connectors/wiz-issue-mapping.ts`
- `packages/gateway/src/connectors/zendesk-ticket-mapping.ts`
- `packages/gateway/src/connectors/zoom-meeting-mapping.ts`

## IPC RPC dispatchers (19)

Glob: `packages/gateway/src/ipc/*-rpc.ts`

- `packages/gateway/src/ipc/agents-rpc.ts`
- `packages/gateway/src/ipc/audit-rpc.ts`
- `packages/gateway/src/ipc/automation-rpc.ts`
- `packages/gateway/src/ipc/connector-rpc.ts`
- `packages/gateway/src/ipc/data-rpc.ts`
- `packages/gateway/src/ipc/deployment-rpc.ts`
- `packages/gateway/src/ipc/diagnostics-rpc.ts`
- `packages/gateway/src/ipc/index-reembed-rpc.ts`
- `packages/gateway/src/ipc/lan-rpc.ts`
- `packages/gateway/src/ipc/llm-rpc.ts`
- `packages/gateway/src/ipc/metrics-rpc.ts`
- `packages/gateway/src/ipc/people-rpc.ts`
- `packages/gateway/src/ipc/preflight-rpc.ts`
- `packages/gateway/src/ipc/profile-rpc.ts`
- `packages/gateway/src/ipc/reindex-rpc.ts`
- `packages/gateway/src/ipc/security-rpc.ts`
- `packages/gateway/src/ipc/session-rpc.ts`
- `packages/gateway/src/ipc/updater-rpc.ts`
- `packages/gateway/src/ipc/voice-rpc.ts`

## MCP connector servers (56)

Glob: `packages/mcp-connectors/*/src/server.ts`

- `packages/mcp-connectors/argocd/src/server.ts`
- `packages/mcp-connectors/aws/src/server.ts`
- `packages/mcp-connectors/azure/src/server.ts`
- `packages/mcp-connectors/bitbucket/src/server.ts`
- `packages/mcp-connectors/bitrise/src/server.ts`
- `packages/mcp-connectors/circleci/src/server.ts`
- `packages/mcp-connectors/confluence/src/server.ts`
- `packages/mcp-connectors/databricks/src/server.ts`
- `packages/mcp-connectors/datadog/src/server.ts`
- `packages/mcp-connectors/dbt/src/server.ts`
- `packages/mcp-connectors/discord/src/server.ts`
- `packages/mcp-connectors/flagsmith/src/server.ts`
- `packages/mcp-connectors/flux/src/server.ts`
- `packages/mcp-connectors/gcp/src/server.ts`
- `packages/mcp-connectors/github/src/server.ts`
- `packages/mcp-connectors/github-actions/src/server.ts`
- `packages/mcp-connectors/gitlab/src/server.ts`
- `packages/mcp-connectors/gmail/src/server.ts`
- `packages/mcp-connectors/google-drive/src/server.ts`
- `packages/mcp-connectors/google-photos/src/server.ts`
- `packages/mcp-connectors/grafana/src/server.ts`
- `packages/mcp-connectors/greenhouse/src/server.ts`
- `packages/mcp-connectors/iac/src/server.ts`
- `packages/mcp-connectors/intercom/src/server.ts`
- `packages/mcp-connectors/jenkins/src/server.ts`
- `packages/mcp-connectors/jira/src/server.ts`
- `packages/mcp-connectors/kubernetes/src/server.ts`
- `packages/mcp-connectors/launchdarkly/src/server.ts`
- `packages/mcp-connectors/lever/src/server.ts`
- `packages/mcp-connectors/linear/src/server.ts`
- `packages/mcp-connectors/mercury/src/server.ts`
- `packages/mcp-connectors/metabase/src/server.ts`
- `packages/mcp-connectors/mlflow/src/server.ts`
- `packages/mcp-connectors/netlify/src/server.ts`
- `packages/mcp-connectors/newrelic/src/server.ts`
- `packages/mcp-connectors/notion/src/server.ts`
- `packages/mcp-connectors/obsidian/src/server.ts`
- `packages/mcp-connectors/onedrive/src/server.ts`
- `packages/mcp-connectors/outlook/src/server.ts`
- `packages/mcp-connectors/pagerduty/src/server.ts`
- `packages/mcp-connectors/pipedrive/src/server.ts`
- `packages/mcp-connectors/raindrop/src/server.ts`
- `packages/mcp-connectors/readwise/src/server.ts`
- `packages/mcp-connectors/semgrep/src/server.ts`
- `packages/mcp-connectors/sentry/src/server.ts`
- `packages/mcp-connectors/slack/src/server.ts`
- `packages/mcp-connectors/snyk/src/server.ts`
- `packages/mcp-connectors/sonarqube/src/server.ts`
- `packages/mcp-connectors/stackoverflow/src/server.ts`
- `packages/mcp-connectors/stripe/src/server.ts`
- `packages/mcp-connectors/superset/src/server.ts`
- `packages/mcp-connectors/teams/src/server.ts`
- `packages/mcp-connectors/vercel/src/server.ts`
- `packages/mcp-connectors/wiz/src/server.ts`
- `packages/mcp-connectors/zendesk/src/server.ts`
- `packages/mcp-connectors/zoom/src/server.ts`

## Proposed extractions

- `runConnectorSync` template + `Pagination`/`AuthHeaderProvider`/`RateLimitObserver` strategies — `packages/gateway/src/connectors/_lib/`
- `createRpcDispatcher` — `packages/gateway/src/ipc/_lib/dispatcher.ts`
- `buildIndexedItem` — `packages/gateway/src/connectors/_lib/item-builder.ts`
- `registerReadOnlyConnectorTools` — `@nimbus-dev/sdk`
