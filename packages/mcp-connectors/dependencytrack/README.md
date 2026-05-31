# Dependency-Track Connector

## What this is

First-party Nimbus MCP connector for [OWASP Dependency-Track](https://dependencytrack.org/).
Indexes the user's software-supply-chain **projects** from a self-hosted
Dependency-Track instance as `dependencytrack:project` items in the local index
and exposes three read-only tools to the Nimbus agent
(`dependencytrack_list`, `dependencytrack_get`, `dependencytrack_search`).
Each project carries its current vulnerability metrics (critical / high /
medium / low counts, total vulnerabilities, component count). Useful for
supply-chain discovery — "which projects have critical vulnerabilities?".

v1 indexes **projects only** — individual findings and components are a
deferred follow-up.

## Install

Bundled with Nimbus — no separate install required.

## Quickstart

```bash
# Dependency-Track is self-hosted: both keys are required (no defaults).
nimbus vault set dependencytrack.base_url https://dtrack.example.com
nimbus vault set dependencytrack.api_key <your-dependency-track-api-key>

nimbus ask "Which Dependency-Track projects have critical vulnerabilities?"
```

Create the API key in Dependency-Track under Administration → Access
Management → Teams → (your team) → API Keys, with the `VIEW_PORTFOLIO`
permission. The Gateway injects the base URL as `DEPENDENCYTRACK_URL` and the
API key as `DEPENDENCYTRACK_API_KEY` at spawn time; the connector itself never
touches the vault. The API key is sent as the `X-Api-Key` request header.
Because Dependency-Track has no universal SaaS host, the sandbox network list
is empty in the static manifest — the gateway parses the hostname from the
configured base URL and extends the sandbox network allow-list at spawn time
(`phase3AddDependencytrackMcp`).

The gateway-side syncable
(`packages/gateway/src/connectors/dependencytrack-sync.ts`) walks
`GET /api/v1/project?pageSize=100&pageNumber=<n>&excludeInactive=false` — a
single forward page-number pass per cycle, incrementing `pageNumber` while a
full page comes back (capped at 20 pages) — and upserts each project with
metadata `{ uuid, name, version, classifier, active, last_bom_import, tags,
critical, high, medium, low, vulnerabilities, components, canonical_url }`. The
project's vulnerability metrics are read from the `metrics` object embedded in
each list entry.

Vault keys:

| Key | Required | Purpose |
| --- | --- | --- |
| `dependencytrack.base_url` | yes | Dependency-Track base URL (e.g. `https://dtrack.example.com`); requests go to `${base_url}/api/v1/...`. |
| `dependencytrack.api_key` | yes | Dependency-Track API key (sent as the `X-Api-Key` header). |

Tools exposed:

| Tool | Purpose |
| --- | --- |
| `dependencytrack_list` | List projects; optional `pageNumber`. |
| `dependencytrack_get` | Fetch one project by its `uuid`. |
| `dependencytrack_search` | Substring search across projects (name, version, classifier, tags). |

All three tools are read-only; `hitlRequired` is intentionally empty.
Individual findings and components are a deferred follow-up.

## See also

- [Nimbus Connectors Overview](https://nimbus-agent.dev/user-guide/connectors/)
- [Nimbus Architecture Overview](https://nimbus-agent.dev/architecture-overview/)
- [HITL and Safety](https://nimbus-agent.dev/user-guide/hitl-and-safety/)

## License

AGPL-3.0
