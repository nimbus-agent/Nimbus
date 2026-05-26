# Mercury Connector

## What this is

First-party Nimbus MCP connector for [Mercury](https://mercury.com). Indexes the
user's bank **accounts** as `mercury:account` items in the local index and
exposes three read-only tools to the Nimbus agent (`mercury_list`,
`mercury_get`, `mercury_search`). Useful for answering banking questions —
"what's my checking balance?", "which accounts are archived?" — without leaving
Nimbus.

v1 indexes accounts only. Transactions, bills, and statements are deferred
follow-ups, as are the wire / ACH transfer writes (which would land behind
HITL).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set mercury.token <your-mercury-api-token>
nimbus ask "What's my Mercury checking balance?"
```

The `mercury.token` value is a Mercury **API token**. It is sent as
`Authorization: Bearer <token>` and is never logged.

The Gateway injects `mercury.token` as `MERCURY_TOKEN` at spawn time; the
connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/mercury-sync.ts`) does a single
`GET /api/v1/accounts` (no pagination — Mercury returns the full account list in
one call) and upserts each account with metadata `{ account_id, name, status,
type, kind, account_number_last4, routing_number, available_balance,
current_balance, legal_business_name, created_at, canonical_url }`.

Note: the full account number is **never** stored — only the last 4 digits as
`account_number_last4`. Balances are USD **major units** (dollars, not cents).
`createdAt` is an ISO-8601 string; the connector converts it to
epoch-milliseconds on index.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `mercury.token` | yes | Mercury API token (sent as `Authorization: Bearer <token>`). |

The API host is fixed at `https://api.mercury.com` (no host override key — it is
a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `mercury_list` | List the user's accounts (`GET /api/v1/accounts`). |
| `mercury_get` | Fetch one account by id (`GET /api/v1/account/{id}`). |
| `mercury_search` | Substring search across the accounts (id, name, status, type, kind, legal business name). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Transactions, bills, and statements — plus the wire / ACH transfer writes
(behind HITL) — are deferred follow-ups; v1 indexes accounts only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
