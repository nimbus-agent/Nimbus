# Netlify Connector

## What this is

First-party Nimbus MCP connector for [Netlify](https://www.netlify.com). Indexes
the user's **sites** as `netlify:site` items in the local index and exposes
three read-only tools to the Nimbus agent (`netlify_list`, `netlify_get`,
`netlify_search`). Each site carries its embedded **published-deploy status**
(state / branch / commit ref / deploy preview URL), so you can answer "is the
latest deploy live?" and "which site shipped this commit?" without an N+1
per-site deploy walk.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set netlify.token <your-netlify-personal-access-token>
nimbus ask "Did the last Netlify deploy go live?"
```

The Gateway injects `netlify.token` as `NETLIFY_TOKEN` at spawn time; the
connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/netlify-sync.ts`) walks
`GET /api/v1/sites?per_page=100&page=N` (page-paginated, capped 20 pages) and
upserts each site with metadata `{ site_id, name, url, admin_url, ssl_url,
repo_url, repo_branch, deploy_state, deploy_id, deploy_branch, commit_ref,
commit_url, deploy_url, account_name, created_at, updated_at, canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `netlify.token` | yes | Netlify personal access token (sent as `Authorization: Bearer <token>`). |

The API host is fixed at `https://api.netlify.com` (no host override key — it is
a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `netlify_list` | List sites (`GET /api/v1/sites`). |
| `netlify_get` | Fetch one site by id (`GET /api/v1/sites/{siteId}`). |
| `netlify_search` | Substring search across sites (id, name, url, ssl_url, repo, branch, deploy state, commit ref). |

All three tools are read-only; `hitlRequired` is intentionally empty. Per-deploy
history, forms, functions, environment variables, and DNS are deferred
follow-ups — v1 indexes sites + their embedded published-deploy status only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
