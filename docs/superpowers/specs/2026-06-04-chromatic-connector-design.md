# Chromatic connector + close out Wave B — design

**Date:** 2026-06-04
**Phase:** 5 (Extended Surface), Wave B
**Branch:** `dev/asafgolombek/chromatic-connector`

## Goal

Close out Phase 5 Wave B by:

1. Adding a **read-only first-party MCP connector for Chromatic** (visual-testing build
   observability), following the established codemagic/testflight connector template.
2. **Formally cancelling App Center** — Microsoft retired Visual Studio App Center on
   2025-03-31 (sign-in and API calls stopped that day; only Analytics & Diagnostics survive
   until 2026-06-30). Building against it is building against a dead service. It is recorded
   as **cancelled — upstream retired**, not deferred.

## Background

Wave B added TestFlight, Firebase App Distribution, and Codemagic (read-only mobile/build
observability connectors). PR #486 deferred "App Center / Chromatic". App Center is now
retired upstream; Chromatic is alive and a natural fit alongside the existing `storybook`
connector.

Chromatic differs from the existing REST connectors in one way: its API is **GraphQL**
(`https://index.chromatic.com/graphql`, `Authorization: Bearer <token>`), so the MCP server
and the gateway syncable issue `POST` requests with a query body rather than REST `GET`s.

**Risk — GraphQL schema:** Chromatic's exact GraphQL field names are not crisply documented
publicly. Like the other ~85 first-party connectors, correctness is unit-tested against
synthetic fixtures (no live cloud calls in CI); the real schema is confirmed manually with a
token during implementation. The query constants in `src/graphql.ts` are the single place to
adjust if a field name differs from the assumed schema below.

## Scope

### Two indexed item types

- `chromatic:project` — each Chromatic project ("app") the token can see.
- `chromatic:build` — recent builds per project.

### Auth

- Secret: `CHROMATIC_TOKEN` (personal access token), sent as `Authorization: Bearer <token>`.
- Vault secret key: `chromatic.token`.
- Network allowlist: `index.chromatic.com`.

## Architecture

### Connector package — `packages/mcp-connectors/chromatic/`

| File | Purpose |
| --- | --- |
| `src/server.ts` | MCP server via `runReadOnlyMcpConnector`; tools `chromatic_list`, `chromatic_get`, `chromatic_search`. Each issues a GraphQL `POST`. |
| `src/graphql.ts` | GraphQL endpoint constant, query constants (projects, builds, single build), and a small typed `chromaticGraphql(query, variables, token)` POST helper. |
| `src/search-filter.ts` | Pure `filterChromaticBuilds(builds, { query, limit })` — case-insensitive substring match over `branch`, `commit`, `status`, `number`. |
| `nimbus.extension.json` | Manifest (id `com.nimbus.chromatic`, network `index.chromatic.com`, tool list). |
| `package.json` | Package metadata (AGPL, depends on `@nimbus-dev/sdk` only). |
| `README.md` | Public-tier README with the mandated H2 sections (`audit:package-readmes`). |
| `tsconfig.json` | Standard connector tsconfig. |
| `test/search-filter.test.ts` | Unit tests for the filter on synthetic fixtures. |
| `test/sandbox.test.ts` | Manifest / sandbox-shape assertions (cloned from codemagic). |

#### MCP tools

- `chromatic_list` — no `projectId` → returns the viewer's projects; with `projectId` →
  returns that project's recent builds (`limit` optional, ≤ 50).
- `chromatic_get` — with `buildId` → single build; with only `projectId` → that project.
- `chromatic_search` — substring search over a project's recent builds; returns
  `{ matches: [...] }`.

### Gateway side — `packages/gateway/src/connectors/`

| File | Purpose |
| --- | --- |
| `chromatic-sync.ts` | `Syncable` (serviceId `chromatic`). `viewer → projects → per-project builds` walk via `connectorFetch` (POST). Cursor prefix `nimbus-chromatic1:`, shape `{ pass: number }`. `defaultIntervalMs` 10 min, `initialSyncDepthDays` 30. |
| `chromatic-build-mapping.ts` | Pure `mapChromaticProjectToItem` / `mapChromaticBuildToItem` returning the mapped-row shape; defensive field access via `asRecord` / `stringField`. |

