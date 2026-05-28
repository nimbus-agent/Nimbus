# Stripe Connector

## What this is

First-party Nimbus MCP connector for [Stripe](https://stripe.com). Indexes the
user's recent **invoices** as `stripe:invoice` items in the local index and
exposes three read-only tools to the Nimbus agent (`stripe_list`, `stripe_get`,
`stripe_search`). Useful for answering billing questions — "which invoices are
still open?", "what did ACME pay last month?" — without leaving Nimbus.

v1 indexes invoices only. Customers, charges / payment intents, disputes, and
subscription events are deferred follow-ups, as is the `stripe.refund.create`
write (which would land behind HITL).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set stripe.api_key <your-stripe-secret-key>
nimbus ask "Which Stripe invoices are still open?"
```

The `stripe.api_key` value is a Stripe **secret key** (it starts `sk_live_` or
`sk_test_`); a read-scoped restricted key (`rk_...`) with invoice read access
also works. It is sent as `Authorization: Bearer <key>` and is never logged.

The Gateway injects `stripe.api_key` as `STRIPE_API_KEY` at spawn time; the
connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/stripe-sync.ts`) walks
`GET /v1/invoices?limit=100` (id-cursor pagination via `starting_after`, capped
20 pages) and upserts each invoice with metadata `{ invoice_id, number,
customer_id, customer_name, customer_email, status, amount_due, amount_paid,
currency, subscription_id, hosted_invoice_url, invoice_pdf, created_at,
due_date, period_start, period_end, canonical_url }`.

Note: Stripe timestamps are Unix **seconds**; the connector converts them to
epoch-milliseconds on index. Amounts are integer minor units (cents); the
body preview divides by 100 for a human-readable figure (acceptable for v1 —
zero-decimal currencies such as JPY are not special-cased).

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `stripe.api_key` | yes | Stripe secret / read-scoped restricted key (sent as `Authorization: Bearer <key>`). |

The API host is fixed at `https://api.stripe.com` (no host override key — it is
a SaaS host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `stripe_list` | List recent invoices (`GET /v1/invoices`). |
| `stripe_get` | Fetch one invoice by id (`GET /v1/invoices/{id}`). |
| `stripe_search` | Substring search across recent invoices (id, number, status, customer id/name/email, description). |

All three tools are read-only; `hitlRequired` is intentionally empty. Customers,
charges, disputes, and subscription events — plus the `stripe.refund.create`
write (behind HITL) — are deferred follow-ups; v1 indexes invoices only.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
