# Flagsmith Connector

## What this is

First-party Nimbus MCP connector for [Flagsmith](https://flagsmith.com)
feature flags. Indexes the user's **feature-flag definitions** across all
Flagsmith projects as `flagsmith:feature_flag` items in the local index and
exposes three read-only tools to the Nimbus agent (`flagsmith_list`,
`flagsmith_get`, `flagsmith_search`). Useful for incident correlation —
"did this flag exist when the alert fired?".

v1 indexes flag **definitions only** — per-environment on/off state and
segments are a deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# SaaS (api.flagsmith.com)
nimbus vault set flagsmith.token <your-flagsmith-admin-api-token>

# Self-hosted / regional
nimbus vault set flagsmith.api_base https://flagsmith.internal.example.com

nimbus ask "Which Flagsmith feature flags are archived in the payments project?"
```

The Gateway injects `flagsmith.token` as `FLAGSMITH_TOKEN` (and the optional
`flagsmith.api_base` as `FLAGSMITH_API_BASE`) at spawn time; the connector
itself never touches the vault. The Flagsmith admin API token is sent as the
`Authorization: Token <token>` header (the literal word `Token`, a space, then
the raw token — not `Bearer`). The gateway-side syncable
(`packages/gateway/src/connectors/flagsmith-sync.ts`) walks
`GET /api/v1/projects/ → GET /api/v1/projects/{id}/features/` (DRF-paged
100/page, capped 20 pages per project) plus one
`GET /api/v1/projects/{id}/tags/` call per project to resolve tag ids to
labels, and upserts each flag with metadata
`{ name, type, default_enabled, initial_value, description, tags, is_archived,
owner_count, project_id, project_name, created_at, canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `flagsmith.token` | yes | Flagsmith admin API token (sent as `Authorization: Token <token>`). |
| `flagsmith.api_base` | no | Regional / self-hosted host root (default `https://api.flagsmith.com`); requests go to `${api_base}/api/v1/...`. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `flagsmith_list` | List projects (no `projectId`), or feature flags for a project. |
| `flagsmith_get` | Fetch one flag by `projectId` + `featureName` (search + exact-name narrow). |
| `flagsmith_search` | Substring search across a project's flags (name, description, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty. The
`flagsmith.flag.toggle` write tool is a deferred Phase 8 follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
