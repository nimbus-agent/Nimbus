# Local DB Schema / Saved Queries Connector

## What this is

Nimbus MCP connector for **local database tooling** (the Tier-5 local connector
class). It indexes the saved SQL queries and schema scripts that desktop DB tools
— **DBeaver, DataGrip, pgAdmin** — keep on disk as `.sql` files, as
`localdb:saved_query` items. This enables semantic recall of *"that one SQL query
I wrote last month"* across your local query history.

By design this connector is a **pure, local filesystem read**:

- **No database connection** — it never connects to a database.
- **No query execution** — it never runs any SQL.
- **No binary spawn** — it reads files only.

Each indexed item carries the SQL text (capped) plus lightweight metadata: the
relative path, referenced table/view names (heuristic), statement count, and size.

## Install

Bundled with Nimbus — no separate install required. No runtime dependencies
beyond the MCP SDK.

## Quickstart

Point the connector at the directory your DB tool stores scripts/consoles in (for
example DBeaver project script folders, or a DataGrip `consoles/` directory).
Configure the connector, then query:

```bash
nimbus connector auth localdb
nimbus ask "find the SQL query I wrote that joins orders and customers"
```

The configured scripts directory (`localdb.scripts_dir`) is added to the sandbox
filesystem read allow-list at spawn time; the connector has no network access.

## Tools

- `localdb_list` — list saved SQL queries (relative path, title, size, line count, SQL text).
- `localdb_get` — fetch one saved query by its relative path.
- `localdb_search` — substring search over query title / path / SQL text.

## See also

- [Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
