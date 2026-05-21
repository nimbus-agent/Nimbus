# nimbus-mcp-snyk

First-party MCP connector exposing the Snyk REST API as read-only tools for
the Nimbus engine and indexing the user's Snyk **issues** (open-source,
container, IaC, code) as `snyk:vulnerability` items in the local index.

## Tools

| Tool          | Purpose                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| `snyk_list`   | List issues for an org and optional project; severity / type filters.    |
| `snyk_get`    | Fetch a single issue by id from an org + project.                        |
| `snyk_search` | Substring search across issue titles + CVE ids (server-side via filter). |

All three tools are read-only; **no write tools** are exposed and
`hitlRequired` is intentionally empty.

## Credentials

The connector reads `SNYK_TOKEN` from the environment at startup. The
Gateway injects it at spawn time from the `snyk.token` vault key — the
connector itself never touches the vault.

## Manifest

`permissions.network` is restricted to `api.snyk.io`. Snyk does not expose a
documented endpoint outside that hostname for the read flows used here.
Self-hosted Snyk endpoints (e.g. on-prem instances) are a deferred
follow-up — same Task 14 limitation as Sentry self-hosted.

## Indexing

The gateway-side syncable (`packages/gateway/src/connectors/snyk-sync.ts`)
walks the org's projects, fetches each project's open issues via Snyk's
`/v1/org/<orgId>/project/<projectId>/aggregated-issues` endpoint, and
upserts each issue as a `snyk:vulnerability` item with metadata
`{ severity, cve_id, affected_package, affected_version, fix_available,
fix_version, project_url, project_id, disclosed_at, published_at, type }`.
