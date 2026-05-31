# Salesforce Connector

## What this is

First-party Nimbus MCP connector for [Salesforce](https://salesforce.com).
Indexes a tenant's **Opportunities** as `salesforce:opportunity` items in the
local index and exposes three read-only tools to the Nimbus agent
(`salesforce_list`, `salesforce_get`, `salesforce_search`). Useful for sales
questions — "what's the status of the Acme renewal?", "which deals close this
quarter?" — without leaving Nimbus.

This is a Tier-2 OAuth connector: it authenticates via the 3-legged OAuth
authorization-code flow (with PKCE) shared with the other Tier-2 connectors.
Salesforce is "forky" because its API host is **per-tenant** — the
`instance_url` is discovered during the OAuth exchange and used as the base for
every request.

v1 indexes Opportunities. Other sObjects (Accounts, Leads, Cases) are a deferred
follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
export NIMBUS_OAUTH_SALESFORCE_CLIENT_ID=<your-connected-app-consumer-key>
export NIMBUS_OAUTH_SALESFORCE_CLIENT_SECRET=<your-connected-app-consumer-secret>
nimbus connector auth salesforce
nimbus ask "What's the status of the Acme renewal opportunity?"
```

Create a Connected App under Salesforce → Setup → App Manager → New Connected
App with **Enable OAuth Settings**, the `api` and `refresh_token` scopes, and a
loopback redirect URL; copy its Consumer Key (client id) + Consumer Secret
(client secret). The connector authenticates via the **OAuth 2.0
authorization-code flow WITH PKCE**: the Gateway opens the browser to
`https://login.salesforce.com/services/oauth2/authorize`, then exchanges the
returned code at `POST https://login.salesforce.com/services/oauth2/token` with
the client id + client secret **form-encoded in the request body**. The token
response returns a per-tenant `instance_url`; the access + refresh tokens and the
`instance_url` are stored under the `salesforce.oauth` vault key.

Salesforce **does not return `expires_in`**, so the Gateway synthesizes a
conservative 30-minute access-token lifetime and proactively refreshes the
short-lived access token roughly every sync cycle using the long-lived refresh
token — robust against short org session timeouts. The token is never logged.

The Gateway injects the live access token as `SALESFORCE_ACCESS_TOKEN` and the
discovered host as `SALESFORCE_INSTANCE_URL` at spawn time; the connector itself
never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/salesforce-sync.ts`) resolves a valid access
token + instance_url once per cycle, then queries the SOQL API:

1. `GET <instance_url>/services/data/v60.0/query?q=SELECT ... FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 200`.
2. When the response's `done` is `false`, it follows `nextRecordsUrl`
   (`GET <instance_url><nextRecordsUrl>`) for the next page, walking a single
   forward pass per cycle, page-capped.

It flattens all Opportunity records into `salesforce:opportunity` items. The
title is the opportunity name (falling back to `Salesforce opportunity <id>`);
the item id is `salesforce:<Id>` (stable); `modifiedAt` is derived from
`LastModifiedDate` (else the sync time). The mapper is pure and side-effect-free,
so it does not construct an instance-relative url — url/canonical_url are null.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `salesforce.oauth` | yes | OAuth access + refresh tokens AND the discovered per-tenant `instance_url` (written by `nimbus connector auth salesforce`; refreshed by the Gateway). |

The client id + secret are read from the `NIMBUS_OAUTH_SALESFORCE_CLIENT_ID` /
`NIMBUS_OAUTH_SALESFORCE_CLIENT_SECRET` environment variables (not the vault).
The API host is the per-tenant `instance_url` discovered at OAuth time; the only
fixed host is `login.salesforce.com` (authorize/token endpoints). The instance
host is added to the sandbox manifest at spawn via the lazy-mesh extra-hosts
path.

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `salesforce_list` | List Opportunities via the SOQL query API (paged by `nextRecordsUrl`). |
| `salesforce_get` | Fetch one Opportunity by id (`GET .../sobjects/Opportunity/{id}`). |
| `salesforce_search` | Substring search across the first page (opportunity name, stage, type). |

All three tools are read-only; `hitlRequired` is intentionally empty. Additional
sObjects, full-text SOSL search, and write tools are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
