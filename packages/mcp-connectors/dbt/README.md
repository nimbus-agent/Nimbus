# dbt Cloud Connector

## What this is

First-party Nimbus MCP connector for [dbt Cloud](https://www.getdbt.com/product/dbt-cloud).
Indexes the user's **dbt Cloud jobs and their latest run status** across
accounts as `dbt:job` items in the local index and exposes three read-only
tools to the Nimbus agent (`dbt_list`, `dbt_get`, `dbt_search`). Useful for
incident correlation — "which dbt job last ran before the data alert fired?".

v1 indexes **jobs + run status only** via the Administrative API. Model-level
lineage (`data_model` items with upstream/downstream refs) requires the
separate dbt Discovery GraphQL API and is a deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# SaaS (cloud.getdbt.com)
nimbus vault set dbt.token <your-dbt-cloud-service-or-user-token>

# Regional / custom access URL (e.g. emea.dbt.com, au.dbt.com)
nimbus vault set dbt.api_base https://emea.dbt.com

# Restrict to a single account (optional; otherwise all accounts are discovered)
nimbus vault set dbt.account_id 12345

nimbus ask "Which dbt Cloud jobs failed their most recent run?"
```

The Gateway injects `dbt.token` as `DBT_TOKEN` (and the optional `dbt.api_base`
as `DBT_API_BASE`) at spawn time; the connector itself never touches the vault.
The dbt Cloud API token is sent as the `Authorization: Token <token>` header
(the literal word `Token`, a space, then the raw token — not `Bearer`). The
gateway-side syncable (`packages/gateway/src/connectors/dbt-sync.ts`) walks
`GET /api/v2/accounts/ → GET /api/v2/accounts/{id}/jobs/` (offset-paged
100/page, capped 20 pages per account) and upserts each job with metadata
`{ job_id, name, account_id, project_id, environment_id, dbt_version, state,
schedule_cron, triggers, created_at, updated_at, most_recent_run_status,
most_recent_run_finished_at, canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `dbt.token` | yes | dbt Cloud service/user API token (sent as `Authorization: Token <token>`). |
| `dbt.api_base` | no | Regional / custom-access-URL host root (default `https://cloud.getdbt.com`); requests go to `${api_base}/api/v2/...`. |
| `dbt.account_id` | no | Restrict the walk to a single account id; when unset, all accounts are discovered via `/accounts/`. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `dbt_list` | List accounts (no `accountId`), or jobs for an account. |
| `dbt_get` | Fetch one job by `accountId` + `jobId`. |
| `dbt_search` | Substring search across an account's jobs (name, dbt version, id). |

All three tools are read-only; `hitlRequired` is intentionally empty. Model
lineage (Discovery GraphQL API) and the `dbt.job.trigger` write tool are
deferred follow-ups (`dbt.job.trigger` lands behind HITL in Phase 6).

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
