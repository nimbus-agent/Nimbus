# MLflow Connector

## What this is

First-party Nimbus MCP connector for [MLflow](https://mlflow.org/).
Indexes the user's **MLflow registered models** as `mlflow:ml_model` items in
the local index and exposes three read-only tools to the Nimbus agent
(`mlflow_list`, `mlflow_get`, `mlflow_search`). Each registered model surfaces
its **latest version** (version number, stage, status, run id) — preferring the
`Production`-stage entry, else the highest numeric version — plus its
description, created + updated timestamps, and tags. Useful for model-registry
discovery — "which models are in Production?".

v1 indexes **registered models only** — experiments, runs, metrics, params, and
artifacts are a deferred follow-up. `ml.model.promote` /
`ml.model.transition-stage` (HITL) writes are deferred to Phase 6.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# MLflow has no universal SaaS host: both keys are required (no defaults).
# The host is your tracking-server URL (self-hosted or managed).
nimbus vault set mlflow.host https://mlflow.acme.com
nimbus vault set mlflow.token <your-mlflow-api-token>

nimbus ask "Which MLflow models are in Production?"
```

The Gateway injects `mlflow.host` as `MLFLOW_HOST` and `mlflow.token` as
`MLFLOW_TOKEN` at spawn time; the connector itself never touches the vault. The
token is sent as `Authorization: Bearer <token>`. Because MLflow has no
universal SaaS host, the sandbox network list is empty in the static manifest —
the gateway parses the hostname from `mlflow.host` and extends the sandbox
network allow-list at spawn time (`phase3AddMlflowMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/mlflow-sync.ts`) walks
`GET /api/2.0/mlflow/registered-models/search` (token-paginated via
`next_page_token`), upserting each registered model with metadata
`{ name, description, version_count, latest_version, latest_stage,
latest_status, latest_run_id, created_at, updated_at, tags, canonical_url }`.
MLflow timestamps are epoch milliseconds, surfaced as-is.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `mlflow.host` | yes | Tracking-server URL (e.g. `https://mlflow.acme.com`); requests go to `${host}/api/2.0/mlflow/...`. |
| `mlflow.token` | yes | MLflow API token (sent as the `Authorization: Bearer` header). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `mlflow_list` | List registered models (`GET /api/2.0/mlflow/registered-models/search`); optional `limit` (1..100) page-size cap. |
| `mlflow_get` | Fetch one registered model by `name`. |
| `mlflow_search` | Substring search across registered models (`name`, `description`, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Experiments, runs, metrics, params, and artifacts — plus
`ml.model.promote` / `ml.model.transition-stage` (HITL) write tools — are a
deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
