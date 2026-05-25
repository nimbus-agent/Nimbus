# ArgoCD Connector

## What this is

First-party Nimbus MCP connector for [ArgoCD](https://argo-cd.readthedocs.io/)
GitOps. Indexes the user's **ArgoCD applications** as `argocd:application`
items in the local index and exposes three read-only tools to the Nimbus
agent (`argocd_list`, `argocd_get`, `argocd_search`). Useful for deployment
correlation — "did this app go OutOfSync / Degraded when the alert fired?".

v1 indexes **applications only** — AppProjects and per-application sync
history are a deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# ArgoCD is always self-hosted: both keys are required (no defaults).
nimbus vault set argocd.url https://argocd.example.com
nimbus vault set argocd.token <your-argocd-api-token>

nimbus ask "Which ArgoCD applications are OutOfSync right now?"
```

Generate the API token with `argocd account generate-token` (or from the
ArgoCD UI under Settings → Accounts → Tokens). The Gateway injects
`argocd.url` as `ARGOCD_URL` and `argocd.token` as `ARGOCD_TOKEN` at spawn
time; the connector itself never touches the vault. The ArgoCD API token is
sent as the `Authorization: Bearer <token>` header. Because ArgoCD has no
SaaS host, the sandbox network list is empty in the static manifest — the
gateway parses the hostname from `argocd.url` and extends the sandbox network
allow-list at spawn time (`phase3AddArgocdMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/argocd-sync.ts`) makes a single
`GET /api/v1/applications` call (ArgoCD returns the full list in one
response — no pagination) and upserts each application with metadata
`{ name, namespace, project, sync_status, health_status, repo_url, path,
target_revision, dest_server, dest_namespace, revision, created_at,
canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `argocd.url` | yes | ArgoCD server base URL (e.g. `https://argocd.example.com`); requests go to `${url}/api/v1/...`. |
| `argocd.token` | yes | ArgoCD API token (sent as `Authorization: Bearer <token>`). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `argocd_list` | List applications; optional `project` filter + `limit` cap. |
| `argocd_get` | Fetch one application by `name`. |
| `argocd_search` | Substring search across applications (name, project, repo, sync/health status). |

All three tools are read-only; `hitlRequired` is intentionally empty. The
`argocd.app.sync` / `argocd.app.delete` write tools are deferred to Phase 6.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
