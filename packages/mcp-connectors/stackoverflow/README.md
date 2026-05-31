# Stack Overflow for Teams Connector

## What this is

First-party Nimbus MCP connector for [Stack Overflow for Teams](https://stackoverflow.co/teams/).
Indexes the team's private Q&A **questions** as `stackoverflow:question` items in
the local index and exposes three read-only tools to the Nimbus agent
(`stackoverflow_list`, `stackoverflow_get`, `stackoverflow_search`). Useful for
answering knowledge questions — "how do we handle retries?", "who knows about
the billing pipeline?" — without leaving Nimbus.

v1 indexes questions only. Answers, articles, tags-as-items, and users-as-items
are deferred follow-ups.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set stackoverflow.token <your-stack-overflow-for-teams-pat>
nimbus vault set stackoverflow.team <your-team-slug>
nimbus ask "What did the team write about exponential backoff?"
```

The `stackoverflow.token` value is a Stack Overflow for Teams **Personal Access
Token** (create one under your Teams account settings). It is sent as
`Authorization: Bearer <token>` and is never logged.

The `stackoverflow.team` value is the team **slug** that appears in the API URL
path (e.g. `acme` for `https://stackoverflowteams.com/c/acme`). The Gateway
URL-encodes it into the `/v3/teams/<team>/questions` request path.

The Gateway injects `stackoverflow.token` as `STACKOVERFLOW_TOKEN` and
`stackoverflow.team` as `STACKOVERFLOW_TEAM` at spawn time; the connector itself
never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/stackoverflow-sync.ts`) walks
`GET /v3/teams/<team>/questions?page=N&pagesize=100&sort=creation&order=desc` —
the `{ items, totalCount, pageSize, page, totalPages, sort, order }` envelope —
page number is 1-based, incrementing `page` while `page < totalPages` and `items`
is non-empty (capped at 20 pages), and upserts each question with metadata
`{ question_id, title, tags, score, view_count, answer_count, is_answered,
owner_id, owner_name, creation_date, last_activity_date, last_edit_date,
canonical_url }`.

Note: `creationDate`, `lastActivityDate`, and `lastEditDate` are ISO-8601
strings; the connector converts them to epoch-milliseconds on index. The
`canonical_url` is the per-question `webUrl`. `tags` is stored as the array of
tag names (v3 tags may be `{ name }` objects or plain strings; both are
handled).

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `stackoverflow.token` | yes | Stack Overflow for Teams Personal Access Token (sent as `Authorization: Bearer <token>`). |
| `stackoverflow.team` | yes | The team slug used in the `/v3/teams/<team>/questions` URL path. |

Both keys are required — the gateway-side syncable and the MCP spawn both no-op
unless both are present.

The API host is fixed at `https://api.stackoverflowteams.com` (the v3 API — no
host override key; it is a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `stackoverflow_list` | List the team's questions (`GET /v3/teams/<team>/questions?pagesize=100&sort=creation&order=desc`). |
| `stackoverflow_get` | Fetch one question by id (`GET /v3/teams/<team>/questions/{id}`). |
| `stackoverflow_search` | Substring search across the questions (title, body, tags, owner name). |

All three tools are read-only; `hitlRequired` is intentionally empty. Answers,
articles, tags-as-items, and users-as-items are deferred follow-ups; v1 indexes
questions only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
