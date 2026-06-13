# Bigeye Connector

## What this is

First-party Nimbus MCP connector for [Bigeye](https://www.bigeye.com/).
Indexes the user's **Bigeye data-quality issues** as `data_quality_test` items in the
local index and exposes three read-only tools to the Nimbus agent
(`bigeye_list`, `bigeye_get`, `bigeye_search`). Indexes issue metadata and
monitored table names for cross-connector lineage — **NEVER row data or cell values**.

Uses a Bearer API key against a per-tenant Bigeye instance (`base_url`).
The per-tenant host is derived from `bigeye.base_url` at spawn time (like
the Looker/Tableau/Snowflake connectors).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set bigeye.base_url https://app.bigeye.com
nimbus vault set bigeye.api_key <your-bigeye-api-key>

nimbus ask "Which tables have active Bigeye data-quality breaches?"
```

The gateway injects `BIGEYE_BASE_URL` and `BIGEYE_API_KEY` at spawn time via
`phase3AddBigeyeMcp`; the connector itself never touches the vault.

The gateway-side syncable
(`packages/gateway/src/connectors/bigeye-sync.ts`) lists issues via
`GET /api/v1/issues`, then upserts each issue as a `data_quality_test` item
with metadata `{ monitoredDataModelKeys, slaStatus, anomaly }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `bigeye.base_url` | yes | Per-tenant Bigeye instance URL (e.g. `https://app.bigeye.com`). |
| `bigeye.api_key` | yes | Bigeye API key (Bearer token). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `bigeye_list` | List Bigeye data-quality issues; optional `limit` cap (default 200, max 500). |
| `bigeye_get` | Fetch one issue by id. |
| `bigeye_search` | Substring search across issues by summary. |

All three tools are read-only; `hitlRequired` is intentionally empty. Write
tools are deferred.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
