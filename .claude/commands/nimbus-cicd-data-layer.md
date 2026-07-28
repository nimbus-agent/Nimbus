---
name: nimbus-cicd-data-layer
description: >
  Phase 5 T4 CI/CD data layer: the four DORA calculators (deployment frequency, lead
  time, change failure rate, MTTR), the pre-deploy preflight check, the post-deploy
  annotation pipeline, the `[metrics.dora.<id>]` + `[ci.service.<id>]` nimbus.toml
  schema, URN-based repo + PagerDuty binding, the OpenAPI surface (`/v1/metrics/dora`,
  `/v1/preflight/deploy`, `POST /v1/deployments`), and `packages/github-actions/`. Use
  when adding a DORA metric / preflight check / deployment provider, changing the pure
  calculators, modifying `ServiceConfig`, wiring a CI integration that feeds the index,
  counting P1 incidents (`severity_p1_aliases`), or asking why `nimbus metrics dora`
  returns nulls / a deploy is missing from `deployment_frequency`. Consult before any
  change under `packages/gateway/src/{metrics,preflight,deployment}/`.
---

# Nimbus CI/CD Data Layer (Phase 5 T4)

## Why This Skill Exists

Phase 5 T4 introduced three connected systems: DORA metric calculators that read the local index, a pre-deploy check that returns three structured counts, and a post-deploy annotation pipeline that lets CI feed back into the index over a narrow HTTP write surface. Together they let a CI job answer "is it safe to deploy?" and then record what happened, all without an external SaaS metrics store.

The pieces are deliberately separated:

- **Calculators are pure functions.** They take inputs and return envelopes; they do not touch the database or the network.
- **RPC handlers are thin wrappers.** They parse, hand off to a calculator, format the response.
- **HTTP routes are dispatched via I13** — see the `nimbus-http-write-surface` skill for the write-side discipline.
- **GitHub Actions are thin client wrappers.** They call the HTTP API; they contain no calculation logic.

Adding a new metric or check means writing a pure calculator and wiring it; do not let business logic leak into the RPC handler or the GitHub Action.

## Where It Lives

| Area | File | Role |
|---|---|---|
| **DORA calculators** | [`packages/gateway/src/metrics/dora.ts`](../../packages/gateway/src/metrics/dora.ts) | Four pure functions: `deploymentFrequency`, `leadTimeForChanges`, `changeFailureRate`, `mttr`. Each returns a `{ value, unit, sample, gap }` envelope |
| | [`packages/gateway/src/metrics/dora-config.ts`](../../packages/gateway/src/metrics/dora-config.ts) | `ServiceConfig` type (and `DoraServiceConfig` back-compat alias), URN parser, provider-prefix → `service` column map |
| **Preflight** | [`packages/gateway/src/preflight/preflight.ts`](../../packages/gateway/src/preflight/preflight.ts) | Pure: counts active P1 incidents, failing CI on target ref, open PR conflicts. Returns `DeployPreflightResult` envelope |
| **Deployment annotation** | [`packages/gateway/src/deployment/annotate.ts`](../../packages/gateway/src/deployment/annotate.ts) | Pure validator + index upsert (one `item` row + one `deployment_items` shadow row + one audit entry) |
| | [`packages/gateway/src/deployment/external-id.ts`](../../packages/gateway/src/deployment/external-id.ts) | Stable `external_id` derivation: `<provider>:<sha>:<env>` |
| | [`packages/gateway/src/deployment/types.ts`](../../packages/gateway/src/deployment/types.ts) | Shared `DeploymentAnnotateInput` / `DeploymentAnnotateResult` types |
| **RPC** | [`packages/gateway/src/ipc/metrics-rpc.ts`](../../packages/gateway/src/ipc/metrics-rpc.ts) | `metrics.dora` handler |
| | [`packages/gateway/src/ipc/preflight-rpc.ts`](../../packages/gateway/src/ipc/preflight-rpc.ts) | `deploy.preflight` handler |
| | [`packages/gateway/src/ipc/deployment-rpc.ts`](../../packages/gateway/src/ipc/deployment-rpc.ts) | Internal `deployment.annotate` handler (NOT in renderer allowlist) |
| **HTTP surface** | [`packages/gateway/openapi/v1.yaml`](../../packages/gateway/openapi/v1.yaml) | OpenAPI schema for `/v1/metrics/dora`, `/v1/preflight/deploy`, `POST /v1/deployments` |
| **CLI** | [`packages/cli/src/commands/metrics.ts`](../../packages/cli/src/commands/metrics.ts) | `nimbus metrics dora` |
| | [`packages/cli/src/commands/deploy.ts`](../../packages/cli/src/commands/deploy.ts) | `nimbus deploy preflight` |
| | [`packages/cli/src/commands/deploy-annotate.ts`](../../packages/cli/src/commands/deploy-annotate.ts) | `nimbus deploy annotate` |
| **First-party Actions** | [`packages/github-actions/preflight-query/`](../../packages/github-actions/preflight-query/) | Wraps `GET /v1/preflight/deploy` |
| | [`packages/github-actions/annotate-action/`](../../packages/github-actions/annotate-action/) | Wraps `POST /v1/deployments` |

