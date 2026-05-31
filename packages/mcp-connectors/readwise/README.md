# Readwise Connector

## What this is

First-party Nimbus MCP connector for [Readwise](https://readwise.io). Indexes the
user's saved book/article **highlights** as `readwise:highlight` items in the
local index and exposes three read-only tools to the Nimbus agent
(`readwise_list`, `readwise_get`, `readwise_search`). Useful for answering
reading questions — "what did I highlight about retries?", "find my note on
backpressure" — without leaving Nimbus.

v1 indexes highlights only. Books, documents, and the daily-review feed are
deferred follow-ups, as is the newer Reader v3 API.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set readwise.token <your-readwise-api-token>
nimbus ask "What did I highlight about exponential backoff?"
```

The `readwise.token` value is a Readwise **API token** (get one at
<https://readwise.io/access_token>). It is sent as `Authorization: Token <token>`
(Django-REST-Framework token auth — the literal word "Token", NOT "Bearer") and
is never logged.

The Gateway injects `readwise.token` as `READWISE_TOKEN` at spawn time; the
connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/readwise-sync.ts`) walks
`GET /api/v2/highlights/?page_size=1000&page=N` — the DRF
`{ count, next, previous, results }` envelope — incrementing `page` while
`results` is non-empty and `next` is non-null (capped at 20 pages), and upserts
each highlight with metadata `{ highlight_id, text, note, book_id, location,
location_type, color, tags, source_url, highlighted_at, updated_at,
canonical_url }`.

Note: `highlighted_at` and `updated` are ISO-8601 strings; the connector
converts them to epoch-milliseconds on index. The `canonical_url` is the source
article `url` for web highlights (book highlights have a null source url).
`tags` is stored as the array of tag-name strings.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `readwise.token` | yes | Readwise API token (sent as `Authorization: Token <token>`). |

The API host is fixed at `https://readwise.io` (no host override key — it is a
SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `readwise_list` | List the user's highlights (`GET /api/v2/highlights/?page_size=1000`). |
| `readwise_get` | Fetch one highlight by id (`GET /api/v2/highlights/{id}/`). |
| `readwise_search` | Substring search across the highlights (text, note, color, location_type, tag names). |

All three tools are read-only; `hitlRequired` is intentionally empty. Books,
documents, the daily-review feed, and the Reader v3 API are deferred follow-ups;
v1 indexes highlights only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
