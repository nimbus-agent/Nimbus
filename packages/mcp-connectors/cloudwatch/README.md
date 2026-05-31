# Amazon CloudWatch Connector

## What this is

Nimbus MCP connector for Amazon CloudWatch Logs. This is a **Tier-3
"no-row-data"** connector: it indexes log-group **metadata only** — log-group
name, ARN, retention, stored bytes, creation time, metric-filter count, and an
optional stream count + last-event timestamp. It **never** fetches log-event
contents / row data into the local index. There is no `get-log-events`, no
`filter-log-events`, no `start-query`, no `get-query-results`, and no `tail` —
those endpoints are forbidden by design, and the `assertNoRowDataTools`
contract test locks the metadata-only surface in.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

CloudWatch reuses your existing AWS credentials — no separate CloudWatch
secret. Configure the AWS connector (access key + secret + region, or a named
profile), which CloudWatch reads via the aws CLI:

```bash
nimbus connector auth aws
nimbus ask "Which CloudWatch log groups have the most stored bytes?"
```

## Tools

- `cloudwatch_list` — list log groups (metadata only; optional name prefix).
- `cloudwatch_get` — one log group's metadata + a stream summary (stream names + last-event timestamps).
- `cloudwatch_search` — substring search over log-group names.

## See also

- [CloudWatch Connector Documentation](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
