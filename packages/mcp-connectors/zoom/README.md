# Zoom Connector

## What this is

First-party Nimbus MCP connector for [Zoom](https://zoom.us/).
Indexes the authenticated user's **scheduled meetings** as `zoom:meeting` items
AND **cloud-recording AI transcripts** as `zoom:transcript` items (prose-heavy)
in the local index via `GET /v2/users/me/meetings?type=scheduled` and
`GET /v2/users/me/recordings`, and exposes five read-only tools to the Nimbus
agent (`zoom_list`, `zoom_get`, `zoom_search`, `zoom_recordings_list`,
`zoom_transcript_get`). Useful for answering questions like "what meetings do I
have scheduled this week?", "find the design review meeting", or "what did we
decide in last week's recorded sync?" without leaving Nimbus.

Indexes scheduled meetings AND cloud-recording transcripts (`zoom:transcript`,
prose-heavy) via the same OAuth grant — no re-consent, because the
`cloud_recording:read:list_user_recordings` scope is requested up-front.

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
| `zoom_recordings_list` | List cloud recordings in a date window (`GET /v2/users/me/recordings?from=&to=`). Validates `(to - from) <= 31 days` locally before the call. Transcript files surface as `zoom:transcript` in the local index. |
| `zoom_transcript_get` | Fetch one meeting's recording-file inventory (`GET /v2/meetings/{meetingId}/recordings`). Full transcript text lives in the local index, keyed by `<meeting_uuid>:<recording_file_id>`. |

All five tools are read-only; `hitlRequired` is intentionally empty. The MCP
server does not refetch + parse transcript VTT — the gateway-side syncable owns
that, indexing `zoom:transcript` items keyed by `<meeting_uuid>:<recording_file_id>`.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
