# Intercom Connector

## What this is

First-party Nimbus MCP connector for [Intercom](https://www.intercom.com).
Indexes the user's recent **conversations** as `intercom:conversation` items in
the local index and exposes three read-only tools to the Nimbus agent
(`intercom_list`, `intercom_get`, `intercom_search`). Useful for answering
support questions — "what conversations are still open?", "find the thread about
the billing bug" — without leaving Nimbus.

v1 indexes conversations only. Contacts, companies, tickets, admins-as-items,
and write tools (reply / close / assign) are deferred follow-ups.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set intercom.token <your-intercom-access-token>
nimbus ask "Which Intercom conversations are still open?"
```

The `intercom.token` value is an Intercom **Access Token** (create one for your
app at <https://developers.intercom.com/>). It is sent as `Authorization: Bearer
<token>` and is never logged.

The Gateway injects `intercom.token` as `INTERCOM_TOKEN` at spawn time; the
connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/intercom-sync.ts`) walks
`GET /conversations?per_page=150` — the `{ type: "conversation.list",
conversations, pages, total_count }` envelope — following the cursor at
`pages.next.starting_after` while it is a non-empty string (capped at 20 pages),
and upserts each conversation with metadata `{ conversation_id, title, state,
priority, open, read, source_type, source_author_name, source_author_email,
source_subject, contact_ids, assignee_id, team_assignee_id, tags, created_at,
updated_at, canonical_url }`.

Note: `created_at` and `updated_at` are epoch SECONDS; the connector converts
them to epoch-milliseconds on index. The `source.body` is HTML; it is stripped
to plain text for the body preview. The `canonical_url` is null — the Intercom
inbox deep link needs the workspace app id, which is not present in the
conversation payload (deferred).

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `intercom.token` | yes | Intercom Access Token (sent as `Authorization: Bearer <token>`). |

The API host is fixed at `https://api.intercom.io` (the US host — EU/AU regional
hosts are a deferred follow-up; no host override key).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `intercom_list` | List the user's conversations (`GET /conversations?per_page=150`). |
| `intercom_get` | Fetch one conversation by id (`GET /conversations/{id}`). |
| `intercom_search` | Substring search across the conversations (title, source body, state, source author name/email, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty. Contacts,
companies, tickets, admins-as-items, and write tools are deferred follow-ups; v1
indexes conversations only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
