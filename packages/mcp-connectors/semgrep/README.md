# Semgrep Connector

## What this is

First-party Nimbus MCP connector for Semgrep AppSec Platform. Indexes
the user's open Semgrep **findings** (SAST rule matches across all
configured projects) as `semgrep:finding` items in the local index and
exposes three read-only tools to the Nimbus agent (`semgrep_list`,
`semgrep_get`, `semgrep_search`).

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
nimbus vault set semgrep.token <your-semgrep-pat>
nimbus vault set semgrep.deployment_slug <your-deployment-slug>
nimbus ask "Show me critical Semgrep findings opened this week."
```

The Gateway injects `semgrep.token` as `SEMGREP_TOKEN` and
`semgrep.deployment_slug` as `SEMGREP_DEPLOYMENT_SLUG` at spawn time;
the connector itself never touches the vault. The gateway-side
syncable (`packages/gateway/src/connectors/semgrep-sync.ts`) walks
`GET /api/v1/deployments → /api/v1/deployments/<slug>/findings` (paged
100/page, capped 20 pages per cycle) and upserts each open finding
with metadata
`{ severity, confidence, rule_name, rule_message, categories,
file_path, line, end_line, column, repository, branch, triage_state,
status, created_at, relevant_since, line_of_code_url }`.

Tools exposed:

| Tool             | Purpose                                                                          |
| ---------------- | -------------------------------------------------------------------------------- |
| `semgrep_list`   | List deployments (no filters), or findings under the configured slug.            |
| `semgrep_get`    | Fetch one finding by id from the configured deployment.                          |
| `semgrep_search` | Substring search across rule name, message, file path, repository.               |

All three tools are read-only; `hitlRequired` is intentionally empty.
The `semgrep.finding.triage` write tool (ignore / suppress / accept-risk)
is a deferred Phase 8 follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
