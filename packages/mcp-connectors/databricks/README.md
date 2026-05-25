# Databricks Connector

## What this is

First-party Nimbus MCP connector for [Databricks](https://www.databricks.com/).
Indexes the user's **Databricks jobs** as `databricks:data_pipeline` items in
the local index and exposes three read-only tools to the Nimbus agent
(`databricks_list`, `databricks_get`, `databricks_search`). Each job is
enriched with its **latest run status** (life-cycle/result state, run id,
started-at, duration, cluster, triggered-by) resolved from one page of the
runs API. Useful for orchestration discovery — "which pipelines failed
overnight?".

v1 indexes **jobs only** — clusters, SQL warehouses, and notebooks/workspace
listing are a deferred follow-up. `job.trigger` / `job.cancel` /
`cluster.restart` (HITL) writes are deferred to Phase 6.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# Databricks has no universal SaaS host: both keys are required (no defaults).
# The host is your per-workspace URL (AWS / Azure / GCP all differ).
nimbus vault set databricks.host https://dbc-abc123.cloud.databricks.com
nimbus vault set databricks.token <your-databricks-pat>

nimbus ask "Which Databricks jobs failed in their latest run?"
```

Create a Personal Access Token in Databricks under Settings → Developer →
Access tokens. The Gateway injects `databricks.host` as `DATABRICKS_HOST` and
`databricks.token` as `DATABRICKS_TOKEN` at spawn time; the connector itself
never touches the vault. The token is sent as `Authorization: Bearer <token>`.
Because Databricks has no universal SaaS host, the sandbox network list is
empty in the static manifest — the gateway parses the hostname from
`databricks.host` and extends the sandbox network allow-list at spawn time
(`phase3AddDatabricksMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/databricks-sync.ts`) makes one
`GET /api/2.1/jobs/runs/list` call (to build a latest-run-per-job map; a non-ok
response here is non-fatal) and then walks `GET /api/2.1/jobs/list`
(token-paginated via `next_page_token`), upserting each job with metadata
`{ job_id, name, creator_user_name, schedule_cron, format, created_at,
latest_run_id, latest_run_status, latest_run_started_at,
latest_run_duration_ms, latest_run_cluster_id, latest_run_triggered_by,
canonical_url }`. Databricks timestamps are epoch milliseconds, surfaced as-is.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `databricks.host` | yes | Per-workspace Databricks URL (e.g. `https://dbc-abc123.cloud.databricks.com` or `https://adb-123.azuredatabricks.net`); requests go to `${host}/api/2.1/...`. |
| `databricks.token` | yes | Databricks Personal Access Token (sent as the `Authorization: Bearer` header). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `databricks_list` | List jobs (`GET /api/2.1/jobs/list`); optional `limit` (1..100) page-size cap. |
| `databricks_get` | Fetch one job by numeric `jobId`. |
| `databricks_search` | Substring search across jobs (`settings.name`, `creator_user_name`, `job_id`). |

All three tools are read-only; `hitlRequired` is intentionally empty. Clusters,
SQL warehouses, and notebooks/workspace listing — plus `job.trigger` /
`job.cancel` / `cluster.restart` (HITL) write tools — are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
