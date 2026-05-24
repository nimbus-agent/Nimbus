# nimbus-mcp-launchdarkly

First-party Nimbus MCP connector for [LaunchDarkly](https://launchdarkly.com)
feature flags. Read-only.

## Tools

- `launchdarkly_list` — list flags for a project (or list projects).
- `launchdarkly_get` — fetch one flag by `projectKey` + `flagKey`.
- `launchdarkly_search` — substring search across a project's flags.

## Credentials (vault keys, injected at spawn time)

- `launchdarkly.token` — **required.** A LaunchDarkly REST API access token.
- `launchdarkly.base_url` — optional. Override for regional/federal instances
  (default `https://app.launchdarkly.com`).
- `launchdarkly.project_key` — optional. Restrict the sync to one project;
  otherwise all projects are walked.

## Item shape

`launchdarkly:feature_flag`, `external_id = "<projectKey>:<flagKey>"`. Metadata:
`key`, `name`, `kind`, `project_key`, `tags`, `temporary`, `archived`,
`maintainer`, `maintainer_id`, `description`, `variation_count`,
`environments`, `env_states`, `created_at`, `updated_at`, `canonical_url`.

## Deferred (Phase 8)

`launchdarkly.flag.toggle` (HITL-gated write).
