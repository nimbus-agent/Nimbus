# Looker Connector

## What this is

First-party Nimbus MCP connector for [Looker](https://cloud.google.com/looker).
Indexes the user's **Looker dashboards and LookML views** as `looker:dashboard` and
`looker:data_model` items in the local index and exposes three read-only tools to
the Nimbus agent (`looker_list`, `looker_get`, `looker_search`). Indexes metadata
only — **NEVER underlying data or cell values**.

Uses the Looker API 4.0 with OAuth2 client-credentials auth.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set looker.base_url https://your-instance.looker.com
nimbus vault set looker.client_id your-client-id
nimbus vault set looker.client_secret your-client-secret

nimbus ask "Show me my Looker dashboards"
```

The base URL is the root URL of your Looker instance
(e.g. `https://your-company.cloud.looker.com`). The gateway injects
`LOOKER_BASE_URL`, `LOOKER_CLIENT_ID`, and `LOOKER_CLIENT_SECRET` at spawn time;
the connector itself never touches the vault. Because Looker instances have
per-tenant hostnames, the sandbox network list is empty in the static manifest —
the gateway derives the hostname from `looker.base_url` and extends the sandbox
network allow-list at spawn time (`phase3AddLookerMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/looker-sync.ts`) authenticates via
`POST /api/4.0/login` with client-credentials, then lists dashboards via
`GET /api/4.0/dashboards` and LookML models/views via
`GET /api/4.0/lookml_models`. LookML view `sql_table_name` fields are normalized
via `normalizeDataModelKey` to produce cross-connector lineage edges (Looker→dbt),
stored as `dataModelKey` metadata on each `data_model` item.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `looker.base_url` | yes | Looker instance base URL (e.g. `https://your-company.cloud.looker.com`). |
| `looker.client_id` | yes | OAuth2 client ID. |
| `looker.client_secret` | yes | OAuth2 client secret. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `looker_list` | List dashboards and LookML views; optional `limit` cap (default 200, max 500). |
| `looker_get` | Fetch one dashboard or view by id. |
| `looker_search` | Substring search across dashboards and views (title, id, model name). |

All three tools are read-only; `hitlRequired` is intentionally empty. Write
tools and Explore-level metadata are deferred.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
