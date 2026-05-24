# Phase 5 Connector Buildout — Program Design

**Date:** 2026-05-24
**Status:** Approved sequencing; per-connector designs follow individually.
**Author:** Asaf Golombek (with Claude Opus 4.7)

## Goal

Complete the remaining Phase 5 ("The Extended Surface") connector breadth and the
one remaining Marketplace v2 feature, so that "wherever a knowledge worker or
developer spends time, their data is in the index." Phase 5's structural epics
(T2 extension maturity, T3 Team Intelligence, T4 CI/CD data layer, T6 hardening,
`nimbus security scan`, semantic layer) are already complete; what remains is a
long, mostly-parallel tail of individual connectors plus community ratings.

This is a **program**, not a single project: one agreed sequence, then a
connector-by-connector cadence where each connector is its own design → plan →
PR cycle.

## Scope

In scope — the unchecked Phase 5 items in [`docs/roadmap.md`](../../roadmap.md):

- ~45 connectors across the tiers below.
- Marketplace v2 → community ratings & reviews.
- Tier 0 freebie: flip the stale "Multi-model embedding" checkbox (work already
  shipped via T6 PR 3; the checkbox was never flipped).

Out of scope:

- Extension monetization (explicitly deferred to Phase 6 by the roadmap).
- The Phase 6 write-tool follow-ups for read-only connectors (ArgoCD `sync`,
  Flux `reconcile`, ML `promote`, etc.) — these land in Phase 6 / Phase 8 per the
  roadmap's "Deferred from Phase 5" section.

## Cadence (decision, 2026-05-24)

**Per-connector approval.** For each connector I present a short design (auth
model, endpoints walked, item type(s), metadata surfaced, graph edges, vault
keys, HITL deferrals) and wait for explicit approval before building it. One PR
per connector. Each PR is verified to `bun run test:ci` parity before it is
opened, and follows the `nimbus-connector-authoring` template the Wiz / Snyk /
SonarQube / Semgrep connectors established.

**PR granularity (Review S1):** one PR per connector is the default. Items the
roadmap already bundles on a single checkbox (e.g. Pocket/Readwise/Raindrop,
Airflow/Prefect/Dagster) ship as one PR for that bundle. Opt-in batching of
near-identical *separate* connectors (e.g. Vercel + Netlify) into one PR is
offered at design-approval time — **the user decides per case** (standing
preference: opt-in pair-batching allowed; see Decision log).

## Per-connector template (the fixed shape)

Every connector PR reuses the proven structure (see the `nimbus-connector-authoring`
skill for the authoritative checklist):

1. `packages/mcp-connectors/<name>/` — MCP server exposing the mandatory
   read-tool surface (`<name>_list` / `<name>_get` / `<name>_search`), manifest
   (`nimbus.extension.json` with `permissions.network` sandbox allow-list +
   `hitlRequired`), `package.json`, `tsconfig.json`, `README.md`,
   `search-filter.ts` (pure), and `test/{search-filter,sandbox}.test.ts`.
2. `packages/gateway/src/connectors/<name>-sync.ts` — `Syncable` (single-pass
   cursor; per-cycle page cap), credentials via `readConnectorSecret`.
3. `packages/gateway/src/connectors/<name>-<thing>-mapping.ts` — pure mapper
   (unit-tested independently of the HTTP path).
4. Seven wiring sites: `connector-catalog.ts`, `connector-secrets-manifest.ts`,
   `lazy-mesh/first-party-manifests.ts` (+ `.test.ts` enumeration),
   `lazy-mesh/phase3-config.ts` (+ `.test.ts` `phase3Add<Name>Mcp` block),
   `platform/assemble-sync-registrations.ts`, `sync/rate-limiter.ts`, root
   `package.json`.
5. Gateway-side tests: `test/unit/connectors/<name>-*-mapping.test.ts` +
   `test/integration/connectors/<name>-sync-fake-server.test.ts` (`Bun.serve`
   fake; satisfies the per-file 80% coverage floor). **The integration test must
   exercise the error / rate-limit path** — at minimum a non-2xx response (e.g.
   `429` / `5xx`) and an auth-failure response — asserting the sync degrades
   gracefully (no throw past the `Syncable` boundary; cursor preserved) rather
   than only the happy path. (Review S2.)
6. Docs: `CLAUDE.md` + `GEMINI.md` status lines, `docs/roadmap.md` row flip,
   `.claude/commands/nimbus-file-map.md` rows.

## Sequencing

### Tier 0 — Freebie

- Flip the stale "Multi-model embedding" roadmap checkbox.

### Tier 1 — API-token REST, read-only (closest to the proven template)

LaunchDarkly → Flagsmith → ArgoCD‡ → Flux → SBOM/supply-chain → dbt Cloud →
Metabase → Superset → Databricks → Airflow/Prefect/Dagster → MLflow →
Vercel/Netlify → Stripe → Ramp → Mercury → Expensify → Pipedrive → Greenhouse →
Lever → Zendesk/Intercom → Stack Overflow → Pocket/Readwise/Raindrop → Zotero

### Tier 2 — OAuth SaaS (new OAuth app registration + flow)

HubSpot‡ → Salesforce → Zoom → Google Meet (extends Google auth) → Loom →
Figma → Miro → Canva

### Tier 3 — Cloud-cred reuse / "no-row-data" warehouse & logging

BigQuery‡ → AWS Athena → CloudWatch / Cloud Logging → Kibana / Elasticsearch →
SageMaker (reuses AWS creds) → Vertex AI (reuses GCP ADC) → Great Expectations
(CI artefacts). Each carries an extra contract test asserting **no row-fetch /
cell-read tool** on the connector surface. Enforcement is *structural at the
connector surface* — the connector never registers a row/cell tool — verified by
a reusable assertion added to the SDK contract-test harness
(`@nimbus-dev/sdk` `runContractTests`). **Not** a runtime Gateway invariant
(`I17`): there is nothing to block at runtime if the tool was never registered.
A future connector that genuinely needs a live-gated row tool is a discrete I17
design discussion, out of scope here. (Review Q1.)

