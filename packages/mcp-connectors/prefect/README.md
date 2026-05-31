# Prefect Connector

## What this is

First-party Nimbus MCP connector for [Prefect](https://www.prefect.io/).
Indexes the user's data-orchestration **deployments** from a Prefect Cloud
workspace or a self-hosted Prefect Server as `prefect:deployment` items in the
local index and exposes three read-only tools to the Nimbus agent
(`prefect_list`, `prefect_get`, `prefect_search`). Each deployment carries its
flow id, description, tags, paused flag, work pool, work queue, schedule,
status, and created/updated timestamps. Useful for orchestration discovery —
"which deployments are paused?", "what's the schedule for the nightly flow?".

v1 indexes **deployments only** — individual flow runs and task runs are a
deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# Prefect Cloud: the api_url is the per-workspace API root.
nimbus vault set prefect.api_url https://api.prefect.cloud/api/accounts/<account_id>/workspaces/<workspace_id>
nimbus vault set prefect.api_key <your-prefect-api-key>

# Self-hosted Prefect Server: the api_url is the server API root; the api_key
# may be empty (set it to a placeholder so the spawn wiring stays uniform).
nimbus vault set prefect.api_url http://prefect.example.com:4200/api

nimbus ask "Which Prefect deployments are paused?"
```

The `prefect.api_url` is the **per-tenant workspace API root** — for Prefect
Cloud it includes the account and workspace ids; for a self-hosted Prefect
Server it is the server's `/api` root. The Gateway injects the API URL as
`PREFECT_API_URL` and the API key as `PREFECT_API_KEY` at spawn time; the
connector itself never touches the vault. The API key is sent as a Bearer
`Authorization` header (required for Prefect Cloud; omitted when empty for
keyless self-hosted Prefect Server). Because Prefect has no universal SaaS
host, the sandbox network list is empty in the static manifest — the gateway
parses the hostname from the configured API URL and extends the sandbox network
allow-list at spawn time (`phase3AddPrefectMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/prefect-sync.ts`) walks
`POST <api_url>/deployments/filter` with a JSON body
`{ limit: 100, offset: <n>, sort: "CREATED_DESC" }` — a single forward offset
pass per cycle, advancing `offset` by 100 while a full page comes back (capped
at 20 pages) — and upserts each deployment with metadata `{ deployment_id,
name, flow_id, description, tags, paused, work_pool_name, work_queue_name,
schedule, status, created, updated, canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `prefect.api_url` | yes | Prefect workspace API root (Cloud: `https://api.prefect.cloud/api/accounts/<id>/workspaces/<id>`; Server: `http://<host>:4200/api`); requests go to `${api_url}/deployments/...`. |
| `prefect.api_key` | yes | Prefect API key (Bearer auth). Required for Prefect Cloud; may be a placeholder for keyless self-hosted Prefect Server. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `prefect_list` | List deployments (POST filter); optional `offset`. |
| `prefect_get` | Fetch one deployment by its `id`. |
| `prefect_search` | Substring search across deployments (name, description, work pool/queue, status, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Individual flow runs and task runs are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
