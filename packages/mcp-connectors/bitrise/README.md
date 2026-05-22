# Bitrise Connector

## What this is

First-party Nimbus MCP connector for [Bitrise](https://www.bitrise.io/).
Indexes the user's Bitrise **apps** and recent **builds** into the local
index as `bitrise:app` and `bitrise:build` items and exposes three
read-only tools to the Nimbus agent (`bitrise_list`, `bitrise_get`,
`bitrise_search`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set bitrise.token <your-bitrise-personal-access-token>
nimbus ask "Which Bitrise builds on main failed in the last 24h?"
```

The Gateway injects `bitrise.token` as `BITRISE_TOKEN` env at spawn time;
the connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/bitrise-sync.ts`) walks
`/v0.1/me/apps → /v0.1/apps/<slug>/builds` and upserts each build with
metadata `{ status, workflow_id, app_slug, started_at, finished_at,
duration_ms, triggered_by, commit_hash, branch }`.

Tools exposed:

| Tool             | Purpose                                                                       |
| ---------------- | ----------------------------------------------------------------------------- |
| `bitrise_list`   | List the user's apps, or recent builds for an app (status filter + limit).    |
| `bitrise_get`    | Fetch a single app or build by slug.                                          |
| `bitrise_search` | Substring search across recent builds (branch / commit / workflow / status). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Bitrise write actions (trigger build, abort build) are deferred — the
roadmap row scopes this connector to read-only mobile CI observability.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
