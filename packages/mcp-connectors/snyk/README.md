# Snyk Connector

## What this is

First-party Nimbus MCP connector for Snyk. Indexes the user's Snyk
**issues** (open-source, container, IaC, code) as `snyk:vulnerability`
items in the local index and exposes three read-only tools to the
Nimbus agent (`snyk_list`, `snyk_get`, `snyk_search`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set snyk.token <your-snyk-api-token>
nimbus ask "What critical vulnerabilities did Snyk surface this week?"
```

The Gateway injects `snyk.token` as `SNYK_TOKEN` env at spawn time; the
connector itself never touches the vault. The gateway-side syncable
(`packages/gateway/src/connectors/snyk-sync.ts`) walks
`/v1/orgs → /v1/org/<id>/projects → /v1/org/<id>/project/<pid>/aggregated-issues`
and upserts each issue with metadata `{ severity, cve_id, affected_package,
affected_versions, fix_available, fix_version, project_url, project_id,
org_id, type, disclosed_at, published_at }`.

Tools exposed:

| Tool          | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `snyk_list`   | List org projects, or aggregated issues for a project (severity filter). |
| `snyk_get`    | Fetch a single issue by id from an org + project.                        |
| `snyk_search` | Substring search across issue titles, CVE ids, and package names.        |

All three tools are read-only; `hitlRequired` is intentionally empty.
The `snyk.issue.ignore` write tool is a deferred Phase 8 follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
