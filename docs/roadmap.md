# Nimbus Roadmap

This document is the authoritative roadmap for Nimbus. [`README.md`](./README.md) carries a summary; this file contains acceptance criteria, inter-phase dependencies, and the reasoning behind sequencing decisions.

Phases are thematic, not calendar-bound. A phase begins when its dependencies are met and ends when its acceptance criteria pass — not at a quarter boundary. Phases may overlap when deliverables are independent.

> **Last updated:** 2026-05-24 — added **Phase 16 (The Platform Layer)** and **Phase 17 (The On-Call Copilot)**, plus a near-term **First-Run & Time-to-Wow** initiative (including `nimbus demo`), the cross-phase **North-Star Capabilities** (M1–M6 + connective tissue), and the **killer-demo** milestone. Phase 5 (The Extended Surface) remains active. The full dated delivery log (every PR, with dates) lives in [`docs/CHANGELOG.md`](./CHANGELOG.md); this document carries the forward-looking acceptance criteria and per-phase Shipped summaries. Phase 5 core sequencing (locked in the T1 sequencing spec): T1 → T3 → Wave A → T4 → T6 → T2 → Wave B. The 2026-05-10 reorganisation inserted Phases 7 (Engineering Excellence), 8 (Security Engineering), and 9 (AI Engineering Loop) before the Autonomous Agent and added Phase 14 (Agent Evolution / AI v2) and Phase 15 (Cross-Organizational Federation) — see [§ How to Update This Document](#how-to-update-this-document).

---

## Contents

- [Guiding Principles](#guiding-principles)
- [Commercial Roadmap](#commercial-roadmap)
- [Status Overview](#status-overview)
- [Shipped](#shipped) — Phases 1, 2, 3, 3.5, 4
- [Active](#active) — Phase 5
- [Planned](#planned) — Phases 6 through 17, plus near-term & cross-phase initiatives
- [How to Update This Document](#how-to-update-this-document)

---

## Guiding Principles

Every roadmap decision is evaluated against the project's non-negotiables:

1. **Local-first** — machine is the source of truth; cloud is a connector
2. **HITL is structural** — consent gate is in the executor, not the prompt; cannot be bypassed or reasoned around
3. **No plaintext credentials** — Vault only; never in logs, IPC, or config
4. **MCP as connector standard** — the Engine never calls cloud APIs directly
5. **Platform equality** — Windows, macOS, and Linux are equally supported in every phase
6. **No feature creep across phases** — do not implement Phase N+1 features while Phase N is active
7. **Built for professionals** — every feature is evaluated through the lens of an on-call engineer, platform engineer, or security practitioner running systems in production; consumer-oriented affordances are out of scope

## Commercial Roadmap

Nimbus is open source (AGPL-3.0) for individual engineers. Commercial tiers fund continued development:

| Tier | Phase | Key additions |
|---|---|---|
| **Open Source** | Now | Full single-user Gateway, all connectors, CLI, local LLM, VS Code extension |
| **Team** | Phase 6 | Team Vault, shared index namespaces, LAN federation, multi-user HITL, SSO/OIDC |
| **Enterprise** | Phase 12 | SCIM provisioning, audit log shipping (SIEM), Helm/Docker, compliance tooling, SLA support |

Commercial license also available now for organizations that need to embed Nimbus in a product or require compliance guarantees before Phase 12 ships — contact the maintainers.

---

## Status Overview

| Phase | Theme | Status |
|---|---|---|
| Phase 1 | Foundation | ✅ Complete |
| Phase 2 | The Bridge | ✅ Complete |
| Phase 3 | Intelligence | ✅ Complete |
| Phase 3.5 | Observability & Developer Experience | ✅ Complete |
| Phase 4 | Presence | ✅ Complete |
| Phase 5 | The Extended Surface | 🔵 Active — T3 ✅ · Wave A ✅ · T4 ✅ · T6 ✅ · T2 ✅ · Wave B (partial) · Tier-2 (partial) |
| Phase 6 | Team | Planned |
| Phase 7 | Engineering Excellence | Planned |
| Phase 8 | Security Engineering | Planned |
| Phase 9 | AI Engineering Loop | Planned |
| Phase 10 | The Autonomous Agent | Planned |
| Phase 11 | Sovereign Mesh | Planned |
| Phase 12 | Enterprise | Planned |
| Phase 13 | Desktop Distribution | Planned |
| Phase 14 | Agent Evolution / AI v2 | Planned |
| Phase 15 | Cross-Organizational Federation | Planned |
| Phase 16 | The Platform Layer | Planned |
| Phase 17 | The On-Call Copilot | Planned |

---

## Shipped

### Phase 1 — Foundation ✅

**Goal:** Make the Gateway real and the security model provable.

#### Delivered

- [x] Bun workspace monorepo with root `package.json` and `bunfig.toml`
- [x] CI: `pr-quality` job on PRs (Ubuntu); 3-platform matrix on push to `main`/`develop`
- [x] Nimbus Gateway process — JSON-RPC 2.0 IPC over domain socket (macOS/Linux) / named pipe (Windows)
- [x] Platform Abstraction Layer — `PlatformServices` interface + `win32`, `darwin`, `linux` implementations
- [x] Secure Vault — Windows DPAPI, macOS Keychain, Linux libsecret; `NimbusVault` interface
- [x] Local Filesystem MCP connector + SQLite metadata schema
- [x] HITL executor — `HITL_REQUIRED` frozen set; consent gate is structural, not prompt-based; audit log written before action
- [x] `nimbus` CLI: `start`, `stop`, `status`, `ask`, `search`, `vault`
- [x] Unit + integration test suite; coverage gates: Engine ≥85%, Vault ≥90%
- [x] `bun audit` + `trivy` + CodeQL security scanning in CI

#### Acceptance Criteria (all met)

- `nimbus ask "find all markdown files modified this week"` executes end-to-end on Windows, macOS, and Linux
- Any destructive follow-up action triggers the HITL consent prompt before any tool call is dispatched
- Gateway cold-start time is under 100ms on all three platforms
- No credential value appears in IPC responses, logs, or stdout under any code path

---

### Phase 2 — The Bridge ✅

**Goal:** Connect every surface a developer works across — cloud storage, email, source control, communication, project tracking, and knowledge management — and unify them in the local index.

#### Delivered

##### First-party MCP connectors (all with delta sync + index population)

- [x] **Google Drive** — file list, metadata, search; OAuth PKCE; `Changes` API delta; write (create/trash/move/rename) behind HITL
- [x] **Gmail** — message list, thread read, label list, draft create/send; OAuth PKCE
- [x] **Google Photos** — album list, media item metadata (not binary download); OAuth PKCE
- [x] **OneDrive** — files, folders, delete/move behind HITL; Microsoft Graph `delta` endpoint
- [x] **Outlook** — mail, calendar events, contacts; scope-gated tools (`tool-scope-policy.ts`); mail delta sync
- [x] **Microsoft Teams** — chats, channels, messages; post message behind HITL
- [x] **GitHub** — repos, PRs (open/closed/merged), issues, CI check runs; PAT auth
- [x] **GitLab** — projects, merge requests, issues, pipelines; PAT auth; self-hosted `gitlab.api_base` support
- [x] **Bitbucket** — repos, pull requests, pipelines; app-password auth
- [x] **Slack** — channels, DMs, threads, search; OAuth user token; post message/DM behind HITL
- [x] **Linear** — issues, projects, cycles, initiatives, members; API key; write behind HITL
- [x] **Jira** — issues, sprints, boards, epics, comments; API token; write behind HITL
- [x] **Notion** — pages, databases, database rows, comments; OAuth; write behind HITL
- [x] **Confluence** — spaces, pages, blog posts, inline comments; API token; write behind HITL
- [x] **Discord** (opt-in, off by default) — servers, channels, threads; bot token; read-only index

##### Infrastructure

- [x] OAuth PKCE utility — `portRange` config, `--port`/`--scopes` CLI flags, no-secret desktop PKCE; token written to Vault only
- [x] Per-provider rate limiter — token bucket per provider; `[sync.quotas]` config; `penalise()` on 429
- [x] Delta sync scheduler — `maxConcurrentSyncs` semaphore, `hasMore` immediate re-queue, `retentionDays` weekly prune, `catchUpOnRestart` config
- [x] Unified `item` schema (schema v5) — FTS5, `canonical_url` dedup with `duplicates` field, `pinned` column, `sync_state`, `sync_telemetry` tables
- [x] `person` table (schema v5) — GitHub, GitLab, Slack, Linear, Jira, Notion, Bitbucket, Microsoft, Discord handles
- [x] Cross-service people linker — Slack handle → GitHub login → Linear member → email resolves without a network call; `nimbus people` CLI + `people.*` IPC
- [x] Formal migration runner — `_schema_migrations` ledger, numbered append-only migrations, single-transaction per step
- [x] Lazy connector mesh — idle shutdown after 5 min; `registry.ensureRunning()` before dispatch; Google/Microsoft bundles
- [x] `nimbus connector` CLI: `auth`, `list`, `sync`, `pause`, `resume`, `status`, `remove`, `set-interval`
- [x] Engine context ranker + `searchLocalIndex`, `fetchMoreIndexResults`, `resolvePerson` agent tools
- [x] E2E test scenarios: cross-service query, identity resolution, HITL write ops, MCP connector contract
- [x] Security hardening: PKCE failure paths, OAuth vault scopes, audit payload safety, connector remove resilience
- [x] Coverage gates met: Engine ≥85%, Vault ≥90%, Sync scheduler ≥80%, Rate limiter ≥85%, People graph ≥80%
- [x] Linux headless installers (`.deb` + `.tar.gz`); Windows NSIS + macOS pkg sources

#### Acceptance Criteria (all met)

- `nimbus ask "find everything I've touched across Drive, GitHub, Slack, and Linear this sprint"` returns merged, ranked results in under 200ms from the local index
- `nimbus ask "who is the most active reviewer on the payment-service repo and what are they working on in Linear?"` resolves the cross-service identity link without a network call
- Revoking a connector's auth (`nimbus connector remove google`) deletes all associated Vault entries and index rows atomically; no orphaned credentials
- All write operations through Slack, Linear, Jira, Notion, Confluence connectors trigger HITL before any outbound call

#### Deferred from Phase 2 (by design)

| Topic | Resolved in |
|---|---|
| Full document content extraction (PDF/DOCX body text in FTS5) | Phase 3 — embedding pipeline + Filesystem connector v2 |
| Generic user-defined MCP connector (`nimbus connector add --mcp`) | Phase 3 — Extension Registry v1 (adds sandboxing + manifest verification) |
| Vault credential portability between machines | Phase 4 — `nimbus data export/import` |
| SQLite encryption at rest (SQLCipher) | Phase 4 — opt-in AES-256 via SQLCipher; key in OS Vault; `[db.encrypt] = true`; see Data Sovereignty section |
| Per-connector OAuth vault keys vs shared family key (`google.oauth`, `microsoft.oauth`) | Phase 3/4 consideration — shared key kept for simplicity; revisit if scope-collision UX proves painful |

---

### Phase 3 — Intelligence ✅

**Goal:** Make Nimbus semantically aware and proactively useful. Extend into CI/CD, cloud infrastructure, observability MCPs, workflows, watchers, extensions, and specialized agents.

**Status:** **Complete** on `main` (closed 2026-04). This section is the authoritative post-closure summary (the long-form Phase 3 plan doc was retired when the phase closed). **Phase 3.5** owns observability, conversational E2E harnesses, and remaining polish.

#### Dependencies (met)

- Phase 2 unified metadata index
- Extension SDK + Registry v1 for safe third-party MCP / `nimbus connector add --mcp`

#### Delivered

##### Semantic layer

- [x] **Embedding pipeline** — Bun worker; `@xenova/transformers` local default; `sqlite-vec` (`vec_items_384`); OpenAI opt-in; provider/model switch + resumable backfill; `MINIMUM_MODEL_VERSION` in `embedding/model.ts`
- [x] **Hybrid search** — BM25 + vector RRF; chunk dedupe / parent chunk context where implemented; `nimbus search --semantic`; quality gate: `packages/gateway/test/benchmark/search-quality.test.ts`
- [x] **RAG session memory** — per-session embedded chunks; IPC `session.*`; hourly prune; isolation tests in `session-memory-store.test.ts`

##### Extension ecosystem

- [x] **Extension Registry v1** — `nimbus.extension.json`; manifest **and** entry-point SHA-256 on startup; scaffold + install/list/enable/disable/remove; tarball / URL / local path; see `docs/contributors/extension-author-walkthrough.md`
- [ ] **Extension sandbox hardening** — full syscall/network isolation → **Phase 5** (process + scoped env today)
- [ ] **Extension Marketplace** — **Phase 4** (Tauri)

##### CI/CD and infrastructure MCP connectors

- [x] Jenkins, GitHub Actions, CircleCI, GitLab CI (pipelines/jobs + HITL)
- [x] AWS, Azure, GCP (CLI-backed tools + sync + HITL mutations)
- [x] **IaC** — Terraform / CloudFormation / Pulumi via MCP; sync heartbeat + **drift hints** (`nimbus status --drift`, `gateway.ping` `includeDrift`) — not full Terraform-state vs live reconciliation (later phase)
- [x] Kubernetes, Datadog, Grafana, Sentry, PagerDuty, New Relic

##### Automation and graph

- [x] **Workflows** — `workflow-runner` / store; `nimbus workflow`; script files `nimbus run`; dry-run / `--no-ttv` HITL safety
- [x] **Watchers** — post-sync evaluation; rate limiting + cycle detection; cron gating; startup catch-up; unit coverage in `watcher-engine.test.ts` / `watcher-store.test.ts`
- [x] **Relationship graph** — `graph_entity` / `graph_relation`; `traverseGraph`; indexed incident correlation substrate: `packages/gateway/test/e2e/scenarios/incident-correlation-indexed.e2e.test.ts`
- [x] **Filesystem intelligence (v2 scope shipped)** — `[[filesystem.roots]]`, `code_symbol`, git/deps metadata; semantic recall via shared embedding + hybrid search. Deeper vision (blame UX, multi-manifest parsers, etc.) → later phases

##### Agents and CLI

- [x] **DevOps** and **Research** agents — domain-tuned prompts and tool scoping in Gateway engine
- [x] **Session CLI** — TTY REPL (`nimbus` no args); headless bundle defaults to bundled MiniLM (`scripts/package-headless-bundle.ts`)

##### Security and quality

- [x] **Phase 3 HITL action ids** in `packages/gateway/src/engine/executor.ts` — exercised by `packages/gateway/test/e2e/scenarios/hitl-write-ops.test.ts`
- [x] **Coverage gates** — embedding ≥80%, workflow ≥80%, watcher ≥80%, extensions ≥85% (see root `package.json` + `.github/workflows/_test-suite.yml`)
- [x] **Three-platform CI** — push matrix in `.github/workflows/ci.yml`

#### Intentionally incomplete (follow-ups)

| Topic | Where it lands |
|---|---|
| Full IaC drift (Terraform state vs live resource diff) | Later phase; hints only in Phase 3 |
| Proactive anomaly **user** notify (beyond log stub) | Phase 3.5+ |
| Deterministic TTY E2E for `nimbus ask` / anaphoric session turns | Phase 3.5 |
| Extension syscall sandbox | Phase 5 |

#### Acceptance criteria (all met for Phase 3 closure)

- **Indexed** cross-service incident correlation (PagerDuty, GitHub PR, Jenkins, Slack, AWS-style alert) via search + graph — `incident-correlation-indexed.e2e.test.ts`; conversational `nimbus ask` on same data = manual smoke
- Contributor path documented — `docs/contributors/extension-author-walkthrough.md`
- Watcher fires within a sync cycle; downtime catch-up on restart — covered by watcher engine/store tests and gateway E2E where applicable
- `terraform plan` → HITL → `apply` — mock Terraform in `packages/mcp-connectors/iac/terraform-mock.integration.test.ts`
- `bun audit --audit-level high` clean for Phase 3 packages; `sqlite-vec` on all CI OS runners

---

### Phase 3.5 — Observability & Developer Experience ✅

**Goal:** Make Nimbus debuggable, composable, and trustworthy before the public `v0.1.0` release. Connectors, workflows, and the index are only as useful as your ability to see what they're doing, query them programmatically, and recover when things go wrong.

**Sequencing rationale:** Phase 3 delivers a large surface area of connectors and agentic capability. Phase 3.5 ensures that surface area is observable, configurable, and robust before it ships publicly. **Phase 3.5 remains a release prerequisite** — Phase 4 does not begin until the consolidated acceptance criteria in `docs/phase-3.5-plan.md` are verified on Windows, macOS, and Linux.

> **Status (2026-04-15):** Phase 3.5 is **✅ Complete**. All acceptance criteria have been verified on Windows, macOS, and Linux. `@nimbus-dev/client` is published to npm. The Starlight docs site is live. Phase 4 (Presence) is now active.

#### Dependencies

- Phase 3 connector mesh and watcher system (health model builds on them)
- Phase 3 Extension Registry v1 (extension testing infrastructure builds on the SDK)

#### Delivered on `main` (high level)

**Self-observability**

- [x] **`nimbus diag`** — snapshot over IPC; `--json`; `slow-queries` subcommand (`packages/cli/src/commands/diag.ts`, `packages/gateway/src/ipc/diagnostics-rpc.ts`)
- [x] **Metrics in diagnostics / status** — `diag.snapshot` carries index metrics (including query latency percentiles); `nimbus status --verbose` prints per-service item counts, total items, **p95** query latency, and per-connector health lines (`packages/cli/src/commands/status.ts`)
- [x] **Prometheus-compatible metrics endpoint** — localhost-only, off by default (`packages/gateway/src/ipc/metrics-server.ts`)
- [x] **Slow query logging** — ring buffer + SQLite persistence; surfaced via `nimbus diag slow-queries` (`packages/gateway/src/db/latency-ring-buffer.ts`, related DB tables)

**Connector health**

- [x] **Explicit health states** — persisted in `sync_state` (`healthy`, `degraded`, `error`, `rate_limited`, `unauthenticated`, `paused`); surfaced in IPC and **`nimbus connector list`** (`packages/gateway/src/connectors/health.ts`, CLI table)
- [x] **429 → `rate_limited`** — connectors throw `RateLimitError`; scheduler skips dispatch until retry window (`packages/gateway/src/sync/scheduler.ts`)
- [x] **Health history** — SQLite history + **`nimbus connector history <name>`** (`packages/gateway/src/connectors/health.ts`, `packages/cli/src/commands/connector.ts`)
- [x] **401/403 → `unauthenticated` + notification UX** — typed `UnauthenticatedError` from connectors; scheduler calls `transitionHealth` + one-shot CLI notification on auth loss (`packages/gateway/src/sync/scheduler.ts`); per-connector throws vary by connector implementation
- [x] **Agent caveat strings** — scoped `searchLocalIndex` / `fetchMoreIndexResults` attach **`connectorHealthCaveat`** when the `service` filter targets a non-healthy connector; unscoped `searchLocalIndex` may attach **`connectorHealthCaveats`** (capped list) for services present in the returned context window (`packages/gateway/src/engine/connector-health-caveat.ts`)

**Data layer**

- [x] **`nimbus query`** — structured filters, `--since` / `--until`, `--sql` read-only guard, `--json` / `--pretty` (`packages/cli/src/commands/query.ts`)
- [x] **Read-only local HTTP API** — `nimbus serve`; `GET /v1/items`, `/v1/items/:id`, `/v1/people`, `/v1/people/:id`, `/v1/connectors`, `/v1/audit`, `/v1/health` (`packages/gateway/src/ipc/http-server.ts`); item list filters share SQL with IPC via `packages/gateway/src/index/item-list-query.ts`
- [x] **`@nimbus-dev/client`** — typed IPC wrapper + `MockClient` (`packages/client/`); publish automation on tag `client-v*` (`.github/workflows/publish-client.yml`)
- [x] **Dual CJS + ESM publish shape** — `dist/index.js` (tsc ESM) + `dist/index.cjs` (bundled `require`); `exports` exposes both *[ ] first npm publish — manual sign-off (`client-v*` tag + `NPM_TOKEN`)*

**Configuration**

- [x] **`nimbus config`** — `get` / `set` / `list` / `validate` / `edit` (`packages/cli/src/commands/config.ts`); telemetry keys show file vs env where wired
- [x] **`nimbus profile`** — create / list / switch / delete (`packages/cli/src/commands/profile.ts`); Gateway profile support (`packages/gateway/src/config/profiles.ts`)
- [x] **`nimbus config list` env legend** — table lists `[telemetry]` keys with env sources; footer documents additional `NIMBUS_*` overrides (Gateway `config.ts` / `assemble.ts`)

**Data integrity & recovery**

- [x] **`nimbus db verify` / `repair` / snapshot / restore / prune / backups list** — CLI + gateway `packages/gateway/src/db/*`
- [x] **Pre-migration backups + rollback tests** — backups under `<dataDir>/backups`; migration failure rollback covered in `packages/gateway/test/unit/db/migration-rollback.test.ts` (and FTS5 mismatch coverage in `verify.test.ts`)

**Telemetry**

- [x] **Opt-in pipeline** — `[telemetry]` TOML + env overrides, payload safety gate, `nimbus telemetry show` / `disable`, flush scheduler POST to configured endpoint (`packages/gateway/src/config/telemetry-toml.ts`, `packages/gateway/src/telemetry/*`, `packages/cli/src/commands/telemetry.ts`)
- [x] **Telemetry catalog (aggregate-only)** — flush + `telemetry.preview` include `connector_error_rate`, `sync_duration_p50_ms` (7d window), `connector_health_transitions`, `extension_installs_by_id`, `cold_start_ms` (Gateway assembly), plus latency percentiles; agent invocation histograms remain `0` until instrumented

**Documentation & extension testing**

- [x] **Starlight docs package** — `packages/docs/`; `bun run docs:build`; Pagefind search at build time; **internal links validated** on production build (`starlight-links-validator@0.23.0`, Astro 6 per Starlight peer range)
- [x] **`nimbus test` + `runContractTests`** — CLI runs manifest contract from `@nimbus-dev/sdk` before optional `bun test` (`packages/cli/src/commands/test.ts`, `packages/sdk/src/contract-tests.ts`)
- [x] **Docs hub (Phase 3.5 scope)** — Starlight site with getting started, connectors overview, query/HTTP, telemetry, client, architecture overview, FAQ, unreleased banner on home; deep per-connector pages → Phase 5+ content cadence
- [x] **Extension CI template (copy-paste)** — `docs/templates/nimbus-extension-ci.yml`; referenced from `docs/contributors/extension-author-walkthrough.md`

**Onboarding**

- [x] **`nimbus doctor`** — Bun minimum, Linux `secret-tool`, Gateway IPC + `config.validate`, `diag.snapshot` index total + per-connector health table; exit `0` / `1` / `2` for ok / warnings / hard failures (`packages/cli/src/commands/doctor.ts`)
- [x] **First-run / empty index guidance** — `nimbus start` prints next-step hints once (TTY, skip with `--no-wizard`); `nimbus ask` exits early with no connectors; Gateway `runAsk` returns onboarding text when the index has zero items

#### Acceptance (all criteria met)

- [x] **`nimbus query` latency harness** — p95 < 500ms on 8k-row index; strict mode (`< 100ms`) gated by `NIMBUS_RUN_QUERY_BENCH=1`
- [x] **`bun audit --audit-level high` clean** — workspace audit passes at HIGH threshold
- [x] **`@nimbus-dev/client` published to npm** — `client-v*` tag + `NPM_TOKEN` workflow verified
- [x] **Docs editorial sign-off** — Starlight hub live; “getting started in under 10 minutes” verified on all three platforms

---

### Phase 4 — Presence ✅

**Goal:** Give Nimbus a face, a local AI backbone that requires no cloud API key, and the trust foundations needed for a public `v0.1.0` release.

> **Release gate:** `v0.1.0` ships only the headless gateway + CLI binaries and the VS Code extension. The Tauri desktop UI release vehicle (signed installers, build-ui matrix, Gatekeeper / SmartScreen handling) was moved out of `v0.1.0` and into Phase 13 — see [§ Phase 13 → Desktop Release Vehicle](#desktop-release-vehicle). The desktop UI code itself is complete in this phase; what slipped is publishing it as a release artifact.
>
> The end-to-end manual smoke checklist for headless releases lives at [`docs/release/manual-smoke-headless.md`](./release/manual-smoke-headless.md) and covers TUI + VS Code only. The Tauri-only checklist for the future `desktop-v0.1.0` tag lives at [`docs/release/manual-smoke-desktop.md`](./release/manual-smoke-desktop.md).

#### Dependencies

- **Phase 3.5 complete** — all Phase 3.5 acceptance criteria must pass before Phase 4 begins; the docs site, onboarding, and data integrity work are release prerequisites
- Phase 3 Extension Registry v1 (Marketplace panel depends on it)
- Phase 3 Watcher system (Watcher management UI depends on it)
- Phase 3 Workflow pipelines (pipeline editor depends on it)
- Phase 3.5 `@nimbus-dev/client` (VS Code extension depends on it)
- Phase 3.5 configuration profiles (Settings panel profile switcher depends on it)
- Code signing certificates provisioned before release build step

#### Desktop Application (Tauri 2.0)

> **Code complete; release vehicle deferred to Phase 13.** Every WS5 item below is implemented and tested in-tree, but publishing signed Tauri installers as release artifacts moved out of the `v0.1.0` release gate and into Phase 13 — see [§ Phase 13 → Desktop Release Vehicle](#desktop-release-vehicle). The Tauri smoke checklist no longer gates `v0.1.0`; it gates the future `desktop-v0.1.0` tag.

- [x] **App shell foundation (WS5-A)** — React 19 + Tailwind v4 + Radix + Zustand v5 + React Router v7 scaffolding; Rust Tauri 2.0 bridge with compile-time `ALLOWED_METHODS` allowlist (6 methods); system tray + `Ctrl/Cmd+Shift+N` Quick Query popup (frameless, 560×220, auto-close after stream); three-step onboarding wizard (Welcome → Connect → Syncing); first-run routing; macOS accessory mode; CI unit coverage gate (≥80% lines / ≥75% branches)
- [x] **System tray enhancements (WS5-B)** — aggregate-health icon (green → amber → red); pending-HITL badge; "Connectors ▸" submenu populated from `set_connectors_menu`; click navigates to Dashboard and flashes the matching tile
- [x] **Dashboard (WS5-B)** — `IndexMetricsStrip` (items · embeddings · p95 · size), `ConnectorGrid` with live `connector://health-changed` patches + empty state, `AuditFeed` (last 25); `useIpcQuery` polling hook pauses on hidden / disconnected
- [x] **HITL consent dialogs (WS5-B)** — dedicated frameless 480×360 always-on-top popup at `#/hitl-popup`; `StructuredPreview` renders details XSS-safely; destructive-action deny-list suppresses Approve `autoFocus`; Rust `pending_hitl` inbox + `consent://request`/`consent://resolved` classifier; diff view for file/code changes and optional edit-before-approve deferred to a later sub-project
- [x] **Settings Shell (WS5-C)** — Profiles, Telemetry, Connectors, Model, Audit, Updates, and Data panels (including Export/Import/Delete wizards); per-service OAuth vault keys; re-attaches to in-flight pulls
- [x] **Extension Marketplace panel (WS5-D)** — list, install-from-directory, enable/disable, remove; v0.1.0 MVP
- [x] **Watcher management UI (WS5-D)** — create, pause, delete; graph-aware condition builder; history-of-fires drawer
- [x] **Workflow pipeline editor (WS5-D)** — step list editor, run, dry-run toggle, delete; run history drawer with audit deep-link + "Run with params…" override

##### WS5 Sub-project B acceptance

- Dashboard (metrics + connectors + audit) renders within 2 s against a populated Gateway.
- HITL popup opens within 1 s of `consent.request`; Approve / Reject → `consent.respond`.
- Tray icon reflects aggregate health (green → amber → red) via `tray://state-changed` events.
- Tray badge matches pending HITL count.
- `ALLOWED_METHODS` grew by exactly four read-side methods; no `vault.*` or `db.*` writes.
- `packages/ui` coverage ≥ 80 % lines / ≥ 75 % branches.

#### Local LLM & Multi-Agent

- [x] **Local LLM support** — Ollama integration (model discovery, pull, load, unload via Gateway IPC); llama.cpp fallback (GGUF model files, no Ollama required); per-task model routing (fast local model for classification; remote for multi-step reasoning; configurable); fully air-gapped operation when a local model is loaded
- [x] **Multi-agent orchestration** — coordinator agent decomposes complex tasks into independent sub-tasks; sub-agents run in parallel in isolated tool scopes; all sub-agent write operations remain HITL-gated; coordinator cannot approve on behalf of the user *(loop-guard config stubs in place: `NIMBUS_MAX_AGENT_DEPTH` default 3, `NIMBUS_MAX_TOOL_CALLS_PER_SESSION` default 20; `agent.gasLimitReached` notification reserved)*

#### Built-in Agent Workflows

First-party demonstrations of multi-agent orchestration. **Deferred to the v0.1.1 batch** — see the table later in this section. The Phase 4 multi-agent infrastructure ships without first-party agents; the agents themselves slip out of `v0.1.0` to keep the release scope tight.

#### VS Code Extension

- [x] **VS Code extension** — `@nimbus-dev/client`-based IPC client (Node.js/TypeScript, separate from the Bun Gateway); connects to the running Gateway over domain socket / named pipe using the existing JSON-RPC 2.0 protocol; no new Gateway APIs required
  - Commands palette: `Nimbus: Ask`, `Nimbus: Search`, `Nimbus: Run Workflow`
  - Inline HITL consent UI — approval/rejection as a VS Code notification with structured diff preview
  - Status bar item: Gateway health + active profile name
  - Compatible with VS Code-fork hosts: Cursor, Windsurf, VSCodium, Gitpod
  - Published to Open VSX Registry and VS Code Marketplace
  - `packages/vscode-extension` workspace package; depends on `@nimbus-dev/client` only; never imports Gateway source

#### Editor AI Context (MCP Native)

- [ ] **Native Cursor / Claude Code / Copilot context exposure** — expose the Nimbus local index as an MCP server endpoint that AI coding assistants can connect to directly. Cursor, Claude Code, and any MCP-compatible editor AI can then query the Nimbus index as a tool during code generation — giving the assistant access to incident history, deployment state, open PRs, and connector health without the user switching context. Implementation: the Gateway's existing JSON-RPC IPC surface is wrapped as an MCP stdio server via a thin adapter (`packages/gateway/src/ipc/mcp-adapter.ts`); read-only tools only (`searchIndex`, `getConnectorStatus`, `getRecentIncidents`, `getOpenPRs`); no write tools exposed; no HITL surface required. Configured via `nimbus mcp-server` CLI command which prints the MCP server config block the user pastes into their editor's `mcp.json`. This is not a new protocol — Nimbus is already MCP-native; this just inverts the client/server relationship for the local index.

#### Terminal Power Users

- [x] **Rich TUI** (Ink-based) `v0.1.0` — builds on the Phase 3 Session CLI; pane layout: query input, result stream, connector health sidebar, active watcher list; keyboard navigation; SSH-safe; real-time inline HITL consent; `nimbus tui` command; also launchable from system tray

#### Voice Interface

- [x] **Local STT** — `whisper-cli` subprocess called by the Gateway voice service; model: `whisper-base.en` (default) / user-selectable via config; audio never leaves the machine
- [x] **Voice queries** — `voice.transcribe` + `voice.speak` IPC methods; TTS via `NativeTtsProvider` (`say` on macOS, PowerShell SAPI on Windows, `espeak-ng`/`spd-say` on Linux)
- [x] **Wake word** (opt-in, disabled by default) — background loop in Gateway voice service; `voice.startWakeWord` / `voice.stopWakeWord` IPC

#### Data Sovereignty

- [x] **Full export** — `nimbus data export --output nimbus-backup.tar.gz`: SQLite snapshot, vault credential manifest (re-encrypted with user passphrase + BIP39 recovery seed), BLAKE3 integrity hashes in manifest; `--no-index` flag to omit SQLite snapshot
- [x] **Full import** — `nimbus data import nimbus-backup.tar.gz`: verifies BLAKE3 hashes, decrypts manifest (passphrase or recovery seed), re-seals credentials into target machine's native Vault, restores index
- [x] **GDPR deletion** — `nimbus data delete --service <name>`: preflight shows counts; `--dry-run` for preview; `--yes` to confirm; removes all `item` rows and Vault entries for a service; writes `data.delete` audit entry
- [x] **Tamper-evident audit log** — each audit log row is BLAKE3-chained to the previous (V18 schema migration); `nimbus audit verify [--full] [--since <id>]` checks integrity incrementally or fully; `nimbus audit export --output <path>` exports chain
- [x] **Data minimization / connector reindex** — `nimbus connector reindex <name> [--depth <metadata_only|summary|full>]`: prunes body/embeddings at `metadata_only`, writes `data.minimization.prune` audit entry
- **[Deferred to v0.1.1.]** SQLite encryption at rest (SQLCipher) — see the v0.1.1 batch table.

#### Automation & Graph Enhancements

These items resolve deferred decisions from Phase 3.

- [x] **Graph-aware watcher conditions** — extend the watcher condition evaluator with `graph.*` condition types (`graph.has_relation`, `graph.path_exists`, `graph.neighbor_count`); uses `traverseGraph` from the Phase 3 relationship graph substrate; enables patterns like "alert when a PR author has no prior reviews" without per-watcher custom traversal code; new condition types are additive and backwards-compatible with existing Phase 3 watcher definitions
  - [x] A.1 — Graph-aware watcher conditions (Phase 4 S2): `owned_by` / `upstream_of` / `downstream_of` logical relations; `[automation].graph_conditions` flag; V22 migration.
- **[Deferred to v0.1.1.]** Workflow branching and conditionals — see the v0.1.1 batch table.
- [x] **Per-connector OAuth vault keys** — per-service keys implemented: `google_drive.oauth`, `google_gmail.oauth`, `google_photos.oauth` for Google; `onedrive.oauth`, `outlook.oauth`, `teams.oauth` for Microsoft; `nimbus connector auth` writes per-service key on each PKCE flow; Microsoft keys back-filled from `microsoft.oauth` on Gateway startup; legacy shared keys kept as fallback for Google until each service re-auths; eliminates scope-collision between Google connectors

#### Remote Access

- [x] **Optional encrypted LAN remote access** — E2E encrypted (NaCl box via tweetnacl), no relay server; paired peers exchange X25519 public keys via a 120-bit base58 pairing code issued during a 5-minute window; read-only by default; write requires explicit `nimbus lan grant-write <peer-id>` on the host; `vault.*`, `updater.*`, `lan.*`, `profile.*` forbidden over LAN regardless of grant; disabled by default (`[lan] enabled = false`); mDNS host discovery deferred to a post-v0.1.0 point release

#### Release Infrastructure

- [x] **Linux GPG-signed binaries + `SHA256SUMS.asc`** — signing scripts + `release.yml` workflow live; `nimbus-verify.{sh,ps1}` helpers cross-check fingerprint; `release` GitHub Environment gates the publish job
- [ ] **macOS Gatekeeper notarization + Windows Authenticode signing** — **explicitly deferred to a later point release (NOT `v0.1.1`)**, gated on a maintainer decision to fund recurring procurement (Apple Developer Program $99/yr + Windows EV cert ~$470–$840/yr). For `v0.1.0`, macOS and Windows binaries ship **unsigned**; the GPG-signed `SHA256SUMS.asc` is the canonical integrity boundary, and one-time bypass is documented in [`install-macos-unsigned.md`](./install-macos-unsigned.md) / [`install-windows-unsigned.md`](./install-windows-unsigned.md). See [`release/signing-keys.md` §"v0.1.0 signing cut-line"](./release/signing-keys.md#v010-signing-cut-line) for the full rationale.
- [x] Auto-update — Ed25519-signed binary manifest (`latest.json`); `Updater` state machine verifies signature before install; `nimbus update --check` / `nimbus update`; Gateway emits `updater.updateAvailable` on startup
- [x] Plugin API v1 — `@nimbus-dev/sdk` frozen at v1.0.0; `AuditLogger`, `HitlRequest`, `runContractTests` stable surface; `CHANGELOG.md` documents breaking-change policy

#### Security audit follow-ups (B1)

Items deferred from the Phase 4 internal security audit (B1, 2026-04-25; summary in [`docs/SECURITY.md`](./SECURITY.md#security-audits)). The High, Medium, and Low PRs (`#112`, `#113`, commit `806453a`) closed all 78 unique findings; these three remain open. S6-F1 (Updater production wiring) shipped in PR #312 — the `Updater` state machine is now instantiated in gateway startup, so `nimbus update --check` and the startup `updater.updateAvailable` notification run against a live state object. Full end-to-end auto-update awaits six follow-ups tracked separately (see below). The two Tauri-specific items (S4-F6, S4-F8) gate the future `desktop-v0.1.0` tag — see [§ Phase 13 → Desktop Release Vehicle](#desktop-release-vehicle).

- [ ] **Tauri-native file picker for `data.import` (S4-F6)** — replace the renderer-supplied `path` string with a Rust-side native dialog so the gateway never trusts a caller-controlled filesystem path; folds into the same UI-rebuild PR as the existing `extension.install` path-validation work (S4-F5 / S7-F7). **Gates `desktop-v0.1.0`, not `v0.1.0`.**
- [ ] **Profile-switch global broadcast refactor (S4-F8)** — Rust-side window-registry refactor so `profile.switched` events fan out through a registered subscriber list instead of walking the live Tauri window list on each notification; same UI-rebuild PR as S4-F6. **Gates `desktop-v0.1.0`, not `v0.1.0`.**
- [x] **Updater production wiring (S6-F1)** (PR #312) — the `Updater` state machine is now instantiated in gateway startup via `packages/gateway/src/updater/factory.ts` and attached to the IPC server via `setUpdater`. `nimbus update --check` and `updater.checkNow` IPC now return live state instead of `ERR_UPDATER_NOT_CONFIGURED`; with `[updater].check_on_startup = true` (default), the gateway emits `updater.updateAvailable` on startup if a newer version is published at the configured manifest URL. Six follow-ups remain before end-to-end auto-update is usable in production:
  - [ ] Publish `latest.json` from `release.yml` so the default manifest URL resolves to a real envelope (today: 404)
  - [ ] Linux `invokeInstaller` — POSIX binary swap + restart helper
  - [ ] macOS + Windows `invokeInstaller` — gated on signing certs (Phase 13 entry)
  - [ ] `recordUpdateEvent` audit-log integration — wire `system.update.{start,verified,installed,failed}` rows
  - [ ] `Updater.getStatus()` to expose cached `CheckNowResult` so a late-connecting client (e.g., Tauri Updates panel) can read the startup-check result without re-fetching
  - [ ] Track the gateway as a `release-please` component so `packages/gateway/package.json` + `packages/gateway/src/version.ts` (`GATEWAY_VERSION` constant) are auto-bumped on release. Today both are hand-edited; the wiring PR collapses two hand-edit sites into one, but the manual step still exists.

##### Polish items from B1 follow-up review

Smaller, lower-risk follow-ups surfaced when the B1 plans were retired. None are gating for `v0.1.0` but each closes a paper-cut a future audit would flag.

- [ ] **Broaden URL-userinfo redaction regex** — the current redactor in updater `lastError` and a couple of log paths matches the canonical `scheme://userinfo@host` form but misses compound schemes like `git+https://` and `svn+ssh://`; switch to `/[a-zA-Z0-9+\-.]+:\/\/[^\s/]+@[^\s/]+/gi` and add fixtures covering git/svn/ssh URLs
- [ ] **`patchPerson` transaction wrapping** — the per-field `dbRun` migration (S5-F5) traded one statement for many; audit callers and wrap the multi-field paths in `db.transaction(() => …)` so a crash mid-update cannot leave a partial row
- [x] **Centralise timing-safe helpers** — extracted the `timingSafeEqual` hex helpers used independently by `updater/`, `extensions/verify-extensions.ts`, and `ipc/lan-pairing.ts` into `packages/gateway/src/util/timing-safe-compare.ts`; also added `constantTimeStringEqual` for bearer tokens (`ipc/http-auth.ts`) and extended the `I10` security-invariants test to assert all four call sites import from the canonical module (Phase 5 T6 PR 1)
- [ ] **Deprecate `connector.startAuth` alias** — annotate with `@deprecated` JSDoc + emit a single warning log per gateway run; remove the alias in Phase 5 once the desktop UI has migrated entirely to `connector.auth`

#### v0.1.1 batch (deferred from v0.1.0)

These items have no external blocker; they slip out of `v0.1.0` to keep the release scope tight, and ship in `v0.1.1` once the listed trigger is met.

| Item | Trigger to ship |
|---|---|
| **SQLite encryption at rest (SQLCipher, opt-in `[db.encrypt]`)** | engineering work only — no external dependency |
| **Workflow branching / conditionals (`if` / `else` / `switch`)** | engineering work only |
| **Built-in `nimbus prep` (Meeting preparation agent)** | WS6 streaming surface (`engine.askStream`) battle-tested in the wild |
| **5 seed community extensions in the registry** | `registry.nimbus-agent.dev` host live |
| **`nimbus oncall` (opinionated on-call brief, no query required)** — auto-identifies the active PagerDuty/OpsGenie incident assigned to the user, then assembles in parallel: last deployment before the alert fired, the triggering PR and commit diff summary, CI run result, Slack threads mentioning the affected service in the last 24 h, and the last time a similar alert fired and how it was resolved. Output is a structured Markdown brief identical in shape to `nimbus prep` but scoped to the active incident. Requires the PagerDuty or OpsGenie connector authenticated. Entirely read-only — no HITL triggered. Trigger: `nimbus oncall` with no arguments; `--service <name>` to override auto-detection. | engineering work only — depends on the Phase 3 PagerDuty connector (already shipped); OpsGenie support folds in once that connector lands |
| **`nimbus tail` (lightweight real-time terminal feed of Gateway operational state)** — not the full Ink TUI; a simple line-by-line stream (respects `NO_COLOR`) showing connector health state changes, watcher fires with payload summary, HITL requests with action type and target, and sync cycle completions with item delta counts. Intended for users who keep a terminal pane open during incidents. Exits on Ctrl+C. No Gateway API changes required — subscribes to existing IPC notifications. Trigger: `nimbus tail` with no arguments; `--filter <connector\|watcher\|hitl\|sync>` to scope output. **Naming note:** `nimbus watch` is already the watcher-CRUD command (`packages/cli/src/commands/watch.ts` → `watcher.list / pause / resume / delete`); the v0.1.1 verb for the gateway-operational stream is `nimbus tail` to avoid the clash. | engineering work only — uses existing IPC notification surface |
| **`nimbus explain last` (X-ray of the most recent `nimbus ask`)** — prints what data the agent loaded into its context window, how each item was ranked and why, what was discarded and the reason (connector rate-limited, below relevance threshold, context window full), and which connectors were queried vs answered from cache. Helps users understand weak or wrong answers and tune their index accordingly. No new Gateway APIs required — the agent already tracks this metadata internally during query execution; this command surfaces it. Output: plain text by default; `--json` for machine-readable. Read-only, no HITL. | engineering work only — surfaces metadata the agent already records |
| **`nimbus changelog` (Markdown changelog assembled from the local index)** — generates a human-readable changelog for a service or across all connected services by assembling everything that moved in the indexed data over a time window: PRs merged, deployments ran, incidents opened and resolved, dependency updates, config changes. Formatted as a Markdown document suitable for release notes, weekly engineering updates, or onboarding new team members. Flags: `--service <name>` to scope to one service, `--since <duration>` (default: `7d`), `--format <markdown\|slack\|plain>`. Zero new connectors required. Read-only, no HITL. | engineering work only — uses existing indexed data |
| **`nimbus standup` (personal standup update from indexed activity)** — assembles everything the authenticated user did across all connected services in the last 24 hours (configurable via `--since`): PRs opened, reviewed, and merged; tickets moved or commented on; incidents responded to; deployments triggered; Slack threads participated in. Output is copy-pasteable Markdown. Scoped to the current user's identity as resolved by the people graph. `--format <markdown\|slack\|plain>` flag. Read-only, no HITL. Entirely local — nothing is posted anywhere without a separate explicit command. | engineering work only — uses existing people graph |
| **`nimbus index health` (index quality report beyond raw item counts)** — embedding coverage percentage per connector, connectors contributing stale data (last synced more than a configurable threshold ago), item types with sparse metadata (missing `url`, `modified_at`, or `raw_meta` fields), and an overall query confidence score (0–100) derived from coverage and freshness. Helps users understand why they're getting weak query results before giving up on Nimbus. Integrates with `nimbus doctor` — a confidence score below 60 prints a warning in `nimbus doctor` output. Read-only, no HITL. `--json` flag for machine-readable output. | engineering work only — index metrics already collected |

#### Maintenance-initiative follow-ups (B-series)

The B1 security audit completed in Phase 4. Three more initiatives are active or sequenced; each gets its own design spec when picked up.

- [x] **B2 — Perf bench (Phase 1)** — S8/S9/S10 drivers implemented; reference-machine baseline established; wired into CI via `_perf.yml`.
- [x] **B3 — Structure audit (Phases 1 & 2)** — Phase 1 tooling (`check-nimbus-invariants.ts`, `count-any-usage.ts`) implemented; Phase 2 ranking and findings documented in `docs/structure-audit/baseline.md`.
- [ ] **B4 — Bug-hunt audit** — ranked by user-facing impact / engineering cost.
- [ ] **Third-party package upgrades** — npm + cargo crate upgrades **deferred from the toolchain refresh** (the refresh PR bumped runner OSes, Node, and Rust MSRV but left dependency upgrades for a focused follow-up).

#### Acceptance Criteria

- `v0.1.0` macOS + Windows binaries install and run correctly after the documented unsigned-install bypass; Linux installers verify cleanly against `SHA256SUMS.asc`. (Native Gatekeeper / SmartScreen acceptance is the bar for the *post-v0.1.1 signing release*, not v0.1.0.)
- `nimbus ask "summarize everything that happened across my projects this week"` runs fully locally via Ollama — no API key, no network call — in under 30 seconds on a mid-range laptop
- Multi-agent orchestration: a task decomposed into 3 parallel sub-agents cannot bypass HITL on any write step — verified by automated test
- `nimbus data export` → wipe index and Vault → `nimbus data import` restores full functionality on a fresh machine with all connectors re-authenticated
- VS Code extension installs from Open VSX and connects to a running Gateway without any manual configuration
- Cursor can query the Nimbus local index via MCP and surface the last deployment and open PRs for a service mentioned in a code comment — verified manually by connecting Cursor to a running `nimbus mcp-server` instance
- Voice query completes end-to-end (speech → Whisper.cpp transcription → Gateway → TTS playback) on all three platforms; audio never leaves the machine — verified by network inspection in CI

> Acceptance criteria for the **community-extension Marketplace seed**, `nimbus changelog`, `nimbus standup`, `nimbus explain last`, and `nimbus index health` moved to the v0.1.1 batch table above.

---

## Active

### Phase 5 — The Extended Surface

**Goal:** Fill every connector gap so that wherever a knowledge worker or developer spends time, their data is in the index. Mature the extension ecosystem. Establish Nimbus as a first-class data layer for CI/CD pipelines and external tooling.

#### Dependencies

- Phase 3 Extension Registry v1 (new connectors should ship as community extensions where possible)
- Phase 3.5 `@nimbus-dev/client` and local HTTP API (CI/CD data layer depends on them)
- Phase 4 Plugin API v1 stable and documented

#### New Connector Categories

##### Browser & Reading

- [ ] **Pocket / Readwise / Raindrop** — saved articles, highlights, reading lists, tags; read-only index
- [x] **Obsidian vault connector** (2026-05-10, Phase 5 Wave A PR 2) — indexes local Markdown vaults with frontmatter metadata, backlinks, and daily notes; uses `[[filesystem.roots]]` as the discovery mechanism; `obsidian_note` item type; backlinks surfaced in the relationship graph (`backlinks` edge type, V26 migration adds `obsidian_notes` shadow table); append to daily note behind HITL (`obsidian.note.append`); no network call required — fully local. Hybrid surface: gateway-side syncable at `packages/gateway/src/connectors/obsidian-sync.ts` plus a thin MCP package at `packages/mcp-connectors/obsidian/` that hosts the HITL-gated `obsidian_append_to_daily_note` write tool. Vault id is derived from the absolute vault root path (`sha256(path).slice(0, 12)`); moving a vault re-issues all note ids — documented in `docs/architecture.md`.
- [ ] **Zotero** — index whitepapers, PDFs, and citations alongside technical docs; `research_paper` item type; read-only

##### API Surface Intelligence

- [x] **OpenAPI / AsyncAPI spec indexer** (2026-05-10, Phase 5 Wave A PR 1) — gateway-side syncable at `packages/gateway/src/connectors/openapi-indexer-sync.ts` that crawls `[[filesystem.roots]]` for `openapi.{yaml,yml,json}`, `swagger.{yaml,yml,json}`, and `asyncapi.{yaml,yml,json}` files; parses each endpoint as an `api_endpoint` item with fields: `path`, `method`, `operation_id`, `tags`, `deprecated`, `service_name` (inferred from per-spec `nimbus.openapi.toml` override → enclosing directory → `info.title` slug → `service-<sha8>` fallback), `spec_file`, `spec_version`, `last_modified`. Mtime-based delta sync, sticky deletes for endpoints removed from re-parsed specs. Emits `api_endpoint → service` edges into the relationship graph so `nimbus impact` answers naturally include API-surface ramifications. V25 migration adds the `api_endpoint` shadow table; the unified `item` table holds the cross-cutting search row (`service = "openapi"`, `type = "api_endpoint"`). Discovery walker is depth-bounded (`[openapi].max_walk_depth`, default 8), respects `[openapi].ignore_globs`, skips a default-ignored dir set (`node_modules`, `.git`, `dist`, `build`, `target`, `.next`, `out`, `vendor`, `.cache`), and never follows symlinks. Spec-size gate (`[openapi].max_spec_bytes`, default 5 MiB); skipped specs surface in the connector's `getLastSyncStats()` for health snapshots. Indexing is fully local — no outbound call. Remote-repo spec discovery, external `$ref` resolution, and AsyncAPI 3.0 are deferred to a follow-up. Parser: `js-yaml` for synchronous parsing; `@readme/openapi-parser` (v6) reserved for future validation.

##### Email via IMAP/SMTP

- [ ] **Generic IMAP connector** — any IMAP server (Fastmail, ProtonMail, self-hosted); credentials in Vault; `body_preview` indexing; `email.send` behind HITL via SMTP
- [ ] **Fastmail MCP connector** — JMAP native (faster and more efficient than IMAP)
- [ ] **ProtonMail MCP connector** — ProtonMail Bridge integration; local IMAP interface; read-only (E2EE precludes server-side access)

##### Meetings & Async Video

- [ ] **Zoom** — meeting metadata, recordings index, AI-generated transcripts (Zoom AI Companion); OAuth; read-only; `meeting.summary` and `meeting.transcript` item types; linked to calendar events via meeting URL
- [ ] **Google Meet** — meeting metadata and auto-generated transcripts via Google Workspace; OAuth (extends existing Google connector auth); read-only; indexed alongside Google Calendar events
- [ ] **Loom** — async video index: title, description, transcript, viewer stats; OAuth; read-only; `loom_video` item type

##### Finance & Expenses

- [ ] **Expensify** — expense reports, receipts, reimbursement status; read-only index; submit behind HITL
- [ ] **Ramp** — transactions, receipts, budgets, vendor spend; read-only index
- [ ] **Mercury** — business banking; balances, transactions, bills; read-only; wire/ACH behind HITL
- [ ] **Stripe** — invoices, payments, customers, disputes, subscription events; read-only; refund behind HITL

##### CRM & Sales

- [ ] **HubSpot** — contacts, companies, deals, activities, notes; OAuth; write behind HITL
- [ ] **Salesforce** — Lead, Contact, Account, Opportunity, Case; OAuth; write behind HITL
- [ ] **Pipedrive** — deals, persons, organisations, activities, notes; API key; write behind HITL

##### Support & Community

- [ ] **Zendesk / Intercom** — tickets, conversations, help articles; read-only index; correlate customer history with code/PR changes
- [ ] **Stack Overflow (Teams/Private)** — index internal knowledge base, questions, and answers; read-only

##### HR & Recruiting

- [ ] **Greenhouse** — jobs, candidates, applications, scorecards, offers; write (move stage, post feedback) behind HITL
- [ ] **Lever** — requisitions, candidates, feedback, interviews; write behind HITL

##### Design & Creative

- [ ] **Figma** — files, frames, comments, version history, FigJam boards; OAuth; comment post behind HITL
- [ ] **Miro** — boards, cards, sticky notes, comments; OAuth; write behind HITL
- [ ] **Canva** — designs, folders, shared projects; OAuth; read-only index

##### Databases & Infrastructure

- [ ] **Local DB Schema Indexing** — index saved queries or schema documentation from local DB tools (pgAdmin, DBeaver, DataGrip); enables semantic recall of "that one SQL query I wrote last month"
- [ ] **Vercel / Netlify** — deployment status, preview URLs, project metadata; correlate deploys with PR/Slack history

##### Feature Flags

- [x] **LaunchDarkly** (2026-05-24, Phase 5 Tier 1) — first-party MCP connector `nimbus-mcp-launchdarkly` + gateway-side syncable. Walks `GET /api/v2/projects → GET /api/v2/flags/{projectKey}` (offset-paged 100/page, 20 pages per project cap) and upserts feature flags as `launchdarkly:feature_flag` items via `mapLaunchDarklyFlagToItem`. Metadata exposed: `key`, `name`, `kind` (boolean/multivariate), `project_key`, `tags`, `temporary`, `archived`, `maintainer`, `maintainer_id`, `description`, `variation_count`, `environments`, `env_states` (per-env on/off), `created_at`, `updated_at`, `canonical_url` — critical for incident correlation ("was this flag enabled when the alert fired?"). API-token auth (raw `Authorization` header). Vault keys: `launchdarkly.token` (required API access token), `launchdarkly.base_url` (optional regional override → default `https://app.launchdarkly.com`; sandbox runtime-merge for regional/federal hosts inherits the same Task 14 follow-up as `sentry.url`), `launchdarkly.project_key` (optional single-project restriction). Three read-only MCP tools: `launchdarkly_list` / `launchdarkly_get` / `launchdarkly_search`. `hitlRequired: []` — `launchdarkly.flag.toggle` is a deferred Phase 8 follow-up.
- [x] **Flagsmith** (2026-05-24, Phase 5 Tier 1) — first-party MCP connector `nimbus-mcp-flagsmith` + gateway-side syncable. Walks `GET /api/v1/projects/ → GET /api/v1/projects/{id}/features/` (DRF-paged 100/page, 20 pages per project cap) plus one `GET /api/v1/projects/{id}/tags/` call per project to resolve feature tag ids to labels, and upserts feature-flag definitions as `flagsmith:feature_flag` items via `mapFlagsmithFeatureToItem`. Metadata exposed: `name`, `type`, `default_enabled`, `initial_value`, `description`, `tags` (resolved labels), `is_archived`, `owner_count`, `project_id`, `project_name`, `created_at` (parsed from the ISO-8601 `created_date`), `canonical_url` (project page) — useful for incident correlation ("did this flag exist when the alert fired?"). Admin-API-token auth (`Authorization: Token <token>`). Vault keys: `flagsmith.token` (required), `flagsmith.api_base` (optional regional / self-hosted host root → default `https://api.flagsmith.com`; requests go to `${api_base}/api/v1/...`; sandbox runtime-merge for non-SaaS hosts inherits the same Task 14 follow-up as `sentry.url`). Three read-only MCP tools: `flagsmith_list` / `flagsmith_get` / `flagsmith_search`. `hitlRequired: []`. **v1 indexes flag definitions only — per-environment on/off state + segments are deferred.** `flagsmith.flag.toggle` is a deferred Phase 8 follow-up.

##### GitOps & Deployment

- [x] **ArgoCD** (2026-05-25, Phase 5 Tier 1) — `argocd:application` items via `mapArgocdApplicationToItem`; metadata name/namespace/project/sync_status/health_status/repo_url/path/target_revision/dest_server/dest_namespace/revision/created_at/canonical_url; vault keys `argocd.url` + `argocd.token` (Bearer); single `GET /api/v1/applications` walk (no pagination); self-hosted host extended into the sandbox network list from `argocd.url` (Grafana pattern); three read tools (`argocd_list` / `argocd_get` / `argocd_search`); `hitlRequired: []`; applications-only — AppProjects + per-app sync history deferred; `argocd.app.sync` / `argocd.app.rollback` writes deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)
- [x] **Flux** (2026-05-25, Phase 5 Tier 1) — `flux:resource` items via `mapFluxResourceToItem` across 9 CRD kinds (kustomization, helm_release, git/oci/helm_repository, bucket, image_repository/policy/update_automation); vault keys `flux.api_url` + `flux.token` (SA Bearer); `status.conditions` Ready health (ready_status/reason/message), suspend, last_applied/attempted_revision; three read tools (`flux_list` / `flux_get` / `flux_search`); `hitlRequired: []`; self-hosted host extended into the sandbox network list from `flux.api_url` (Grafana pattern); TLS note (needs CA-trusted endpoint — self-signed K8s certs rejected by Bun fetch in v1); `flux reconcile` / `flux suspend` writes deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)

##### Data Warehouses, Orchestration & BI (Personal-Auth)

- [ ] **Databricks** (PAT) — workspaces, notebooks (metadata only), jobs, clusters, SQL warehouses; `data_pipeline` item type indexed with job name, status, triggering user, cluster id, started_at, duration; `job.trigger`, `job.cancel`, `cluster.restart` behind HITL
- [ ] **Metabase** (API key) — saved questions, dashboards, collections; `dashboard` item type; read-only index
- [ ] **Superset** (API key) — saved queries, dashboards, charts, datasets; `dashboard` item type; read-only index
- [ ] **Apache Airflow (OSS) / Prefect / Dagster** (API token) — DAGs/flows, tasks, task groups, run statuses, logs; `data_pipeline` item type; `orchestration.run.trigger` / `orchestration.run.cancel` behind HITL
- [ ] **Kibana / Elasticsearch** — saved searches, dashboards, Watcher alerts; `log_alarm` item type; read-only index; agent can query specific indices for error patterns during incident correlation
- [ ] **AWS CloudWatch Logs / GCP Cloud Logging** — log groups, alarms, metric filters, dashboards; `log_alarm` item type; `alarm.acknowledge` / `alarm.silence` behind HITL; agent fetches error-level logs for a service when a PagerDuty alert fires
- [ ] **BigQuery** (Application Default Credentials) — dataset / table / view schema metadata, column tags, recent expensive-query log; `data_model` item type; strictly no row data
- [ ] **AWS Athena** — catalog metadata, saved queries, recent queries; read-only
- [ ] **dbt Cloud** (API token) — projects, models, runs, tests, exposures; `data_model` item type indexed with model name, owner, tags, last-run status, upstream/downstream refs; `dbt.job.trigger` behind HITL
- [ ] **MLflow** (read-only; self-hosted or managed, API token) — experiments, runs, registered models, metrics, artefacts (metadata only); `ml_model` item type indexed with experiment, run id, framework, metric snapshot, registered-model stage. Write tools (`ml.model.promote`, `ml.model.transition-stage`) deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)
- [ ] **SageMaker** (read-only; reuses existing AWS vault credentials from Phase 3 AWS connector) — training jobs, processing jobs, endpoints, model registry, experiments; `ml_model` item type. Write tools (`ml.endpoint.update`, `ml.endpoint.delete`, `ml.job.stop`) deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)
- [ ] **Vertex AI** (read-only; reuses existing GCP ADC from Phase 3 GCP connector) — experiments, custom training jobs, model registry, pipeline runs, endpoints; `ml_model` item type. Write tools (`ml.endpoint.update`, `ml.pipeline.cancel`) deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)
- [ ] **Great Expectations** — validation run results parsed from CI artefacts (no live creds required); `data_quality_test` item type indexed with suite name, batch id, expectation name, success/failure, observed value; read-only
- [ ] **Local data profiling** (Filesystem v2+) — indexes local `.parquet`, `.csv`, `.jsonl`, `.json`, `.orc` files under `[[filesystem.roots]]`: column names, column types, file size, row-count estimate from Parquet footer / line count; `data_model` item type with `provider = "filesystem"`. **Explicitly never indexed:** cell values, row samples, first-N-rows previews, header-row data values. Contract test asserts the connector surface has no row-fetch or row-sample tool.

##### Security & Vulnerability Tooling

- [x] **Snyk** (2026-05-21, Phase 5 Wave A) — first-party MCP connector `nimbus-mcp-snyk` + gateway-side syncable; open source vulnerabilities, licence issues, container scan results, IaC misconfigs; API token; `vulnerability` item type indexed with severity, CVE ID, affected package, fix availability; enables CVE-to-repo-to-open-PR correlation queries from the local index
- [x] **SonarQube / SonarCloud** (2026-05-22, Phase 5 Tier 2) — first-party MCP connector `nimbus-mcp-sonarqube` + gateway-side syncable. Walks `GET /api/components/search?qualifiers=TRK` → `GET /api/issues/search` (paged 100/page, capped 20 pages per project) and upserts open issues (status `OPEN`/`CONFIRMED`/`REOPENED`; types `BUG`/`VULNERABILITY`/`CODE_SMELL`) as `sonarqube:code_issue` items via `mapSonarIssueToItem`. Metadata exposed: `severity` (5-tier `BLOCKER`→`INFO`), `type`, `status`, `rule`, `component`, `project_key`, `file_path`, `line`, `tags`, `effort`, `debt`, `author`, `message`, `creation_date`, `update_date`, `canonical_url`, `organization`. Vault keys: `sonarqube.token` (required), `sonarqube.organization` (required for SonarCloud SaaS), `sonarqube.url` (optional override → default `https://sonarcloud.io`; sandbox runtime-merge for arbitrary self-hosted hostnames inherits the same Task 14 follow-up as `sentry.url`). Three read-only MCP tools: `sonarqube_list` / `sonarqube_get` / `sonarqube_search`. `hitlRequired: []` — `sonarqube.hotspot.review` + `sonarqube.issue.transition` are deferred Phase 8 follow-ups.
- [x] **Semgrep** (2026-05-22, Phase 5 Tier 2) — first-party MCP connector `nimbus-mcp-semgrep` + gateway-side syncable. Walks `GET /api/v1/deployments → /api/v1/deployments/<slug>/findings` (paged 100/page, capped 20 pages per cycle) and upserts open findings as `semgrep:finding` items via `mapSemgrepFindingToItem`. Metadata exposed: `severity` (5-tier critical→info), `confidence` (high/medium/low), `rule_name`, `rule_message`, `categories`, `file_path`, `line`, `end_line`, `column`, `repository`, `repository_url`, `branch`, `triage_state` (untriaged/triaged/ignored/muted), `status` (open/fixed/removed/ignored), `created_at`, `relevant_since`, `line_of_code_url`. Vault keys: `semgrep.token` (required PAT), `semgrep.deployment_slug` (optional — auto-discovered from `/deployments` when unset). Three read-only MCP tools: `semgrep_list` / `semgrep_get` / `semgrep_search`. `hitlRequired: []` — `semgrep.finding.triage` (ignore/suppress/accept-risk) is a deferred Phase 8 follow-up.
- [x] **Wiz** (2026-05-24, Phase 5 Tier 2) — first-party MCP connector `nimbus-mcp-wiz` + gateway-side syncable. Authenticates via OAuth `client_credentials` at `https://auth.app.wiz.io/oauth/token`, then walks the `issues(first, after, filterBy)` GraphQL query at `https://api.app.wiz.io/graphql` (paged 100/page, capped 20 pages per cycle) and upserts open issues (CSPM findings, misconfigurations, toxic combinations) as `wiz:issue` items via `mapWizIssueToItem`. Metadata exposed: `severity` (5-tier `CRITICAL`→`INFORMATIONAL`), `status` (`OPEN`/`IN_PROGRESS`/`RESOLVED`/`REJECTED`), `type`, `source_rule_id`, `source_rule_name`, `entity_id`, `entity_name`, `entity_type`, `project_ids`, `project_names`, `description`, `remediation`, `created_at`, `updated_at`, `resolved_at`, `canonical_url`. Vault keys: `wiz.client_id` + `wiz.client_secret` (required), `wiz.api_url` + `wiz.auth_url` (optional regional overrides → default to the US-east SaaS tenant; sandbox runtime-merge for arbitrary regional/self-hosted hostnames inherits the same Task 14 follow-up as `sentry.url`). Three read-only MCP tools: `wiz_list` / `wiz_get` / `wiz_search`. `hitlRequired: []` — `wiz.issue.resolve` + `wiz.issue.assign` are deferred Phase 8 follow-ups.
- [ ] **SBOM / supply chain tracking** — ingests CycloneDX or SPDX SBOMs from CI artefacts or GitHub Dependency Graph; indexes component → repo → version relationships; enables queries like "which of my services ship lodash <4.17.21?" without touching each repo; no auth required beyond existing GitHub/GitLab connectors
- [x] **`nimbus security scan`** (2026-05-21) — local secret and credential hygiene scan across indexed filesystem roots and repository content. Runs a Gitleaks-compatible pattern set against already-indexed file content (requires `[indexing.depth] = "full"` or `"summary"` for the relevant connector); never fetches new content for the scan — only what is already in the local index. Reports: files containing high-confidence secret patterns (API keys, tokens, private keys), which connector/service they belong to, and whether the file has been modified since the secret was introduced (via git metadata already indexed). Output: `nimbus security scan --json` for machine-readable results; plain text table by default. Write operations: none — purely read. HITL: not triggered. Fits naturally into the existing `nimbus doctor` / `nimbus diag` diagnostic family. New CLI command at `packages/cli/src/commands/security.ts`; pattern definitions at `packages/gateway/src/security/secret-patterns.ts`.

#### Team Intelligence

- [x] **T3 PR 1 — coordinator parallelism + `nimbus expert`** (2026-05-09) — `AgentCoordinator.executeAll` runs sub-agents in parallel; `expert.ts` ships as the first built-in agent. `nimbus expert <topic-or-file>` answers "who on my team has the most context on this?" by querying the relationship graph and indexed metadata: PR authorship via indexed code symbols, review participation patterns, Slack thread activity, and Linear/Jira ticket assignments. Returns a ranked list of people with a confidence score and the evidence behind each ranking (e.g. "authored 4 of the last 6 PRs touching this file, resolved 2 incidents tagged `payment-retry`"). Uses the existing people graph — no new connectors required. Read-only, no HITL. CLI: `nimbus expert <topic-or-file>`; IPC: `agents.expert`; notification: `agents.expert.briefReady`.
- [x] **T3 PR 2 — `nimbus impact`** (2026-05-09) — second built-in agent: reverse-dependency blast radius. `nimbus impact <file-or-PR-url>` answers "if I change this, what breaks?" by running a reverse dependency query across the relationship graph: which services import the affected module (via indexed code symbols and `depends_on` graph edges), which pipelines would rebuild (via `pipeline_run` items linked to the repo), which dashboards pull from affected data models (via `upstream_refs` graph edges), and which on-call rotations own the affected services (via PagerDuty schedule index). Five parallel sub-agents. Returns a structured impact report with blast radius by category. Built entirely on the Phase 3 relationship graph substrate — no new connectors required. Read-only, no HITL. `--json` flag for CI integration. CLI: `nimbus impact <file-or-PR-url>`; IPC: `agents.impact`; notification: `agents.impact.briefReady`.
- [x] **T3 PR 3 — `nimbus catchup`** (2026-05-10) — third built-in agent: personalized retrospective digest. `nimbus catchup --since <duration>` returns everything that happened across connected services while the user was away, prioritized by relevance to their recent work history. Unlike `nimbus changelog` (which is service-scoped and uniform), `nimbus catchup` is personalized — it weights activity by the user's historical involvement: services they own, repos they contribute to, incidents they've responded to, people they collaborate with frequently. Default window: `3d`. Output: structured Markdown with sections per service, prioritized by relevance score. Read-only, no HITL. Five parallel sub-agents (`s_owned_services`, `s_active_repos`, `s_responded_incidents`, `s_collaborators`, `s_window_items`) over the local index; three-tier self-person resolver (override → git email → OS username). CLI: `nimbus catchup [--since 3d] [--json] [--service <id>]`; IPC: `agents.catchup`; notification: `catchup.briefReady`. T3 epic complete.

#### Nimbus as a CI/CD Data Layer

The local HTTP API and `@nimbus-dev/client` (Phase 3.5) unlock Nimbus as a data source for CI pipelines and external tooling. This section makes that story explicit with first-class integration points.

- [x] **Published OpenAPI spec** (2026-05-22, Phase 5 T4 PR 1 wrap-up) — machine-readable OpenAPI 3.1 schema covering all 11 routes (10 `GET` + the `POST /v1/deployments` write surface) at `packages/gateway/openapi/v1.yaml`; served as JSON at `GET /v1/openapi.json` (cached via `loadOpenApiJsonBytes`); locked by `bun run audit:openapi-drift` which compares `paths` against the canonical `HTTP_ROUTES` constant in `packages/gateway/src/ipc/http-routes.ts` and fails CI on any add/rename/method-flip drift; enables auto-completion, contract testing, and third-party tooling without bespoke client code.
- [x] **Pre-deploy index check** (2026-05-13, Phase 5 T4 PR 3a) — `nimbus-dev/query-action` GitHub Action that queries the local Gateway's `GET /v1/preflight/deploy` endpoint for active P1 incidents on the target service, failing CI runs on the target branch, and open PRs with merge conflicts. `mode: warn` (default) annotates without blocking; `mode: block` exits 1 on findings; `allow-gateway-failure: true` is the escape hatch for infra noise. CLI counterpart `nimbus deploy preflight` for non-GitHub CI providers. Reuses the `[metrics.dora.<id>]` config plus a new `[ci.service.<id>]` alias.
- [x] **Post-deploy annotation** (2026-05-14, Phase 5 T4 PR 3b) — `nimbus-agent/annotate-action` GitHub Action + `POST /v1/deployments` + `nimbus deploy annotate` CLI. Records a deploy as a first-class `deployment` item (V28 shadow table); DORA's `selectDeploys` prefers annotated rows and emits `gap: "mixed_source"` when both annotated and regex-matched `ci_run` rows fall in the same window. Bearer-auth via vault key `http_api.deployment_token`; 60 req/min sliding-window rate limit. New security invariant **I13** locks the HTTP write-route allowlist.
- [x] **Pre-commit hook template** (2026-05-22, Phase 5 T4 PR 1 wrap-up) — `docs/templates/nimbus-pre-commit.sh` is a fail-open bash hook that queries the local index for active P1 incidents (last 24 h) and failing CI runs on the current branch (last 4 h). Warn-only by default; flip per-check to block via `NIMBUS_HOOK_BLOCK_ON_INCIDENT=1` / `NIMBUS_HOOK_BLOCK_ON_FAILING_CI=1`. Install + extend recipes in [`docs/cli/pre-commit.md`](./cli/pre-commit.md). The Linear/Jira "related tickets on staged files" check is documented as an opt-in extension pattern — issue state is not yet captured by the Linear/Jira sync layers, so a useful "open ticket" filter requires sync-layer changes outside this PR.
- [x] **`nimbus query` in CI** (2026-05-21, Phase 5 T4 wrap-up) — documented pattern for using `nimbus query --json` inside CI pipelines (GitHub Actions, Jenkins, GitLab CI) to gate deployments, generate release notes from indexed PRs, or surface incident context in PR comments; requires Gateway running on a self-hosted runner or accessible over LAN. Five worked, copy-paste-ready examples in [`docs/cli/use-in-ci.md`](./cli/use-in-ci.md): GH-Actions P1 gate, GitLab CI gate + stale-PR warning, Jenkins (declarative + scripted), PR-comment incident context, release-notes generation grouped by repo.
- [x] **DORA Metrics** (2026-05-12, Phase 5 T4 PR 2) — compute the four key DORA metrics directly from already-indexed data with no new connectors required: *deployment frequency* (GitHub/GitLab releases + CI deploy runs), *lead time for changes* (PR open → merge → deploy correlation), *change failure rate* (deploy events correlated with PagerDuty/Datadog incidents within a configurable window), *mean time to restore* (incident open → resolve timestamps); exposed via `nimbus metrics dora [--service <name>] [--since 30d]` and the local HTTP API; renders in the Tauri dashboard alongside connector health
- [x] **PagerDuty connector enrichment** (2026-05-14, Phase 5 T4 wrap-up) — `pagerduty-sync.ts`
  now writes `metadata.opened_at_ms` (from `incident.created_at`),
  `metadata.pagerduty_service_id` (from `incident.service.id`), and
  `metadata.severity` (from strict `incident.priority?.name`) on every indexed
  `incident` row. DORA CFR/MTTR (PR 2) and Preflight active-P1 (PR 3a) now compute
  against real PagerDuty data; both surfaces previously returned `no_pagerduty_mapping` /
  zero findings in production. `initialSyncDepthDays` bumped 14 → 30 so a fresh install's
  first `nimbus metrics dora --since 30d` window is fully populated. No schema change, no
  migration — natural cursor re-sync overwrites pre-existing rows. Non-`"P1"` priority
  names (`"Critical"`, `"SEV-1"`) pass through verbatim; a future
  `[pagerduty].severity_strategy` config knob can map them to preflight's P1 filter if
  user demand emerges.
- [x] **PagerDuty sync pagination** (2026-05-16, Phase 5 T4 wrap-up) — `pagerduty-sync.ts`
  now walks pages with `sort_by=updated_at:asc` and `limit=100`, honoring `parsed.more`
  and capping at `[pagerduty].max_pages_per_sync` (default 20, range 1..100). On cap-hit
  the syncable returns `hasMore: true` so the scheduler re-queues; partial-failure cursors
  preserve progress from pages already ingested. No new credentials.
- [x] **`[pagerduty].severity_p1_aliases` config knob** (2026-05-16, Phase 5 T4 wrap-up) —
  preflight's `selectActiveP1Incidents` now matches `LOWER(severity) IN (?, ?, ...)` over
  the union of `"p1"` plus org-declared aliases (e.g. `"Critical"`, `"SEV-1"`). Aliases are
  lowercased + deduped at parse time. New `PreflightGap` variant
  `"pagerduty_urgency_without_priority"` fires when the strict filter yields zero matches
  but high-urgency-without-priority incidents exist on the configured services, so operators
  can self-diagnose silent-zero preflight results. Query-time evaluation — no re-index needed.

#### Semantic Layer Enhancements

These items resolve deferred decisions from Phase 3.

- [ ] **Multi-model embedding** — add `vec_items_1536` virtual table for OpenAI `text-embedding-3-small` (and compatible) embeddings alongside the existing `vec_items_384` (`all-MiniLM-L6-v2`); `embedding_chunk.dims` and `embedding_chunk.model` are already recorded — schema is pre-positioned (Phase 3); per-item-type model routing: code symbols use local MiniLM by default; prose items use the configured model; `nimbus index reembed --model <id>` triggers selective backfill; multiple models can be active simultaneously with queries fan-out across matching vec tables and RRF-merged
- [x] **T2 PR 1 — Sandbox PAL + 3-OS isolation** (2026-05-17, Phase 5 T2 PR 1) — enforce full syscall/network isolation for extension child processes: seccomp BPF filter + bwrap + nimbus-sandbox-helper (`cap_net_admin+ep`) + per-host iptables on Linux, sandbox-exec SBPL profile on macOS, AppContainer + `internetClient` capability + orphan-reap on Windows; network access and filesystem read/write paths must be declared in `nimbus.extension.json` under `permissions.{network,filesystem}` and enforced at the kernel level; replaces the Phase 3 honour-system env restriction; extensions without `permissions.network` run fully offline; new security invariant **I15** wires `wrapServerSpec(...)` → `sandbox-wrapper.ts` → `runner.spawn(...)` as the single sandbox-execution boundary, enforced statically by `D10` in `check-nimbus-invariants.ts` and at runtime by `security-invariants.test.ts`; `runSandboxContractTests()` ships in `@nimbus-dev/sdk` for first- and third-party connector authors; pre-T2 extensions hard-disabled until reinstall. **Merged 2026-05-17.**
- [x] **T2 PR 2 — Verified publisher (Ed25519-signed manifests)** (2026-05-18, PR #343, Phase 5 T2 PR 2) — extension manifests carry an optional `publisher: { id, key }` field + an embedded `signature` field; Ed25519 verification fires at install AND every Gateway startup before the extension is allowed to spawn; new structural security invariant **I16** wires `verifyManifestSignature(...)` at `extensions/install-from-local.ts` + `extensions/verify-extensions.ts` (signature pass added to `verifyExtensionsBestEffort`); hard-disable on failure via the new `SignatureDisabledRegistry` singleton (parallel to PR 1's `PreT2DisabledRegistry`); new CLI: `nimbus extension keygen`, `nimbus extension sign`, `nimbus extension sync`, `nimbus extension install --publisher-key`; tabular `nimbus extension list` with a Publisher column and dim-yellow `(unverified)` rendering on TTY when `NO_COLOR` is unset; publisher pubkeys cached at `extension.publisher_key.<id>` (D11 vault-key allow-list extended); IPC `extension.sync` is CLI-only — added to `FORBIDDEN_OVER_LAN` per `I5`, NOT in Tauri allowlist per `I7`; crypto primitives (`canonical-json`, `verify-signature`) moved into `@nimbus-dev/sdk` (MIT) so connector authors can sign manifests without an AGPL dep; gateway re-exports through thin shims at the old paths.
- [x] **T2 PR 3 — Auto-update with per-bump HITL** (2026-05-20, PR #367, Phase 5 T2 PR 3) — in-process polling daemon (`ExtensionAutoUpdater`, default 24h via `[extensions].update_check_interval_hours` 1..168, 30–300s startup jitter, air-gap-aware) that calls the registry to detect newer versions of installed signed extensions and writes them into an in-memory `AutoUpdateCache` keyed by extension id (no DB persistence — recovered on next poll); two new HITL action types `extension.autoUpdate` (forward) and `extension.downgrade` (backward) added to `HITL_REQUIRED_BACKING`; two new IPC methods `extension.checkForUpdates` + `extension.update` are CLI/UI-only — added to `FORBIDDEN_OVER_LAN` per `I5` and alphabetically inserted into Tauri `ALLOWED_METHODS` (60 → 62) per `I7`; three new CLI verbs `nimbus extension update [<id>] [--check] [--to <version>] [--json]`, `nimbus extension downgrade <id> --to <version>`, and `extension.info` extended with `prevVersion` + `cachedUpdate`; two-version on-disk directory layout `<extRoot>/<id>/{active,_prev/<v>}` enables `nimbus extension downgrade` as a thin `fs.rename` swap; atomic upgrade swap with revert-on-failure (older `_prev/*` move aside to a holding dir, restore on swap failure); startup crash recovery in `verify-extensions.ts` promotes the most-recent `_prev/<v>/` when `active/` is missing and audits `extension.autoUpdate.crash_recovered`; tarball download enforces a 50 MiB content-length + body cap with `AbortSignal` plumbing; manifest schema gains optional `updateChannel: "stable" | "beta"` (default `"stable"`) and `changelog?: string` (≤ 4 KiB after NFC) — both absent on disk by default so pre-PR-3 signed manifests verify unchanged. No new structural invariant — composes on top of I2/I3/I4/I5/I7/I14/I16.
- [x] **T2 PR 4 — Dependency resolution + V31 `extension_dependency`** (2026-05-21, PR #374, Phase 5 T2 PR 4) — manifest `dependsOn: Record<string, string>` (semver ranges) + custom backtracking solver in `extensions/dependency-graph.ts` (recursive DFS with per-frame `pinned` / `ranges` and an explicit `ancestors: Set` so diamond DAGs never false-positive as cycles), V31 `extension_dependency` table + `idx_extension_dependency_reverse` index, install path runs `resolveClosure` after signature verify and refuses with `DependencyConflictError` / `OfflineDependencyResolutionError` before any disk mutation, install closure unpacked leaf-first with per-session `createdDirs` cleanup on failure, `recordInstall` writes forward edges in one transaction, `extension.install_complete` audit row carries the full version map; remove path consults `reverseDeps` and refuses unless `--force`; auto-update daemon runs the solver per detected bump with `activeConstraints` covering every installed extension and surfaces a new `conflicts?: DependencyConflict[]` field on `AvailableUpdate`; startup integrity adds two new offline-safe passes — backfill `extension_dependency` rows from on-disk manifests, then completeness guard (iterates to fixed point, marks dependent extensions whose deps are missing or unsatisfied via new `MissingDependencyRegistry` singleton parallel to PR 1's `PreT2DisabledRegistry` and PR 2's `SignatureDisabledRegistry`; cascade-disables transitively); new CLI: `nimbus extension info --deps`, `nimbus extension list --tree` (NO_COLOR-aware, cycle-safe ASCII renderer), `nimbus extension remove --force` (HITL preview surfaces danglingDeps via existing `extension.uninstall` confirmation flow); `extension.info` IPC returns `forwardDeps` + `reverseDeps`; local-first `RegistryFetcher` ensures installed ids resolve from on-disk manifest without a network call. No new structural invariant — composes on `I9` (bound parameters for `extension_dependency` writes), `I14` (`dbRun` / `dbExec` for every write), `I16` (solver runs after signature verify on every closure node). `fast-check` property tests gate cycle / satisfiability correctness over random DAGs ≤ 12 nodes.

#### T6 — B1 hardening + semantic layer prep

Phase 5 Core item 5. Four sequential PRs in the order below, locked by the [T6 sequencing spec](./superpowers/specs/2026-05-14-phase-5-t6-design.md). Each PR follows the T4-wrap-up cadence (brainstorm → spec → plan → execute → PR). Bridge work between T4 (just merged) and T2 (sandbox + Marketplace v2).

- [x] **T6 PR 1 — I10 timing-safe helper consolidation** (2026-05-14, PR #292) — migrated `ipc/lan-pairing.ts`'s local `timingSafeEqual` and `ipc/http-auth.ts`'s local `constantTimeStringEqual` into the canonical helper at `packages/gateway/src/util/timing-safe-compare.ts`; finishes the I10 consolidation that `extensions/verify-extensions.ts` and `updater/updater.ts` already follow. Updated `SECURITY-INVARIANTS.md` I10 row and `security-invariants.test.ts`. No migration.
- [x] **T6 PR 2 — `tool_call_log` audit table (V29)** (2026-05-15) — closes "Structured tool-call result auditing (S8-F10)" below; complements the `<tool_output>` envelope (I11) by recording the envelope's contents at audit time via `writeToolCallLog` (best-effort — internal try/catch never breaks the LLM-facing path; envelopes >64 KiB are truncated with a `...[truncated, N bytes total]` marker). New `audit.toolCalls` IPC method (read-only) is IPC-only — NOT LAN-callable per `I5`, NOT in Tauri `ALLOWED_METHODS` per `I7`, NOT exposed via the read-only HTTP API. Composite (`calledAt`, `id`) cursor pagination handles same-millisecond rows deterministically; `sessionId=''` is the explicit NULL-session sentinel. Wired at both `wrapToolOutput` sites in `engine/agent.ts` (`wrapToolForLlm`) and `connectors/lazy-mesh/mesh.ts` (`listTools`); I11 enforcement test extended to assert both `wrapToolOutput` AND `writeToolCallLog` are present at each site. No new invariant — strengthens I11.
- [x] **T6 PR 3 — `vec_items_1536` + per-type routing + reembed CLI (V30)** (2026-05-15) — closes "Multi-model embedding" above; per-`(service, type)` model routing with `text-embedding-3-small` for the 14 prose-heavy pairs in `embedding/routing.ts:PROSE_HEAVY_TYPES` (gated on `openai.api_key` in vault, default = MiniLM-only fallback when missing) and a `nimbus index reembed --model <id> [--item-type <key>] [--service <name>] [--limit N] [--batch-size N] [--dry-run] [--yes] [--json]` CLI for selective backfill. New `vec_items_1536` virtual table (V30) coexists with `vec_items_384`; query-side `vectorSearchChunksDual` merges KNN results across both. `index.reembed` / `index.reembedCancel` are CLI-only — added to `FORBIDDEN_OVER_LAN` per `I5`, NOT in Tauri allowlist per `I7`. `provider = "openai"` promoted to 1536-dim everywhere; new `provider = "hybrid"` selects the routing pipeline.
- [x] **T6 PR 4 — Typed `dbRun` / `dbExec` migration (2026-05-16, 163 sites)** — closes "Typed `dbRun` / `dbExec` migration (S5-F4)" below; migrated 163 direct `db.run()` / `db.exec()` / `stmt.run()` call sites across every package to the centralised `dbRun` / `dbExec` / `dbStmtRun` wrappers in `db/write.ts`; new `D12` static-audit rule in `check-nimbus-invariants.ts` banning direct calls outside the `DB_RUN_EXEC_ALLOW_LIST`; new security invariant **I14** wired and enforced in `security-invariants.test.ts` + `SECURITY-INVARIANTS.md`; `db-run-census.json` baseline updated to 3 entries (the wrapper internals only).

#### Security audit follow-ups (B1)

Items deferred from the Phase 4 internal security audit (B1, 2026-04-25) that fit naturally with Phase 5's hardening pass.

- [x] **Typed `dbRun` / `dbExec` migration (S5-F4)** (2026-05-16, Phase 5 T6 PR 4) — 163 sites migrated; `D12` static-audit rule + invariant `I14` enforce the wrapper at CI time
- [x] **Structured tool-call result auditing (S8-F10)** (2026-05-15, Phase 5 T6 PR 2) — V29 `tool_call_log` table; `writeToolCallLog` wired at both `wrapToolOutput` sites; `audit.toolCalls` IPC read surface

#### Extension Marketplace v2

- [ ] Community ratings and reviews per extension
- [x] Verified publisher badges (Ed25519-signed manifest from a registered publisher) (2026-05-18, PR #343, Phase 5 T2 PR 2)
- [x] Auto-update with changelog preview; user approves each version bump (2026-05-20, PR #367, Phase 5 T2 PR 3)
- [x] Extension dependency resolution (one extension can depend on another) (2026-05-21, PR #374, Phase 5 T2 PR 4)
- Extension monetization (paid extensions, license key enforcement, revenue sharing) deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)

#### Wave B — Mobile & Frontend Engineering (stretch)

Connector breadth for mobile and frontend engineering disciplines that didn't fit the original Phase 5 categories. Each is read-only in Phase 5; write tools (releasing a build, dismissing a Web-Vitals regression) land in Phase 8 (Security Engineering) or Phase 12 (Enterprise) depending on shape. Does not gate Phase 5 completion.

- [x] **Bitrise** — mobile CI builds, workflows, releases, certificates state, app dashboards; read-only (2026-05-21, Phase 5 Wave B; `bitrise:app` + `bitrise:build` items via `/v0.1/me/apps` → `/v0.1/apps/<slug>/builds`; mandatory read-tool surface; vault key `bitrise.token`; `permissions.network = ["api.bitrise.io"]`)
- [ ] **Codemagic** — Flutter/RN/native mobile CI; build pipelines, distribution targets, code-signing status; read-only
- [ ] **Microsoft App Center** (or successor where deprecated) — mobile build pipelines, distribution groups, crash analytics, in-app analytics; read-only
- [ ] **Firebase App Distribution** — release tracks, tester groups, distribution events; read-only
- [ ] **TestFlight** (read-only via App Store Connect API) — build groups, tester sessions, feedback; read-only
- [ ] **Storybook** — local Storybook component manifest; story-level metadata indexed when run alongside Nimbus; design-system component coverage feeds Phase 7 service-catalog `component` items
- [ ] **Chromatic** — visual-regression test results, baseline diffs, build approvals; read-only; `chromatic.build.approve` HITL
- [ ] **LogRocket / FullStory / Datadog RUM** — frontend session replays metadata (no replay-payload bodies indexed by default), error events, Web Vitals (LCP, FID, CLS, INP); read-only; opt-in to indexing PII-redacted metadata
- [ ] **Web-vitals watcher** — fires when LCP/FID/CLS p75 regresses past configurable threshold over a 24-h window for a tracked service; surfaces in morning briefing; ties into Phase 7 DORA dashboard

#### Acceptance Criteria

- A user with a Fastmail account can run `nimbus connector auth fastmail` and have their inbox indexed within 5 minutes using the IMAP connector
- A HubSpot deal update initiated by the agent triggers HITL before any outbound API call
- The `nimbus-dev/query-action` GitHub Actions action successfully queries a running Gateway's HTTP API and blocks a deploy when an active P1 incident is detected for the target service
- A repo containing `openapi.yaml` is indexed and `nimbus ask "which services have a POST /payments endpoint?"` returns the correct service name from the local index without a live API call
- `nimbus security scan` detects a deliberately introduced test credential in a filesystem root configured at `summary` depth and reports the file path, pattern match type, and connector — verified in `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts`
- A community extension published via the Marketplace can be installed, enabled, and used without the author having access to Nimbus core source
- `nimbus ask "which repos have critical Snyk vulnerabilities with open PRs touching the affected packages?"` returns results from the local index without any live API call
- `nimbus metrics dora --service payment-service --since 30d` returns all four DORA metrics computed from indexed GitHub and PagerDuty data
- An ArgoCD application sync failure is indexed and correlatable with the triggering Git commit within one sync cycle
- `nimbus ask "which dbt models feed the failing Tableau dashboard?"` returns a lineage chain once Phase 6 Tableau lands; intermediate Phase 5 variant works end-to-end against Metabase / Superset dashboards linked to dbt models
- No raw row data or binary extract crosses the connector boundary for any warehouse or BI connector — verified by a contract test that asserts the absence of row-fetch tools on each connector's MCP surface
- **Downstream Impact Analysis** — `nimbus ask "if I change the revenue calc in this PR, which Looker dashboards break?"` resolves via `traverseGraph` over `code_symbol` → `data_model` → `dashboard` relations in the Phase 3 relationship graph; returns affected dashboards in under 500 ms from the local index
- Local data-file profiling indexes column names + types + row-count estimates from `.parquet`, `.csv`, `.jsonl`, `.json`, and `.orc` files under configured filesystem roots; contract test asserts the connector surface exposes no row-sample or cell-read tool; manual audit confirms only file footers / header lines / line counts are read — never row contents
- MLflow / SageMaker / Vertex AI experiments and models are indexed with framework, metric snapshots, and stage transitions (read-only in Phase 5; the `ml.model.promote` HITL write path lands in Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5))
- `nimbus expert src/billing/retry.ts` returns a ranked list of team members with evidence drawn from indexed PR authorship, review history, and incident involvement — answered from the local index without a live API call
- `nimbus catchup --since 3d` returns a digest prioritized by the authenticated user's historical involvement, with higher-ranked items matching services and repos the user has recently contributed to — verified by seeding two connectors with different activity levels and confirming the more-relevant one ranks first
- `nimbus impact src/billing/retry.ts` returns at minimum the set of services that depend on the file and the pipelines that would be affected, resolved from the local relationship graph without a live API call

---

## Planned

### Phase 6 — Team

**Goal:** Make Nimbus a collaborative layer for engineering teams — shared intelligence without surrendering local sovereignty.

> **Composes with Phase 7 (Engineering Excellence):** the federation primitives, Team Vault, ChatOps, admin console, and org-level policy engine in this phase are the multipliers for Phase 7's service catalog, DORA metrics, feature-flag, and shared knowledge graph features. Phase 6 ships independently of Phase 7 — but when both are present, the `@nimbus excellence` ChatOps shortcut, embedded DORA panels in the admin console, and federated synchronisation of the Phase 7 knowledge graph + automation library all light up.

#### Dependencies

- Phase 4 encrypted LAN remote access (E2EE channel foundation for Nimbus-to-Nimbus)
- Phase 4 tamper-evident audit log (required for org-level compliance controls)
- Phase 4 Plugin API v1 (team connectors can ship as extensions)
- Phase 3.5 configuration profiles (team policy interacts with per-user profile config)

#### Shared Infrastructure

- [ ] **Nimbus-to-Nimbus federation** — two Gateways share a scoped index namespace over E2E-encrypted channel (NaCl box); no relay server; each side controls which `item` types and services it exposes; revocable per peer
- [ ] **Cross-user conflict detection** — use the federated index to detect "Work-in-Progress collisions" (e.g., Alice editing `auth.ts` while Bob is assigned to the related Jira ticket); notifies the user before starting changes
- [ ] **Team Vault** — shared credential store; one Gateway acts as trust anchor; role-based read/write access to named vault entries; credentials never leave the LAN
- [ ] **Shared index namespaces** — user publishes a named namespace (e.g. `project:zurich`) as a filtered slice of their index; teammates subscribe over the federation channel; changes propagate on next sync cycle
- [ ] **LAN discovery** — Gateways advertise each other via mDNS; `nimbus team discover` lists available peers; pairing requires explicit mutual approval

#### Identity & Access

- [ ] **SSO/OIDC/SAML** — enterprise identity provider integration; tokens stored in the Vault; Gateway validates ID token on every session
- [ ] **SCIM user provisioning** — automated user lifecycle driven by IdP; deprovisioned users' shared namespaces revoked automatically
- [ ] **Role-based access control** — `owner`, `editor`, `viewer` roles per shared namespace; enforced at the federation protocol layer, not just the UI
- [ ] **Multi-user HITL** — workspace owner delegates HITL approval rights to a named team member for a specific workflow; delegate sees a pending approval queue; every delegation recorded in audit log

#### Data Warehouses & BI (SSO-gated)

Depends on Team Vault (above) so service-account / SSO credentials can be shared across a workspace without each user re-authenticating.

- [ ] **Snowflake** (SSO / OAuth / Key-Pair) — databases, schemas, tables / views (column names + tags only), tasks, pipe status, recent query history metadata; `data_model` item type indexed with database, schema, table, column tags, row-count estimate, last-altered; `warehouse.task.run` / `warehouse.pipe.resume` behind HITL; strictly no row data
- [ ] **Tableau Server / Cloud** — dashboards, reports, views, workbooks, authors, folders, extract refresh status; `dashboard` item type; read-only except `bi.comment.post` behind HITL; links Tableau views to upstream Snowflake tables via data-source metadata
- [ ] **Looker** — dashboards, Looks, Explores, LookML models, content folders; `dashboard` + `data_model` item types; read-only; `bi.schedule.send` behind HITL; links Looker Views to the underlying dbt models in GitHub via LookML `sql_table_name`
- [ ] **PowerBI** — workspaces, reports, dashboards, datasets (schema only), dataflows; `dashboard` item type; read-only except `bi.dataset.refresh` behind HITL
- [ ] **Monte Carlo** (SSO) — data quality incidents, freshness alerts, schema change logs, monitored tables; `data_quality_test` item type indexed with monitor id, table, incident status, severity, first-seen-at; read-only; `dq.incident.resolve` behind HITL
- [ ] **Bigeye** (SSO) — data quality metrics, SLA breaches, monitored schemas, anomaly records; `data_quality_test` item type; read-only; `dq.sla.acknowledge` behind HITL

#### Shared Workflows & Policy

- [ ] **Team-owned workflow pipelines** — pipelines in a shared namespace; any team member can trigger; write steps require HITL from the triggering user; no credentials embedded in pipeline YAML
- [ ] **Team "Huddle" Briefing** — aggregate morning briefing summarizing team achievements across PRs, tickets, and incidents without manual status reporting
- [ ] **Tribal-knowledge extraction** — agent watches Slack / Teams for repeated questions ("how do I deploy X?") and proactively suggests saving the answer to a shared Notion / Confluence page or as a Phase 7 Wave 4 automation template; upstream pattern detector that feeds the automation library
- [ ] **Cross-team blast-radius pre-flight** — before merging a PR, the upstream service owner's agent sends a "preflight request" to the agents of downstream service owners; downstream agents simulate the change against their local integration tests / environments only after the downstream owner approves via their HITL queue (no auto-execution on the upstream owner's say-so); aggregated results return to the upstream PR; stops cascading failures across team boundaries without a centralised staging environment
- [ ] **Org-level policy engine** — `nimbus.policy.toml` enforces: connector allowlists, `retentionDays` floor, HITL threshold overrides, audit log shipping destination; interacts with per-user profile config from Phase 3.5
- [ ] **Policy enforcement at the Gateway** — policy loaded on startup; connectors not in the allowlist disabled before the mesh starts; violations logged to audit trail

#### ChatOps

- [ ] **Bidirectional Slack/Teams bot** — team members interact with the shared Nimbus Gateway via `@nimbus` in a channel; read queries (`@nimbus who's on call for payment-service?`) answered from the shared index; write commands (`@nimbus rollback payment-service to v1.4`) route to the HITL queue of the appropriate team member before executing — the bot never bypasses the consent gate
- [ ] **HITL via Slack/Teams** — pending HITL approvals surfaced as interactive Slack/Teams messages; approver clicks Approve/Reject in-channel; decision recorded in audit log with approver identity; deep link to the full approval context
- [ ] **Notification routing** — watcher alerts and incident summaries optionally routed to a designated Slack/Teams channel; configurable per watcher rule and per team namespace
- [ ] **Bot security model** — bot token stored in Team Vault; bot can only act on behalf of the requesting user's authorised scope; channel-to-namespace mapping enforced in policy; no bot command can exceed the requesting user's permission level

#### Admin & Observability

- [ ] **Admin console** — web UI served locally by the Gateway: user list, namespace health, connector status across the team, audit log viewer, policy editor
- [ ] **Team audit log** — federation events appended to each member's local audit log; owner can request a merged view
- [ ] **GDPR/compliance at org level** — `nimbus team purge --user <id>` removes a user's contributions from all shared namespaces; writes a signed deletion record

<a id="deferred-from-phase-5"></a>

#### Deferred from Phase 5

Items moved here from Phase 5 per the T1 sequencing spec. Read-only counterparts of split items remain in Phase 5.

##### Browser & Reading

- [ ] **Web clipper** — browser extension saves a page into the Nimbus index with a tag; includes a browser "sidecar" UI (overlay) to show related local items without leaving the tab; surfaced in `nimbus search` alongside Drive files and emails
- [ ] **Mendeley** — index whitepapers, PDFs, and citations alongside technical docs; `research_paper` item type; read-only (Zotero shipped in Phase 5)

##### Email & Calendar (macOS-only)

- [ ] **Apple Mail + macOS Calendar** — Apple Mail via local IMAP (no Bridge required); macOS Calendar via CalDAV (`caldav.apple.com`); macOS only; credentials in Vault; calendar events indexed as `event` items; mail indexed as `email` items with body preview; create/delete calendar event and draft send behind HITL

##### HR

- [ ] **Workday** — time off, headcount, org chart, job postings; read-only where API access allows. Lifted to Phase 6 because typical Workday tenancy is org-wide and pairs naturally with team identity / SSO already landing in this phase

##### GitOps (Write Tools)

- [ ] **ArgoCD writes** — `gitops.app.sync`, `gitops.app.rollback` behind HITL; depends on the read-only ArgoCD connector landing in Phase 5
- [ ] **Flux writes** — `gitops.kustomization.reconcile`, `gitops.helmrelease.reconcile` behind HITL; depends on the read-only Flux connector landing in Phase 5

##### ML/AI (Write Tools)

- [ ] **MLflow writes** — `ml.model.promote`, `ml.model.transition-stage` behind HITL; depends on the read-only MLflow connector landing in Phase 5
- [ ] **SageMaker writes** — `ml.endpoint.update`, `ml.endpoint.delete`, `ml.job.stop` behind HITL; depends on the read-only SageMaker connector landing in Phase 5
- [ ] **Vertex AI writes** — `ml.endpoint.update`, `ml.pipeline.cancel` behind HITL; depends on the read-only Vertex AI connector landing in Phase 5

##### Marketplace v2 Monetization

- [ ] **Paid extensions** — license-key enforcement via local validation; revenue sharing to publisher; depends on Marketplace v2 ratings/reviews/verified-publisher work landing in Phase 5 T2

#### Acceptance Criteria

- Two Nimbus instances on the same LAN establish a federated namespace in under 60 seconds with no external server involved
- A team member's HITL approval on a shared workflow is recorded in both the approver's and the workspace owner's local audit log
- Revoking a peer's federation access removes their read access within one sync cycle; no data retained on their machine after revocation
- An org policy disallowing the Slack connector prevents `nimbus connector auth slack` from succeeding on any member's machine while the policy is active
- A `@nimbus rollback` command issued in Slack routes to the on-call engineer's HITL queue and does not execute until they approve; the approval is recorded in the audit log with their identity
- Cross-warehouse lineage query `nimbus ask "why is the Q1 revenue Tableau dashboard stale?"` resolves the chain Tableau view → Looker view → dbt model → Snowflake table → Airflow DAG → failing PR from the local index in under 500 ms; no live warehouse or BI API call is made during the query

---

### Phase 7 — Engineering Excellence

**Goal:** Give engineers a local, queryable view of how their team operates — service ownership, DORA / SPACE health, feature-flag state, and a shared knowledge graph that turns one engineer's hard-won pattern into the team's reusable automation. **Single-user-first;** Phase 6 federation amplifies the value but is not a precondition.

> **Composes with Phase 6 (Team):** Phase 7 ships fully on a solo machine, but every wave gets richer when Phase 6 federation is available. Wave 1's ownership graph merges federated peers' service catalogs into a single cross-team view; Wave 4's knowledge graph + automation library publish to Phase 6 shared namespaces; Wave 4's team policy library produces fragments the Phase 6 org-level policy engine consumes; the `nimbus excellence` agent can optionally aggregate DORA snapshots and stale-flag counts across federated peers (still LAN-bounded, no relay server).

#### Dependencies

- Phase 4 LLM router + multi-agent orchestration (the `nimbus excellence` agent is a built-in)
- Phase 4 Plugin API v1 (long-tail vendors land as community extensions)
- Phase 3 connector mesh + relationship graph (Phase 7 connectors stack on it)
- Phase 3.5 telemetry counters (engineering-metrics dashboard reads aggregate metrics from same pipeline)
- *Optional / enhancing only:* Phase 6 federation — see Composes-with note above

#### Structure

Four ordered waves. Waves 1 → 2 → 4 are sequential because Wave 2 references the `service` / `team` item types added in Wave 1, and Wave 4 (capstone) ties Waves 1–3 together. **Wave 3 has no dependency on Waves 1–2 and can land in parallel.**

#### Wave 1 — Service Catalog & Ownership

Adds `service`, `component`, `team`, `scorecard` item types and the ownership graph used by every later wave.

- [ ] **Backstage** (open-source IDP) — index `Component` / `API` / `System` / `Resource` / `Group` entities; `service` / `component` / `team` item types; cross-link `service → repository (github)`, `service → on-call (pagerduty)`, `service → dashboard (datadog/grafana)`; read-only; `catalog.entity.update` HITL
- [ ] **Cortex** — services, scorecards, on-call mappings, ownership; `service` + `scorecard` item types; read-only; `cortex.scorecard.acknowledge` HITL
- [ ] **OpsLevel** — services, rubrics, checks, levels; `service` + `scorecard` item types; read-only; `opslevel.check.run` HITL
- [ ] **Port** — entities, blueprints, scorecards, action runs; `service` + `component` item types; read-only; `port.action.run` HITL
- [ ] **Ownership graph** — extends the Phase 3 relationship graph with `code_symbol → service → team` resolution; `nimbus ask "who owns this file?"` answered locally without a live API call
- [ ] **`nimbus services list / show`** — CLI surface; supports `--owned-by`, `--scorecard-status`

#### Wave 2 — DORA / Engineering Metrics

Builds on Wave 1's `service` / `team` item types. Inherently aggregate-level so privacy posture is conservative — ingest only the user's own team metrics, never individual engineer PII beyond what the user already has access to in the source.

- [ ] **LinearB** — DORA metrics, deploy frequency, cycle time, deploy events, team rosters; `dora_metric` + `engineering_metric_snapshot` item types; read-only
- [ ] **Jellyfish** — engineering allocation, deliverable progress, team metrics; SSO-gated authentication; read-only
- [ ] **Swarmia** — DORA dashboards, work-item flow, investment dimensions; read-only
- [ ] **Sleuth** — deploy tracking, change failure rate, recovery time, lead time; `dora_metric` item type; read-only; `sleuth.incident.acknowledge` HITL
- [ ] **Engineering metrics dashboard** — Tauri UI panel + TUI pane: 4-metric DORA grid (deploy frequency, lead time, MTTR, change failure rate) × 7-day / 30-day / 90-day windows; renders from local index without a live API call
- [ ] **Continuous profiling & cost correlation** — connectors for Pyroscope and Datadog Profiler; profile flamegraphs index alongside the Wave 1 ownership graph so `nimbus ask "which recent PR caused the CPU spike in payment-service?"` resolves `service → repo → commit → flamegraph` from the local index without a live API call; `dora_metric` extended with profile-correlation rows
- [ ] **Developer-experience (DevEx) metrics** — connectors for DX, Atlassian Team Health, Jellyfish DevEx surveys; new `/excellence/devex` Tauri route renders survey scores side-by-side with the DORA grid; data flows through the same telemetry pipeline; drilldowns into specific surveys / sentiment categories; balances delivery speed with developer-burnout signal
- [ ] **SLO burn-rate forecaster** — connects to Datadog / Prometheus SLIs; runs a local regression on deploy frequency × change-failure rate × recent incident pattern × day-of-week seasonality to forecast whether the team will blow their error budget before month end; dashboard surfaces top-N feature contributions so the forecast is not a black box; no external ML infrastructure required
- [ ] **Privacy contract test** — asserts no individual-engineer-keyed metric is indexed unless the user is explicitly admin/owner in the source system

#### Wave 3 — Feature Flags & Experimentation

Independent of Waves 1–2; can ship in parallel. Critical: write tools are production-impacting, so HITL gating is non-negotiable and the consent dialog must show before/after rollout %, environments affected, and segment scope.

- [ ] **LaunchDarkly** — flags, environments, segments, rollout rules, kill switches; `feature_flag` + `experiment` item types; read-only by default; `flag.toggle`, `flag.rollout.update`, `flag.environment.override`, `flag.kill-switch.fire` all HITL
- [ ] **Split.io** — splits, treatments, experiments, metric impacts; `feature_flag` + `experiment` item types; read-only; `split.killswitch.fire` HITL
- [ ] **Flagsmith** (open source; self-hostable) — flags, environments, segments; `feature_flag` item type; read-only; `flag.toggle` HITL
- [ ] **Unleash** (open source; self-hostable) — toggles, strategies, gradual rollouts; read-only; `toggle.update` HITL
- [ ] **Statsig** — feature gates, dynamic configs, experiments; read-only; `gate.update`, `experiment.publish` HITL
- [ ] **Stale flag watcher** — fires on flags at 100% rollout > N days (default 90); surfaces in the morning briefing
- [ ] **`nimbus flags list / show`** — CLI surface; supports `--stale`, `--service`, `--environment`

#### Wave 4 — Shared Knowledge Graph + Automation Library + `nimbus excellence`

Capstone. Ties Waves 1–3 together; works on a solo machine, federation amplifies it.

- [ ] **Cross-team dependency graph** — extends Phase 3 relationship graph with team boundaries; resolves "what other teams' services depend on mine?" without a live catalog API call
- [ ] **Automation template library** — local store of reusable watcher + workflow templates ("CI failure → Slack thread → rerun once → if still failing, escalate"); user can publish a template to a named local library; templates are pure declarative TOML, no embedded credentials
- [ ] **Pattern recognition** — agent identifies repeated incident-response patterns from indexed history; surfaces them as automation template candidates ("you've followed this same 3-step recovery 4 times — save as template?"); explicit user confirm required (no silent learning)
- [ ] **Team policy library** — shared policy fragments (HITL thresholds, connector allowlists, retention floors) consumable by the Phase 6 policy engine when available; on a solo machine, used as user-level config presets
- [ ] **ADR auto-drafter** — watcher fires on architectural shifts (lockfile diffs, migration file appearance, IaC resource-type changes); agent drafts an Architecture Decision Record from the diff + recent commit context; HITL-gated push to Notion / Confluence / `docs/adrs/`; keeps documentation alive without manual nagging
- [ ] **`nimbus excellence` built-in agent** — read-only, parallel sub-agents over: service catalog, DORA metrics, feature flags, recent deploy/incident activity; emits `agents.excellence.briefReady` notification; CLI surface `nimbus excellence [--service <name> | --team <name>]` (mirrors `nimbus expert / impact / catchup` per `nimbus-agent-patterns`)
- [ ] **Excellence dashboard** — Tauri page combining DORA grid + service-catalog browser + stale-flag list + automation template list

#### Stretch (does not gate phase completion)

- [ ] **Long-tail vendors as community extensions** — Atlassian Compass, Roadie (managed Backstage), Configu, Hatica, Code Climate Velocity, GitClear; ship via Marketplace v2 per the "comprehensive then community" model
- [ ] **Self-hosted preference path** — Flagsmith / Unleash / Backstage self-hosted variants documented as the recommended privacy-conservative defaults; matches Nimbus values
- [ ] **Cross-vendor DORA harmonisation** — when two DORA connectors are connected (e.g. LinearB + Sleuth), the engine reconciles overlapping metrics with a configurable preference order; surfaces a "DORA confidence" indicator

#### Acceptance Criteria

- A connected Backstage instance with 50+ services indexes in under 60 seconds; `nimbus services list --owned-by my-team` returns the correct subset from the local index without a live API call
- `nimbus ask "who owns src/billing/retry.ts?"` resolves the chain `code_symbol → repository → service → team` from the local relationship graph in under 200 ms
- DORA dashboard renders 4-metric × 7-day / 30-day / 90-day grid for one indexed team without a live API call to LinearB / Jellyfish / Swarmia / Sleuth
- Toggling a LaunchDarkly flag via `nimbus flag toggle <key>` requires HITL; the consent dialog shows before/after rollout %, environments affected, and segments scoped; rejection logs `hitl_status = 'rejected'` to the audit chain
- A stale-flag watcher fires on a flag at 100% rollout for the configured threshold; surfaces in the morning briefing without a separate query
- An automation template saved from a recognised incident pattern can be applied to a fresh incident matching the same pattern; user explicitly approves application
- `nimbus excellence --team my-team` returns a Markdown brief with: top 3 services by recent change, 4-metric DORA snapshot, stale flag count, open-incident count — all from the local index, in under 15 s on a mid-range laptop
- Privacy contract test passes: no individual-engineer-keyed metric is indexed unless source-system role grants the user access

---

### Phase 8 — Security Engineering

**Goal:** Bring the security practitioner's tool surface into the local index and ship the four built-in security agents that turn that surface into actionable briefs. Read-first; every write tool gates on HITL with rich diff preview because security writes (acknowledging vulnerabilities, rotating secrets, suppressing findings) are decisions with downstream consequences. Full design in [`docs/superpowers/specs/2026-05-10-phase-8-security-engineering-design.md`](./superpowers/specs/2026-05-10-phase-8-security-engineering-design.md).

> **Composes with Phase 7 (Engineering Excellence):** Phase 7 scorecards consume security-posture metrics produced here (open-vuln count, secret-rotation overdue count); Phase 8 service-attribution joins back to the Phase 7 service catalog so a finding routes to its owner team without a live API call.
>
> **Composes with Phase 10 (The Autonomous Agent):** Phase 10's incident correlation engine queries security findings from the Phase 8 index. The two `nimbus incident*` agents are deliberately distinct — Phase 8's `nimbus incident` is security-shaped (attacker indicators, exposed endpoints, vuln CVEs, IR runbooks); Phase 10's `nimbus incident-brief` is operational (deploy → PR → commit → CI → Slack). When both ship, each brief includes a section sourced from the other domain.

#### Dependencies

- Phase 4 LLM router + multi-agent orchestration (built-in agents)
- Phase 4 Plugin API v1 (long-tail vendors as community extensions)
- Phase 3 connector mesh + relationship graph
- Phase 7 service catalog (`service` / `team` item types — security findings attribute to services and route to owner teams)
- Phase 3.5 telemetry counters

#### Wave 1 — Code & Dependency Scanning

- [x] **Snyk** (Code + Open Source + Container) — SAST, SCA vulns, container scan. Read-only read-tools landed early in Phase 5 (2026-05-21, T2/Wave-A connector Snyk) — `snyk:vulnerability` item type indexed via the gateway-side syncable at `packages/gateway/src/connectors/snyk-sync.ts` (walks `/v1/orgs` → `/v1/org/<id>/projects` → `/v1/org/<id>/project/<pid>/aggregated-issues`), with metadata `{ severity, cve_id, affected_package, affected_versions, fix_available, fix_version, project_url, project_id, org_id, type, disclosed_at, published_at }`; first-party MCP package at `packages/mcp-connectors/snyk/` hosts the three mandatory read tools (`snyk_list`, `snyk_get`, `snyk_search`); sandbox manifest pins `permissions.network` to `api.snyk.io`; `snyk:vulnerability` added to `PROSE_HEAVY_TYPES` (description field is paragraph-shaped). Write tool `snyk.issue.ignore` HITL deferred — when Phase 8 ships it, gate via `engine/executor.ts` `HITL_REQUIRED`.
- [ ] **Semgrep** — SAST rules + custom packs; `semgrep.finding.suppress` HITL
- [ ] **SonarQube** — code-quality + security hotspots; `sonar.hotspot.review` HITL
- [ ] **GitGuardian** — secret findings, severity, validation; `gg.incident.resolve`, `gg.secret.invalidate` HITL
- [ ] **TruffleHog** (open source, self-hostable) — secret findings; `trufflehog.finding.suppress` HITL
- [ ] **Dependabot / Renovate state** — read-only; open dependency PRs, severity, age
- [ ] **`nimbus security <repo|service>`** — built-in agent ranking open findings by severity × exploitability × age; emits `agents.security.briefReady`

#### Wave 2 — Cloud & Container Security Posture

- [ ] **Wiz** — CSPM findings, attack-path graph, identity over-permissions; `wiz.issue.assign`, `wiz.issue.resolve` HITL
- [ ] **Prisma Cloud** — CSPM, CWPP, CIEM; `prisma.alert.acknowledge` HITL
- [ ] **Trivy** (open source, offline) — container/image scan, IaC scan, license check; read-only
- [ ] **Checkov** — IaC misconfig findings (Terraform, CloudFormation, Helm, Kubernetes manifests); `checkov.finding.suppress` HITL
- [ ] **Sysdig / Falco** — runtime threat detections, policy violations; `sysdig.alert.silence` HITL
- [ ] **`nimbus posture <cloud-account|cluster>`** — built-in agent ranking by exploitability × blast radius × asset criticality; emits `agents.posture.briefReady`

#### Wave 3 — Incident Response & SOC

- [ ] **FireHydrant** — incidents, runbooks, retros, severity, affected services; `firehydrant.incident.update`, `firehydrant.incident.resolve` HITL
- [ ] **Rootly** — incidents, retro templates, action items; `rootly.incident.update` HITL
- [ ] **Tines** (SOAR) — story runs, action history; `tines.story.run` HITL (running an automation is a write)
- [ ] **Splunk Search** (read-only SIEM) — saved searches, recent results, alert configurations
- [ ] **Microsoft Sentinel** (read-only) — incidents, analytic rules, recent alerts
- [ ] **VirusTotal** — hash / IP / domain reputation, recent submissions; read-only
- [ ] **`nimbus incident <alert-id|incident-id>`** — security-incident-shaped: attacker indicators (IPs, hashes, domains), affected services + owners, exposed endpoints, recent vulnerable deploys, IR runbook recommendations; emits `agents.security_incident.briefReady`. **Distinct** from Phase 10's `nimbus incident-brief` (operational shape).

#### Wave 4 — Supply Chain & Identity

- [ ] **Sigstore Rekor** — signed artifacts, transparency-log entries; read-only (Rekor is append-only globally)
- [ ] **in-toto / SLSA provenance** — build provenance, attestation graph; read-only
- [ ] **Okta logs** (System Log API) — sign-in events, MFA challenges, admin actions; `okta.user.suspend` HITL
- [ ] **Azure AD audit** — sign-in events, conditional-access decisions, role assignments; read-only
- [ ] **HashiCorp Vault audit log** — secret reads, role bindings, policy changes; read-only
- [ ] **Doppler** — secret access events, environment configs; `doppler.secret.rotate` HITL
- [ ] **Synthetic credential honeytokens** — Nimbus generates fake credentials in the local workspace (e.g., `.env.local`) and registers them with the watcher; outbound process env / log emissions are scanned for the tokens, and any hit triggers an immediate audit-log entry + HITL prompt; active intrusion detection at the workstation level
- [ ] **Least-privilege auto-remediation** — agent watches AWS IAM and Okta usage (Wave 4 Okta logs ingestion provides the visibility) and drafts terraform / config PRs to revoke unused permissions after 30 days; HITL-gated merge; enforces least privilege without manual hunting
- [ ] **`nimbus supply-chain <repo|artifact>`** — SBOM diff against last release, signed-vs-unsigned dependencies, attestation gaps, license-policy violations, transparency-log presence; emits `agents.supply_chain.briefReady`

#### Stretch (does not gate phase completion)

- [ ] **Long-tail vendors as community extensions** — Lacework, Orca, Aqua, Anchore, Mend, FOSSA, Black Duck, Tracecat, Torq, Recorded Future, MISP
- [ ] **`nimbus security --remediate <finding-id>`** — agent proposes a fix PR for highest-confidence findings (lockfile bump for SCA, secret-rotation flow for GitGuardian); HITL-gated; experimental
- [ ] **STIX/TAXII threat-intel feed** — read-only ingestion of community threat-intel feeds into the `threat_indicator` table

#### Acceptance Criteria

- A connected Snyk org with 100+ open vulns indexes in under 60 s; `nimbus security my-service` returns the top-N ranked open findings from the local index without a live API call
- `nimbus posture aws-prod` returns CSPM + IaC + runtime findings ranked by exploitability × blast radius from the local index in under 15 s
- A FireHydrant incident closure via `nimbus` requires HITL with a structured before/after diff; rejection logs `hitl_status = 'rejected'`
- `nimbus incident` (security-shaped) returns a Markdown brief with attacker indicators + affected services + recent deploys in under 15 s; verified distinct from Phase 10's `nimbus incident-brief` shape via e2e test
- `nimbus supply-chain my-service` returns the SBOM diff + attestation gaps + license-policy violations in under 15 s, all from the local index
- Sigstore Rekor entries are verified before the local index records `sbom_artifact.is_signed = true` (no trust-on-first-use)
- Privacy contract: identity-event ingestion is read-only by default; the only write operations are HITL-gated `okta.user.suspend` and `doppler.secret.rotate`

---

### Phase 9 — AI Engineering Loop

**Goal:** Bring the tool surface that ML engineers and AI-product teams already use into the local index, and ship `nimbus model-health` + `nimbus rag-health` to surface actionable status without a live API call. Read-first for ingestion; HITL on the few write tools (`prompt.deploy`, `model.promote-stage`, `feature.publish`) because pushing a prompt or promoting a model is a production change. Full design in [`docs/superpowers/specs/2026-05-10-phase-9-ai-engineering-loop-design.md`](./superpowers/specs/2026-05-10-phase-9-ai-engineering-loop-design.md).

> **Composes with Phase 8 (Security Engineering):** supply-chain attestations from Phase 8 Wave 4 extend to model artifacts — a deployed model can be queried "does it have a signed SLSA provenance? what's its base-model dependency CVE state?"
>
> **Composes with Phase 10 (The Autonomous Agent):** Phase 10's incident correlation engine pulls AI-Eng Loop signals when an LLM-backed feature is in the affected scope. Phase 10's standing-approval engine can suppress noise from `nimbus model-health` after N consecutive identical decisions.

#### Dependencies

- Phase 4 LLM router + multi-agent orchestration
- Phase 4 Plugin API v1
- Phase 3 connector mesh + relationship graph
- Phase 7 service catalog (AI features attribute to services and route to owner teams)
- Phase 3.5 telemetry counters

#### Wave 1 — LLM Observability & Evaluation

- [ ] **Helicone** — LLM traces, latency p50/p95/p99, cost per request, error rate; read-only
- [ ] **Langfuse** (open source, self-hostable) — traces, sessions, prompt versions, eval datasets; `langfuse.prompt.deploy` HITL
- [ ] **LangSmith** — traces, datasets, eval-run results, prompt versions in LangSmith Hub; `langsmith.prompt.commit` HITL
- [ ] **Braintrust** — eval runs, scorers, prompt versions, regressions; `braintrust.prompt.deploy` HITL
- [ ] **Promptfoo** (open source CLI) — eval-run state from `promptfoo.yaml` runs in CI; read-only
- [ ] **Prompt-regression watcher** — fires when an eval-suite pass-rate drops below threshold (configurable; default 95% of trailing 7-day mean)
- [ ] **AI context minimizer** — periodic agent over Helicone / Langfuse / LangSmith trace ingestion; analyses prompt traces, identifies context segments the LLM didn't materially use, and surfaces removal suggestions; directly reduces token cost and latency on the user's own prompts

#### Wave 2 — ML Model Lifecycle

Phase 5/6 already index model registry entries from MLflow / SageMaker / Vertex AI; Phase 9 adds the **operational** signals.

- [ ] **Arize AI** — model monitors, drift signals, performance segments; `arize.monitor.acknowledge` HITL
- [ ] **WhyLabs** (open core) — data profiles, drift detections, model performance; `whylabs.monitor.silence` HITL
- [ ] **Feast** (open source) — feature views, online/offline freshness, materialisation status; `feast.feature.materialize` HITL
- [ ] **Tecton** — feature pipelines, materialisation state, online-store health; `tecton.feature.publish` HITL
- [ ] **Fiddler** — model performance, fairness/bias monitors, segment drilldowns; `fiddler.monitor.acknowledge` HITL

#### Wave 3 — Vector Stores & RAG Infrastructure

- [ ] **Pinecone** — indexes, namespace stats, vector count, recent upsert/delete events; read-only (Phase 9 write surface deferred)
- [ ] **Weaviate** (open source, self-hostable) — classes/collections, object counts, schema versions, recent imports; read-only
- [ ] **Qdrant** (open source, self-hostable) — collections, point counts, snapshot list; read-only
- [ ] **Chroma** — collections, embedding-function versions, document counts; read-only
- [ ] **Ragas / TruLens** (CLI integration) — RAG eval runs, faithfulness / answer-relevance / context-precision scores; read-only
- [ ] **Embedding-drift watcher** — fires when a vector index's embedding-function version diverges from the model that originally embedded the indexed content; surfaces in morning briefing

#### Wave 4 — AI Cost & Governance

- [ ] **OpenAI usage export** — per-API-key, per-model spend, token counts, daily aggregates; read-only
- [ ] **Anthropic usage export** — per-API-key spend, token counts, model breakdown; read-only
- [ ] **AWS Bedrock spend** (via Cost Explorer) — per-model invocations, on-demand vs. provisioned spend; read-only
- [ ] **Vertex AI spend** (via Cloud Billing export) — per-model spend, prediction unit counts; read-only
- [ ] **Model-policy registry** (in-Nimbus) — declarative policy: which model class for which task class, redaction policy before send, data-residency mappings; `policy.update` HITL
- [ ] **AI cost watcher** — fires when 24 h spend exceeds 7-day rolling average by configurable threshold (default 50%); surfaces in morning briefing
- [ ] **Policy-violation watcher** — fires when an LLM call routes to a model class violating the active policy (e.g. PII data class to non-residency-compliant model); blocks via the existing LLM router air-gap mechanism

#### Built-in Agents

- [ ] **`nimbus model-health [<model-name>]`** — parallel sub-agents over LLM observability + eval + cost connectors; per-model brief with latency p50/p95/p99, eval-suite pass rate trajectory, cost burn vs. budget, recent prompt regressions, drift indicators; emits `agents.modelHealth.briefReady`
- [ ] **`nimbus rag-health [<rag-app-name>]`** — parallel sub-agents over vector-store + RAG-eval + ingestion connectors; per-application brief with retrieval-quality scores, embedding-version drift, vector-store health, knowledge-base freshness, recent ingestion failures; emits `agents.ragHealth.briefReady`

#### Stretch (does not gate phase completion)

- [ ] **Long-tail vendors as community extensions** — Aporia, Phoenix Arize, OpenLLMetry, Pezzo, Hopsworks, Featureform, Dynamic.ai, Confident AI, DeepEval
- [ ] **Eval-as-a-watcher** — `nimbus` runs Promptfoo evals locally on a configurable schedule against locally-indexed prompt versions; results feed `nimbus model-health`. Two use cases share the same primitive: (a) **zero-shot bring-your-own-model evaluator** — download a newly released open-source model and run the existing eval suite locally to see if it is better for the team's use case; (b) **prompt A/B testing** — route a prompt-diff through the same eval suite and compare pass rates before recommending the new version
- [ ] **Local fine-tuning data curation** — agent identifies high-quality human artefacts (well-written incident post-mortems, effective PR reviews, polished design docs) from the local index and packages them into a JSONL dataset for Phase 14 style / voice fine-tuning; distinct from Phase 14's tool-use trace dataset builder (which targets agent traces); user approves the dataset before fine-tune kickoff
- [ ] **Bring-your-own-model fine-tune trace** — when Phase 14 (AI v2) ships fine-tuning, Phase 9 indexes the resulting fine-tuned model's training-run telemetry as `ml_model` rows

#### Acceptance Criteria

- A connected Helicone account with 1M+ traces indexes recent traces (last 24 h) in under 60 s; `nimbus model-health gpt-4o-prod` returns latency p50/p95/p99 + cost burn from the local index in under 15 s with no live API call
- A prompt-regression watcher fires on a connected Braintrust suite when pass-rate drops below threshold; surfaces in morning briefing
- `nimbus rag-health my-rag-app` returns retrieval-quality scores from a connected Ragas eval-run history + vector-store stats from Pinecone in under 15 s, locally
- An embedding-drift watcher detects a Pinecone index whose embedding-function version no longer matches the indexing-time model and surfaces a structured remediation suggestion (re-index)
- AI cost watcher fires on a 50 % daily-spend spike against the 7-day rolling baseline; surfaces in morning briefing with per-key attribution
- Policy-violation watcher blocks an LLM call routing to a non-policy model class (verified via LLM router integration test); decision recorded in audit log
- Privacy contract: no LLM trace body content is exfiltrated; only per-trace metadata (latency, cost, model id, success/error) is indexed unless the user explicitly opts in via `[ai_engineering].index_trace_bodies = true`

---

### Phase 10 — The Autonomous Agent

**Goal:** Transform Nimbus from a reactive tool into a proactive collaborator that watches, learns, and acts — always within the bounds of what you have authorised.

**Scope note:** This phase contains items with very different risk and complexity profiles. Standing approvals, scheduled workflows, morning briefings, deadline tracking, and the incident correlation engine are low-risk, buildable directly on Phase 3 infrastructure, and form the **core** of this phase. LoRA fine-tuning and the Infrastructure-as-Agent SRE loop are research-adjacent and are marked **stretch** — they do not gate phase completion if the core items pass their acceptance criteria.

#### Dependencies

- Phase 3 Watcher system and RAG conversational memory
- Phase 3 Proactive anomaly detection (watcher baseline learning)
- Phase 4 Local LLM support and multi-agent orchestration
- Phase 4 Tamper-evident audit log (standing approvals are recorded and auditable)

#### Core — Standing Approvals & Scheduling

- [ ] **Standing approval rules** — users pre-authorise specific recurring write patterns; stored in SQLite with explicit scope, expiry, and item count ceiling; agent checks standing rules before prompting for HITL. Canonical use cases include autonomous drafting of dependency-update PRs (Dependabot / Renovate equivalents) and lint-fix PRs once the user has approved the same pattern N times in a row
- [ ] **Approval learning** — after N consecutive identical approvals (configurable; default: 5), Nimbus suggests a standing rule; user must explicitly confirm; suggestion is logged
- [ ] **Confidence Score for standing approvals** — standing rules require a confidence score based on contextual similarity (same service, time of day, user location) to prevent over-permissioning
- [ ] **Standing rule management** — `nimbus approve list`, `pause`, `revoke`; each rule shows match scope, expiry, action count, last-fired timestamp
- [ ] **Audit trail for standing approvals** — every action taken under a standing rule logged with rule ID, matched scope, and timestamp; `nimbus audit standing` shows per-rule history
- [ ] **Scheduled workflows** — watchers trigger workflow pipelines on `schedule` condition (cron syntax); read-only workflows run unattended; write workflows with standing-approved steps also run unattended; HITL-required steps without a standing rule block and notify
- [ ] **Morning briefing** — built-in scheduled workflow: cross-service summary (open PRs, active incidents, overdue tickets, unread threads) delivered via notification system at a configured time
- [ ] **Privacy-preserving agent-to-agent scheduling** — one user's agent negotiates meeting times with another's over the Phase 6 federated channel; returns mutually available slots without leaking full calendar details
- [ ] **Deadline tracking** — monitors items with due dates across Linear, Jira, GitHub, and Calendar; fires notification 24h before deadline when no recent activity is detected on the item
- [ ] **`nimbus schedule list`** — shows all active scheduled workflows with next fire time and last run status

#### Core — Incident Correlation Engine

- [ ] **Automatic incident assembly** — when a monitoring alert fires, agent automatically queries the local index for: last deployment before the alert, associated PR, triggering commit, CI run result, Slack/Teams threads mentioning the affected service; assembles a structured incident summary without any user query. For **data-platform** alerts (PagerDuty events tagged `data`, Monte Carlo / Bigeye incidents, failing dbt test notifications) the same assembly also pulls: last Airflow / Dagster / Prefect DAG run logs, recent dbt test failures, recent warehouse schema changes (Snowflake / BigQuery `INFORMATION_SCHEMA` deltas), and the dbt-model-authoring PRs merged in the preceding 24 hours — delivered as a single "Data Incident Brief"
- [ ] **Incident timeline** — structured Markdown timeline (alert → deploy → commit → PR → CI); exported via `nimbus incident show <alert-id>` or surfaced in the Tauri dashboard
- [ ] **Proactive technical debt detection** — agent flags code symbols that haven't been touched in months but are frequently referenced in failing pipelines or incident logs
- [ ] **Suggested remediation** — agent proposes a remediation action (rollback, restart, scale-up) based on indexed history of similar incidents; always HITL-gated before execution
- [ ] **Post-mortem generation** — after incident resolution, agent drafts a structured post-mortem (timeline, root cause, contributing factors, action items) from the assembled incident record and HITL decision log; user reviews and edits before HITL-gated push to Notion or Confluence; template is configurable
- [ ] **On-call schedule awareness** — indexes PagerDuty/OpsGenie on-call schedules; answers `nimbus ask "who's on call for payment-service right now?"` from the local index; feeds on-call context into the morning briefing and incident assembly so the agent can route notifications to the right engineer without an additional API call

#### Core — Agent Memory & Personalization

- [ ] **Long-term episodic memory** — agent stores summarised observations from past sessions in a dedicated SQLite table; recalled at query time via semantic similarity
- [ ] **Personalization layer** — agent adapts communication style and tool selection priority based on observed user preferences; preferences are explicit (configurable), not inferred silently
- [ ] **Automated PR pre-review** — agent performs "lint-plus" review based on team's historical review patterns (e.g., "In this repo, we usually ask for Y when X is changed")
- [ ] **Decision pattern recognition** — agent identifies repeated HITL decision patterns across history; surfaces them as standing rule candidates
- [ ] **Point-in-time index queries** — ability to reconstruct the state of the indexed data at a specific historical timestamp using sync history and item `modified_at` metadata already stored in the index. Enables queries like `nimbus ask "what was the deployment state of payment-service at 14:32 last Tuesday?"` for post-incident analysis. Implementation: the query layer filters indexed items to their state at the requested timestamp using `modified_at` and sync cycle timestamps already recorded in `sync_state`; no new data collection required. Exposed via `--at <ISO8601-or-relative-time>` flag on `nimbus ask` and `nimbus query`. Read-only, no HITL.

#### Core — LAN Hardening (deferred from Phase 4 B1 audit)

- [ ] **LAN forward secrecy (S3-F8)** — replace the static X25519 pairing identity with per-session ephemeral DH so a future pairing-key compromise cannot decrypt past LAN sessions; multi-PR handshake redesign incompatible with the v0.1.0 LAN protocol — gated on a versioned LAN handshake bump; tracked from the Phase 4 internal security audit (B1, 2026-04-25)

#### Stretch — Local Model Fine-Tuning

*These items do not gate phase completion. They are explicitly aspirational.*

- [ ] **LoRA adapter training** — train lightweight adapters on the user's own writing style (emails, Slack messages, Notion pages, PR descriptions) using local NPU/GPU; model: Llama 3 or Mistral base; no data leaves the machine
- [ ] **Domain-specific recall** — fine-tuned adapter improves agent's ability to match user naming conventions and project context when drafting or classifying
- [ ] **`nimbus model train --adapter writing-style`** — background fine-tuning job; `nimbus model status` shows progress; adapters versioned and rollback-safe

#### Stretch — Infrastructure-as-Agent (SRE Loop)

*These items do not gate phase completion. They are explicitly aspirational.*

- [ ] **Autonomous drift detection** — agent continuously compares IaC declared state against indexed live cloud state; flags drift in the dashboard without waiting for a user query
- [ ] **Remediation proposals** — agent drafts `terraform plan` or equivalent for detected drift; user reviews diff in HITL dialog; no cloud mutation without approval
- [ ] **Cost anomaly detection** — monitors Cost Explorer / Azure Cost Management / GCP Billing daily spend; alerts when 24h spend exceeds 7-day rolling average by a configurable threshold; once Phase 6 BI connectors land, the same detection window covers Snowflake credit consumption and Databricks DBU usage
- [ ] **Cloud cost "garbage collection"** — agent identifies orphaned cloud resources (unattached EBS volumes, empty staging environments, stale ALB target groups, orphaned snapshots) and queues them for deletion behind a single HITL click; distinct from cost anomaly detection (which surfaces *spend* spikes) — this finds *waste* that doesn't move the cost needle but is pure garbage; direct measurable savings with zero manual hunting
- [ ] **Data FinOps attribution** (depends on Phase 6 warehouse connectors) — correlates Snowflake / BigQuery / Databricks query cost rows with the specific notebook, Airflow task, dbt run, or user that triggered them; joins warehouse `QUERY_HISTORY` (or equivalent) with orchestration run metadata in the local index; answers "show me the top 5 most expensive notebooks run yesterday and who ran them" without a single live warehouse API call; stretch — does not gate Phase 10 completion
- [ ] **FinOps connectors** — third-party FinOps platforms feed the cost anomaly detector with cleaner per-team / per-tag attribution than raw cloud billing exports: **Vantage**, **CloudHealth (VMware Tanzu)**, **Spot.io / Flexera**, **Kubecost** (Kubernetes per-pod cost), **OpenCost** (open source CNCF project)
- [ ] **Sustainability connectors** — carbon-footprint reporting feeds the SRE loop's "right-size to lower-carbon region" recommendations: **Cloud Carbon Footprint** (open source), **Climatiq**, **Watershed**, AWS / Azure / GCP carbon footprint exports
- [ ] **Runbook automation** — common SRE runbooks registered as named HITL-gated actions; agent proposes the right runbook when an incident matches a known pattern

#### Acceptance Criteria (core items only)

- A standing approval rule for "archive read Gmail threads older than 60 days" executes its next scheduled run without any user prompt; every archived thread appears in the audit log under the rule ID
- When a PagerDuty P1 fires, the incident summary (deploy, PR, commit, CI result, Slack thread) is assembled and available via `nimbus incident show` within 30 seconds of the alert being indexed — no user query required
- A morning briefing workflow runs fully unattended; any write step without a standing rule sends a notification and blocks rather than executing silently
- `nimbus ask "who's on call for payment-service right now?"` returns the correct engineer from the indexed PagerDuty schedule without a live API call
- A post-mortem draft for a resolved incident is generated from the incident record and surfaced for review; the HITL-gated push to Notion succeeds only after the user explicitly approves
- `nimbus ask "what PRs were open for payment-service at 09:00 yesterday?" --at yesterday-09:00` returns results consistent with the indexed sync history for that timestamp, verified by seeding the index with timestamped items and confirming the filter excludes items modified after the requested time

---

### Phase 11 — Sovereign Mesh

**Goal:** Extend Nimbus beyond the single machine — across the user's own devices, between trusted people, and into the physical world — without any relay server or trusted third party.

**Note on the Digital Executor:** The dead man's switch and Shamir's Secret Sharing items address a real use case: secure handover of credentials and cryptographic keys to trusted people upon death or extended incapacitation. They are included because they are a natural extension of the local sovereignty model — if Nimbus holds the keys to your digital life, it should have a principled way to hand them to the people you designate. They are not a novelty feature; they are the logical conclusion of the "no cloud, no intermediary" architecture applied to the hardest edge case.

#### Dependencies

- Phase 4 tamper-evident audit log and data export/import
- Phase 6 federation protocol (Nimbus-to-Nimbus channel is the mesh primitive)
- Phase 10 standing approvals (mobile HITL approvals are a standing-approval variant)

#### Cross-Device Sync

- [ ] **P2P index sync** — encrypted index sync between a user's own machines; BLAKE3-keyed protocol; vector-clock conflict resolution; no third party
- [ ] **Selective sync** — user controls which `item` types and services sync to which device; configuration stored in the Vault per profile
- [ ] **Sync conflict resolution UI** — diverged devices surface conflict in the dashboard with diff view; user resolves manually or accepts one side
- [ ] **Geofenced context switching** — Phase 3.5 configuration profiles extended with a "trusted-network" gate; sensitive index namespaces auto-disable sync (and optionally lock the Vault) when the device connects to an untrusted / public Wi-Fi BSSID; configuration is local-only, no cloud involved
- [ ] **Mesh backup sharding** — encrypted shards of the index + Vault are distributed across the user's trusted devices using erasure coding over the Phase 6 federation channel; recovery from any M-of-N shards; reuses the Digital Executor's Shamir cryptographic shape applied to live backup instead of inheritance; eliminates the need for cloud backup while preserving durability

#### Mobile Companion

- [ ] **iOS app** — connects to home Gateway over E2EE LAN or WireGuard tunnel; no cloud relay; natural language queries, HITL approval queue, watcher notifications, read-only connector status
- [ ] **Android app** — same feature set as iOS
- [ ] **Push notifications** — via local push (LAN) or WireGuard; no third-party push service required; opt-in to cloud push (APNs/FCM) for out-of-LAN reachability
- [ ] **Biometric HITL** — use the Mobile Companion as the primary HITL gate; approvals cryptographically signed with a device key and authorized via FaceID/TouchID for a superior security/UX balance
- [ ] **Mobile HITL signature** — approvals cryptographically signed with a device key stored in the phone's secure enclave

#### Physical Sovereignty

- [ ] **Hardware vault integration** — YubiKey and Ledger as a second factor; FIDO2/WebAuthn locally; unlock requires physical device presence
- [ ] **Hardware audit-log signing** — support for Nitrokey or OpenPGP cards to cryptographically sign the BLAKE3 audit chain, making it physically tamper-proof
- [ ] **Air-gapped secret management** — credentials for sensitive connectors stored exclusively on a hardware key; Gateway requests them via USB/NFC at sync time; never written to disk even temporarily
- [ ] **Decentralized Identifiers (DIDs)** — self-sovereign DIDs for Nimbus-to-Nimbus authentication; DID document stored locally; no central registry required

#### Digital Executor

- [ ] **Dead man's switch** — configures cryptographic keys and documents to be handed over to named recipients if Gateway is inactive for a configurable period
- [ ] **Threshold secret sharing** — executor payload split using Shamir's Secret Sharing across N trusted recipients; any M-of-N can reconstruct; no single recipient can access it alone. Extends to runtime privileged credentials (production secrets, root tokens) so no single engineer or compromised machine can unilaterally access critical credentials — same Shamir primitive applied to live credentials instead of inheritance payload
- [ ] **Executor audit trail** — every check-in, near-trigger, and handover event logged in the tamper-evident audit chain; recipients receive a verifiable log alongside the payload

#### Stretch — Internationalisation (i18n / l10n)

The mobile companion is the natural moment to introduce locale awareness; the same string-extraction effort serves the Tauri UI, CLI, and TUI. Does not gate phase completion.

- [ ] **String-extraction pass** — extract all user-facing strings in the Tauri UI (`packages/ui/src/`), CLI (`packages/cli/src/`), and TUI (`packages/cli/src/tui/`) into resource bundles; English remains the source-of-truth locale
- [ ] **Reference locales (3)** — ship Spanish (es), French (fr), and Japanese (ja) as the first three translated locales; community contributors handle additional locales via `packages/locales/<lang>/`
- [ ] **Locale-aware formatting** — date / time / number formatting throughout the UI uses `Intl.*`; CLI respects `LC_TIME` / `LC_NUMERIC` envs
- [ ] **Right-to-left support** — Tauri UI honours `dir="rtl"` for RTL locales; verified with Hebrew sample translation in QA
- [ ] **Indexed-content character-set robustness** — the FTS5 tokeniser handles CJK + non-Latin scripts correctly; verified by an integration test that indexes a Japanese-language Notion page and queries it back

#### Acceptance Criteria

- Index syncs between two machines on the same LAN in under 60 seconds for a 50,000-item dataset; no data passes through any external server
- A HITL approval made on the mobile app executes within 5 seconds on the home Gateway; action and approval signature appear in the local audit log
- Removing a YubiKey while the Gateway is running causes credential access to fail gracefully; re-inserting resumes normal operation without re-auth
- A Digital Executor payload reconstructed by M-of-N recipients is byte-identical to the original and its audit chain passes `nimbus audit verify`

---

### Phase 12 — Enterprise

**Goal:** Make Nimbus deployable and auditable at institutional scale. Tied to the commercial license tier — AGPL users retain all individual and team features; enterprise deployment, compliance tooling, and SLA support are commercial.

**Dependency note:** The Phase 10 dependency is narrowed to **standing approvals only**. Docker, Helm, SAML SSO, audit log shipping, and SCIM provisioning do not require the autonomous agent or LoRA fine-tuning to be complete. The SRE loop stretch items are independent of enterprise deployment.

#### Dependencies

- Phase 6 Team (Enterprise builds on the team collaboration foundation)
- Phase 4 tamper-evident audit log (required for compliance export)
- Phase 10 standing approvals (required for unattended enterprise workflows)
- Phase 3.5 telemetry infrastructure (audit log shipping uses the same batched-transmission pipeline)

#### Deployment & Operations

- [ ] **Docker image** — official `ghcr.io/nimbus/gateway` image; multi-arch (amd64/arm64); configurable via env vars and mounted `nimbus.toml`
- [ ] **Helm chart** — `nimbus/gateway` Helm chart for Kubernetes; namespace isolation, persistent volume for SQLite, external Vault backend (HashiCorp Vault), RBAC, NetworkPolicy
- [ ] **Air-gapped bundle** — single tarball with all binaries, local LLM model weights, and dependency assets; no outbound internet access required
- [ ] **"Clean room" AI deployment mode** — named deployment topology where sensitive compliance / HR data is processed exclusively on an air-gapped node within the enterprise, never hitting the broader LAN or any cloud endpoint; builds on the air-gapped bundle + data residency controls but elevates the configuration to a first-class topology that auditors can certify; unblocks AI adoption for the highest-regulation data classifications
- [ ] **High availability** — active/passive Gateway clustering; leader election via SQLite WAL + advisory lock; failover in under 30 seconds
- [ ] **Managed update channel** — enterprise updates on a dedicated channel with 2-week delay vs. main; allows internal QA before rollout
- [ ] **Remote vector store adapters** — pluggable `VectorStore` interface with Qdrant, Weaviate, and Pinecone backends; `sqlite-vec` remains the default (local-first principle); remote backend enabled only via explicit `[index.vector_store]` config block — never on by default; suitable for enterprise deployments with centralised vector infrastructure or index sizes exceeding local storage thresholds; resolves the Phase 3 deferral (remote stores were incompatible with local-first for individual users; self-hosted enterprise deployments clear the privacy boundary)

#### Centralized Policy & Compliance

- [ ] **Policy-as-code** — `nimbus.policy.toml` extended for enterprise: per-user role assignments, connector allowlists, data classification labels, mandatory audit log shipping, HITL threshold overrides per user group
- [ ] **Data Loss Prevention (DLP) Gate** — pre-dispatch scanner that flags PII, secrets, or "Internal Only" content before it is sent to remote LLMs or exported
- [ ] **Audit log shipping** — `audit_log` rows streamed (append-only, tamper-evident) to SIEM targets (Splunk, Elastic, Datadog Logs), S3/GCS/Azure Blob, or a mounted file path; fire-and-forget with local retention as fallback
- [ ] **Compliance posture tooling** — `nimbus compliance check` reports: credential storage status, audit log integrity, plaintext credential scan result, connector scope minimization status; structured JSON output suitable for auditors
- [ ] **Legal Hold & Discovery** — compliance mode to "freeze" index state or export an immutable subset of the audit log for legal discovery
- [ ] **Data residency controls** — per-connector restriction to a named geographic boundary; Gateway enforces at ingest; non-compliant items flagged and excluded from the index
- [ ] **Formal security audit** — third-party penetration test of Gateway, IPC surface, Vault, and extension sandbox; published report; responsible disclosure programme and bug bounty

#### GRC Platforms (Compliance Automation)

Connectors for the GRC tools enterprises already use to evidence SOC 2 / ISO 27001 / HIPAA / PCI-DSS controls. Read-only ingestion of control state into the local index; the Phase 12 `nimbus compliance check` output is consumable by these platforms via standard auditor formats.

- [ ] **Drata** — control state, evidence requests, framework mappings, monitoring tests; `compliance_control` + `evidence_request` item types; read-only; `drata.evidence.attach` HITL
- [ ] **Vanta** — controls, monitors, employee onboarding/offboarding state, vendor reviews; `compliance_control` item type; read-only; `vanta.task.complete` HITL
- [ ] **Secureframe** — control library, framework progress, evidence collection, vendor risk; read-only; `secureframe.evidence.upload` HITL
- [ ] **Tugboat Logic / OneTrust GRC (read-only)** — controls, risks, audit logs; read-only
- [ ] **Automated compliance-evidence attachments** — agent maps locally-indexed Jira tickets, PRs, deploy logs, and audit-log entries to specific auditor evidence requests in the connected GRC platform (Drata / Vanta / Secureframe); produces a one-click evidence package per request; turns audit preparation from a weeks-long manual task into an export

#### Identity & Governance

- [ ] **Enterprise SSO** — SAML 2.0 and OIDC; tokens in enterprise Vault, not browser cookies; session binding to machine identity
- [ ] **SCIM 2.0 provisioning** — automated user lifecycle driven by IdP; deprovisioned users' Vault entries and shared namespaces revoked within one sync cycle
- [ ] **Knowledge Isolation (Project Boundaries)** — strict index partitioning to ensure context from one client/project never bleeds into another
- [ ] **Privileged access management** — named admin users can view (not export) any team member's connector health and audit log; cannot view index content or credentials

#### Admin Console (Enterprise)

- [ ] **Org-wide dashboard** — Gateway health per member, index item counts by service, watcher fire rate, HITL queue depth, audit log freshness
- [ ] **Policy editor** — GUI for `nimbus.policy.toml` with validation and diff preview before applying
- [ ] **Credential rotation assistant** — identifies connectors with credentials older than a configurable threshold; guides admin through coordinated re-auth with minimal downtime

#### SLA & Support

- [ ] **Priority support tier** — dedicated CSM, 4h response SLA for P1 issues, private Slack channel
- [ ] **Deployment assistance** — official runbooks for Docker/Kubernetes/air-gapped deployments; reference architecture for common enterprise stacks
- [ ] **DPA and legal templates** — Data Processing Agreement, sub-processor list, GDPR Article 28 documentation for enterprise procurement

#### Acceptance Criteria

- The Helm chart deploys a functional Gateway cluster on Kubernetes with persistent storage and NetworkPolicy in under 15 minutes from a clean cluster
- `nimbus compliance check` produces a machine-readable JSON report passing a reference auditor schema without manual intervention
- Audit log shipping to a Splunk HEC endpoint is verified end-to-end in CI against a mock HEC target; no audit row is lost in a Gateway restart scenario
- Deprovisioning a user via SCIM removes their shared namespace access within one sync cycle and writes a signed record to the org audit log

---

### Phase 13 — Desktop Distribution

**Goal:** Publish the Tauri desktop UI as signed, OS-gatekeeper-clean release artifacts. The desktop UI itself was built in Phase 4 (WS5-A through WS5-D, all `[x]` in [§ Phase 4](#phase-4--presence-)); what slipped from `v0.1.0` was the release vehicle — signed installers, per-OS build matrix, Gatekeeper / SmartScreen handling, and the Tauri-specific security audit follow-ups. This phase delivers the `desktop-v0.1.0` tag, gated independently of the headless `v0.1.0` and `vscode-v0.1.0` tags.

#### Dependencies

- Phase 4 WS5 (Tauri UI code-complete in-tree)
- Phase 4 WS4 (Updater state machine + Ed25519 signing plumbing)
- Code signing certificate procurement (Apple Developer Program enrollment + Windows EV cert)

<a id="desktop-release-vehicle"></a>

#### Desktop Release Vehicle

The Tauri desktop UI was code-complete in Phase 4 (WS5-A through WS5-D) but did not ship as a release artifact in `v0.1.0`. Phase 13 is the release vehicle: signed installers, a per-OS `build-ui` matrix in `release.yml`, and the Tauri-specific security audit follow-ups deferred from B1. The desktop tag is `desktop-v0.1.0`, gated independently of the headless `v0.1.0` and `vscode-v0.1.0` tags.

- [ ] **`build-ui` release-pipeline job** — add a per-OS matrix (windows-latest, macos-13, macos-14, ubuntu-24.04) to `.github/workflows/release.yml` that runs `cd packages/ui && bunx tauri build` and uploads the `.msi` / `.dmg` / `.AppImage` / `.deb` artifacts; gated on the same `desktop-v[0-9]+.[0-9]+.[0-9]+` tag pattern, parallel to the existing headless gateway/CLI jobs
- [ ] **macOS Gatekeeper notarization** — Apple Developer Program enrollment ($99/yr); `codesign` + `notarytool` + `stapler` integrated into the macOS leg of `build-ui`; produces a notarized `.dmg` that opens without user override
- [ ] **Windows Authenticode signing** — EV code-signing certificate procurement (~$470–$840/yr); `signtool.exe` integrated into the Windows leg of `build-ui`; produces an `.msi` that passes SmartScreen reputation
- [ ] **Linux desktop bundle GPG signatures** — extend the existing `sign-linux-gpg.sh` to cover the `.AppImage` and `.deb` Tauri bundles produced by `build-ui`
- [ ] **Tauri-native file picker for `data.import` (S4-F6)** — see [§ Phase 4 → Security audit follow-ups (B1)](#security-audit-follow-ups-b1); the same UI-rebuild PR also handles the `extension.install` path-validation work (S4-F5 / S7-F7)
- [ ] **Profile-switch global broadcast refactor (S4-F8)** — Rust-side window-registry refactor; folded into the S4-F6 UI-rebuild PR
- [ ] **`desktop-v0.1.0` smoke pass** — every section in [`docs/release/manual-smoke-desktop.md`](./release/manual-smoke-desktop.md) green on Windows + both macOS arches + Ubuntu 24.04
- [ ] **`nimbus desktop` CLI shim (optional)** — a thin `packages/cli/src/commands/desktop.ts` command that locates and launches the installed Tauri app, so users can launch the desktop UI from the same CLI surface they use for everything else

#### Stretch — Channel Reach (does not gate phase completion)

Native package-manager distribution; gated independently of the desktop tag, may ship as `headless-channel-v0.1.x` after `desktop-v0.1.0` is green.

- [ ] **Homebrew formula** (macOS / Linux) — `brew install nimbus`; tap maintained alongside the release pipeline
- [ ] **winget package** (Windows) — submitted to the Microsoft community repository; auto-updated on each `v*` tag
- [ ] **Chocolatey package** (Windows) — community-channel package signed with the same Authenticode cert
- [ ] **Snap** (Linux) — strict-confinement Snap published to the Snap Store
- [ ] **Flatpak** (Linux) — published to Flathub; sandbox manifest covers Vault-via-libsecret access
- [ ] **AUR** (Arch Linux) — community-maintained `nimbus-bin` and `nimbus-git` packages
- [ ] **MacPorts** (macOS) — Portfile maintained alongside Homebrew
- [ ] **Nix flake** — `nix run github:nimbus/nimbus#nimbus`; reproducible build outputs

#### Acceptance Criteria

- `desktop-v0.1.0` produces `.dmg` (notarized, both arches), `.msi` (Authenticode-signed), `.AppImage` and `.deb` (GPG-detached signatures) as release artifacts.
- A user double-clicking the macOS `.dmg` and the Windows `.msi` from a clean OS install is not blocked by Gatekeeper or SmartScreen.
- The smoke checklist in `manual-smoke-desktop.md` is ✅/⚠ on every row.
- The Tauri auto-update path (Ed25519 signature verify + rollback) round-trips against a live update manifest from `desktop-v0.1.0` to a hypothetical `desktop-v0.1.1`.

---

### Phase 14 — Agent Evolution / AI v2

**Goal:** Expand Nimbus's intrinsic agent capabilities along four dimensions — multimodal I/O, isolated code execution, computer use, and runtime tool generation. Highest risk-blast-radius phase; structured Core / Stretch so the phase remains shippable even if the most research-adjacent capabilities slip. Full design in [`docs/superpowers/specs/2026-05-10-phase-14-agent-evolution-design.md`](./superpowers/specs/2026-05-10-phase-14-agent-evolution-design.md).

> **Composes with Phase 10 (Autonomous Agent):** Phase 10's standing approvals are explicitly **not** extended to Phase 14 capabilities by default. The autonomous agent's incident correlation engine can however invoke Phase 14 capabilities under HITL when the user explicitly approves a multi-step remediation. Phase 14 capabilities can be disabled at the org level via Phase 12's policy-as-code.

#### Dependencies

- Phase 4 LLM router + multi-agent orchestration
- Phase 4 Plugin API v1
- Phase 10 standing approvals (Phase 14 explicitly **opts out**; the dependency confirms the gate exists, not that it extends)
- Phase 12 Enterprise policy-as-code (org-level disable mechanism)
- All prior platform phases stable — this phase inherits, never overrides

#### Core — Multimodal I/O

- [ ] **Image input — vision-model OCR + scene understanding** — indexed screenshots, design-file thumbnails, whiteboard photos passed to a local or remote VLM (Pixtral, Llama 3.2 Vision, Claude Sonnet / Opus, GPT-4o); structured caption + entity extraction stored as `image_understanding` rows
- [ ] **Video input — local STT + frame captioning** — Loom / Vidyard / meeting recordings indexed via `whisper-cli` STT + periodic frame caption; `video_understanding` rows with transcript, frame captions, speaker diarization
- [ ] **Audio input beyond Phase 4 voice** — long-form transcription with diarization, summary extraction, action-item identification
- [ ] **Image output via local SD/Flux** — `nimbus diagram <description>` produces a draft diagram via locally-installed Stable Diffusion or Flux; HITL on save-to-file; opt-in
- [ ] **Multimodal MCP tools** — `searchLocalIndexImages`, `summarizeVideo`, `extractActionItemsFromAudio`; wrapped via `wrapToolOutput` per invariant `I11`

#### Core — Code Execution Sandbox

- [ ] **Local sandbox runner** — Bun + Deno (`--no-net` by default) inside `bwrap` (Linux) / `sandbox-exec` (macOS) / AppContainer (Windows); per-execution capability flags (`--allow-net`, `--allow-fs <path>`, `--allow-env <var>`)
- [ ] **Optional remote sandbox adapters** — pluggable adapters for E2B, Modal, Daytona, fly.io machines; enabled only via explicit `[code_execution.remote_sandbox]` config; `enforce_air_gap = true` blocks remote sandboxes regardless of config
- [ ] **HITL on every execution by default** — consent dialog shows code body, declared capability flags, expected runtime budget; **standing approvals explicitly NOT supported** in this phase
- [ ] **Output capture and feed-back** — stdout/stderr/exit-code/runtime returned to the LLM via `wrapToolOutput`; binary outputs recorded in audit log
- [ ] **`nimbus exec --interactive`** — REPL mode where each agent-emitted code block individually requires Enter-to-approve

#### Stretch — Computer Use (browser / terminal / screen)

*Highest-risk capability. Per-action HITL by default; sandboxed runtimes; explicit per-session opt-in.*

- [ ] **Browser automation** — Playwright-driven, screenshot-grounded; sandboxed Chromium profile with no shared cookies / no shared history
- [ ] **Terminal automation** — PTY-grounded; sandboxed shell; no access to user's primary shell history or environment
- [ ] **Screen capture + click** — desktop OS-level click + keystroke; sandboxed application target only (cannot drive Nimbus UI itself, cannot click outside target window)
- [ ] **Action-stream audit** — every emitted action recorded with screenshot before/after for screen capture, DOM snapshot before/after for browser; supports post-incident replay

#### Stretch — Tool Generation & Fine-Tuning

- [ ] **Runtime tool generation** — agent writes its own MCP tool stub; runs `@nimbus-dev/sdk` contract test; if green, registers ephemerally for the session only; HITL per tool registration
- [ ] **Tool persistence** — `nimbus tool save <session-tool-id>` promotes ephemeral tool to a named installed extension after manual review; standard SHA-256-verified extension manifest path
- [ ] **Local instruction fine-tuning** — full-precision instruction-tune of small models (3B–7B) on tool-use traces + writing samples; output as GGUF in local model directory
- [ ] **Tool-use trace dataset builder** — `nimbus dataset build --from-audit --kind tool-use` produces JSONL ready for the fine-tuner; user reviews + edits before train start
- [ ] **Adapter rollback safety** — every fine-tune output is rollback-safe; previous adapter retained until explicit promotion

#### Org-Level Lockoff

- [ ] **Capability disable via Enterprise policy** — `nimbus.policy.toml` honours `[capabilities.ai_v2]` block: `multimodal_input = false`, `code_execution = false`, `computer_use = false`, `tool_generation = false`, `local_finetuning = false`. Each false value disables the corresponding capability at gateway startup; required by regulated industries.

#### Acceptance Criteria — Core (gates phase)

- A 5-minute Loom recording indexed via local STT + frame captioning produces a `video_understanding` row with non-empty transcript and at least one frame caption; verified e2e on Windows + macOS + Linux
- `nimbus ask "what did I demo in the recording from yesterday?"` returns a coherent answer derived from the `video_understanding` row alone
- `nimbus exec` runs an agent-written 5-line Python script in the local sandbox with `--allow-fs /tmp` capability; HITL fires before execution; output captured; audit log records code body, capability grant, exit code, stdout/stderr digest
- A code execution attempting to write outside `/tmp` fails closed; the agent is told the operation was denied
- `enforce_air_gap = true` blocks the remote sandbox adapter even when configured; verified by integration test
- Privacy contract: no image / video / audio body data leaves the machine without explicit user opt-in for that artifact

#### Acceptance Criteria — Stretch (does not gate phase)

- Browser automation completes a 3-step task (login → search → screenshot) against a sandboxed Chromium profile with HITL on every action; verified manually on Windows + macOS + Linux
- An agent-generated MCP tool passes the contract test and registers ephemerally for the session; the tool is unavailable in a fresh session unless promoted via `nimbus tool save`
- A local instruction fine-tune of a 3B model on a 1k-row tool-use dataset completes in under 30 minutes on a mid-range GPU; resulting GGUF appears in `llm.listModels`; rollback works without restart
- Computer use, code execution, and tool generation share a single audit-log fingerprint format that lets `nimbus audit replay <session-id>` deterministically reconstruct what the agent did

---

### Phase 15 — Cross-Organizational Federation (The Global Mesh)

**Goal:** Extend Nimbus's federation primitive across organisational boundaries — vendors, partner companies, contractors — without surrendering local sovereignty and without a central broker.

> **Composes with Phase 6 (Team):** Phase 15 reuses Phase 6's NaCl-box federation channel and namespace primitive; the new contribution is a **lease envelope** that wraps a Phase 6 namespace with cryptographic time-bound + scope + revocation semantics. Phase 6 is intra-org; Phase 15 is the inter-org case.

#### Dependencies

- Phase 6 Nimbus-to-Nimbus federation (NaCl-box channel, scoped namespaces, RBAC enforcement at the federation protocol layer)
- Phase 12 audit log shipping (enterprise leases must produce shippable audit trails per lease)
- Phase 11 Decentralized Identifiers (DIDs are the natural identity primitive for cross-org peer authentication; not strictly required but recommended)

#### Core — B2B Index Leasing

- [ ] **Lease envelope protocol** — cryptographically signed wrapper around a Phase 6 namespace export that adds: scope (item types, services), expiry (wall-clock + max-age), revocation key, lessee identity (DID or X.509). Wire format extends the existing NaCl-box framing; reuses the federation channel.
- [ ] **Lease issuance + signing** — `nimbus lease issue --namespace <name> --to <peer> --scope <filter> --expires <duration>`; issuer signs with their X25519 (or DID-backed) key; recipient verifies signature before the leased namespace becomes queryable on their machine.
- [ ] **Lease revocation** — `nimbus lease revoke <lease-id>` flips a revocation bit broadcast over the same federation channel; lessee's Gateway purges leased rows from its local index on receipt; revocation is signed and audit-logged.
- [ ] **Lease audit trail** — every issue, query, and revocation appended to the BLAKE3-chained audit log on both sides; in enterprise deployments, the audit ships via the Phase 12 audit-log shipping pipeline so legal can verify lease compliance independently.
- [ ] **`nimbus lease list / show`** — local CLI surface; shows leases issued, leases received, expiry / revocation state.

#### Acceptance Criteria

- A lease issued from org A to a contractor at org B is queryable on the contractor's machine within one federation sync cycle; the lease envelope verifies against org A's published key before any leased row is written locally.
- A revocation issued from org A purges all leased rows on org B's machine within one sync cycle; a subsequent query for any leased item returns empty; revocation appears in both audit logs with matching signatures.
- A lease that expires (wall-clock past `expires_at`) is treated as revoked on both sides without an explicit revocation event; expiry is enforced locally without a central broker.
- Privacy contract: a leased namespace is strictly a Phase 6 namespace-export; no data outside the lease scope is ever queryable by the lessee; verified by an integration test that issues a narrow lease and asserts the lessee's `index.query` calls outside scope return empty.

---

### Phase 16 — The Platform Layer

**Goal:** Turn Nimbus from a personal agent each engineer configures individually into a **team operating system** a platform engineer curates **once** and rolls out to the whole team — connectors, automations, conventions, and golden paths reconciled to every Gateway, plus a lead's-eye view of team health no dashboard shows. No relay server, no surveillance, no surrender of local sovereignty.

> **Composes-with Phase 6** (federation channel, Team Vault, org policy engine, shared namespaces) and **Phase 7** (service catalog, automation-template library, ownership graph). Phase 16 is the *distribution + curation* layer those phases lacked.

#### Dependencies

- Phase 6 federation + Team Vault + org policy engine + shared namespaces
- Phase 7 service catalog + automation-template library + ownership graph
- Phase 4 multi-agent + LLM router (the `onboard` / `risk` built-ins)
- Phase 10 scheduled workflows (the ROI report + huddle); standing approvals (W4 templates)
- Phase 3 relationship graph + tamper-evident audit log (the W3 lead-intelligence built-ins run on these alone — see the W3 note)

#### Non-negotiable guardrails

- Team config repo holds **references to vault keys, never secrets**; the Gateway scans the baseline on every apply/reconcile and refuses literal secrets (defense in depth beyond the team's CI).
- The team baseline is **Ed25519-signed** (reuses the `I16` machinery); `nimbus apply`/reconcile verify against the team key (via the Phase 6 Team Vault trust anchor) before applying — a compromised git host cannot push malicious config to the fleet.
- `nimbus apply` is HITL-gated with a preview. **Reconcile boundary:** unattended reconcile applies only enforcement policy + read-only config; anything adding a write-capable surface (write-action watcher, workflow, skill pack, standing-approval template) requires a preview even on reconcile.
- **New invariant proposal — team skill packs cannot loosen HITL** (they may tighten, never remove an action from `HITL_REQUIRED` or auto-approve; rejected at load if they try). Lands as a full invariant triple when W2 is built.
- Radar / ROI / fleet views are **aggregate, risk-framed, opt-in** — they name services/areas at risk and config/health state, never rank or surveil individuals.
- **Offline is normal:** a Gateway runs fully on its last-applied baseline; a standing rule that expires offline fails safe to HITL, never locking the agent out.

#### Wave 1 — Fleet Foundation *(distribution substrate)*

- [ ] **`nimbus.team.toml` + team config repo** — declarative, version-controlled team baseline (connectors as vault-key references, sync intervals/depths, watchers, workflows, automation templates, dashboard presets, model-policy defaults, policy pointer).
- [ ] **Signed team baseline** — `nimbus team sign`; verified on every apply/reconcile; unsigned/mis-signed refused.
- [ ] **`nimbus apply` + reconciliation loop** — verify signature → diff → preview → HITL apply; idempotent; reconcile boundary (above) enforced.
- [ ] **`nimbus team join <repo>`** — one-command onboarding: clone → apply config → auth only the connectors needing per-user identity (Team-Vault service accounts need none); creds land in the local/Team Vault, never the repo.
- [ ] **`nimbus team leave`** — clean detach: stop reconcile, revoke federation grants, remove team-applied content; auditable.
- [ ] **Layered precedence** — `team baseline → profile → user overrides`, org policy as a hard ceiling; `nimbus config explain <key>`.
- [ ] **Secrets discipline (defense in depth)** — team CI contract test **and** Gateway-side payload scan refusing literal secrets.
- [ ] **Team-server tier** — `nimbus serve --team`: always-on team Gateway (shared namespaces + Team Vault anchor + reconcile source) without enterprise Helm; the on-ramp to Phase 12.
- [ ] **Overlay-mesh federation** — federation over a user-run WireGuard/Tailscale overlay, not just same-LAN mDNS; **no Nimbus relay**.
- [ ] **Fleet health view** — `nimbus team fleet`: config version + reconcile/drift state + reachability across the team (no index content; aggregate; opt-in).
- [ ] **Staged / canary config rollout** + **fleet rollback** (`nimbus team rollback <version>`, atomic over the whole baseline — skill packs/watchers/workflows/config pinned by version).

#### Wave 2 — Paved Roads *(curated agent + golden paths)*

- [ ] **Team skill packs** — versioned, team-authored packs shaping the agent's reasoning (incident response, PR-review standards, deploy checklist, house rules); distributed via the W1 repo.
- [ ] **🔒 Skill-pack HITL invariant** — a pack can tighten but never loosen the HITL gate; rejected at load if it tries.
- [ ] **Golden-path scaffolding** — `nimbus scaffold service <name>` (**HITL**): reads the team IDP + skill packs, generates the team-standard skeleton (repo layout, required checks, ownership + on-call, dashboard), files the catalog entry.
- [ ] **New-hire onboarding agent** — `nimbus onboard <service|team>`: read-only brief (architecture, owners, recent incidents, golden path, who-to-ask); emits `agents.onboard.briefReady`.
- [ ] **Convention-drift detector** — flags services diverging from the golden path; feeds W3.
- [ ] **"Ask the team" federated Q&A** — `nimbus ask --team`: scope-permissioned fan-out across teammates' indexes with provenance. **Highest-risk item; ships experimental, opt-in, behind a dedicated security/privacy sub-spec** (query-text minimization, peer-side logging policy, cross-federation injection via `I11`, fan-out cap).
- [ ] **Team-standard PR-review agent** — Phase 10 pre-review driven by the team skill-pack standards.
- [ ] **Runbook-as-agent execution** — team-distributed runbooks, **HITL per step**.
- [ ] **Skill-pack feedback loop** — engineers flag unhelpful packs; routes to the lead dashboard (W3).

#### Wave 3 — The Lead's-Eye View *(team intelligence; can parallel W2)*

> The bus-factor radar, toil heatmap (per-user mode), and onboarding agent run on a **single Gateway's already-indexed data** (Phase 3 graph + audit log) — the lightest deps in the phase; they could be pulled forward as standalone built-ins (even early), with federation only enriching them.

- [ ] **Knowledge-risk / bus-factor radar** — `nimbus risk [--team|--service]`: single-points-of-knowledge, review bottlenecks (sole reviewer OOO — joins on-call/calendar + review history), undocumented-critical surfaces. **Names services at risk, never ranks individuals**; opt-in; privacy contract test.
- [ ] **Team value/ROI report** — `nimbus team report [--since 7d]`: aggregate (incidents surfaced, time-to-context, HITL actions, stale flags caught, post-mortems drafted, onboarding briefs) — **no per-engineer attribution**.
- [ ] **Toil heatmap** — mines the audit log for repeated action types / workflows / incident patterns → what to automate next; per-user mode (single index) + team-aggregate (counts of action types only, opt-in, raw logs never leave a machine); `nimbus toil flag` for explicit signals.
- [ ] **Onboarding-readiness score per service** + **golden-path compliance scorecard** (feeds Phase 7 scorecards).
- [ ] **Team huddle briefing** (formalizes Phase 6's stub) + **lead dashboard** (radar + ROI + toil + drift/compliance + skill-pack feedback queue).

#### Wave 4 — Team Automation Governance

- [ ] **Team standing-approval templates** — lead-curated, distributed via W1; a template **proposes**, each engineer must confirm adoption (never force-granted); inherits Phase 10 scope/expiry/ceiling/confidence constraints.
- [ ] **"What changed in our Nimbus" digest** — auto-changelog when the team baseline changes.

#### Acceptance Criteria

- `nimbus team join <repo>` applies all team config in under 2 minutes (zero secrets from the repo); per-user OAuth/PAT is the only remaining step; a missing/invalid baseline signature is refused on every machine.
- A baseline edit reconciles to a subscribed Gateway within one cycle after an approved preview; a policy-violating connector is refused fleet-wide; a canary rollout updates only the canary subset; `nimbus team rollback` reverts atomically.
- A skill pack shapes agent behavior on every subscribed machine; a pack attempting to auto-approve a HITL action is rejected at load.
- `nimbus risk --team` flags a bus-factor-1 service + a review bottleneck in <15s, naming services not individuals; `nimbus team report` produces an aggregate report with zero per-engineer attribution.

---

### Phase 17 — The On-Call Copilot

**Goal:** The individual on-call engineer's real-time copilot — **predict → understand → mitigate → coordinate.** Distinct from Phase 10's *autonomous* SRE loop (standing automation) and Phase 8's *security* `nimbus incident` (attacker-shaped); this is interactive, HITL, incident-time. The roadmap already does reactive *assembly* well (Phase 10); Phase 17 adds the proactive, mitigation, coordination, and deep-first-response layers.

> **Composes-with Phase 16** → **Team Incident Command**: the copilot pulls in who knows the code (bus-factor radar), who's on call (schedule), runs the team channel (scribe), and drives the team's runbooks (skill packs) — collaborative incident command with no war-room.

#### Dependencies

- Phase 10 incident correlation engine + post-mortem drafter + on-call schedule + anomaly baseline
- Phase 4 multi-agent (deep parallel investigation) + LLM router
- Phase 3 relationship graph (cascade root-cause) + tamper-evident audit log (replay)
- Phase 11 mobile + push transport; Phase 5 PagerDuty/CI/deploy connectors; Phase 16 skill-pack runbooks + bus-factor radar

#### Non-negotiable guardrails

- Every mitigation is HITL with a **dry-run + blast-radius preview**; no auto-remediation (that's Phase 10 standing approvals, opt-in, separate).
- **Reversibility is classified, never assumed** (reversible / irreversible / unknown), surfaced prominently; the copilot never claims "reversible" it can't prove.
- **Accountable:** `nimbus audit replay <incident-id>` reconstructs what the copilot saw + did. **Engineer stays in command:** disengage to advisory-only at any point.
- Local-first (logs/metrics/traces correlated locally; incident data never leaves). Detection ≠ action (radar/advisor surface, never act). Scribe drafts, never sends without consent.

#### Wave 1 — Predict & Prevent

- [ ] **Silent-degradation radar** — detects the *absence* of expected events + sub-threshold drift; baselines from explicit `nimbus.team.toml` declarations (primary) + learned patterns (secondary). Detection only.
- [ ] **Deploy-risk advisor** — an enrichment of Phase 5 `deploy preflight` (system state × change velocity × on-call coverage × time-of-week → risk score + the why).
- [ ] **Anomaly → proactive heads-up** — Phase 10 anomaly surfaced to the on-call engineer ("this looks about to page"), not a silent log.

#### Wave 2 — Page → Instant Understanding

- [ ] **Pushed incident brief** — assembled brief pushed to where the engineer is (terminal/Slack/mobile) the instant it fires. **Approve-from-push** for a reversible, high-confidence mitigation via Phase 11 biometric/secure-enclave-signed HITL.
- [ ] **Deep automated investigation** — multi-agent fan-out: correlates logs/metrics/traces, snapshots dashboards, diffs the deploy. **Cost discipline:** pushes query computation down to the backend, pulls only correlated results (no raw firehose).
- [ ] **Cascade root-cause ranking** — ranks root vs. downstream via the dependency graph + timing when many alerts fire.

#### Wave 3 — Mitigate with Confidence

- [ ] **Confidence + evidence + dry-run remediation** — confidence score + cited evidence + blast-radius preview + reversibility classification; HITL.
- [ ] **Live runbook driving** — executes the team's Phase 16 skill-pack runbook step-by-step, HITL per step.
- [ ] **One-tap rollback** (blast-radius preview inline) + **undo the copilot's own action** (one keystroke where the action class supports it; audit-logged).

#### Wave 4 — Coordinate & Close

- [ ] **Live incident scribe + comms** — maintains the timeline, drafts stakeholder/status-page updates (**HITL to send**), keeps the channel current; tone/templates from Phase 16 skill packs.
- [ ] **On-call handoff brief** — `nimbus oncall handoff`: shift events, open/smoldering items, watch-list.
- [ ] **Auto post-mortem** — composes Phase 10's draft from the richer incident record; HITL-gated push.

#### Acceptance Criteria

- On a seeded multi-alert cascade, the pushed brief names the single root and marks the rest downstream in <15s, delivered without a query (measured mean-time-to-context).
- For a seeded bad-deploy incident, the copilot proposes a rollback with confidence + cited evidence + dry-run blast radius + reversibility label; approving executes through the HITL gate (action + preview in the audit chain); `nimbus audit replay <id>` reconstructs the steps deterministically.
- A mitigation that makes things worse can be undone in one keystroke (where reversible); irreversible actions are flagged before approval.
- `nimbus oncall handoff` returns a shift brief in <15s, zero HITL.

---

### North-Star Capabilities (cross-phase)

Audience-agnostic "no other tool does this" pillars, each enabled **because** of local-first / no-relay / HITL / audit. They thread through several phases rather than living in one; M1 and M3 are each strong enough to anchor a late phase.

- [ ] **M1 — The Org's Living Memory** — the org's permanent, queryable institutional memory (*"why did we choose Kafka in 2024?"*, *"we tried this migration before — why did it fail?"*). Extends Phase 7 ADR drafter + Phase 10 episodic/point-in-time + Phase 16 collective Q&A.
- [ ] **M2 — Preventive Ops** — learns from *your own* incident history the patterns that precede outages and warns at change time; headline signal **incidents prevented** (a heuristic — pattern-match + engineer-acted-on-warning — not a provable counterfactual). Extends Phase 17 W1 + Phase 9 local fine-tune.
- [ ] **M3 — Accountable Autonomy** — multi-step loops end-to-end, HITL only at irreversible steps, **every decision replayable** (`nimbus audit replay`). *(Substrate: faithful replay needs the agent's reasoning/evidence trace captured, not just actions + HITL status — an extension beyond `audit_log` + `tool_call_log`, designed with the replay feature.)* Extends Phase 10 + Phase 14.
- [ ] **M4 — Surveillance-Free Collective Intelligence** — cross-team/cross-org benchmarking + shared incident-pattern learning via secure aggregation over the relay-free mesh, **with nobody's data leaving their machine. Opt-in at the team/org level via `nimbus.policy.toml`, off by default, never per-engineer.** Extends Phase 6/11/15.
- [ ] **M5 — Counterfactual / Time-Travel Ops** — v1 is *static/causal analysis* (config + code paths + dependency graph + indexed integration-test history); live simulation of stateful external systems is out of scope. Extends Phase 10 point-in-time + Phase 14.
- [ ] **M6 — The Self-Extending Agent** — notices its own gaps (toil heatmap) and **drafts its own connector/automation**: read-only by default, contract-tested against the SDK, generated only against an authoritative published spec (never hallucinated), sandboxed (`I15`), HITL-installed + `I16`-signed; never auto-tests writes against a live API. Extends Phase 14 + Phase 16.

**Connective tissue** (the substrates that make the above one product): the **proactive meta-agent** ("what should I look at right now?" — routes to the right brief by context across ~15 built-in agents); the **Impact Ledger** (one tamper-evident measurement spine feeding the team ROI report, the evaluator "look what it did this week," and M2); a **causal/temporal event spine** (under M1/M2/M5); a first-class **transparency surface** (always-visible "Local Only" egress indicator + inspect/delete-everything + decision replay); and the **"when the agent is wrong" backbone** (calibrated confidence with the humility to say "I'm not sure," one-keystroke undo, wrong-recommendation feedback that lowers future confidence — shared with Phase 17's remediation).

---

### First-Run & Time-to-Wow (near-term initiative)

Defeating the cold start — Nimbus's wow is proportional to how much it has indexed, but at minute one the index is empty. This **gates adoption, so the cheap pieces should ship early — not be deferred to a late phase.**

- [ ] **`nimbus demo` — seeded sandbox** — loads a realistic synthetic org so an evaluator experiences incident assembly / `impact` / `expert` / the bus-factor radar in 30 seconds, zero connect, zero wait (repurpose the perf-bench synthetic corpora; shift all timestamps relative to "now" so it always looks like today). Also the host for the killer demo.
- [ ] **Detect-and-reuse existing local auth** — notice the user is already logged into `gh` / `aws` / `gcloud` / `kubectl` and offer to use those credentials — one keypress instead of N OAuth flows (uniquely possible because Nimbus is local).
- [ ] **Zero-auth local-first wow** — point it at `~/code` (filesystem + git, no OAuth) → value on the user's own work in 60s.
- [ ] **"Prove it's local" demonstration** — first-run + always-visible: loopback-only socket, everything indexed (inspect/delete), audit log proving **zero outbound calls**.
- [ ] **`nimbus wow` guided tour** — runs the 3 most impressive queries based on what's indexed; no blank-prompt paralysis.
- [ ] **Screenshot-worthy output** + re-weight **signed installers / one-liner install** (Phase 13) for the adoption reason, not just enterprise.

---

### The Killer Demo (north-star milestone)

**"The page that answered itself"** — runs on `nimbus demo`: a P1 fires → the assembled brief is already there (cause, the deploy 8 min ago, the PR, cascade root) → *"95% confidence, rollback dry-run affects payment-service only, reversible — approve?"* → resolved, mean-time-to-context 22s → post-mortem + status-page drafted → `nimbus audit replay` shows every decision and **"0 outbound network calls."** Tagline: *"Your systems just had an incident. Nimbus already handled the first 30 minutes — locally, and it can prove it."*

This is **not a feature — it's a cross-phase milestone that proves the thesis**, and reverse-engineering it yields the minimal first slice to build: `nimbus demo` sandbox → Phase 17 W2 (pushed brief + deep investigation + cascade) → Phase 17 W3 (confidence/dry-run remediation) + the "when the agent is wrong" mechanism → `nimbus audit replay` + transparency surface (M3) → the Impact Ledger. *(The production version needs a minimal cut of the Phase 10 + Phase 4 substrate; the demo sandbox seeds it.)* **Declare "ship the killer demo" an explicit prioritization spine.** Alternate cuts: *"Ask your entire org anything"* (data-eng/lineage; M1) and *"Watch it run and never phone home"* (security buyer; M3/M4).

---

## How to Update This Document

- When a phase becomes active, update its status in the overview table and add a progress note (e.g. "~14 of 21 items complete").
- Check off individual items (`[x]`) as they land on `main`; update the progress count in the phase status note.
- When a phase completes, add a **Delivered** section (see Phases 1 and 2 for the format) and update the status table.
- Do not add new items to an active phase without a corresponding issue and team discussion.
- Planned phase items can be reprioritised between phases — open a discussion, then update this file and `CLAUDE.md` and `GEMINI.md` (AI assistant context files at the repo root that carry architecture and convention summaries for AI-assisted development) to match.
- New phases can be added after the last planned phase; do not insert phases between active/complete phases.
- Update the "Last updated" note at the top whenever significant waves of work land on `main`.
