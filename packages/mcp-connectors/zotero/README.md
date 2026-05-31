# Zotero Connector

## What this is

First-party Nimbus MCP connector for [Zotero](https://www.zotero.org). Indexes
the bibliographic **references** from a Zotero library as `zotero:reference`
items in the local index and exposes three read-only tools to the Nimbus agent
(`zotero_list`, `zotero_get`, `zotero_search`). Useful for answering research
questions — "what did I save about retrieval-augmented generation?", "find my
reference with DOI 10.1145/…" — without leaving Nimbus.

v1 indexes top-level bibliographic references only. Attachments and standalone
notes are skipped.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set zotero.api_key <your-zotero-api-key>
nimbus vault set zotero.library users/12345
nimbus ask "What references did I save about exponential backoff?"
```

The `zotero.api_key` value is a Zotero **API key** (create one at
<https://www.zotero.org/settings/keys>). It is sent as the `Zotero-API-Key`
header (the `Zotero-API-Version` header is pinned to `3`) and is never logged.

The `zotero.library` value is a **non-secret** library spec of the form
`users/<id>` or `groups/<id>` — it selects which library path the connector
walks. Your numeric user id is shown on <https://www.zotero.org/settings/keys>;
group ids appear in the group's library URL.

The Gateway injects `zotero.api_key` as `ZOTERO_API_KEY` and `zotero.library`
as `ZOTERO_LIBRARY` at spawn time; the connector itself never touches the vault.
The gateway-side syncable
(`packages/gateway/src/connectors/zotero-sync.ts`) walks
`GET /<library>/items?format=json&limit=100&start=<offset>&sort=dateModified&direction=desc`
— a single forward pass per cycle, incrementing `start` by 100 while a full page
comes back (capped at 20 pages) — and upserts each top-level reference with
metadata `{ key, version, item_type, title, creators, date, date_modified,
date_added, tags, collections, doi, url, abstract }`. Items whose `data.itemType`
is `attachment` or `note` are skipped.

Note: `dateModified` / `dateAdded` are ISO-8601 strings; the connector converts
them to epoch-milliseconds on index. `creators` is reduced to a formatted
author-list string; `tags` and `collections` are stored as string arrays; the
abstract is truncated.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `zotero.api_key` | yes | Zotero API key (sent as the `Zotero-API-Key` header). |
| `zotero.library` | yes | Non-secret library spec (`users/<id>` or `groups/<id>`). |

The API host is fixed at `https://api.zotero.org` (no host override key — it is
a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `zotero_list` | List the library's top-level items (`GET /<library>/items?...`). |
| `zotero_get` | Fetch one item by its item key (`GET /<library>/items/{key}`). |
| `zotero_search` | Substring search across the items (title, item type, abstract, DOI, publication title, creator names, tag names). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Attachments and standalone notes are skipped; v1 indexes top-level
bibliographic references only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
