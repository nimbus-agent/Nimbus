# Canva Connector

## What this is

First-party Nimbus MCP connector for [Canva](https://www.canva.com). Indexes the
authenticated user's **designs** as `canva:design` items in the local index and
exposes three read-only tools to the Nimbus agent (`canva_list`, `canva_get`,
`canva_search`). Useful for design questions — "where's the Q2 marketing deck?",
"find the onboarding slides" — without leaving Nimbus.

This is a Tier-2 OAuth connector: it authenticates via the 3-legged OAuth
authorization-code flow (with PKCE) shared with the other Tier-2 connectors.

v1 indexes designs only. Folders and shared projects are a deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
export NIMBUS_OAUTH_CANVA_CLIENT_ID=<your-canva-app-client-id>
export NIMBUS_OAUTH_CANVA_CLIENT_SECRET=<your-canva-app-client-secret>
nimbus connector auth canva
nimbus ask "Find my Q2 marketing deck on Canva"
```

Create an integration under [canva.com/developers](https://www.canva.com/developers)
with the `design:meta:read` scope and copy its client id + client secret. The
connector authenticates via the **OAuth 2.0 authorization-code flow with PKCE**:
the Gateway opens the browser to `https://www.canva.com/api/oauth/authorize`,
then exchanges the returned code at `POST https://api.canva.com/rest/v1/oauth/token`
authenticating the client via an **HTTP Basic header**
(`base64(client_id:client_secret)`) alongside the PKCE `code_verifier` — the same
token-exchange shape as Zoom. The resulting access + refresh tokens are stored
under the Canva OAuth vault key; the Gateway refreshes the short-lived access
token automatically.

The Gateway injects the live access token as `CANVA_TOKEN` at spawn time; the
connector itself never touches the vault. The token is never logged. The
gateway-side syncable (`packages/gateway/src/connectors/canva-sync.ts`) resolves a
valid access token once per cycle, then walks `GET
https://api.canva.com/rest/v1/designs` — following the response `continuation`
query parameter for a single forward pass per cycle, capped at 20 pages — and
upserts each design with metadata `{ id, title, created_at, updated_at, edit_url,
view_url, thumbnail_url }`.

The title is the design title (falling back to `Canva design <id>`); `modifiedAt`
is derived from `updated_at` (or `created_at`); the canonical url is the design
`view_url` (or `edit_url`, or `null` when both are absent).

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `canva.oauth` | yes | OAuth access + refresh tokens (written by `nimbus connector auth canva`; refreshed by the Gateway). |

The client id + secret are read from the `NIMBUS_OAUTH_CANVA_CLIENT_ID` /
`NIMBUS_OAUTH_CANVA_CLIENT_SECRET` environment variables (not the vault). The API
host is fixed at `https://api.canva.com` (no host override — it is a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `canva_list` | List designs (`GET /rest/v1/designs?continuation=...`). |
| `canva_get` | Fetch one design by its id (`GET /rest/v1/designs/{id}`). |
| `canva_search` | Substring search across the first page of designs (title). |

All three tools are read-only; `hitlRequired` is intentionally empty. Folders and
shared projects are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
