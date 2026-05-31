# Pipedrive Connector

## What this is

First-party Nimbus MCP connector for [Pipedrive](https://www.pipedrive.com). Indexes
the user's CRM **deals** as `pipedrive:deal` items in the local index and exposes
three read-only tools to the Nimbus agent (`pipedrive_list`, `pipedrive_get`,
`pipedrive_search`). Useful for answering sales questions — "what deals are
closing this month?", "find the Acme renewal deal" — without leaving Nimbus.

v1 indexes deals only. Persons, organizations, activities, and notes are deferred
follow-ups.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set pipedrive.token <your-pipedrive-api-token>
nimbus ask "Which Pipedrive deals are still open?"
```

The `pipedrive.token` value is a Pipedrive API token (find it under
Settings → Personal preferences → API in the Pipedrive web app).

> **Token safety.** Pipedrive authenticates with the token **in the query
> string** (`?api_token=<token>`) — there is no `Authorization` header, so the
> full request URL contains the secret. The connector and the gateway-side
> syncable therefore never log a request URL and never put a URL (or anything
> derived from it) into an error message; errors are built from the HTTP status
> code, the resource name, and a token-free response-body slice only.

The Gateway injects `pipedrive.token` as `PIPEDRIVE_TOKEN` at spawn time; the
connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/pipedrive-sync.ts`) walks
`GET /v1/deals?api_token=<t>&limit=100&start=N` — the
`{ success, data, additional_data: { pagination: { more_items_in_collection,
next_start } } }` envelope — following the `next_start` offset while
`more_items_in_collection` is true (capped at 20 pages), and upserts each deal
with metadata `{ deal_id, title, value, currency, status, stage_id, pipeline_id,
person_id, person_name, org_id, org_name, owner_name, probability, label,
expected_close_date, won_time, close_time, add_time, update_time, canonical_url }`.

Note: `add_time` / `update_time` are Pipedrive's non-ISO
`"YYYY-MM-DD HH:MM:SS"` **UTC** strings (NOT ISO-8601, NOT epoch); the connector
converts them to epoch-milliseconds on index. The `canonical_url` is `null` — a
Pipedrive deal deep link requires the company-specific domain, which the
token-only `api.pipedrive.com` base does not provide (deferred).

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `pipedrive.token` | yes | Pipedrive API token (sent as the `?api_token=` query parameter; never logged). |

The API host is fixed at `https://api.pipedrive.com` (no host override key — it
is a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `pipedrive_list` | List the user's deals (`GET /v1/deals?limit=100`). |
| `pipedrive_get` | Fetch one deal by id (`GET /v1/deals/{id}`). |
| `pipedrive_search` | Substring search across the deals (title, status, org name, person name, owner name, label). |

All three tools are read-only; `hitlRequired` is intentionally empty. Persons,
organizations, activities, and notes are deferred follow-ups; v1 indexes deals
only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
