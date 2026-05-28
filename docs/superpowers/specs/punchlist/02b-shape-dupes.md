# Punch list — section 2b: Shape duplication

## Task 4.7 status (2026-05-28)

The `runConnectorSync` template proposed below was redesigned as the
narrower `connectorFetch` helper in `packages/gateway/src/connectors/_lib/fetch-outcome.ts`
after a survey showed the actual duplication was the rate-limit + fetch
+ text + ok/parse → FetchOutcome block, not flat pagination. 28
connectors in the Tier-1/Tier-2 simple-REST list adopted the helper
(argocd, bitrise, databricks, dbt, flagsmith, flux, greenhouse,
intercom, launchdarkly, lever, mercury, metabase, mlflow, netlify,
raindrop, readwise, semgrep, snyk, sonarqube, stackoverflow, stripe,
superset, vercel, wiz, zendesk, zoom) — `[EXTRACTED]`. Opt-outs:
`obsidian`, `openapi-indexer` (filesystem, no HTTP), `pipedrive`
(api_token in query string — helper's url-log would leak it) —
`[N/A — opted out]`.

Out of scope for Task 4.7: older connectors that use Octokit-style
clients / non-Syncable shapes (github, gitlab, slack, jira, jenkins,
sentry, datadog, etc.) — they don't match the `Syncable` + `FetchOutcome`
+ `syncPassCursor*` envelope the helper targets.

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
