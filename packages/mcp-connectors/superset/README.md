# Superset Connector

## What this is

First-party Nimbus MCP connector for [Apache Superset](https://superset.apache.org/).
Indexes the user's **Superset dashboards** as `superset:dashboard` items in
the local index and exposes three read-only tools to the Nimbus agent
(`superset_list`, `superset_get`, `superset_search`). Superset has no static
API key: the connector authenticates with username/password against
`POST /api/v1/security/login` to obtain a short-lived JWT, then calls the
dashboards API with `Authorization: Bearer <access_token>`. Useful for
analytics discovery — "which Superset dashboards track payment failures?".

v1 indexes **dashboards only** — charts, datasets, and saved queries are a
deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# Superset is self-hosted: all three keys are required (no defaults).
nimbus vault set superset.url https://superset.acme.com
nimbus vault set superset.username analytics-reader
nimbus vault set superset.password <your-superset-password>

nimbus ask "Which Superset dashboards mention revenue?"
```

Use a low-privilege Superset account dedicated to read access. The Gateway
injects `superset.url` as `SUPERSET_URL`, `superset.username` as
`SUPERSET_USERNAME`, and `superset.password` as `SUPERSET_PASSWORD` at spawn
time; the connector itself never touches the vault. The connector logs in
once per process (`POST /api/v1/security/login` with `{ username, password,
provider: "db", refresh: true }`), caches the returned JWT, and sends it as
`Authorization: Bearer <access_token>` on every subsequent request. Because
Superset has no universal SaaS host, the sandbox network list is empty in the
static manifest — the gateway parses the hostname from `superset.url` and
extends the sandbox network allow-list at spawn time (`phase3AddSupersetMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/superset-sync.ts`) logs in, then walks
`GET /api/v1/dashboard/?q=(page:N,page_size:100)` (Rison-paginated `result`
envelope), and upserts each dashboard with metadata `{ dashboard_id, title,
slug, published, status, owner_count, changed_by, changed_at, canonical_url }`.
If login fails, the whole sync degrades to a graceful empty pass (no throw).

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `superset.url` | yes | Superset base URL (e.g. `https://superset.acme.com`); requests go to `${url}/api/v1/...`. |
| `superset.username` | yes | Superset username for the login (`provider: "db"`) flow. |
| `superset.password` | yes | Superset password; exchanged for a JWT at login, never logged. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `superset_list` | List dashboards; optional `limit` cap. |
| `superset_get` | Fetch one dashboard by numeric `id`. |
| `superset_search` | Substring search across dashboards (title, slug). |

All three tools are read-only; `hitlRequired` is intentionally empty. Charts,
datasets, saved queries, and write tools are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
