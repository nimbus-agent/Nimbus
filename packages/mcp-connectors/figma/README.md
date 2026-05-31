# Figma Connector

## What this is

First-party Nimbus MCP connector for [Figma](https://figma.com). Indexes the
files of a single configured **team** as `figma:file` items in the local index
and exposes three read-only tools to the Nimbus agent (`figma_list`,
`figma_get`, `figma_search`). Useful for design questions — "where's the Q2
roadmap design?", "find the onboarding mockups" — without leaving Nimbus.

This is a Tier-2 OAuth connector: it authenticates via the 3-legged OAuth
authorization-code flow shared with the other Tier-2 connectors.

v1 indexes the files of a **single configured team**. Multi-team support is a
deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
export NIMBUS_OAUTH_FIGMA_CLIENT_ID=<your-figma-app-client-id>
export NIMBUS_OAUTH_FIGMA_CLIENT_SECRET=<your-figma-app-client-secret>
nimbus connector auth figma
nimbus vault set figma.team_id <your-team-id>
nimbus ask "Find my Q2 roadmap Figma file"
```

Create an app under Figma → Settings → Account → Developer apps with the
`files:read` scope and copy its client id + client secret. The connector
authenticates via the **OAuth 2.0 authorization-code flow** (NOT PKCE): the
Gateway opens the browser to `https://www.figma.com/oauth`, then exchanges the
returned code at `POST https://api.figma.com/v1/oauth/token` with the client id +
client secret **form-encoded in the request body**. The resulting access +
refresh tokens are stored under the `figma.oauth` vault key; the Gateway
refreshes the short-lived access token automatically.

This connector needs **two** vault values: the OAuth token (`figma.oauth`) and a
non-secret team identifier (`figma.team_id`). The team id is the numeric id in a
Figma team URL (`figma.com/files/team/<team_id>/...`). Both must be present for
the connector to spawn and sync.

The Gateway injects the live access token as `FIGMA_TOKEN` and the team id as
`FIGMA_TEAM_ID` at spawn time; the connector itself never touches the vault. The
token is never logged. The gateway-side syncable
(`packages/gateway/src/connectors/figma-sync.ts`) resolves a valid access token
once per cycle, then performs a **two-level fetch**:

1. `GET https://api.figma.com/v1/teams/<team_id>/projects` → `{ name, projects: [{ id, name }] }`.
2. For each project, `GET https://api.figma.com/v1/projects/<project_id>/files` → `{ name, files: [{ key, name, thumbnail_url, last_modified }] }`.

It flattens all files across all projects into `figma:file` items (capturing
each file's project name), capped per cycle at a defensive project- and
file-count bound. Neither endpoint paginates with a cursor — each returns the
full list — so the cap is the safety bound, and the syncable walks a single
forward pass per cycle.

The title is the file name (falling back to `Figma file <key>`); the item id is
`figma:<key>` (stable); `modifiedAt` is derived from `last_modified` (else the
sync time); the canonical url is constructed from the key
(`https://www.figma.com/file/<key>`).

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `figma.oauth` | yes | OAuth access + refresh tokens (written by `nimbus connector auth figma`; refreshed by the Gateway). |
| `figma.team_id` | yes | Non-secret Figma team id selecting which team's files to index (written by `nimbus vault set figma.team_id <id>`). |

The client id + secret are read from the `NIMBUS_OAUTH_FIGMA_CLIENT_ID` /
`NIMBUS_OAUTH_FIGMA_CLIENT_SECRET` environment variables (not the vault). The API
host is fixed at `https://api.figma.com` (no host override — it is a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `figma_list` | List the configured team's files (two-level fetch, flattened). |
| `figma_get` | List one project's files by project id (`GET /v1/projects/{id}/files`). |
| `figma_search` | Substring search across the team's files (file name, project name). |

All three tools are read-only; `hitlRequired` is intentionally empty. Multi-team
support, file nodes (frames, components), and comments are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
