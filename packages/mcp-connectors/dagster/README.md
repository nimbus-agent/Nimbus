# Dagster Connector

## What this is

First-party Nimbus MCP connector for [Dagster](https://dagster.io/).
Indexes the user's data-orchestration **jobs** from a Dagster Cloud deployment
or a self-hosted Dagster OSS instance as `dagster:job` items in the local index
and exposes three read-only tools to the Nimbus agent (`dagster_list`,
`dagster_get`, `dagster_search`). Each job carries its repository, code
location, description, `isJob` flag, and tags. Useful for orchestration
discovery — "which jobs live in the analytics repository?", "what tags does the
nightly job carry?".

v1 indexes **jobs only** — runs and assets are a deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# Dagster Cloud: the base_url is the per-deployment host root.
nimbus vault set dagster.base_url https://my-org.dagster.cloud/prod
nimbus vault set dagster.api_token <your-dagster-cloud-api-token>

# Self-hosted Dagster OSS: the base_url is the webserver root; the api_token
# may be a placeholder (set any non-empty value so the spawn wiring stays
# uniform — self-hosted OSS does not require an api token).
nimbus vault set dagster.base_url http://localhost:3000
nimbus vault set dagster.api_token placeholder

nimbus ask "Which Dagster jobs are in the analytics repository?"
```

The `dagster.base_url` is the **per-tenant host root** — for Dagster Cloud it is
`https://<org>.dagster.cloud/<deployment>`; for self-hosted Dagster OSS it is the
webserver root (e.g. `http://localhost:3000`). Both surfaces expose a single
GraphQL endpoint at `<base_url>/graphql`. The Gateway injects the host root as
`DAGSTER_BASE_URL` and the token as `DAGSTER_API_TOKEN` at spawn time; the
connector itself never touches the vault. The token is sent as the
`Dagster-Cloud-Api-Token` header (required for Dagster Cloud; unauthenticated
self-hosted OSS users may set any non-empty placeholder). Because Dagster has no
universal SaaS host, the sandbox network list is empty in the static manifest —
the gateway parses the hostname from the configured base URL and extends the
sandbox network allow-list at spawn time (`phase3AddDagsterMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/dagster-sync.ts`) issues one GraphQL query
(`repositoriesOrError → nodes[].pipelines[]`) to `POST <base_url>/graphql`,
flattens every repository's pipelines into jobs (capturing each job's repository
and code location), and upserts each as a `dagster:job` with metadata `{ name,
repository, location, description, is_job, tags, tag_keys, canonical_url }`. A
`PythonError` typename or a top-level GraphQL `errors` array is treated as a
non-fatal sync error (graceful degrade, cursor preserved) — the response returns
in a single pass per cycle, capped defensively.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `dagster.base_url` | yes | Dagster host root (Cloud: `https://<org>.dagster.cloud/<deployment>`; OSS: `http://<host>:3000`); requests go to `${base_url}/graphql`. |
| `dagster.api_token` | yes | Dagster Cloud API token (sent as the `Dagster-Cloud-Api-Token` header). Required for Cloud; may be any non-empty placeholder for unauthenticated self-hosted OSS. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `dagster_list` | List jobs (flattened repositories catalog); optional `limit`. |
| `dagster_get` | Fetch one job by its `location:repository:jobName` triple (or bare `jobName`). |
| `dagster_search` | Substring search across jobs (name, repository, location, description, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Individual runs and assets are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
