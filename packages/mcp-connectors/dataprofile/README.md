# Local Data Profiling Connector

## What this is

Nimbus MCP connector for **local data files** (the Tier-5 local, no-row-data
connector class). It profiles `.parquet`, `.csv`, `.jsonl`/`.ndjson`, and `.json`
files under a configured directory into `dataprofile:data_model` items carrying
the **schema only** — column names, column types, column count, a row-count
estimate, and file size. This lets you recall *"which local dataset has a
`customer_id` column"* or *"how many rows is that export"* from the local index.

By design this connector indexes **schema metadata only**:

- **Never** cell values, row samples, first-N-row previews, or header-row data values.
- **Parquet** schema + row count come from the file **footer** (read via
  [`hyparquet`](https://www.npmjs.com/package/hyparquet) — no row data is read).
- **CSV** column names come from the header line; **JSONL/JSON** field names +
  JS types come from the top-level structure (keys/types only).

It is a pure, path-traversal-guarded local filesystem read — no database, no
network, no row-fetch or row-sample tool (a contract test asserts this).

> **ORC** is deferred: no maintained pure-JS ORC schema reader exists yet.

## Install

Bundled with Nimbus — no separate install required. Uses `hyparquet` (pure-JS
Parquet footer reader) for Parquet schema.

## Quickstart

Point the connector at the directory holding your data files, then query:

```bash
nimbus connector auth dataprofile
nimbus ask "which local dataset has an order_id column?"
```

The configured directory (`dataprofile.dir`) is added to the sandbox filesystem
read allow-list at spawn time; the connector has no network access.

## Tools

- `dataprofile_list` — list profiled data files (path, format, columns + types, column count, row estimate, size).
- `dataprofile_get` — profile one data file by its relative path.
- `dataprofile_search` — substring search over relative path / format / column names.

## See also

- [Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
