# LaunchDarkly Connector

## What this is

First-party Nimbus MCP connector for [LaunchDarkly](https://launchdarkly.com)
feature flags. Indexes the user's **feature flags** across all (or one
configured) LaunchDarkly project as `launchdarkly:feature_flag` items in the
local index and exposes three read-only tools to the Nimbus agent
(`launchdarkly_list`, `launchdarkly_get`, `launchdarkly_search`). Useful for
incident correlation — "was this flag enabled when the alert fired?".

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set launchdarkly.token <your-launchdarkly-api-token>
nimbus ask "Which LaunchDarkly flags are on in production?"
```

The Gateway injects `launchdarkly.token` as `LAUNCHDARKLY_TOKEN` (and the
optional `launchdarkly.base_url` as `LAUNCHDARKLY_BASE_URL`) at spawn time; the
connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/launchdarkly-sync.ts`) walks
`GET /api/v2/projects → GET /api/v2/flags/{projectKey}` (offset-paged 100/page,
capped 20 pages per project) and upserts each flag with metadata
`{ key, name, kind, project_key, tags, temporary, archived, maintainer,
maintainer_id, description, variation_count, environments, env_states,
created_at, updated_at, canonical_url }`.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `launchdarkly.token` | yes | LaunchDarkly REST API access token (raw `Authorization` header — no `Bearer` prefix). |
| `launchdarkly.base_url` | no | Regional/federal override (default `https://app.launchdarkly.com`). |
| `launchdarkly.project_key` | no | Restrict the sync to one project; otherwise all projects are walked. |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `launchdarkly_list` | List projects (no `projectKey`), or feature flags for a project. |
| `launchdarkly_get` | Fetch one flag by `projectKey` + `flagKey`. |
| `launchdarkly_search` | Substring search across a project's flags (key, name, description, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty. The
`launchdarkly.flag.toggle` write tool is a deferred Phase 8 follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
