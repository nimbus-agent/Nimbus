# Power BI Connector

## What this is

First-party Nimbus MCP connector for [Microsoft Power BI](https://powerbi.microsoft.com/).
Indexes the user's **Power BI reports** as `powerbi:dashboard` items in the
local index and exposes three read-only tools to the Nimbus agent
(`powerbi_list`, `powerbi_get`, `powerbi_search`). Indexes report metadata and
dataset table names for cross-connector lineage — **NEVER row data or cell values**.

Uses the Azure AD client-credentials flow to mint an OAuth 2.0 access token, then
calls the Power BI REST API (`GET /v1.0/myorg/reports`). Dataset table names are
normalized via `normalizeDataModelKey` so lineage edges converge with other
Slice-7 warehouse connectors.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set powerbi.tenant_id <your-azure-tenant-id>
nimbus vault set powerbi.client_id <your-app-client-id>
nimbus vault set powerbi.client_secret <your-app-client-secret>

nimbus ask "Which Power BI reports use the revenue dataset?"
```

The gateway injects `POWERBI_TENANT_ID`, `POWERBI_CLIENT_ID`, and
`POWERBI_CLIENT_SECRET` at spawn time via `phase3AddPowerBiMcp`; the connector
itself never touches the vault. Unlike the Snowflake/Tableau/Looker connectors,
Power BI uses fixed well-known endpoints — the static manifest declares
`login.microsoftonline.com` (for AAD tokens) and `api.powerbi.com` (for the
REST API) directly; no per-tenant host derivation is needed.

The gateway-side syncable
(`packages/gateway/src/connectors/powerbi-sync.ts`) obtains a token, lists
reports, optionally fetches dataset tables for lineage keys, then upserts each
report as a `dashboard` item with metadata `{ upstreamDataModelKeys }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `powerbi.tenant_id` | yes | Azure AD tenant ID (GUID or domain slug). |
| `powerbi.client_id` | yes | Azure AD application (client) ID. |
| `powerbi.client_secret` | yes | Azure AD client secret. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `powerbi_list` | List Power BI reports; optional `limit` cap (default 200, max 500). |
| `powerbi_get` | Fetch one report by id. |
| `powerbi_search` | Substring search across reports by name. |

All three tools are read-only; `hitlRequired` is intentionally empty. Write
tools (publish, update dataset) are deferred.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
