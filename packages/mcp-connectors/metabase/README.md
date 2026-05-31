# Metabase Connector

## What this is

First-party Nimbus MCP connector for [Metabase](https://www.metabase.com/).
Indexes the user's **Metabase dashboards** as `metabase:dashboard` items in
the local index and exposes three read-only tools to the Nimbus agent
(`metabase_list`, `metabase_get`, `metabase_search`). Each dashboard's
collection name is resolved from a single `GET /api/collection` call. Useful
for analytics discovery — "which dashboards track payment failures?".

v1 indexes **dashboards only** — saved questions (cards) and
collections-as-items are a deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# Metabase has no universal SaaS host: both keys are required (no defaults).
nimbus vault set metabase.url https://acme.metabaseapp.com
nimbus vault set metabase.api_key <your-metabase-api-key>

nimbus ask "Which Metabase dashboards mention revenue?"
```

Create the API key in Metabase under Settings → Admin → Authentication → API
keys. The Gateway injects `metabase.url` as `METABASE_URL` and
`metabase.api_key` as `METABASE_API_KEY` at spawn time; the connector itself
never touches the vault. The Metabase API key is sent as the `x-api-key`
request header (NOT `Authorization`). Because Metabase has no universal SaaS
host, the sandbox network list is empty in the static manifest — the gateway
parses the hostname from `metabase.url` and extends the sandbox network
allow-list at spawn time (`phase3AddMetabaseMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/metabase-sync.ts`) makes one
`GET /api/collection` call (to resolve collection ids → names) and one
`GET /api/dashboard` call (Metabase returns the full list in one response —
no pagination), then upserts each dashboard with metadata `{ dashboard_id,
name, description, collection_id, collection_name, creator_id, archived,
card_count, created_at, updated_at, canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `metabase.url` | yes | Metabase base URL (e.g. `https://acme.metabaseapp.com`); requests go to `${url}/api/...`. |
| `metabase.api_key` | yes | Metabase API key (sent as the `x-api-key` header). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `metabase_list` | List dashboards; optional `limit` cap. |
| `metabase_get` | Fetch one dashboard by numeric `id`. |
| `metabase_search` | Substring search across dashboards (name, description). |

All three tools are read-only; `hitlRequired` is intentionally empty. Saved
questions (cards) + write tools are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
