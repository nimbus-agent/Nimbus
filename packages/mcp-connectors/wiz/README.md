# Wiz Connector

## What this is

First-party Nimbus MCP connector for Wiz cloud security platform.
Indexes the user's open Wiz **issues** (CSPM findings, toxic
combinations, misconfigurations, identity over-permissions) as
`wiz:issue` items in the local index and exposes three read-only
tools to the Nimbus agent (`wiz_list`, `wiz_get`, `wiz_search`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# Default tenant (api.app.wiz.io)
nimbus vault set wiz.client_id <your-client-id>
nimbus vault set wiz.client_secret <your-client-secret>

# Regional tenant (us-2, eu-1, …)
nimbus vault set wiz.api_url https://api.us2.app.wiz.io/graphql
nimbus vault set wiz.auth_url https://auth.app.wiz.io/oauth/token

nimbus ask "Show me critical Wiz findings on the payments service."
```

The Gateway injects credentials as `WIZ_CLIENT_ID`,
`WIZ_CLIENT_SECRET`, `WIZ_API_URL`, and `WIZ_AUTH_URL` env vars at
spawn time; the connector itself never touches the vault. At process
startup the connector exchanges client credentials for an access
token via Wiz's OAuth client_credentials flow (default endpoint
`https://auth.app.wiz.io/oauth/token`); the token is cached for the
process lifetime.

The gateway-side syncable (`packages/gateway/src/connectors/wiz-sync.ts`)
runs the same GraphQL `Issues` query, paginated, and upserts each
open issue with metadata
`{ severity, status, type, source_rule_id, source_rule_name, entity_id,
entity_name, entity_type, project_ids, project_names, description,
remediation, created_at, updated_at, resolved_at }`.

Tools exposed:

| Tool         | Purpose                                                                            |
| ------------ | ---------------------------------------------------------------------------------- |
| `wiz_list`   | List Wiz issues with optional severity / status / entity-type filters.             |
| `wiz_get`    | Fetch one issue by id.                                                             |
| `wiz_search` | Substring search across rule name, description, entity name/type, project names.   |

All three tools are read-only; `hitlRequired` is intentionally empty.
The `wiz.issue.resolve` and `wiz.issue.assign` write tools are
deferred Phase 8 follow-ups.

### Regional endpoints

Wiz hosts regional tenants at `api.<region>.app.wiz.io`
(e.g. `api.us2.app.wiz.io`). The static sandbox manifest only
allow-lists the default `api.app.wiz.io` + `auth.app.wiz.io` hosts
today; regional users supply the explicit URLs via `wiz.api_url` /
`wiz.auth_url` vault keys. Runtime-merge of arbitrary hostnames into
the sandbox network allow-list is the same Task 14 follow-up shared
with Sentry's `sentry.url`.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
