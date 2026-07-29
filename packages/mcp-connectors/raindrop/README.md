# Raindrop Connector

## What this is

First-party Nimbus MCP connector for [Raindrop.io](https://raindrop.io). Indexes
the user's saved **bookmarks** as `raindrop:bookmark` items and their parent
**collections** as `raindrop:collection` items in the local index, and exposes
six read-only tools to the Nimbus agent (`raindrop_list`, `raindrop_get`,
`raindrop_search`, `raindrop_collections_list`, `raindrop_collection_get`,
`raindrop_collections_search`). Useful for answering bookmarking questions —
"what did I save about retries?", "which shelf is that bookmark on?" — without
leaving Nimbus.

Highlights and per-collection filtering of bookmarks remain deferred follow-ups.

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
(`packages/gateway/src/connectors/raindrop-sync.ts`) runs two independent walks
over the same token:

| Walk | Endpoint(s) | Item type | Metadata |
| --- | --- | --- | --- |
| bookmarks | `GET /rest/v1/raindrops/0?perpage=50&page=N` — 0-based page number, incrementing while `items` is non-empty AND a full page of 50 (Raindrop's max), capped at 20 pages | `raindrop:bookmark` | `bookmark_id`, `title`, `link`, `excerpt`, `note`, `domain`, `type`, `tags`, `collection_id`, `created_at`, `updated_at`, `canonical_url` |
| collections | `GET /rest/v1/collections` (root) and `GET /rest/v1/collections/childrens` (nested) — **neither is paginated**, one request each | `raindrop:collection` | `collection_id`, `title`, `count`, `public`, `view`, `color`, `sort`, `parent_id`, `created_at`, `updated_at`, `canonical_url` |

Collection id `0` — the special "all raindrops" collection the bookmark walk
reads — is a query pseudo-id and is not returned by either collections
endpoint, so it is never indexed as an item. A failure in one walk degrades that
walk only.

Notes:

- `created` and `lastUpdate` are ISO-8601 strings on both object types; the
  connector converts them to epoch-milliseconds on index.
- A bookmark's `canonical_url` is the bookmarked `link`. A collection's is
  **null** — the Raindrop API returns no URL for a collection, and constructing
  an app deep link would be inventing data the vendor did not send.
- `tags` is stored as the array of tag strings (bookmarks only — the Collection
  object has no tags, and no description either, so its title is the only free
  text there is).
- A collection's `external_id` is `collection/<id>`, **not** the bare numeric id:
  Raindrop numbers collections and raindrops in separate id spaces, so an
  unprefixed collection id would collide with the bookmark of the same number on
  the shared `<service>:<external_id>` item primary key. Its
  `metadata.collection_id` is the raw **number**, so it joins a bookmark's
  `metadata.collection_id` directly.
- Both `raindrop:bookmark` and `raindrop:collection` stay on local MiniLM
  (384-dim) embeddings — neither is in `PROSE_HEAVY_TYPES`; the records are
  short, and adding them would route every hybrid-mode user's library through
  OpenAI.
- The `cover` image is deliberately not indexed on either type, nor are a
  collection's `access` / `collaborators` / `user` / `expanded` fields.

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
| `raindrop_collections_list` | List ALL collections — drains both the root and nested endpoints and concatenates them. |
| `raindrop_collection_get` | Fetch one collection by id (`GET /rest/v1/collection/{id}`) — the id space is separate from the bookmark id space. |
| `raindrop_collections_search` | Substring search across all collections (title, view, color). |

All six tools are read-only; `hitlRequired` is intentionally empty. Highlights
and per-collection filtering of bookmarks are deferred follow-ups.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
