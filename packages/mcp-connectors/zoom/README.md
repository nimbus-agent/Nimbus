# Zoom Connector

## What this is

First-party Nimbus MCP connector for [Zoom](https://zoom.us/).
Indexes the authenticated user's **scheduled meetings** as `zoom:meeting` items
in the local index via `GET /v2/users/me/meetings?type=scheduled` and exposes
three read-only tools to the Nimbus agent (`zoom_list`, `zoom_get`,
`zoom_search`). Useful for answering questions like "what meetings do I have
scheduled this week?" or "find the design review meeting" without leaving Nimbus.

v1 indexes scheduled meetings only. Recordings and transcripts are PR-3
follow-ups.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# The Gateway manages the full Zoom OAuth flow — credentials arrive as
# ZOOM_TOKEN at spawn time via getValidZoomAccessToken; you do not need
# to set vault keys manually for normal use.
nimbus ask "What Zoom meetings do I have scheduled?"
```

The `ZOOM_TOKEN` value is a short-lived OAuth access token issued by Zoom's
3-legged PKCE flow. The Gateway injects it at spawn time; the connector itself
never touches the vault. The token is sent as `Authorization: Bearer <token>`
and is never logged.

The gateway-side syncable
(`packages/gateway/src/connectors/zoom-sync.ts`) walks
`GET /v2/users/me/meetings?type=scheduled&page_size=300` and upserts each
meeting with metadata `{ meeting_id, topic, agenda, host_id, start_time,
duration, timezone, type, status, join_url, canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `zoom.oauth.access_token` | yes (managed by Gateway) | Short-lived Zoom OAuth access token. Refreshed automatically via the 3-legged OAuth flow; injected as `ZOOM_TOKEN` at spawn time. |

The API host is fixed at `https://api.zoom.us` (no host override key).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `zoom_list` | List the user's scheduled meetings (`GET /v2/users/me/meetings?type=scheduled&page_size=100`). |
| `zoom_get` | Fetch one meeting by numeric id or UUID (`GET /v2/meetings/{meetingId}`). UUIDs starting with `/` or containing `//` are double-encoded per Zoom's API requirement. |
| `zoom_search` | Substring search over the first page of scheduled meetings (topic, agenda, host id). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Recordings and transcripts are deferred to PR-3.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
