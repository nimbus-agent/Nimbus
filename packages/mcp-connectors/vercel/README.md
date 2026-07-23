# Vercel Connector

## What this is

First-party Nimbus MCP connector for [Vercel](https://vercel.com). Indexes the
user's recent **deployments** as `vercel:deployment` items in the local index
and exposes three read-only tools to the Nimbus agent (`vercel_list`,
`vercel_get`, `vercel_search`). Useful for correlating deploys with PR / Slack
history — "which deploy shipped this commit?".

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set vercel.token <your-vercel-access-token>
nimbus ask "What was the last production deploy on Vercel?"
```

The Gateway injects `vercel.token` as `VERCEL_TOKEN` (and the optional
`vercel.team_id` as `VERCEL_TEAM_ID`) at spawn time; the connector itself never
touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/vercel-sync.ts`) walks
`GET /v6/deployments?limit=100` (paginated via `pagination.next`, capped 20
pages) and upserts each deployment with metadata `{ uid, name, state, target,
url, inspector_url, commit_sha, commit_message, commit_ref, pr_id, repo,
creator, created_at, canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `vercel.token` | yes | Vercel access token (sent as `Authorization: Bearer <token>`). |
| `vercel.team_id` | no | Scope requests to a team — appended as `teamId=<id>` on every request. |

The API host is fixed at `https://api.vercel.com` (no host override key — it is
a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `vercel_list` | List recent deployments (`GET /v6/deployments`). |
| `vercel_get` | Fetch one deployment by id or `*.vercel.app` URL (`GET /v13/deployments/{idOrUrl}`). |
| `vercel_search` | Substring search across recent deployments (uid, name, state, target, url, commit message). |

All three tools are read-only; `hitlRequired` is intentionally empty. Projects,
domains, environment variables, aliases, and build logs are deferred follow-ups
— v1 indexes deployments only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
