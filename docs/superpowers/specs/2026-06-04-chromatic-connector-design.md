# Chromatic connector + close out Wave B — design

> **⚠️ SUPERSEDED — NOT BUILT (2026-06-04).** During plan-out, the repo's own roadmap
> (`docs/roadmap.md`) was found to already document, dated 2026-06-03, that Chromatic's
> token-auth public GraphQL API exposes only `Project.lastBuild` (a single build) with **no
> paginated builds-list field** reachable from a stable headless token — which invalidates
> this design's per-project `builds(first: N)` walk. The decision was to **drop Chromatic and
> close Wave B docs-only** (App Center cancelled — upstream retired; Chromatic deferred). No
> connector code was written. This document is retained as design-decision history only; the
> App Center cancellation reasoning below still stands. See the 2026-06-04 entry in
> `docs/CHANGELOG.md`.

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

The mapping layer degrades gracefully on a field rename by construction: every field is read
through `asRecord` / `stringField` (the codemagic template pattern), so a renamed field
becomes `null` / absent in the item metadata rather than throwing a `TypeError`, and a row
that loses its `id` returns `null` from the mapper and is skipped by the sync loop. No
additional per-field validation is needed beyond this pattern.

**GraphQL-specific error handling (a real REST→GraphQL difference):** GraphQL returns query
errors in a `{ data, errors: [...] }` envelope with **HTTP 200**, so `connectorFetch` (which
branches only on `res.ok`) would classify an errored response as `kind: "ok"` with
`data: null`. To avoid silently treating a schema/permission error as "zero results", the
extract step in `chromatic-sync.ts` checks for a top-level `errors` array and, when present,
logs a warning (`ctx.logger.warn`) and treats the pass as empty (cursor unchanged, retried
next interval). The MCP `src/graphql.ts` helper does the same on the tool path.

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
- **Build:** `external_id` = `<projectId>/<buildId>`; title = `<project name?> #<number> (<status>)`;
  canonical URL = build `webUrl`; metadata
  `{ project_id, number, branch, commit, status, started_at (epoch-ms | null) }`.
  `startedAt` (ISO-8601) parsed to epoch-ms via the defensive `parseIsoMs` helper, which
  returns `null` for a missing / empty / unparseable value. A `PENDING` build with no
  `startedAt` therefore stores `started_at: null` and falls back to `modifiedAt = startedAt ??
  syncedAt` (Chromatic builds have no `finishedAt` in the assumed schema). No mapping error
  for queued builds.

### Wiring landed in the same change (wiring/typecheck coupling)

- `connector-catalog.ts` — add `chromatic` to the list, `MIN10` interval, auth hint
  (`"uses a personal access token sent as a Bearer header (connector.auth chromatic)"`).
- `connector-secrets-manifest.ts` — `chromatic: ["chromatic.token"]`.
- `sync/rate-limiter.ts` — add `"chromatic"` to the union + `chromatic: { requestsPerMinute: 30, burstSize: 10 }`.
  30 RPM is sufficient because the sync issues **O(projects)** requests, not O(builds): one
  `viewer { projects }` query plus one recent-builds page (≤ 50 builds, newest first) per
  project. There is **no deep 30-day pagination** — `initialSyncDepthDays: 30` is the
  freshness intent of the single page, not a multi-page walk. A 429 surfaces as
  `connectorFetch` → `http_error` → empty-this-pass (cursor unchanged), recovered on the next
  10-min interval; no custom backoff is added (matching every other connector). The 30/10
  ceiling is deliberately conservative against Chromatic's undocumented real limit; it is not
  raised speculatively.
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

### Manual validation checklist (one-time, with a real `CHROMATIC_TOKEN`)

Done once during implementation since the API is undocumented and unmocked in CI:

1. Confirm the GraphQL field names in the assumed schema (esp. `viewer { projects }` vs
   `viewer { accounts { projects } }`, and the `builds` connection shape). Adjust
   `src/graphql.ts` only.
2. Confirm `index.chromatic.com` is the live host and the GraphQL endpoint does **not**
   redirect to another subdomain — the sandbox network allowlist (`network:
   ["index.chromatic.com"]`) would block a cross-host redirect, surfacing as a fetch failure.
   If a redirect/tenant host exists, widen the allowlist accordingly.
3. Confirm Bearer auth works with a personal access token and what scope it needs to read
   projects + builds.

## Review dispositions (`…-design-review.md`, 2026-06-04)

| # | Review point | Disposition |
| --- | --- | --- |
| 1 | Defensive GraphQL parsing vs field renames | **Fixed in spec.** Affirmed the `asRecord`/`stringField` template already degrades renames to `null` (no `TypeError`); **added** GraphQL `{ errors[] }`-with-HTTP-200 handling, which is the real REST→GraphQL gap. |
| 2 | 30 RPM sufficiency / 429 backoff / pagination | **Deferred (clarified).** Requests are O(projects) with one recent page each — not a 30-day multi-page walk — so 30 RPM is ample; 429 degrades gracefully (empty pass, retried next interval), matching all connectors. RPM not raised speculatively. |
| 3 | `startedAt` nullability for `PENDING` builds | **Fixed in spec.** Made the `parseIsoMs` → `null` fallback and `modifiedAt = startedAt ?? syncedAt` explicit in the mapping section. |
| 4 | Allowlist redirects / tenant subdomains | **Deferred to manual validation.** Added as checklist item 2; `index.chromatic.com` is correct for the documented endpoint, confirmed live during implementation. |

## Out of scope (YAGNI)

- Write tools (Chromatic review accept/deny) — read-only connector only.
- Snapshot/diff image indexing — builds + projects metadata only.
- Any App Center code.
- A live-substitute connector for App Center (explicitly declined: Chromatic-only closure).