#### Mapping

- **Project:** `external_id` = project id; title = project name; URL = project `webUrl` if present.
- **Build:** `external_id` = build id; title = `<project name?> #<number> (<status>)`;
  canonical URL = build `webUrl`; metadata
  `{ project_id, number, branch, commit, status, started_at (epoch-ms) }`.
  `startedAt` (ISO-8601) parsed to epoch-ms via a defensive helper.

### Wiring landed in the same change (wiring/typecheck coupling)

- `connector-catalog.ts` — add `chromatic` to the list, `MIN10` interval, auth hint
  (`"uses a personal access token sent as a Bearer header (connector.auth chromatic)"`).
- `connector-secrets-manifest.ts` — `chromatic: ["chromatic.token"]`.
- `sync/rate-limiter.ts` — add `"chromatic"` to the union + `chromatic: { requestsPerMinute: 30, burstSize: 10 }`.
- `lazy-mesh/first-party-manifests.ts` — `chromatic: baseManifest("com.nimbus.chromatic", { network: ["index.chromatic.com"], ... })`, and bump the count list in `first-party-manifests.test.ts`.
- `assemble-sync-registrations.ts` — register `createChromaticSyncable`.
- `lazy-mesh/phase3-config.ts` — connector spawn entry.

### Embedding routing

`chromatic:project` and `chromatic:build` are short metadata, not prose → default
MiniLM-384 table. No addition to `PROSE_HEAVY_TYPES`.

## Assumed GraphQL schema (confirm on implementation)

```graphql
# Projects the token can see
query { viewer { projects { id name webUrl } } }

# Recent builds for a project
query Builds($projectId: ID!, $limit: Int!) {
  project(id: $projectId) {
    builds(first: $limit) {
      edges { node { id number branch commit committerName status startedAt webUrl } }
    }
  }
}

# Single build
query Build($buildId: ID!) {
  build(id: $buildId) { id number branch commit status startedAt webUrl }
}
```

`status` is a Chromatic build-status enum (e.g. `PASSED`, `PENDING`, `DENIED`, `ACCEPTED`,
`BROKEN`, `FAILED`, `IN_PROGRESS`) — stored verbatim as a string; the connector does not
interpret it.

## App Center — cancellation record

- No connector code, no manifest entry, no secret key.
- `docs/CHANGELOG.md`: a dated entry noting App Center is cancelled because the upstream
  service retired on 2025-03-31 (API calls disabled that date; Analytics & Diagnostics expire
  2026-06-30). Reference: <https://learn.microsoft.com/en-us/appcenter/retirement>.
- `docs/roadmap.md`: update the Wave B row to mark App Center **cancelled — upstream
  retired**; Wave B otherwise complete (TestFlight, Firebase, Codemagic, Chromatic).
- Per the CHANGELOG convention, the CLAUDE.md / GEMINI.md status line is **not** edited.

## Testing

- `chromatic/test/search-filter.test.ts` — filter logic on synthetic build fixtures.
- `chromatic/test/sandbox.test.ts` — manifest/sandbox shape (cloned from codemagic).
- Gateway-side `chromatic-build-mapping.ts` is covered by the connector coverage gate; add a
  focused mapping test if coverage requires it.
- No live Chromatic API calls in CI — fixtures only.
- Pre-flight: `bun run preflight` (full gate set, incl. `audit:package-readmes` and the
  first-party-manifest count assertion, neither of which is in `test:ci`).

## Out of scope (YAGNI)

- Write tools (Chromatic review accept/deny) — read-only connector only.
- Snapshot/diff image indexing — builds + projects metadata only.
- Any App Center code.
- A live-substitute connector for App Center (explicitly declined: Chromatic-only closure).
