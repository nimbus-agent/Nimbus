# Ramp Connector

## What this is

First-party Nimbus MCP connector for [Ramp](https://ramp.com). Indexes the
user's card **transactions** as `ramp:transaction` items in the local index and
exposes three read-only tools to the Nimbus agent (`ramp_list`, `ramp_get`,
`ramp_search`). Useful for spend questions — "what did I spend at AWS last
month?", "find my transactions in the Engineering department" — without leaving
Nimbus.

v1 indexes card transactions only. Receipts, budgets, and vendor-level spend
rollups are a deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set ramp.client_id <your-ramp-oauth-client-id>
nimbus vault set ramp.client_secret <your-ramp-oauth-client-secret>
nimbus ask "What did I spend at AWS last month on Ramp?"
```

Create an OAuth client under Ramp Developer → Apps with the `transactions:read`
scope and copy its client id + client secret. Both are **secret** credentials.
The connector authenticates via **OAuth2 client-credentials**: it exchanges the
client id + client secret for a bearer token at `POST
https://api.ramp.com/developer/v1/token` (HTTP Basic auth, body
`grant_type=client_credentials&scope=transactions:read`) and caches the token
for the process, then calls the data endpoints with `Authorization: Bearer`.

The Gateway injects `ramp.client_id` as `RAMP_CLIENT_ID` and `ramp.client_secret`
as `RAMP_CLIENT_SECRET` at spawn time; the connector itself never touches the
vault. Both credentials are never logged. The gateway-side syncable
(`packages/gateway/src/connectors/ramp-sync.ts`) performs the token exchange
once per cycle, then walks `GET
https://api.ramp.com/developer/v1/transactions?page_size=100` — following the
`page.next` cursor (a full URL to the next page, or null at the end) for a single
forward pass per cycle, capped at 20 pages — and upserts each transaction with
metadata `{ id, amount, currency_code, merchant_name, card_holder_name,
department, state, category, user_transaction_time, memo }`. On a `401`
mid-cycle the token is re-exchanged once and the page is retried.

Note: `user_transaction_time` is an ISO-8601 string; the connector converts it
to epoch-milliseconds on index. The title is synthesized as
`<merchant_name> — <amount> <currency>`. **No full card numbers or PANs are
surfaced** — Ramp's API does not return them, and only the safe transaction
fields above are mapped.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `ramp.client_id` | yes | Ramp OAuth client id (exchanged for a bearer token). |
| `ramp.client_secret` | yes | Ramp OAuth client secret (exchanged for a bearer token). |

The API host is fixed at `https://api.ramp.com` (no host override key — it is a
SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `ramp_list` | List card transactions (`GET /developer/v1/transactions?page_size=N`). |
| `ramp_get` | Fetch one transaction by its id (`GET /developer/v1/transactions/{id}`). |
| `ramp_search` | Substring search across transactions (merchant, category, state, currency, memo, card holder name/department). |

All three tools are read-only; `hitlRequired` is intentionally empty. Receipts,
budgets, and vendor spend rollups are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
