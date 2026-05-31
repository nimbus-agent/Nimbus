# GCP Cloud Logging Connector

## What this is

Nimbus MCP connector for GCP Cloud Logging. This is a **Tier-3
"no-row-data"** connector: it indexes log routing **sink configuration
metadata only** — sink name, destination, filter expression, description,
disabled flag, and create/update timestamps. It **never** reads log entries /
row data into the local index. There is no `gcloud logging read` and no
`gcloud logging entries list` — those commands are forbidden by design, and
the `assertNoRowDataTools` contract test locks the metadata-only surface in.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

Cloud Logging reuses your existing GCP credentials — no separate Cloud Logging
secret. Configure the GCP connector (service-account JSON key path + project
id), which Cloud Logging reads via the gcloud CLI:

```bash
nimbus connector auth gcp
nimbus ask "Which Cloud Logging sinks route to BigQuery?"
```

## Tools

- `cloud_logging_list` — list log routing sinks (metadata only).
- `cloud_logging_get` — one sink's configuration metadata.
- `cloud_logging_search` — substring search over sink names + filters.

## See also

- [Cloud Logging Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