## Service Configuration

The `<service-id>` chosen by the user (e.g. `payment-service`) is the table key for both `[metrics.dora.<id>]` and `[ci.service.<id>]` blocks. The format is enforced separately at each surface:

- **DORA / preflight CLI:** accept any non-empty string (TOML key validity is the only constraint).
- **`deploy annotate` CLI + HTTP body:** 1..64 chars matching `/^[a-z0-9][a-z0-9._-]*$/`. No colons, no slashes — distinct from URN format.

Repos and PagerDuty services bind to the service id via URNs in the config block:

```toml
[metrics.dora.payment-service]
repos = ["github:acme/payment-service", "github:acme/payment-service-infra"]
pagerduty_services = ["PSVC123", "PSVC456"]
deploy_workflow_pattern = "^Deploy"
incident_window_minutes = 60
exclude_pr_labels = ["dependabot", "docs"]
deploy_environments = ["production"]
```

The provider prefix (`github:`, `gitlab:`, `bitbucket:`, `jenkins:`, `circleci:`) maps to a `service` column value via `providerToServiceColumn` in `dora-config.ts`. Adding a new provider means adding both the type alias entry and the column-map entry.

`severity_p1_aliases` (added in T4 wrap-up, 2026-05-16) is org-wide in `[pagerduty]`:

```toml
[pagerduty]
severity_p1_aliases = ["sev1", "sev-1", "critical"]
```

The set is lowercased + deduplicated at load and copied onto every materialized `ServiceConfig`. An empty default preserves the pre-existing strict `severity = 'P1'` filter — adding aliases is opt-in.

## DORA Calculators

Each calculator is a pure function:

```typescript
function deploymentFrequency(input: {
  readonly deployments: readonly Deployment[];
  readonly windowMs: { since: number; until: number };
  readonly deployEnvironments: readonly string[];
}): DoraMetricEnvelope;
```

The envelope shape is uniform across all four metrics:

| Field | Meaning |
|---|---|
| `value` | The metric value, or `null` if `sample` is too small to compute |
| `unit` | Human-readable unit string (e.g. `"per_day"`, `"hours"`, `"percent"`) |
| `sample` | Number of inputs the metric was computed from |
| `gap` | Optional explanation when `value === null` (e.g. `"no deployments in window"`) |

Adding a fifth metric: add a fifth pure function with the same envelope shape, extend the `DoraEnvelope.metrics` type, and update both `metrics-rpc.ts` and the CLI renderer.

## Preflight

```typescript
function computePreflight(input: {
  readonly activeP1Count: number;
  readonly failingCiCount: number;
  readonly openPrConflictCount: number;
}): DeployPreflightResult;
```

The function itself is trivial; the heavy lifting is in the SQL the RPC handler runs to compute the three counts. Use the existing handler's queries as the template — they hit the unified `item` table with the provider→service-column map, filtered by the service's repo set and the optional `severity_p1_aliases`.

Verdict is `ok` if all three counts are zero, `warn` otherwise. The CLI's `--mode block` flag flips a `warn` verdict into exit code 1; the calculator itself does not know about modes.

## Deployment Annotation

`annotateDeployment` validates the input, derives the `external_id` (`<provider>:<sha>:<env>`), and writes three rows in one transaction via `dbRun` (invariant I14):

1. An `item` row with `type = 'deployment'`, `external_id` from the helper, `metadata` JSON containing `nimbus_service_id`, ref, status, durations, workflow URL.
2. A `deployment_items` shadow row (V28) with structured columns for fast DORA queries.
3. One audit entry — `actionType = 'deployment.annotated'`, `hitlStatus = 'not_required'`.

The conflict resolution is `ON CONFLICT(service, external_id) DO UPDATE` so retries are idempotent. The `is_new` flag in the response tells the caller whether the row was created or updated.

`dora_eligible` is `true` when `environment` is in the service's `deploy_environments` list — non-prod deploys are recorded but excluded from DORA metric inputs.

## Adding a New Provider — Checklist

When adding a new CI provider (e.g. `azure-pipelines`):

- [ ] Add the literal to `DoraProvider` in `dora-config.ts` and to `DeploymentProvider` in `deployment/types.ts`.
- [ ] Add the provider → `service` column entry in `providerToServiceColumn`.
- [ ] Add the literal to `PROVIDER_VALUES` in `deploy-annotate.ts`.
- [ ] Add a unit test in `dora.test.ts` that exercises a deployment from the new provider.
- [ ] If the provider needs a connector, follow the `nimbus-connector-authoring` skill.
- [ ] If the provider needs a first-party GitHub Action equivalent, add it under `packages/github-actions/<name>-action/`.

