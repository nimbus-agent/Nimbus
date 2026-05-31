# Amazon Athena Connector

## What this is

Nimbus MCP connector for Amazon Athena. This is a **Tier-3 "no-row-data"**
connector: it indexes catalog and **metadata only** — data catalogs, databases,
table names, table types, column names/types, partition keys, parameters, and
timestamps. It **never** runs an Athena query or fetches row, cell, or
query-result data into the local index. There is no `start-query-execution`, no
`get-query-results`, and no `get-query-execution` — those endpoints are
forbidden by design, and the `assertNoRowDataTools` contract test locks the
metadata-only surface in.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

Athena reuses your existing AWS credentials — no separate Athena secret.
Configure the AWS connector (access key + secret + region, or a named profile),
which Athena reads via the aws CLI:

```bash
nimbus connector auth aws
nimbus ask "What tables are in my analytics database in Athena?"
```

## Tools

- `athena_list` — list data catalogs, databases, or table metadata (metadata only).
- `athena_get` — one table's schema + metadata (column names/types, partition keys).
- `athena_search` — substring search over catalog/database/table names.

## See also

- [Athena Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
