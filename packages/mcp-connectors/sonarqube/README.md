# SonarQube / SonarCloud Connector

## What this is

First-party Nimbus MCP connector for SonarQube and SonarCloud. Indexes
the user's open SonarQube **issues** (BUG / VULNERABILITY / CODE_SMELL)
as `sonarqube:code_issue` items in the local index and exposes three
read-only tools to the Nimbus agent (`sonarqube_list`, `sonarqube_get`,
`sonarqube_search`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# SonarCloud (SaaS)
nimbus vault set sonarqube.token <your-sonarcloud-token>
nimbus vault set sonarqube.organization <your-org-key>
nimbus ask "What critical SonarQube findings landed this week?"

# Self-hosted SonarQube
nimbus vault set sonarqube.token <your-sonarqube-token>
nimbus vault set sonarqube.url https://sonarqube.example.com
```

The Gateway injects `sonarqube.token` as `SONARQUBE_TOKEN` env at spawn
time; the connector itself never touches the vault. The gateway-side
syncable (`packages/gateway/src/connectors/sonarqube-sync.ts`) walks
`/api/components/search?qualifiers=TRK` → `/api/issues/search` and
upserts each open issue with metadata
`{ severity, type, status, rule, component, project_key, file_path,
line, tags, effort, debt, message, creation_date, update_date,
canonical_url }`.

`sonarqube.url` defaults to `https://sonarcloud.io`. Self-hosted
SonarQube users supply their own URL via that vault key — see
[`docs/sandbox.md`](../../../docs/sandbox.md) for the Task 14
runtime-merge follow-up that will allow the sandbox's network allow-list
to extend beyond `sonarcloud.io` at runtime; until then, self-hosted
syncs run with the broader manifest network permission.

Tools exposed:

| Tool                | Purpose                                                                |
| ------------------- | ---------------------------------------------------------------------- |
| `sonarqube_list`    | List projects, or open issues for a project (type + severity filters). |
| `sonarqube_get`     | Fetch a single issue by key.                                           |
| `sonarqube_search`  | Substring search across issue messages, rule ids, components, tags.    |

All three tools are read-only; `hitlRequired` is intentionally empty.
`sonarqube.hotspot.review` and `sonarqube.issue.transition` are deferred
Phase 8 follow-ups.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