### Tier 4 — Email (distinct IMAP/SMTP/JMAP infra)

Generic IMAP‡ → Fastmail (JMAP) → ProtonMail (Bridge).

### Tier 5 — Local / no-network

Local DB schema indexing → Local data profiling (filesystem v2) → Storybook.

### Tier 6 — Marketplace feature (not a connector)

Community ratings & reviews.

### Tier 7 — Wave B stretch (explicitly non-gating for Phase 5)

Codemagic, Microsoft App Center, Firebase App Distribution, TestFlight,
Chromatic, LogRocket / FullStory / Datadog RUM, web-vitals watcher.

‡ = named in Phase 5's acceptance criteria; pulled slightly forward within its tier.

## Per-tier special considerations

- **Tier 1** is the lowest-risk path — identical to Wiz/Snyk. No new infra.
- **Tier 2 (OAuth)** needs the generic OAuth connector-auth flow exercised once
  (the gateway already has per-service OAuth vault keys + Google/Microsoft flows;
  new providers register an OAuth app and reuse `oauth-vault-tokens.ts`). The
  first OAuth connector (HubSpot) doubles as the infra-proving PR; subsequent
  Tier-2 connectors reuse it. **Refresh scaling (Review Q3):** no structural
  change to `oauth-vault-tokens.ts` is planned. Token refresh is per-service on a
  staggered sync cadence and `getValidVaultOAuthAccessToken()` already caches +
  refreshes on expiry only; a user enables a handful of connectors, not all 45 at
  once. HubSpot is the checkpoint to *measure* refresh behaviour; refresh jitter /
  a refresh scheduler is added only if telemetry later shows a real refresh storm.
- **Tier 3 (no-row-data)** introduces a reusable contract-test assertion that the
  MCP surface exposes only schema/metadata tools — no row sampling. This is a
  hard Phase 5 acceptance criterion. Structural (connector-surface) enforcement,
  not a runtime invariant — see the Tier 3 sequencing note above.
- **Tier 4 (email)** is a distinct connector class (IMAP/SMTP/JMAP, not REST);
  `email.send` is HITL-gated via SMTP. Generic IMAP proves the class.
  **Attachments (Review Q2):** Phase 5 indexes headers + body-text preview +
  attachment *metadata* only (filename, size, mimetype). Attachment **bytes are
  never downloaded or parsed** — that is a separate, sandbox-reviewed follow-up,
  out of scope here.
- **Tier 5 (local)** connectors make no outbound call; discovery is via
  `[[filesystem.roots]]` (mirrors the Obsidian / OpenAPI-indexer pattern).
  **Local DB schema indexing (Review S3):** reads *saved queries + schema
  documentation* from local DB-tool config dirs (pgAdmin / DBeaver / DataGrip) as
  on-disk files, parsed in pure TypeScript. **No local binary execution
  (`psql` / `sqlite3`) and no live database connection.** Live schema
  introspection (drivers + credentials) is a deferred follow-up, out of scope
  here.
- **Tier 6** is a Marketplace/registry + UI feature, not a connector — its own
  design entirely.

## Acceptance

- Each connector satisfies the `nimbus-connector-authoring` checklist and the
  relevant Phase 5 acceptance criteria in `docs/roadmap.md`.
- Phase 5 is considered **complete** when Tiers 0–6 land. Tier 7 (Wave B) is
  explicitly non-gating.
- Every connector PR passes `bun run test:ci` parity before it is opened.

## Review disposition (2026-05-24)

From `2026-05-24-phase-5-connector-buildout-program-design-review.md`:

| # | Item | Disposition |
|---|---|---|
| Q1 | Tier 3 no-row-data: static vs runtime `I17` | **Defer I17 / Fixed in spec** — structural connector-surface enforcement via a reusable SDK contract assertion; no runtime invariant. |
| Q2 | Tier 4 email attachments | **Defer content / Fixed in spec** — headers + body-text preview + attachment metadata only; never download/parse attachment bytes. |
| Q3 | OAuth vault/refresh scaling | **Defer structural change / Fixed in spec** — no `oauth-vault-tokens.ts` change now; measure at HubSpot; add jitter only if a refresh storm is observed. |
| S1 | Batch highly-similar connectors | **Partial** — default one PR/connector; roadmap-bundled checkboxes ship as one PR; opt-in pair-batching pending user standing preference. |
| S2 | Test error/429 handling per connector | **Fixed in spec** — error/rate-limit path is now a mandatory per-connector integration-test requirement. |
| S3 | Tier 5 local DB binaries vs TS drivers | **Fixed in spec** — pure-TS read of saved queries/schema docs; no binary exec, no live connection; live introspection deferred. |

## Decision log

- **2026-05-24** — Cadence: per-connector design approval before build; one PR
  per connector (user choice).
- **2026-05-24** — Order: tiered easiest-template-first (Tier 1) → OAuth (Tier 2)
  → no-row-data warehouse (Tier 3) → email (Tier 4) → local (Tier 5) →
  Marketplace ratings (Tier 6) → Wave B stretch (Tier 7), approved by user.
- **2026-05-24** — Review dispositions Q1–Q3, S2–S3 folded into the spec.
- **2026-05-24** — S1 resolved: opt-in pair-batching allowed (user choice).
  Default remains one PR per connector; near-identical pairs may be batched on a
  per-case basis at design-approval time.
