# Zendesk Connector

## What this is

First-party Nimbus MCP connector for [Zendesk Support](https://www.zendesk.com).
Indexes the user's **tickets** as `zendesk:ticket` items in the local index and
exposes three read-only tools to the Nimbus agent (`zendesk_list`,
`zendesk_get`, `zendesk_search`). Useful for correlating customer support
history with code/PR changes — "which tickets reference the checkout
regression?", "find the ticket about the Safari bug" — without leaving Nimbus.

v1 indexes tickets only. Comments, users, organizations, and Help Center
articles are deferred follow-ups.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set zendesk.url https://acme.zendesk.com
nimbus vault set zendesk.email agent@acme.com
nimbus vault set zendesk.api_token <your-zendesk-api-token>
nimbus ask "What Zendesk tickets mention the checkout regression?"
```

Zendesk is **per-tenant**: `zendesk.url` is the full base URL of your Zendesk
instance (`https://<subdomain>.zendesk.com`). There is no SaaS default — all
three keys are required.

Zendesk uses HTTP **Basic** auth with token authentication: the username is
`<email>/token` and the password is the API token, so the request header is
`Authorization: Basic base64(<email>/token:<api_token>)`. The token is never
logged. Create an API token under **Admin Center → Apps and integrations →
Zendesk API → Token access**.

The Gateway injects `zendesk.url` / `zendesk.email` / `zendesk.api_token` as
`ZENDESK_URL` / `ZENDESK_EMAIL` / `ZENDESK_API_TOKEN` at spawn time; the
connector itself never touches the vault. Because the host is per-tenant, the
static sandbox manifest declares an empty network list and the hostname parsed
from `zendesk.url` is added to the sandbox network list at spawn time by
`phase3AddZendeskMcp` (the same runtime-merge pattern as ArgoCD / Metabase /
Grafana). The gateway-side syncable
(`packages/gateway/src/connectors/zendesk-sync.ts`) walks
`GET /api/v2/tickets.json?page[size]=100` — the cursor-pagination envelope
`{ tickets, meta: { has_more, after_cursor }, links }` — following
`meta.after_cursor` while `meta.has_more` is true (capped at 20 pages), and
upserts each ticket with metadata `{ ticket_id, subject, status, priority,
type, requester_id, assignee_id, group_id, organization_id, tags, via_channel,
created_at, updated_at, canonical_url }`.

Note: `created_at` and `updated_at` are ISO-8601 strings; the connector converts
them to epoch-milliseconds on index. The `canonical_url` is the agent-UI deep
link `<base>/agent/tickets/<id>`. `tags` is stored as the array of tag strings.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `zendesk.url` | yes | Full base URL of your Zendesk instance (`https://<subdomain>.zendesk.com`). The hostname is added to the sandbox network list at spawn time. |
| `zendesk.email` | yes | The agent email used as the `<email>/token` Basic-auth username. |
| `zendesk.api_token` | yes | Zendesk API token (the Basic-auth password). Never logged. |

There is no fixed host — Zendesk is per-tenant, so the host comes from
`zendesk.url`.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `zendesk_list` | List the user's tickets (`GET /api/v2/tickets.json?page[size]=100`). |
| `zendesk_get` | Fetch one ticket by id (`GET /api/v2/tickets/{id}.json`). |
| `zendesk_search` | Substring search across the tickets (subject, description, status, priority, type, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty. Comments,
users, organizations, and Help Center articles are deferred follow-ups;
reply / solve / assign write tools are deferred too. v1 indexes tickets only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
