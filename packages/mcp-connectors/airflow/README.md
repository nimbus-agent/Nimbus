# Apache Airflow Connector

## What this is

First-party Nimbus MCP connector for [Apache Airflow](https://airflow.apache.org/).
Indexes the user's data-orchestration **DAGs** from a self-hosted Airflow
instance as `airflow:dag` items in the local index and exposes three read-only
tools to the Nimbus agent (`airflow_list`, `airflow_get`, `airflow_search`).
Each DAG carries its paused/active flags, owners, description, schedule
interval, tags, source file location, next scheduled run, and last-parsed
timestamp. Useful for orchestration discovery — "which DAGs are paused?",
"what's the schedule for the nightly ETL?".

v1 indexes **DAG definitions only** — individual DAG runs and task instances
are a deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# Airflow is self-hosted: all three keys are required (no defaults).
nimbus vault set airflow.base_url https://airflow.example.com
nimbus vault set airflow.username <your-airflow-username>
nimbus vault set airflow.password <your-airflow-password>

nimbus ask "Which Airflow DAGs are paused?"
```

Use an Airflow user with read access to the DAGs API (the `Viewer` role is
sufficient on the default RBAC setup). The Gateway injects the base URL as
`AIRFLOW_URL`, the username as `AIRFLOW_USERNAME`, and the password as
`AIRFLOW_PASSWORD` at spawn time; the connector itself never touches the vault.
Credentials are sent as an HTTP Basic `Authorization` header. Because Airflow
has no universal SaaS host, the sandbox network list is empty in the static
manifest — the gateway parses the hostname from the configured base URL and
extends the sandbox network allow-list at spawn time (`phase3AddAirflowMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/airflow-sync.ts`) walks
`GET /api/v1/dags?limit=100&offset=<n>` — a single forward offset pass per
cycle, advancing `offset` by 100 while more entries remain per the
`total_entries` count in the response body (capped at 20 pages) — and upserts
each DAG with metadata `{ dag_id, is_paused, is_active, owners, description,
schedule_interval, tags, fileloc, next_dagrun, last_parsed_time, canonical_url
}`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `airflow.base_url` | yes | Airflow base URL (e.g. `https://airflow.example.com`); requests go to `${base_url}/api/v1/...`. |
| `airflow.username` | yes | Airflow username (HTTP Basic auth). |
| `airflow.password` | yes | Airflow password (HTTP Basic auth). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `airflow_list` | List DAGs; optional `offset`. |
| `airflow_get` | Fetch one DAG by its `dag_id`. |
| `airflow_search` | Substring search across DAGs (dag_id, description, owners, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Individual DAG runs and task instances are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
