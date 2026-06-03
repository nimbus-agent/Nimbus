# Codemagic Connector

## What this is

First-party Nimbus MCP connector for [Codemagic](https://codemagic.io/).
Indexes the user's Codemagic **apps** and recent **builds** into the local
index as `codemagic:app` and `codemagic:build` items and exposes three
read-only tools to the Nimbus agent (`codemagic_list`, `codemagic_get`,
`codemagic_search`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set codemagic.token <your-codemagic-api-token>
nimbus ask "Which Codemagic builds on main failed in the last 24h?"
```

The Gateway injects `codemagic.token` as `CODEMAGIC_TOKEN` env at spawn
time; the connector itself never touches the vault. The token is sent in
the `x-auth-token` header (Codemagic's API does not use `Authorization`).
The gateway-side syncable
(`packages/gateway/src/connectors/codemagic-sync.ts`) walks
`/apps → /builds?appId=<id>` and upserts each build with metadata
`{ status, workflow_id, app_id, branch, tag, version, started_at,
finished_at, duration_ms, commit }`.

Tools exposed:

| Tool               | Purpose                                                                     |
| ------------------ | --------------------------------------------------------------------------- |
| `codemagic_list`   | List the user's apps, or recent builds for an app (limit optional).         |
| `codemagic_get`    | Fetch a single build by id, or the app list.                                |
| `codemagic_search` | Substring search across recent builds (branch / message / workflow / status). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Codemagic write actions (start build, cancel build) are deferred — the
roadmap row scopes this connector to read-only mobile CI observability.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
