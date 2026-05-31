# HubSpot Connector

## What this is

First-party Nimbus MCP connector for [HubSpot](https://www.hubspot.com). Indexes
the authenticated portal's CRM **deals** as `hubspot:deal` items in the local
index and exposes three read-only tools to the Nimbus agent (`hubspot_list`,
`hubspot_get`, `hubspot_search`). Useful for pipeline questions — "what deals are
closing this month?", "find my Acme renewal" — without leaving Nimbus.

This is the Tier-2 OAuth infra-prover: the first Tier-2 connector, it exercises
the 3-legged OAuth authorization-code path that later Tier-2 connectors reuse.

v1 indexes deals only. Companies, contacts, and tickets are a deferred
follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
export NIMBUS_OAUTH_HUBSPOT_CLIENT_ID=<your-hubspot-app-client-id>
export NIMBUS_OAUTH_HUBSPOT_CLIENT_SECRET=<your-hubspot-app-client-secret>
nimbus connector auth hubspot
nimbus ask "What HubSpot deals are closing this month?"
```

Create an app under HubSpot Developers → Apps with the `crm.objects.deals.read`
(and `oauth`) scope and copy its client id + client secret. The connector
authenticates via the **OAuth 2.0 authorization-code flow** (NOT PKCE): the
Gateway opens the browser to `https://app.hubspot.com/oauth/authorize`, then
exchanges the returned code at `POST https://api.hubapi.com/oauth/v1/token` with
the client id + client secret **form-encoded in the request body**. The
resulting access + refresh tokens are stored under the `hubspot.oauth` vault key;
the Gateway refreshes the short-lived access token automatically.

The Gateway injects the live access token as `HUBSPOT_TOKEN` at spawn time; the
connector itself never touches the vault. The token is never logged. The
gateway-side syncable (`packages/gateway/src/connectors/hubspot-sync.ts`)
resolves a valid access token once per cycle, then walks `GET
https://api.hubapi.com/crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage,pipeline,closedate,createdate,hs_lastmodifieddate`
— following the `paging.next.after` cursor for a single forward pass per cycle,
capped at 20 pages — and upserts each deal with metadata `{ id, dealname, amount,
dealstage, pipeline, closedate, createdate, hs_lastmodifieddate }`.

Note: HubSpot deal URLs require a portal id the API does not return generically,
so `url` / `canonical_url` are set to `null`. The title is the deal name (falling
back to `HubSpot deal <id>`); `modifiedAt` is derived from
`hs_lastmodifieddate` (or the `updatedAt` envelope field).

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `hubspot.oauth` | yes | OAuth access + refresh tokens (written by `nimbus connector auth hubspot`; refreshed by the Gateway). |

The client id + secret are read from the `NIMBUS_OAUTH_HUBSPOT_CLIENT_ID` /
`NIMBUS_OAUTH_HUBSPOT_CLIENT_SECRET` environment variables (not the vault). The
API host is fixed at `https://api.hubapi.com` (no host override — it is a SaaS
host).

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `hubspot_list` | List deals (`GET /crm/v3/objects/deals?limit=N&properties=...`). |
| `hubspot_get` | Fetch one deal by its id (`GET /crm/v3/objects/deals/{id}`). |
| `hubspot_search` | Substring search across the first page of deals (deal name, stage, pipeline). |

All three tools are read-only; `hitlRequired` is intentionally empty. Companies,
contacts, and tickets are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
