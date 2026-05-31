# Google Meet Connector

## What this is

First-party Nimbus MCP connector for [Google Meet](https://meet.google.com/).
Indexes the authenticated user's **past meeting conference records** as
`google_meet:meeting` items in the local index via the Google Meet REST API v2
(`GET https://meet.googleapis.com/v2/conferenceRecords`), and exposes three
read-only tools to the Nimbus agent (`google_meet_list`, `google_meet_get`,
`google_meet_search`). Useful for answering questions like "when did I last meet
with the platform team?" or "find my conference records from last week" without
leaving Nimbus.

Google Meet is a Google sub-service: it rides on the existing `google` OAuth
provider (alongside Google Drive / Gmail / Google Photos), so no separate
provider registration or re-consent is required beyond granting the
`meetings.space.readonly` scope.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# The Gateway manages the full Google OAuth flow — credentials arrive as
# GOOGLE_OAUTH_ACCESS_TOKEN at spawn time via getValidGoogleAccessToken; you
# do not need to set vault keys manually for normal use.
nimbus connector auth google_meet
nimbus ask "What Google Meet meetings did I have this week?"
```

The `GOOGLE_OAUTH_ACCESS_TOKEN` value is a short-lived OAuth access token issued
by Google's 3-legged flow. The Gateway injects it at spawn time; the connector
itself never touches the vault. The token is sent as `Authorization: Bearer
<token>` and is never logged.

The gateway-side syncable
(`packages/gateway/src/connectors/google-meet-sync.ts`) walks
`GET /v2/conferenceRecords?pageSize=50` (paginating via `nextPageToken`) and
upserts each conference record with metadata `{ name, space, startTime, endTime }`.
Conference records carry no human-authored title, so the title is derived as
`Meeting <start-date>` (or `Meeting <id>` when no start time is present).

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `google_meet.oauth` | yes (managed by Gateway) | Per-service Google OAuth token blob. Falls back to the shared `google.oauth` key. Refreshed automatically; injected as `GOOGLE_OAUTH_ACCESS_TOKEN` at spawn time. |

The API host is fixed at `https://meet.googleapis.com` (no host override key).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `google_meet_list` | List past conference records (`GET /v2/conferenceRecords?pageSize=50`). Pagination via `pageToken`. |
| `google_meet_get` | Fetch one conference record by id (`GET /v2/conferenceRecords/{id}`). |
| `google_meet_search` | List conference records with an optional Meet API `filter` expression and pagination. |

All three tools are read-only; `hitlRequired` is intentionally empty.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