## Adding a New DORA Metric — Checklist

- [ ] Author a pure function in `metrics/dora.ts` returning the standard `{ value, unit, sample, gap }` envelope.
- [ ] Add the new metric key to the `DoraEnvelope.metrics` type in `metrics-rpc.ts`.
- [ ] Update the CLI pretty-print renderer in `metrics.ts` to show the new card.
- [ ] Update [`packages/gateway/openapi/v1.yaml`](../../packages/gateway/openapi/v1.yaml) — the `DoraEnvelope` schema. **Failing to do this fails `bun run audit:openapi-drift`** (CI gate from T4 PR 1).
- [ ] Update [`docs/cli-reference.md`](../../docs/cli-reference.md) §"CI/CD".
- [ ] Add a unit test covering the new metric in `dora.test.ts`; coverage gate is `bun run test:coverage:metrics` (≥80%).

## Adding a New Preflight Check — Checklist

- [ ] Add the count to the `DeployPreflightResult.findings` shape.
- [ ] Run the SQL in `preflight-rpc.ts` (the calculator stays pure).
- [ ] Decide whether a non-zero count flips verdict from `ok` → `warn`. If yes, that's a single new clause in the verdict computation.
- [ ] Update the CLI renderer in `deploy.ts` for both pretty and `--json` output.
- [ ] Update OpenAPI schema (the gate will catch you if not).
- [ ] Add coverage in `preflight.test.ts`; gate is `bun run test:coverage:preflight` (≥80%).

## Anti-Patterns

| Anti-pattern | Why it's bad | What to do instead |
|---|---|---|
| Putting SQL or HTTP fetches in the pure calculator | Calculators are reused by tests, multiple RPC paths, and (someday) a Grafana scraper. Side effects in the calculator kill all three | Keep the calculator pure; the RPC handler is the I/O boundary |
| Hardcoding `severity = 'P1'` in a new preflight or DORA query | The org-wide `severity_p1_aliases` list is the canonical source. New queries must read it from the materialized `ServiceConfig` | Pass the alias list through; default to the strict P1 filter when the set is empty |
| Adding a new HTTP write route directly in `http-server.ts` for "deployment.cancel" | Bypasses I13 entirely | Follow the `nimbus-http-write-surface` skill: add to `WRITE_ROUTE_ALLOWLIST`, update the count assertion, route through `dispatchWriteRoute` |
| Letting the GitHub Action contain calculation logic | The Action is a thin curl wrapper. Logic in the Action means you have two implementations to keep in sync, and shell logic is worse than TS | Put the logic in the gateway calculator; the Action just POSTs |
| Building a new "deploy" calculator that calls `connector-sync` to refresh data first | Calculators are read-only and synchronous. Refreshing is a sync-scheduler concern; if the user wants fresher data they run `nimbus connector sync <name>` first | Document the freshness expectation in the metric's `gap` field |
| Returning `value: 0` when the sample is empty instead of `value: null` + `gap: "no data in window"` | Confuses "zero deploys" (legitimate signal) with "no data" (operational gap) | Always use `null` + `gap` for unknowable; reserve `0` for measured-as-zero |
| Adding a per-route bearer-token vault key (e.g. `http_api.preflight_token`) | One token covers the entire HTTP write surface today by design. Per-route tokens would multiply the rotation burden | Use the existing `http_api.deployment_token`. If finer-grained auth is genuinely needed, that's a discrete design discussion, not an implementation detail |

## Testing

Coverage gates:

| Subsystem | Bun script | Threshold |
|---|---|---|
| DORA calculators + IPC | `bun run test:coverage:metrics` | ≥80% |
| Preflight calculator + IPC + HTTP + github-sync `mergeable` enrichment | `bun run test:coverage:preflight` | ≥80% |
| Post-deploy annotation calculator + HTTP write surface | `bun run test:coverage:deployment` | ≥80% |

All three are part of `bun run test:ci`. A new calculator without a corresponding unit test fails CI on the relevant gate before any feature is reviewed.

## See Also

- `nimbus-http-write-surface` skill — for the I13 discipline that the `POST /v1/deployments` route follows
- `nimbus-ipc` skill — for the RPC handler conventions (`metrics.*`, `deploy.*`, `deployment.*`)
- `nimbus-commands` skill — for the CLI invocation, vault key, and coverage-gate names
- `nimbus-architecture` skill — for the unified `item` table model and the V28 `deployment_items` shadow
- [`docs/cli-reference.md`](../../docs/cli-reference.md) §"CI/CD" — user-facing CLI documentation
- [`docs/SECURITY.md`](../../docs/SECURITY.md) §"IPC Surface" — boundary description for the HTTP write surface
