# Miro Connector

## What this is

First-party Nimbus MCP connector for [Miro](https://miro.com). Indexes the
authenticated user's **boards** as `miro:board` items in the local index and
exposes three read-only tools to the Nimbus agent (`miro_list`, `miro_get`,
`miro_search`). Useful for whiteboard questions — "where's the Q2 roadmap
board?", "find the retro board" — without leaving Nimbus.

This is a Tier-2 OAuth connector: it authenticates via the 3-legged OAuth
authorization-code flow shared with the other Tier-2 connectors.

v1 indexes boards only. Items (cards, sticky notes, shapes) and comments are a
deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
export NIMBUS_OAUTH_MIRO_CLIENT_ID=<your-miro-app-client-id>
export NIMBUS_OAUTH_MIRO_CLIENT_SECRET=<your-miro-app-client-secret>
nimbus connector auth miro
nimbus ask "Find my Q2 roadmap Miro board"
```

Create an app under Miro → Settings → Your apps with the `boards:read` scope and
copy its client id + client secret. The connector authenticates via the **OAuth
2.0 authorization-code flow** (NOT PKCE): the Gateway opens the browser to
`https://miro.com/oauth/authorize`, then exchanges the returned code at
`POST https://api.miro.com/v1/oauth/token` with the client id + client secret
**form-encoded in the request body**. The resulting access + refresh tokens are
stored under the `miro.oauth` vault key; the Gateway refreshes the short-lived
access token automatically.

The Gateway injects the live access token as `MIRO_TOKEN` at spawn time; the
connector itself never touches the vault. The token is never logged. The
gateway-side syncable (`packages/gateway/src/connectors/miro-sync.ts`) resolves a
valid access token once per cycle, then walks `GET
https://api.miro.com/v2/boards?limit=50` — following the response `cursor` query
parameter for a single forward pass per cycle, capped at 20 pages — and upserts
each board with metadata `{ id, name, description, owner_name, createdAt,
modifiedAt, viewLink }`.

The title is the board name (falling back to `Miro board <id>`); `modifiedAt` is
derived from `modifiedAt` (or the `createdAt` field); the canonical url is the
board `viewLink` (or `null` when absent).

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `miro.oauth` | yes | OAuth access + refresh tokens (written by `nimbus connector auth miro`; refreshed by the Gateway). |

The client id + secret are read from the `NIMBUS_OAUTH_MIRO_CLIENT_ID` /
`NIMBUS_OAUTH_MIRO_CLIENT_SECRET` environment variables (not the vault). The API
host is fixed at `https://api.miro.com` (no host override — it is a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `miro_list` | List boards (`GET /v2/boards?limit=N&cursor=...`). |
| `miro_get` | Fetch one board by its id (`GET /v2/boards/{id}`). |
| `miro_search` | Substring search across the first page of boards (name, description, owner name). |

All three tools are read-only; `hitlRequired` is intentionally empty. Items and
comments are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
