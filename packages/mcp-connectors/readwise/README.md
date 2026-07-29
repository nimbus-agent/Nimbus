# Readwise Connector

## What this is

First-party Nimbus MCP connector for [Readwise](https://readwise.io). Indexes the
user's saved book/article **highlights** as `readwise:highlight` items and their
parent **books/articles** as `readwise:book` items in the local index, and
exposes six read-only tools to the Nimbus agent (`readwise_list`,
`readwise_get`, `readwise_search`, `readwise_books_list`, `readwise_book_get`,
`readwise_books_search`). Useful for answering reading questions — "what did I
highlight about retries?", "which book was that note in?" — without leaving
Nimbus.

Documents, the daily-review feed, and the newer Reader v3 API remain deferred
follow-ups.

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
(`packages/gateway/src/connectors/readwise-sync.ts`) runs two independent walks
over the same token — both use the DRF `{ count, next, previous, results }`
envelope and increment `page` while `results` is non-empty and `next` is
non-null (each capped at 20 pages):

| Walk | Endpoint | Item type | Metadata |
| --- | --- | --- | --- |
| highlights | `GET /api/v2/highlights/?page_size=1000&page=N` | `readwise:highlight` | `highlight_id`, `text`, `note`, `book_id`, `location`, `location_type`, `color`, `tags`, `source_url`, `highlighted_at`, `updated_at`, `canonical_url` |
| books | `GET /api/v2/books/?page_size=1000&page=N` | `readwise:book` | `book_id`, `title`, `author`, `category`, `source`, `num_highlights`, `asin`, `tags`, `document_note`, `source_url`, `highlights_url`, `last_highlight_at`, `updated_at`, `canonical_url` |

A failure in one walk degrades that walk only — the other still upserts.

Notes:

- `highlighted_at`, `last_highlight_at`, and `updated` are ISO-8601 strings; the
  connector converts them to epoch-milliseconds on index.
- A highlight's `canonical_url` is the source article `url` for web highlights
  (book highlights have a null source url). A book's `canonical_url` is its
  `source_url`, falling back to the Readwise book-review page (`highlights_url`)
  for Kindle/ePub books that have no public source URL.
- `tags` is stored as the array of tag-name strings on both types.
- A book's `external_id` is `book/<id>`, **not** the bare numeric id: Readwise
  numbers books and highlights in separate sequences, so an unprefixed book id
  would collide with the highlight of the same number on the shared
  `<service>:<external_id>` item primary key. Its `metadata.book_id` is the raw
  **number**, so it joins a highlight's `metadata.book_id` directly.
- Both `readwise:highlight` and `readwise:book` stay on local MiniLM (384-dim)
  embeddings — neither is in `PROSE_HEAVY_TYPES`; the records are short, and
  adding them would route every hybrid-mode user's whole library through OpenAI.
- The `cover_image_url` and the resurface-scheduler fields are deliberately not
  indexed.

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
| `readwise_books_list` | List the user's books/articles (`GET /api/v2/books/?page_size=1000`). |
| `readwise_book_get` | Fetch one book/article by id (`GET /api/v2/books/{id}/`) — the id space is separate from the highlight id space. |
| `readwise_books_search` | Substring search across the books (title, author, category, source, document note, tag names). |

All six tools are read-only; `hitlRequired` is intentionally empty. Documents,
the daily-review feed, and the Reader v3 API are deferred follow-ups.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
