# Snowflake Connector

## What this is

First-party Nimbus MCP connector for [Snowflake](https://www.snowflake.com/).
Indexes the user's **Snowflake tables** as `snowflake:data_model` items in the
local index and exposes three read-only tools to the Nimbus agent
(`snowflake_list`, `snowflake_get`, `snowflake_search`). Indexes column names
and tags only — **NEVER row data or cell values**.

Uses the Snowflake SQL REST API (`POST /api/v2/statements`) with OAuth token
or key-pair JWT auth. v1 indexes tables from `information_schema.tables` across
all non-INFORMATION_SCHEMA schemas.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# OAuth token flow:
nimbus vault set snowflake.account acme-xy12345
nimbus vault set snowflake.oauth_token <your-oauth-token>

# Or key-pair JWT flow:
nimbus vault set snowflake.account acme-xy12345
nimbus vault set snowflake.key_pair_jwt <your-jwt>

nimbus ask "Which Snowflake tables contain revenue data?"
```

The account identifier is the part before `.snowflakecomputing.com`
(e.g. `acme-xy12345`). The gateway injects `SNOWFLAKE_ACCOUNT` and
`SNOWFLAKE_TOKEN` at spawn time; the connector itself never touches the vault.
Because Snowflake accounts have unique hostnames, the sandbox network list is
empty in the static manifest — the gateway derives the hostname from
`snowflake.account` and extends the sandbox network allow-list at spawn time
(`phase3AddSnowflakeMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/snowflake-sync.ts`) posts one
`/api/v2/statements` query to `information_schema.tables`, then upserts each
table as a `data_model` item with metadata `{ dataModelKey, columns,
rowCountEstimate, lastAltered }`. The `dataModelKey` is a normalized
`database.schema.table` identifier shared across all Slice-7 warehouse
connectors so cross-connector lineage edges converge on one graph node.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `snowflake.account` | yes | Snowflake account identifier (e.g. `acme-xy12345`); requests go to `https://${account}.snowflakecomputing.com`. |
| `snowflake.oauth_token` | one of | OAuth access token (sent as `Authorization: Bearer`). |
| `snowflake.key_pair_jwt` | one of | Key-pair JWT (sent as `Authorization: Bearer`). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `snowflake_list` | List tables; optional `limit` cap (default 200, max 500). |
| `snowflake_get` | Fetch one table by fully-qualified id (`database.schema.table`). |
| `snowflake_search` | Substring search across tables (name, schema, database). |

All three tools are read-only; `hitlRequired` is intentionally empty. Column
statistics, query history, and write tools are deferred.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
