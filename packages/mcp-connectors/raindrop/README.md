# Raindrop Connector

## What this is

First-party Nimbus MCP connector for [Raindrop.io](https://raindrop.io). Indexes
the user's saved **bookmarks** as `raindrop:bookmark` items in the local index
and exposes three read-only tools to the Nimbus agent (`raindrop_list`,
`raindrop_get`, `raindrop_search`). Useful for answering bookmarking questions —
"what did I save about retries?", "find my bookmark on backpressure" — without
leaving Nimbus.

v1 indexes bookmarks only. Collections-as-items, highlights, and per-collection
filtering are deferred follow-ups.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set raindrop.token <your-raindrop-api-token>
nimbus ask "What did I bookmark about exponential backoff?"
```

The `raindrop.token` value is a Raindrop.io **test token** or OAuth access token
(create an integration at <https://app.raindrop.io/settings/integrations>). It is
sent as `Authorization: Bearer <token>` and is never logged.

The Gateway injects `raindrop.token` as `RAINDROP_TOKEN` at spawn time; the
connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/raindrop-sync.ts`) walks
`GET /rest/v1/raindrops/0?perpage=50&page=N` (collection id `0` is the special
"all raindrops" collection) — the `{ result, items, count }` envelope — page
number is 0-based, incrementing `page` while `items` is non-empty and a full page
(`perpage=50`, Raindrop's max; capped at 20 pages), and upserts each bookmark
with metadata `{ bookmark_id, title, link, excerpt, note, domain, type, tags,
collection_id, created_at, updated_at, canonical_url }`.

Note: `created` and `lastUpdate` are ISO-8601 strings; the connector converts
them to epoch-milliseconds on index. The `canonical_url` is the bookmarked `link`.
`tags` is stored as the array of tag strings.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `raindrop.token` | yes | Raindrop.io test token or OAuth access token (sent as `Authorization: Bearer <token>`). |

The API host is fixed at `https://api.raindrop.io` (no host override key — it is
a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `raindrop_list` | List the user's bookmarks (`GET /rest/v1/raindrops/0?perpage=50`). |
| `raindrop_get` | Fetch one bookmark by id (`GET /rest/v1/raindrop/{id}`). |
| `raindrop_search` | Substring search across the bookmarks (title, excerpt, note, domain, link, type, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Collections-as-items, highlights, and per-collection filtering are deferred
follow-ups; v1 indexes bookmarks only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
