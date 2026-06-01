# Elasticsearch / Kibana Connector

## What this is

Nimbus MCP connector for Elasticsearch / Kibana. This is a **Tier-3
"no-row-data"** connector: it indexes index **metadata only** — index names,
health (green/yellow/red), status (open/close), document counts, store sizes,
shard/replica counts, UUIDs, and the field names/types from each index's
mapping. It **never** fetches document, row, or hit data into the local index.
There is no `_search`, no `_doc`, no `_mget`, no `_sql`, and no `_scroll` — those
endpoints are forbidden by design, and the `assertNoRowDataTools` contract test
locks the metadata-only surface in.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

Elasticsearch uses its own credentials and a per-tenant host (self-hosted or
Elastic Cloud). Configure the connector with your cluster URL and an API key:

```bash
nimbus connector auth elasticsearch
nimbus ask "Which Elasticsearch indices are red?"
```

## Tools

- `elasticsearch_list` — list indices with health/status/counts (metadata only).
- `elasticsearch_get` — one index's field mapping (field names/types only).
- `elasticsearch_search` — substring search over index **names** (not documents).

## See also

- [Elasticsearch Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
