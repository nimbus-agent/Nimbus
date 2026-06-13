# Tableau Connector

## What this is

First-party Nimbus MCP connector for [Tableau](https://www.tableau.com/).
Indexes the user's **Tableau views and dashboards** as `tableau:dashboard` items in the
local index and exposes three read-only tools to the Nimbus agent
(`tableau_list`, `tableau_get`, `tableau_search`). Indexes view metadata
only — **NEVER underlying data or cell values**.

Uses the Tableau REST API v3.4 with Personal Access Token (PAT) auth.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set tableau.url https://your-server.tableau.com
nimbus vault set tableau.pat_name my-pat-name
nimbus vault set tableau.pat_secret my-pat-secret

nimbus ask "Show me my Tableau dashboards"
```

The server URL is the base URL of your Tableau Server or Tableau Cloud site
(e.g. `https://10ay.online.tableau.com`). The gateway injects `TABLEAU_URL`,
`TABLEAU_PAT_NAME`, and `TABLEAU_PAT_SECRET` at spawn time; the connector
itself never touches the vault. Because Tableau instances have per-tenant
hostnames, the sandbox network list is empty in the static manifest — the
gateway derives the hostname from `tableau.url` and extends the sandbox network
allow-list at spawn time (`phase3AddTableauMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/tableau-sync.ts`) signs in via
`POST /api/3.4/auth/signin`, then lists views via
`GET /api/3.4/sites/{siteId}/views`, and upserts each view as a
`dashboard` item with metadata `{ upstreamDataModelKeys, author, folder,
extractRefreshStatus }`. The `upstreamDataModelKeys` array links dashboards
to upstream warehouse tables via the shared `normalizeDataModelKey` function
so cross-connector lineage edges converge on one graph node.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `tableau.url` | yes | Tableau Server or Cloud base URL (e.g. `https://10ay.online.tableau.com`). |
| `tableau.pat_name` | yes | Personal Access Token name. |
| `tableau.pat_secret` | yes | Personal Access Token secret. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `tableau_list` | List views/dashboards; optional `limit` cap (default 200, max 500). |
| `tableau_get` | Fetch one view by luid. |
| `tableau_search` | Substring search across views (name, luid). |

All three tools are read-only; `hitlRequired` is intentionally empty. Write
tools and workbook-level metadata are deferred.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
