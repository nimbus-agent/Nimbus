# BigQuery Connector

## What this is

Nimbus MCP connector for Google BigQuery. This is a **Tier-3 "no-row-data"**
connector: it indexes schema and **metadata only** — datasets, tables, schema
field names/types, row counts, byte sizes, and timestamps. It **never** fetches
row, cell, or query-result data into the local index. There is no `bq query`,
no `bq head`, and no `tabledata.list` — those endpoints are forbidden by design,
and the `assertNoRowDataTools` contract test locks the metadata-only surface in.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

BigQuery reuses your existing Google Cloud credentials — no separate BigQuery
secret. Configure the GCP connector (service-account JSON key path + project id),
which BigQuery reads via the gcloud CLI:

```bash
nimbus connector auth gcp
nimbus ask "What tables are in my analytics dataset?"
```

## Tools

- `bigquery_list` — list datasets, or the tables in a dataset (metadata only).
- `bigquery_get` — one table's schema + metadata (field names/types, counts).
- `bigquery_search` — substring search over dataset/table names.

## See also

- [BigQuery Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
