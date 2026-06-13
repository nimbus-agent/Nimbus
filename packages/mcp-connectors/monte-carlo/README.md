# Monte Carlo Connector

## What this is

First-party Nimbus MCP connector for [Monte Carlo](https://www.montecarlodata.com/).
Indexes the user's **Monte Carlo data-quality incidents** as
`montecarlo:data_quality_test` items in the local index and exposes three
read-only tools to the Nimbus agent (`montecarlo_list`, `montecarlo_get`,
`montecarlo_search`). Each incident's monitored table is normalized into a
`monitoredDataModelKeys` metadata field so the graph populator automatically
emits `data_quality_test --monitors--> data_model` lineage edges to the
corresponding warehouse tables.

Uses the Monte Carlo GraphQL API at `api.getmontecarlo.com` with API key pair
auth (`x-mcd-id` / `x-mcd-token` headers).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set montecarlo.api_id   <your-api-id>
nimbus vault set montecarlo.api_token <your-api-token>

nimbus ask "Are there any open Monte Carlo incidents on the revenue table?"
```

The API key pair is available from the Monte Carlo UI under **Settings → API**.
The gateway injects `MONTECARLO_API_ID` and `MONTECARLO_API_TOKEN` at spawn
time; the connector itself never touches the vault.

The gateway-side syncable
(`packages/gateway/src/connectors/monte-carlo-sync.ts`) posts one GraphQL
query (`getIncidents`) to `api.getmontecarlo.com/graphql`, then upserts each
incident as a `data_quality_test` item with metadata
`{ monitoredDataModelKeys, status, severity, firstSeenAt }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `montecarlo.api_id` | yes | Monte Carlo API key ID. |
| `montecarlo.api_token` | yes | Monte Carlo API token. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `montecarlo_list` | List incidents; optional `limit` cap (default 200, max 500). |
| `montecarlo_get` | Fetch one incident by id. |
| `montecarlo_search` | Substring search across incidents (id, status, severity, table). |

All three tools are read-only; `hitlRequired` is intentionally empty. Write
tools and incident remediation are deferred.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
