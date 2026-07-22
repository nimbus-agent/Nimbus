# Nimbus Roadmap

This document is the authoritative roadmap for Nimbus. [`README.md`](./README.md) carries a summary; this file contains acceptance criteria, inter-phase dependencies, and the reasoning behind sequencing decisions.

> **Scope.** This file covers the **gateway** — what Nimbus can do. How that capability reaches a human, through `@nimbus-dev/sdk`, `@nimbus-dev/client` and the clients built on them, is sequenced separately in [`ecosystem-roadmap.md`](./ecosystem-roadmap.md). The two are complementary: this roadmap is 27 phases deep, while the client surface is currently 15 methods wide. Where they touch, this file wins on *what* and the ecosystem roadmap wins on *when it becomes reachable*.

Phases are thematic, not calendar-bound. A phase begins when its dependencies are met and ends when its acceptance criteria pass — not at a quarter boundary. Phases may overlap when deliverables are independent.

> **Last updated:** 2026-07-19 — **Phase 6 (Team) COMPLETE** (all 9 slices; Slice 8 Share & Virality Waves 8a–8d shipped 2026-06-15 → 2026-06-18, #687), and the build order from here is the **[Phase 7+ Sequencing Spine](#phase-7-sequencing-spine)** overlay — the current slot is **[S1 — Local Brain](#active)**. Since then, merged to main: the web-clipper gateway surface (invariant **I30** — owner-paired one-time token minting; #718) with its `nimbus clip list` / `clip delete` / `clip pair` CLI (#760/#761), a per-route body cap so real articles fit the I13 write surface (#771/#773), and the **Chrome/Firefox MV3 browser extension `v0.1.0`** from the satellite repo `nimbus-agent/nimbus-web-clipper` (2026-07-19; store listings pending their one-time bootstrap); the `@nimbus-dev/sdk` and `@nimbus-dev/client` npm packages extracted to standalone public repos (both removed from the monorepo; client extraction #758); the egress-ledger & `nimbus prove` provable-locality primitive (#698 — invariant **I29** / static **D22** / schema **V44** `egress_ledger`), dedup waves a/c (#696/#697), connector pagination-SSRF + email header-injection hardening (#694), and launch & community readiness (root README + SECURITY policy, #690). Latest release **v0.22.0**. 2026-06-17 — **Phase 7+ re-sequenced into a three-track Sequencing Spine overlay** (time-to-value × moat; cheap moat primitives harvested forward, no renumber) — see [§ Phase 7+ Sequencing Spine](#phase-7-sequencing-spine) (#677). 2026-06-14 — **Phase 6 Slice 9 sub-project A (Mendeley connector, read-only) shipped** (#631; reuses the `reference` item type — no migration/HITL/invariant). 2026-06-13 — **Phase 6 Slice 7 (Wave 7a — Data Warehouse & BI connectors + cross-warehouse lineage, V40) shipped** (#595); the installer & distribution program (Homebrew/Scoop/winget + native `.msi`/`.pkg`/`.rpm` + hosted GPG-signed apt/yum repo) and the True Coverage per-file ≥80% floor also landed since the last update. 2026-06-04 — **renumbered the Marketplace Registry phase to Phase 9.5** and relocated it after Phase 9 (it previously sat as a `.5` between Phases 5 and 6; its hard blocker is Phase 9 Wave 5, the `nimbus eval` framework); **decomposed Phase 6 (Team) into 9 sequenced delivery slices** (Slice 1 = Federation Core; see `docs/superpowers/specs/2026-06-04-phase6-federation-core-design.md`); and **moved personal/family/friend federation out of Phase 6 into a new Phase 20 (Personal & Household Federation)** per guiding-principle #7. 2026-05-28 (second pass) — added **Phase 18 (Vertical Personas)** + **Phase 19 (Ambient Surfaces)** as new dedicated phases; extended **Phase 6** with personal CRM, family/couples/group mesh mode, `nimbus share`, and sovereign-mesh referral; extended **Phase 7** with the implicit-knowledge agent triad (`nimbus why` / `glossary` / `decisions`), `nimbus negotiate`, devil's-advocate mode, agent-persona configuration, and first-class negation + aggregation queries; extended **Phase 8** with the contextual dependency-update intelligence agent; extended **Phase 9** with **Wave 6 (Agent Honesty Surfaces)** — calibration audit, bias diagnostics, refusal log; extended **Phase 11** with the public dogfooding telemetry dashboard (vulnerability-as-marketing); extended **Phase 13.5** with the voice-only ambient stretch. 2026-05-28 (first pass) — added **Phase 9.5 (Marketplace Registry)**, **Phase 12.5 (Compliance Receipts)**, and **Phase 13.5 (Mobile Companion — iOS first)** as new dedicated phases; promoted **`nimbus eval` (author-facing eval framework + quality score)** into Phase 9 as a Phase 9.5 prerequisite; added **M8 — Time-Travel** as a north-star; added the **S — Standards (reference-impl-only)** cross-phase track anchored on the **Egress Attestation Format (EAF)** as RFC-001 with the verifier CLI. Rationale: a single adversarial stress-test pass over an "industry-standard" brainstorm killed standards-body LAIP/PAT/SCM plays, the vertical-starter-pack compliance plan, the multi-platform distribution scatter, and demoted personal fine-tune + cross-agent handoff to research bets; the surviving shape is the marketplace + compliance-as-receipts + mobile-on-call wedge and an in-place EAF reference impl. 2026-05-25 — added North-Star **M7 (Provable Locality)** (egress ledger threaded through Phase 8 + Phase 12), a **Concurrency & Scaling** documentation pass with a **B5 (high-priority) — WAL concurrency hardening** follow-up, a Phase 9 **model-weight integrity** item, and a proposed standing-approval **taint-barrier** invariant. 2026-05-24 — added **Phase 16 (The Platform Layer)** and **Phase 17 (The On-Call Copilot)**, plus a near-term **First-Run & Time-to-Wow** initiative (including `nimbus demo`), the cross-phase **North-Star Capabilities** (M1–M6 + connective tissue), and the **killer-demo** milestone. Phase 5 (The Extended Surface) is now ✅ complete (2026-06-04); Phase 6 (Team) was then the active phase — Slices 1 (Federation Core) and 3 (Identity/SSO/SCIM) shipped 2026-06-05. The full dated delivery log (every PR, with dates) lives in [`docs/CHANGELOG.md`](./CHANGELOG.md); this document carries the forward-looking acceptance criteria and per-phase Shipped summaries. Phase 5 core sequencing (locked in the T1 sequencing spec): T1 → T3 → Wave A → T4 → T6 → T2 → Wave B. The 2026-05-10 reorganisation inserted Phases 7 (Engineering Excellence), 8 (Security Engineering), and 9 (AI Engineering Loop) before the Autonomous Agent and added Phase 14 (Agent Evolution / AI v2) and Phase 15 (Cross-Organizational Federation) — see [§ How to Update This Document](#how-to-update-this-document).

---

## Contents

- [Guiding Principles](#guiding-principles)
- [Commercial Roadmap](#commercial-roadmap)
- [Status Overview](#status-overview)
- [Shipped](#shipped) — Phases 1, 2, 3, 3.5, 4, 5, 6
- [Active](#active) — **Sequencing Spine S1 (Local Brain)**; from Phase 6 onward the build order is the [Phase 7+ Sequencing Spine](#phase-7-sequencing-spine) overlay (S1 → S5), not the phase numbers
- [Planned](#planned) — Phases 7 through 27 (including 9.5 Marketplace Registry, 12.5 Compliance Receipts, 13.5 Mobile Companion, 18 Vertical Personas, 19 Ambient Surfaces, 20 Personal & Household Federation, and the 21–27 Sovereign-Proof arc — 21 Trust Substrate, 22 Proof Layer, 23 Inert to Injection, 24 Agent Archaeology, 25 Confidential Mesh Compute, 26 Provable Governance, 27 The Agent Society), plus near-term & cross-phase initiatives (M1–M12 north-stars + S — Standards track)
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
| **Sovereign / Auditor** | Phase 21–22 + 12.5 | *Auditor-in-a-Box* read-only profile (HTTP write surface disabled via `I13`, no HITL-eligible actions, `I16`-signed) + per-answer **Verifiable-Negative** receipts an auditor or cyber/E&O insurer verifies offline with `eaf-verify` — a read-only *profile* of the Enterprise/12.5 substrate, not a parallel engineering line |

Commercial license also available now for organizations that need to embed Nimbus in a product or require compliance guarantees before Phase 12 ships — contact the maintainers.

**New buying centers (the Phase 21–26 consequence, not a parallel product line).** The proof layer unlocks constituencies the engineer-tool competitors structurally don't address: the **CISO / GRC auditor**, who installs the read-only *Auditor-in-a-Box* profile and runs `eaf-verify` against the fleet — receiving signed egress ledgers, never content, subject to the same `I17` per-peer grant/role/consent filter as any federated query — and the **cyber / E&O insurer**, for whom a signed, externally-anchorable record that no remote inference host was contacted measurably lowers modeled exfiltration loss (enabling a premium conversation; the actuarial-adoption leg is an outside-the-codebase bet, like the S — Standards track's adoption framing). **BYO-compute pricing:** flat-unlimited holds for `[llm].prefer_local` / BYO-provider-key deployments (≈ zero inference-relay marginal cost), with support/SLA tiers priced separately; a future Nimbus-hosted inference relay is explicitly out of the no-meter guarantee. Air-gapped / SCIF deployments reuse the existing Phase 12 air-gapped bundle + clean-room topology — commercial framing, not new engineering. (MSP white-label consoles and BYO-Index OEM are deliberately *not* pursued as wedges — they are me-too surfaces a cloud vendor can match, and the latter is already the existing "embed Nimbus in a product" commercial-license path.)

---

## Status Overview

| Phase | Theme | Status |
|---|---|---|
| Phase 1 | Foundation | ✅ Complete |
| Phase 2 | The Bridge | ✅ Complete |
| Phase 3 | Intelligence | ✅ Complete |
| Phase 3.5 | Observability & Developer Experience | ✅ Complete |
| Phase 4 | Presence | ✅ Complete |
| Phase 5 | The Extended Surface | ✅ Complete |
| Phase 6 | Team | ✅ Complete |
| Phase 7 | Engineering Excellence | Planned |
| Phase 8 | Security Engineering | Planned |
| Phase 9 | AI Engineering Loop | Planned |
| Phase 9.5 | Marketplace Registry | Planned |
| Phase 10 | The Autonomous Agent | Planned |
| Phase 11 | Sovereign Mesh | Planned |
| Phase 12 | Enterprise | Planned |
| Phase 12.5 | Compliance Receipts | Planned |
| Phase 13 | Desktop Distribution | Planned |
| Phase 13.5 | Mobile Companion | Planned |
| Phase 14 | Agent Evolution / AI v2 | Planned |
| Phase 15 | Cross-Organizational Federation | Planned |
| Phase 16 | The Platform Layer | Planned |
| Phase 17 | The On-Call Copilot | Planned |
| Phase 18 | Vertical Personas | Planned |
| Phase 19 | Ambient Surfaces | Planned |
| Phase 20 | Personal & Household Federation | Planned |
| Phase 21 | Sovereign Trust Substrate | Planned |
| Phase 22 | The Proof Layer (Verifiable Negatives) | Planned |
| Phase 23 | Inert to Injection (The Unexfiltratable Agent) | Planned |
| Phase 24 | Agent Archaeology | Planned |
| Phase 25 | Confidential Mesh Compute | Planned |
| Phase 26 | Provable Governance | Planned |
| Phase 27 | The Agent Society | Planned |

**Current build slot:** **[Spine S1 — Local Brain](#active)**. Every phase from 7 onward keeps its number for cross-linking, but the real build order is the [Phase 7+ Sequencing Spine](#phase-7-sequencing-spine) overlay (S1 → S5) — so "Planned" above means "not yet built", not "next in line".

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
- [x] **Extension sandbox hardening** — full syscall/network isolation; **shipped in Phase 5 T2 as invariant I15** (per-OS sandbox runner under `packages/gateway/src/platform/sandbox/`, wired via `wrapServerSpec`)
- [x] **Extension Marketplace** — **shipped in Phase 4** as the WS5-D Marketplace panel (list / install-from-directory / enable / disable / remove); see the Desktop Application section under Phase 4

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

> **Status (2026-04-15):** Phase 3.5 is **✅ Complete**. All acceptance criteria have been verified on Windows, macOS, and Linux. `@nimbus-dev/client` is published to npm. The Starlight docs site is live. Phase 4 (Presence) was the next phase.

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
- [x] **Dual CJS + ESM publish shape** — `dist/index.js` (tsc ESM) + `dist/index.cjs` (bundled `require`); `exports` exposes both; first npm publish signed off at the `client-v0.1.0` tag (`client-v*` workflow + `NPM_TOKEN`)

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
  - Standalone repo [nimbus-agent/nimbus-vscode](https://github.com/nimbus-agent/nimbus-vscode); depends on the published `@nimbus-dev/client` only; never imports Gateway source

#### Editor AI Context (MCP Native)

- [x] **Native Cursor / Claude Code / Copilot context exposure** — expose the Nimbus local index as an MCP server endpoint that AI coding assistants can connect to directly. Cursor, Claude Code, and any MCP-compatible editor AI can then query the Nimbus index as a tool during code generation — giving the assistant access to incident history, deployment state, open PRs, and connector health without the user switching context. Implementation: the Gateway's existing JSON-RPC IPC surface is wrapped as an MCP stdio server via a thin adapter (`packages/gateway/src/ipc/mcp-adapter.ts`); read-only tools only (`searchIndex`, `getConnectorStatus`, `getRecentIncidents`, `getOpenPRs`); no write tools exposed; no HITL surface required. Configured via `nimbus mcp-server` CLI command which prints the MCP server config block the user pastes into their editor's `mcp.json`. This is not a new protocol — Nimbus is already MCP-native; this just inverts the client/server relationship for the local index. — **Delivered 2026-06-02** as `nimbus mcp-server` (CLI-owned read-only stdio adapter; tool renamed `getOpenPRs` → `getRecentPullRequests` since the index cannot pre-filter PR state; added `getRecentDeployments` + `getDoraMetrics`).

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
- [ ] **B5 (high-priority) — WAL concurrency hardening** — **first confirm the finding** (`PRAGMA journal_mode` on a live gateway DB returns `delete` / `truncate`, not `wal`). If confirmed this is high-priority, not a routine bug-hunt item: with WAL off, `busy_timeout = 8000` is the *only* thing preventing immediate `SQLITE_BUSY` under contention, so concurrent delta sync + query + the `I13` write path serialize and stall up to 8 s before they can even error — a real under-load UX problem. Then explicitly set `PRAGMA journal_mode = WAL` at every production SQLite open site (main writer, embedding worker, the `I13` HTTP write handle) so readers never block the writer and the shutdown `wal_checkpoint(TRUNCATE)` is not a no-op; ship a regression guard (a static rule in `check-nimbus-invariants.ts` or a runtime test asserting `PRAGMA journal_mode` returns `wal` on each write handle). Surfaced by the architecture.md concurrency-model documentation pass (2026-05-25). Tracked in #426.
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

### Phase 5 — The Extended Surface ✅

> **Status: ✅ Complete (2026-06-04).** All workstreams shipped — T1–T6, Wave A, Wave B, and Tiers 1–5. The remaining unchecked connectors are documented non-gating deferrals: **Pocket** (Mozilla shut it down — dead upstream, API disabled 2025-11-12), **Loom** / **Expensify** (no public token-auth read API), **Microsoft App Center** (retired by Microsoft 2025-03-31), **Chromatic** (no listable builds API), **LogRocket / FullStory / Datadog RUM** + **Web-vitals watcher** (Wave B stretch, "does not gate Phase 5 completion"). The `nimbus security scan` v2 and `tool_call_log` retention items closed the last buildable work (see [`docs/CHANGELOG.md`](./CHANGELOG.md)). The community-extension Marketplace acceptance criterion is tracked in **Phase 9.5** and does not gate Phase 5.

**Goal:** Fill every connector gap so that wherever a knowledge worker or developer spends time, their data is in the index. Mature the extension ecosystem. Establish Nimbus as a first-class data layer for CI/CD pipelines and external tooling.

#### Dependencies

- Phase 3 Extension Registry v1 (new connectors should ship as community extensions where possible)
- Phase 3.5 `@nimbus-dev/client` and local HTTP API (CI/CD data layer depends on them)
- Phase 4 Plugin API v1 stable and documented

#### New Connector Categories

##### Browser & Reading

- [ ] **Pocket** — saved articles, reading lists, tags; read-only index. **Cancelled (2026-06-04):** Mozilla shut Pocket down — the service stopped accepting new signups on **2025-05-22**, the app went read-only and was retired on **2025-07-08**, and the **Pocket API was disabled on 2025-11-12** with all user data queued for permanent deletion. There is no upstream left to read and no successor read API, so a connector would be dead code. Revisit only if a successor with a clean token-auth read API emerges; not a gate. (<https://support.mozilla.org/en-US/kb/future-of-pocket>)
- [x] **Raindrop** (2026-05-25, Phase 5 Tier 1) — `raindrop:bookmark` items via `mapRaindropBookmarkToItem` (`GET /rest/v1/raindrops/0?perpage=50&page=N` — collection id `0` is the special "all raindrops" collection — reading the `{ result, items, count }` envelope, incrementing the 0-based `page` while `items` is non-empty AND a full page of `perpage=50`, `MAX_PAGES=20`); get-by-id is the SINGULAR `GET /rest/v1/raindrop/{id}`; `external_id` = `String(<numeric _id>)` (the row is skipped when `_id` is missing/non-numeric); metadata bookmark_id/title/link/excerpt/note/domain/type/tags/collection_id/created_at/updated_at/canonical_url (`tags` is the tag string array stored verbatim; the `cover` field is deliberately NOT stored); `canonical_url`/`url` = the bookmarked `link` (null when missing/empty); `Authorization: Bearer <token>` auth (a Raindrop.io test token or OAuth access token; never logged); vault key `raindrop.token` (required); fixed SaaS host `api.raindrop.io` (static sandbox network, no host override); `created` / `lastUpdate` are ISO-8601 parsed to epoch-ms via `parseIsoMs` (NOT verbatim, NOT epoch seconds); `modifiedAt` = lastUpdate ?? created ?? syncedAt; title = the bookmark `title`, else the `link`, else `Bookmark <id>`; the `raindrop:bookmark` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — a bookmark is short, avoiding surprise OpenAI spend); three read tools (`raindrop_list` / `raindrop_get` / `raindrop_search`); `hitlRequired: []`; **v1 bookmarks only — collections-as-items / highlights / per-collection filtering deferred**
- [x] **Readwise** (2026-05-25, Phase 5 Tier 1) — `readwise:highlight` items via `mapReadwiseHighlightToItem` (`GET /api/v2/highlights/?page_size=1000&page=N`, DRF `{ count, next, previous, results }` page envelope, incrementing `page` while `results` is non-empty AND `next` is non-null, `MAX_PAGES=20`); `external_id` = `String(<numeric highlight id>)`; metadata highlight_id/text/note/book_id/location/location_type/color/tags/source_url/highlighted_at/updated_at/canonical_url (`tags` reduced to the tag-name array; the highlight `text` is stored in full); `canonical_url`/`url` = the source article `url` for web highlights, null for book highlights (no per-highlight public URL); `Authorization: Token <token>` auth (Django-REST-Framework token auth — the literal word "Token", NOT "Bearer"; never logged); vault key `readwise.token` (required); fixed SaaS host `readwise.io` (static sandbox network, no host override); `highlighted_at` / `updated` are ISO-8601 parsed to epoch-ms via `parseIsoMs` (NOT verbatim, NOT epoch seconds); `modifiedAt` = updated ?? highlighted_at ?? syncedAt; title = first 80 chars of the trimmed text (`…` when truncated) with a `Highlight <id>` fallback; the `readwise:highlight` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — a highlight is short, avoiding surprise OpenAI spend); three read tools (`readwise_list` / `readwise_get` / `readwise_search`); `hitlRequired: []`; **v1 highlights only — books / documents / daily-review deferred; the Reader v3 API deferred**
- [x] **Obsidian vault connector** (2026-05-10, Phase 5 Wave A PR 2) — indexes local Markdown vaults with frontmatter metadata, backlinks, and daily notes; uses `[[filesystem.roots]]` as the discovery mechanism; `obsidian_note` item type; backlinks surfaced in the relationship graph (`backlinks` edge type, V26 migration adds `obsidian_notes` shadow table); append to daily note behind HITL (`obsidian.note.append`); no network call required — fully local. Hybrid surface: gateway-side syncable at `packages/gateway/src/connectors/obsidian-sync.ts` plus a thin MCP package at `packages/mcp-connectors/obsidian/` that hosts the HITL-gated `obsidian_append_to_daily_note` write tool. Vault id is derived from the absolute vault root path (`sha256(path).slice(0, 12)`); moving a vault re-issues all note ids — documented in `docs/architecture.md`.
- [x] **Zotero** (2026-05-31, Phase 5 Tier 1) — `zotero:reference` items via `mapZoteroReferenceToItem` (`GET /<library>/items?format=json&limit=100&start=N&sort=dateModified&direction=desc` reading a **bare JSON array** of item objects — each `{ key, version, library, data: { itemType, title, creators, date, dateModified, dateAdded, tags, collections, DOI, url, abstractNote, ... } }` — incrementing the `start` offset by 100 while a full page of 100 comes back, stopping on a short/empty page, `MAX_PAGES=20`); get-by-id is `GET /<library>/items/{key}`; `external_id` = the Zotero item `key` (a stable string, NOT a UUID and NOT numeric — the row is skipped when `key` is missing/empty); items whose `data.itemType` is `attachment` or `note` are skipped (top-level bibliographic references only). **Two-identifier auth (the Stack Overflow shape):** the `Zotero-API-Key: <key>` header (the secret) + `Zotero-API-Version: 3` header, plus a **non-secret** `zotero.library` spec of the form `users/<id>` or `groups/<id>` URL-encoded into the request PATH (the sync handler and the lazy-mesh spawn both no-op unless BOTH keys are present); two required vault keys `zotero.api_key` (secret) + `zotero.library` (non-secret); fixed SaaS host `api.zotero.org` (static sandbox network, no host override). Metadata key/version/item_type/title/creators/date/date_modified/date_added/tags/collections/doi/url/abstract/publication_title (`creators` reduced to a formatted name-array tolerating both the `firstName`/`lastName` and single-field `name` shapes; `tags` reduced to the `tag`-name array; `collections` the collection-key string array; the abstract truncated to 500 chars); `dateModified` / `dateAdded` are ISO-8601 strings parsed to epoch-ms via a LOCAL `parseIsoMs` helper (NOT verbatim, NOT epoch seconds); `modifiedAt` = dateModified ?? dateAdded ?? syncedAt; title = the trimmed `data.title` (120-char `…` truncation) with a `<itemType> <key>` then `Reference <key>` fallback for title-less item types; `canonical_url`/`url` = the item's `data.url` (null when missing/empty); the `zotero:reference` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — abstracts are short and the batch default is to omit, avoiding surprise OpenAI spend for hybrid-mode users); three read tools (`zotero_list` / `zotero_get` / `zotero_search`); `hitlRequired: []`. **NOTE — incremental cursor deviation:** the Zotero Web API exposes a `Last-Modified-Version` response header + `?since=<version>` incremental cursor and a `Total-Results` header for exact pagination, but the shared `connectorFetch` helper returns only the parsed JSON body + byte count (it does not surface response headers); to stay faithful to the proven simple-REST template the connector uses the established single-forward-pass offset walk with empty-page / `MAX_PAGES` termination and a `{ pass }` cursor (mirroring Lever / Stack Overflow) rather than introducing a header-exposing fetch helper — `since`-based incremental sync is a documented follow-up. **v1 top-level bibliographic references only — attachments / notes / per-collection filtering deferred.**

##### API Surface Intelligence

- [x] **OpenAPI / AsyncAPI spec indexer** (2026-05-10, Phase 5 Wave A PR 1) — gateway-side syncable at `packages/gateway/src/connectors/openapi-indexer-sync.ts` that crawls `[[filesystem.roots]]` for `openapi.{yaml,yml,json}`, `swagger.{yaml,yml,json}`, and `asyncapi.{yaml,yml,json}` files; parses each endpoint as an `api_endpoint` item with fields: `path`, `method`, `operation_id`, `tags`, `deprecated`, `service_name` (inferred from per-spec `nimbus.openapi.toml` override → enclosing directory → `info.title` slug → `service-<sha8>` fallback), `spec_file`, `spec_version`, `last_modified`. Mtime-based delta sync, sticky deletes for endpoints removed from re-parsed specs. Emits `api_endpoint → service` edges into the relationship graph so `nimbus impact` answers naturally include API-surface ramifications. V25 migration adds the `api_endpoint` shadow table; the unified `item` table holds the cross-cutting search row (`service = "openapi"`, `type = "api_endpoint"`). Discovery walker is depth-bounded (`[openapi].max_walk_depth`, default 8), respects `[openapi].ignore_globs`, skips a default-ignored dir set (`node_modules`, `.git`, `dist`, `build`, `target`, `.next`, `out`, `vendor`, `.cache`), and never follows symlinks. Spec-size gate (`[openapi].max_spec_bytes`, default 5 MiB); skipped specs surface in the connector's `getLastSyncStats()` for health snapshots. Indexing is fully local — no outbound call. Remote-repo spec discovery, external `$ref` resolution, and AsyncAPI 3.0 are deferred to a follow-up. Parser: `js-yaml` for synchronous parsing; `@readme/openapi-parser` (v6) reserved for future validation.

##### Email via IMAP/SMTP

- [x] **Generic IMAP connector** (2026-06-02, Phase 5 Tier 4 — the EMAIL-class infra-prover) — `imap:email` items via `mapImapMessageToItem` from raw IMAP over `imapflow` (read tools `imap_list` / `imap_get` / `imap_search`) plus one HITL-gated SMTP send tool `imap_mail_send` over `nodemailer`. **HEADERS + a short capped plain-text PREVIEW + attachment METADATA ONLY** — the connector fetches the IMAP `ENVELOPE` (subject/from/to/cc/date/message-id) + `BODYSTRUCTURE` (attachment filename/size/mimetype) + a single truncated `text/plain` body part (capped ~2 KB at fetch + 2000 chars in the mapper); it **NEVER** requests `BODY[]` or an attachment part, so no attachment bytes or full body ever reach the index (the `ImapClient` interface has no surface to request them, and a mapper test asserts no `content`/`base64` field). `external_id` prefers the RFC `Message-Id`, falling back to `<mailbox>:<uidvalidity>:<uid>`; sync is a single most-recent-N forward pass (`MAX_MESSAGES=200`, cursor `{ pass }` / `nimbus-imap1:`), tolerant of transient IMAP outages (the injected fetcher returns `{ ok: false }` / a thrown fetcher is caught → cursor preserved, no scheduler crash). **Per-tenant creds** — nine vault keys `imap.host`/`port`/`username`/`password`/`mailbox` + `imap.smtp_host`/`smtp_port`/`smtp_username`/`smtp_password` (SMTP optional; send tool gated on them); lazy-mesh spawn `phase3AddImapMcp` rides the phase3 bundle gated on the IMAP read creds, injecting `IMAP_*` env. **Sandbox** — the IMAP/SMTP hosts are user-configured and on non-443 ports (IMAP 993, SMTP 465/587), so the static `permissions.network` is empty and the concrete `<host>:<port>` entries are added at spawn via `manifestWithExtraNetworkHosts` (the `host:port` permission syntax landed in Tier-4a sandbox prereq, commit `bc50d57a`), routed through `wrapServerSpec` (I15). **HITL send** — `imap_mail_send` clones the existing gmail/outlook send-tool shape; the gate keys on `action.type` `email.send` (already in `HITL_REQUIRED_BACKING`) via the planner path, so NO executor.ts / invariant change. `imap:email` IS prose → added to `PROSE_HEAVY_TYPES` (like `gmail:email` / `outlook:email`; MiniLM-only fallback when `openai.api_key` is absent). The real imapflow/nodemailer adapters (`_lib/imap-client.ts` + connector `server.ts`) are dependency-injected so all tests run without a socket; **v1 single mailbox, headers+preview+attachment-metadata only — folders / flags / threading / IDLE push and reply/forward write tools deferred.** First Tier-4 connector — sets the EMAIL-class template Fastmail (JMAP) + ProtonMail (Bridge) reuse
- [x] **Fastmail MCP connector** (2026-06-02, Phase 5 Tier 4) — native **JMAP** (not IMAP): `fastmail:email` items via `mapFastmailEmailToItem` over pure HTTPS. The sync handler discovers the JMAP session (`GET /jmap/session` → `apiUrl` + the `urn:ietf:params:jmap:mail` primary account id), then issues ONE batched `POST` with `Email/query` (recent 200, `receivedAt` desc) + a back-referenced `Email/get` (`#ids`) requesting headers + `attachments` metadata + `fetchTextBodyValues` with **`maxBodyValueBytes: 2048`** — the server truncates the body value so a full body never crosses the wire. Read tools `fastmail_list` / `fastmail_get` / `fastmail_search` (the latter a JMAP `Email/query` `{ text }` filter) + HITL-gated `fastmail_mail_send` (JMAP `Identity/get` + `Mailbox/query` drafts → `Email/set` create + `EmailSubmission/set`). **HEADERS + capped PREVIEW + attachment METADATA ONLY** — only `attachments` `{name,size,type}` is read, the `blobId` download URL is NEVER dereferenced (a `viewEmail`/mapper test asserts no `blobId`/`content`/`base64` field reaches the index). `external_id` = RFC `Message-Id` else the stable JMAP email `id`; cursor `{ pass }` / `nimbus-fastmail1:`; transient-tolerant (a session/api HTTP or parse error preserves the cursor). **Auth** — a single secret `fastmail.api_token` (required) + optional non-secret `fastmail.base_url` override, so `CONNECTOR_VAULT_SECRET_KEYS.fastmail` is `["fastmail.api_token", "fastmail.base_url"]`; the connector reads only `FASTMAIL_API_TOKEN` / `FASTMAIL_BASE_URL` from env. **Sandbox** — JMAP is pure HTTPS/443 to the fixed `api.fastmail.com` (session/api/upload/download all under it), so the static `permissions.network` is a single 443 host (no per-tenant host, no port extension), routed through `wrapServerSpec` (I15); spawn `phase3AddFastmailMcp` rides the phase3 bundle gated on the token. `fastmail:email` IS prose → `PROSE_HEAVY_TYPES`. The real JMAP fetch adapter (`server.ts`) is coverage-exempt; the testable JMAP logic (session parse, address/preview/attachment reduction, request builders, response extraction, the `viewEmail` no-bytes view) lives in `jmap-core.ts` (100% covered). **v1 single account, headers+preview+attachment-metadata only — folders / threads / push and reply/forward deferred.** Reuses the EMAIL-class template from the Generic IMAP connector
- [x] **ProtonMail MCP connector** (2026-06-02, Phase 5 Tier 4) — ProtonMail Bridge integration. ProtonMail is E2EE, so the local Bridge app decrypts mail on the user's machine and exposes a standard IMAP/SMTP interface on the loopback interface (127.0.0.1:1143 IMAP / :1025 SMTP) with Bridge-generated credentials. `protonmail:email` items via `mapProtonmailEmailToItem` — HEADERS + capped PREVIEW + attachment METADATA only, never attachment bytes / full body. The gateway sync **reuses the generalized `_lib/imap-client.ts` `fetchImapMessages`** (the `ImapConnectionConfig` gained optional `secure` / `tlsRejectUnauthorized` so Bridge can set `secure:false` + accept the loopback self-signed cert) and the `ImapMessageInput` shape; the connector MCP package mirrors the IMAP read tools + HITL-gated `protonmail_mail_send` over the Bridge SMTP relay. Read tools `protonmail_list` / `protonmail_get` / `protonmail_search`; cursor `{ pass }` / `nimbus-protonmail1:`; transient-tolerant (Bridge-not-running → cursor preserved). **Creds** — Bridge username/password (required) + optional host/port/mailbox + SMTP overrides, so `CONNECTOR_VAULT_SECRET_KEYS.protonmail` lists all nine; the connector reads only `PROTONMAIL_*` env. **Sandbox** — the loopback `127.0.0.1:1143` (+ `:1025` when SMTP is configured) host:port entries are added at spawn via `manifestWithExtraNetworkHosts`, `wrapServerSpec` (I15). HITL send gated by the existing `email.send` `action.type`. `protonmail:email` → `PROSE_HEAVY_TYPES`. (Send is included beyond the original read-only scope — Bridge relays outbound; per user decision.) **v1 single mailbox, headers+preview+attachment-metadata only.** Reuses the EMAIL-class template; the shared IMAP `mail-kit` extraction (dedup with the Generic IMAP connector's `bodystructure`/`mail-core`/tool-registration) is a documented follow-up

##### Meetings & Async Video

- [x] **Zoom** (2026-05-29, Phase 5 Tier 1 PR-2 + PR-3) — scheduled meeting metadata (`zoom:meeting`) via `GET /v2/users/me/meetings?type=scheduled` AND cloud-recording AI transcripts (`zoom:transcript`, prose-heavy) via `GET /v2/users/me/recordings` (≤1-month-windowed walk + skip-if-exists on `<meeting_uuid>:<recording_file_id>` + Bearer-header download, never URL-token, never logged); 3-legged OAuth (PKCE + Basic-header secret) on the provider registry (PR-1); single-flight refresh token rotation; fixed sandbox hosts `api.zoom.us` + `zoom.us` (I15); `hitlRequired: []`
- [x] **Google Meet** (2026-05-31, Phase 5 Tier 2) — past meeting conference records (`google_meet:meeting`) via the Google Meet REST API v2 `GET https://meet.googleapis.com/v2/conferenceRecords?pageSize=50` (paginating via `nextPageToken`; cursor `{ v:1, pageToken }`, the google_photos cursor shape); get-by-id `GET /v2/conferenceRecords/{id}`. **Extends the EXISTING `google` provider as a new google sub-service** (alongside google_drive / gmail / google_photos) — NOT a new `OAuthProvider`: reuses `getValidGoogleAccessToken(vault, "google_meet")`, the shared `google.oauth` / per-service `google_meet.oauth` vault keys, and the generic `connector.auth` OAuth surface (no `oauth-registry.ts` / `never`-switch / `config.ts` / Tauri `ALLOWED_METHODS` change). Scope `https://www.googleapis.com/auth/meetings.space.readonly` declared in `connector-catalog.ts`. Rides in the existing google bundle slot (`ensureGoogleDriveMcp` gains a `google_meet` spawn branch, `ServerSpec` via `wrapServerSpec` (I15)); static sandbox host `meet.googleapis.com`. `external_id` = the `name` id segment (`conferenceRecords/<id>` → `<id>`; row skipped when `name` is missing/empty). Conference records carry no human title → title derived as `Meeting <startTime ISO date>` (or `Meeting <id>` when startTime absent); `modifiedAt` = endTime ?? startTime ?? syncedAt (ISO-8601 via a local `parseIsoMs`); `url`/`canonical_url` null (records carry no productUrl; the pure mapper has no space meetingUri); metadata `{ name, space, startTime, endTime }`. The `google_meet:meeting` type stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — sparse timestamps + ids). Three read tools (`google_meet_list` / `google_meet_get` / `google_meet_search`); `hitlRequired: []`. v1 indexes conference records only — auto-generated transcripts / participant detail deferred.
- [ ] **Loom** — async video index: title, description, transcript, viewer stats; OAuth; read-only; `loom_video` item type. **Deferred to a Phase 5 follow-up (2026-05-31):** Loom exposes no public read REST API for listing/fetching a user's existing videos with a personal or OAuth token — its only official developer surface is the **recordSDK** (embed/record *new* videos into your own app, authenticated by signed-JWT key-pair, `dev.loom.com`). The only "list my videos" options are unofficial third-party scrapers (e.g. Apify) that operate on share/embed URLs without authentication, which are incompatible with Nimbus's MCP-as-connector + first-party-clean-API + Vault-credential posture (a read-only `list`/`get`/`search` template needs a sanctioned, token-authenticated read endpoint). A workspace/admin read API may exist behind Atlassian's enterprise/partner gating but is not generally obtainable. Revisit if Loom ships a public content API; the local-STT path (`Video input — local STT + frame captioning`, below) remains the fallback for indexing a Loom recording's transcript from its file. Not a Phase 5 gate.

##### Finance & Expenses

- [ ] **Expensify** — expense reports, receipts, reimbursement status; read-only index; submit behind HITL. **Deferred to a Phase 5 follow-up (2026-05-31):** unlike every other Tier-1 connector, Expensify exposes no clean REST surface — its only programmatic API is the Integration Server (`requestJobDescription` JSON-over-form POST + a two-step async file-generate→download flow using freemarker export templates), which does not fit the read-only `list`/`get`/`search` template. Sequenced after the remaining tiers; not a Phase 5 gate.
- [x] **Ramp** (2026-05-31, Phase 5 Tier 1) — `ramp:transaction` items via `mapRampTransactionToItem` (`GET https://api.ramp.com/developer/v1/transactions?page_size=100` reading the `.data` array of transaction objects — each `{ id, amount, currency_code, merchant_name, card_holder: { first_name, last_name, department_name }, state, sk_category_name, user_transaction_time, memo, ... }` — and following the `page.next` **cursor** (a full URL to the next page, or null/absent at the end) for a single forward pass per cycle, `MAX_PAGES=20`); get-by-id is `GET /developer/v1/transactions/{id}`; `external_id` = the transaction `id` (a stable Ramp-supplied string, NOT a generated UUID — the row is skipped when `id` is missing/empty). **OAuth2 client-credentials auth (a token exchange, NOT 3-legged user consent — the Superset login shape):** the connector exchanges its client id + client secret for a bearer token at `POST /developer/v1/token` (HTTP **Basic** auth, `Content-Type: application/x-www-form-urlencoded` body `grant_type=client_credentials&scope=transactions:read`) and caches it (per process in the MCP server; per sync cycle in the gateway syncable), then calls the data endpoints with `Authorization: Bearer`; on a mid-cycle `401` the gateway syncable re-exchanges once and retries the page (the sync handler and the lazy-mesh spawn `phase3AddRampMcp` both no-op unless BOTH credentials are present); two required **secret** vault keys `ramp.client_id` + `ramp.client_secret`; fixed SaaS host `api.ramp.com` (static sandbox network, no host override). Metadata id/amount/currency_code/merchant_name/card_holder_name/department/state/category/user_transaction_time/memo (the card holder reduced to a `first_name last_name` display name + the `department_name`; the memo truncated to 500 chars); `user_transaction_time` is an ISO-8601 string parsed to epoch-ms via a LOCAL `parseIsoMs` helper (NOT verbatim, NOT epoch seconds); `modifiedAt` = `user_transaction_time ?? syncedAt`; title synthesized as `<merchant_name> — <amount> <currency>` with a `Ramp transaction — <amount>` then bare `Ramp transaction` fallback; `url`/`canonical_url` are always null (the Ramp API surfaces no transaction permalink); **no full card numbers / PANs are surfaced** (Ramp's API does not return them and only the safe fields are mapped); the `ramp:transaction` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured spend metadata); three read tools (`ramp_list` / `ramp_get` / `ramp_search`); `hitlRequired: []`. **v1 card transactions only — receipts / budgets / vendor spend rollups deferred.**
- [x] **Mercury** (2026-05-25, Phase 5 Tier 1) — `mercury:account` items via `mapMercuryAccountToItem` (a single `GET /api/v1/accounts` reading the `{ accounts: [...] }` object envelope — no pagination, the full account list is returned in one call); `external_id` = the account `id`; metadata account_id/name/status/type/kind/account_number_last4/routing_number/available_balance/current_balance/legal_business_name/created_at/canonical_url; the full account number is NEVER stored — only the last 4 digits (`account_number_last4`); balances are USD major units (dollars, not cents) passed through verbatim; `Authorization: Bearer <api token>` auth (never logged); vault key `mercury.token` (required); fixed SaaS host `api.mercury.com` (static sandbox network, no host override); `createdAt` is ISO-8601 parsed to epoch-ms via `parseIsoMs` (NOT verbatim, NOT epoch seconds); `canonical_url`/`url` are null (Mercury accounts have no per-account public URL); three read tools (`mercury_list` / `mercury_get` / `mercury_search`); `hitlRequired: []`; **v1 accounts only — transactions / bills / statements deferred; wire / ACH (HITL) writes deferred to Phase 6**
- [x] **Stripe** (2026-05-25, Phase 5 Tier 1) — `stripe:invoice` items via `mapStripeInvoiceToItem` (`GET /v1/invoices?limit=100`, `starting_after` + `has_more` cursor walk, `MAX_PAGES=20`); `external_id` = the invoice `id` (e.g. `in_1A2b...`); metadata invoice_id/number/customer_id/customer_name/customer_email/status/amount_due/amount_paid/currency/subscription_id/hosted_invoice_url/invoice_pdf/created_at/due_date/period_start/period_end/canonical_url (canonical prefers `hosted_invoice_url`, else `invoice_pdf`, else null); `Authorization: Bearer <secret key>` auth (the `sk_live_`/`sk_test_` key is never logged); vault key `stripe.api_key` (required); fixed SaaS host `api.stripe.com` (static sandbox network, no host override); Stripe timestamps are epoch SECONDS converted to epoch-ms via `secondsToMs` (×1000, NOT `Date.parse`); amounts are integer minor units (cents); three read tools (`stripe_list` / `stripe_get` / `stripe_search`); `hitlRequired: []`; **v1 invoices only — payments / customers / disputes / subscription events deferred; `stripe.refund` (HITL) deferred to Phase 6**

##### CRM & Sales

- [x] **HubSpot** (2026-05-31, Phase 5 Tier 2 — first Tier-2 OAuth infra-prover) — `hubspot:deal` items via `mapHubspotDealToItem` (`GET /crm/v3/objects/deals?limit=100&properties=dealname,amount,dealstage,pipeline,closedate,createdate,hs_lastmodifieddate`, reading the `{ results, paging?: { next?: { after } } }` envelope and following the `paging.next.after` opaque cursor until absent, `MAX_PAGES=20`); get-by-id is `GET /crm/v3/objects/deals/{dealId}?properties=…`; **6th `OAuthProvider` — proves the 3-legged OAuth authorization-code path the rest of Tier-2 (Salesforce / Google Meet / Loom / Figma / Miro / Canva) reuses**; widening the registry union forced the exhaustive 4-file `never`-switch bundle to co-land (`oauth-registry.ts` + `connector-rpc-handlers/auth.ts` `case "hubspot"` + `config.ts` `oauthHubspot*` + `oauth-env-help-messages.ts`); OAuth shape is authorization-code (NOT PKCE) with the client secret form-encoded in the token-exchange BODY (`secretPlacement: "body"`, distinct from Zoom's Basic-header), authorize `app.hubspot.com/oauth/authorize`, token `api.hubapi.com/oauth/v1/token`, scopes `crm.objects.deals.read` + `oauth`; tokens under the `hubspot.oauth` vault key refreshed by `getValidHubspotAccessToken` (single-flight registry lock); **no new Tauri `ALLOWED_METHODS` entry — reuses the generic `connector.auth` OAuth surface, like Zoom**; lazy-mesh spawn `ensureHubspotMcp` (Zoom dedicated-spawn pattern) gated on a valid `hubspot.oauth` token, `ServerSpec` wrapped via `wrapServerSpec` (I15); fixed SaaS host `api.hubapi.com`; `external_id` = the deal `id`; metadata dealname/amount/dealstage/pipeline/closedate/createdate/hs_lastmodifieddate (date properties parse BOTH ISO-8601 and epoch-ms encodings via a local `parseHubspotMs`); `modifiedAt` = hs_lastmodifieddate ?? envelope updatedAt ?? syncedAt; title = `dealname` (fallback `HubSpot deal <id>`); `url`/`canonical_url` null (deal permalinks need a portal id the API does not return — Ramp/Prefect posture); the `hubspot:deal` type stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — sparse structured pipeline/spend metadata); three read tools (`hubspot_list` / `hubspot_get` / `hubspot_search`); `hitlRequired: []`; **v1 deals only — companies / contacts / tickets / activities / notes deferred; write behind HITL deferred to Phase 6**
- [x] **Salesforce** (2026-05-31, Phase 5 Tier 2) — `salesforce:opportunity` items via `mapSalesforceOpportunityToItem` from the **SOQL query API** (`GET <instance_url>/services/data/v60.0/query?q=SELECT … FROM Opportunity ORDER BY LastModifiedDate DESC LIMIT 200`, following the `{ records, done, nextRecordsUrl?, totalSize }` envelope's `nextRecordsUrl` cursor until `done`, `MAX_PAGES=20`); get-by-id is `GET .../sobjects/Opportunity/<id>`; **10th `OAuthProvider`** — widening the registry union forced the exhaustive 4-file `never`-switch bundle to co-land (`oauth-registry.ts` + `connector-rpc-handlers/auth.ts` `case "salesforce"` + `config.ts` `oauthSalesforce*` + `oauth-env-help-messages.ts`); **per-tenant API host: the `instance_url` is discovered at OAuth time, so the shared OAuth token blob was additively extended (`StoredOAuthTokens`/`PKCEResult` gain optional `instanceUrl?: string`; `parseStoredOAuthTokens` captures it only when non-empty; `persistTokens` conditional-spreads it — the 9 other providers' payloads stay byte-identical)**; OAuth shape is authorization-code **WITH PKCE** + client secret form-encoded in the token-exchange BODY (`usesPkce: true`, `secretPlacement: "body"`), authorize + token both `login.salesforce.com/services/oauth2/{authorize,token}`, scopes `api` + `refresh_token`; a **custom `parseSalesforceTokenResponse` requires `instance_url`** (no silent fallback) and **synthesizes a 30-minute expiry because Salesforce omits `expires_in`** (so the 120 s-margin single-flight refresh renews each cycle via the refresh token); tokens + `instance_url` under the `salesforce.oauth` vault key, `getValidSalesforceAuth` returns `{ accessToken, instanceUrl }`; **no new Tauri `ALLOWED_METHODS` entry — reuses the generic `connector.auth` OAuth surface**; lazy-mesh spawn `ensureSalesforceMcp` combines HubSpot's OAuth-read guard with **Jenkins's per-tenant extra-host pattern** (the discovered instance host added at spawn via `manifestWithExtraNetworkHosts`, `ServerSpec` routed through `wrapServerSpec` directly, I15); the static manifest declares only `login.salesforce.com` (RFC-1123 host validation rejects `*.salesforce.com` wildcards); `external_id` = the SF `Id`; metadata name/stage/amount/closeDate/probability/type/isClosed/isWon/lastModifiedDate/createdDate (ISO-8601 dates via a local `parseIsoMs`); `modifiedAt` = LastModifiedDate ?? syncedAt; title = `Name` (fallback `Salesforce opportunity <id>`); `url`/`canonical_url` null (pure mapper does not take the instance host — HubSpot/Prefect posture); the `salesforce:opportunity` type stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — sparse structured pipeline metadata); three read tools (`salesforce_list` / `salesforce_get` / `salesforce_search`); `hitlRequired: []`; **v1 Opportunities only — other sObjects (Lead / Contact / Account / Case), SOSL full-text, and write behind HITL deferred to Phase 6**
- [x] **Pipedrive** (2026-05-25, Phase 5 Tier 1) — `pipedrive:deal` items via `mapPipedriveDealToItem` (`GET /v1/deals?api_token=<t>&limit=100&start=N`, reading the `{ success, data, additional_data: { pagination: { more_items_in_collection, next_start } } }` envelope — a null `data` is treated as empty — following the `next_start` offset while `more_items_in_collection` is true, `MAX_PAGES=20`); get-by-id is `GET /v1/deals/{id}`; `external_id` = `String(<deal id>)` (the row is skipped when `id` is missing/non-numeric — Pipedrive ids are numbers, mirroring Raindrop's `_id`); metadata deal_id/title/value/currency/status/stage_id/pipeline_id/person_id/person_name/org_id/org_name/owner_name/probability/label/expected_close_date/won_time/close_time/add_time/update_time/canonical_url (`person_id`/`org_id` can themselves be `{ value, name }` objects, extracted defensively via `asRecord`; the denormalized person/org/owner names fall back to the nested `.name`); **auth is via the API token IN THE QUERY STRING (`?api_token=<token>`) — there is NO Authorization header — so the request URL carries the secret; the connector + syncable never log a URL and never put a URL (or anything derived from it) into an Error/audit/log line: errors use the HTTP status + a token-free response-body slice only, and the failure-path warn logs just the status + the token-free `start` offset**; vault key `pipedrive.token` (required); fixed SaaS host `api.pipedrive.com` (static sandbox network, no host override); `add_time` / `update_time` (and `won_time` / `close_time`) are Pipedrive's non-ISO `"YYYY-MM-DD HH:MM:SS"` UTC strings converted to epoch-ms via a local helper (space→`T` + `Z` before `Date.parse`, NOT verbatim, NOT epoch seconds); `modifiedAt` = update_time ?? add_time ?? syncedAt; title = the deal `title`, else `Deal <id>`; bodyPreview = `<value> <currency> — <status>` when a value is present, else the status, else org_name/person_name, else the title; `canonical_url`/`url` = null (a deal deep link needs the company-specific domain, absent from the token-only base — deferred; the Mercury null-canonical pattern); the `pipedrive:deal` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — a deal is short, avoiding surprise OpenAI spend); three read tools (`pipedrive_list` / `pipedrive_get` / `pipedrive_search`); `hitlRequired: []`; **v1 deals only — persons / organizations / activities / notes deferred**

##### Support & Community

- [x] **Zendesk** (2026-05-25, Phase 5 Tier 1) — `zendesk:ticket` items via `mapZendeskTicketToItem` (`GET /api/v2/tickets.json?page[size]=100`, cursor-based pagination reading the `{ tickets, meta: { has_more, after_cursor }, links }` envelope, following `meta.after_cursor` while `meta.has_more` is true AND the cursor is non-empty, `MAX_PAGES=20`); get-by-id is `GET /api/v2/tickets/{id}.json`; `external_id` = `String(<numeric ticket id>)` (the row is skipped when the id is missing/non-numeric — accepted as a numeric string or number, mirroring Raindrop's `_id` skip + Intercom's numeric-string accept); metadata ticket_id/subject/status/priority/type/requester_id/assignee_id/group_id/organization_id/tags/via_channel/created_at/updated_at/canonical_url (`tags` is the string array verbatim via `tagStrings`, tolerating non-strings; `via_channel` is the nested `via.channel` via defensive `asRecord`); `canonical_url`/`url` = the agent-UI deep link `<base>/agent/tickets/<id>` built from the configured base (trailing slash stripped; null only when the base is empty — the base URL is always known here, unlike Intercom, via the ArgoCD `ctx.baseUrl` mapper pattern). Unlike the fixed-host SaaS siblings in this batch, Zendesk is **per-tenant**: the user supplies the full base URL `https://<subdomain>.zendesk.com` via `zendesk.url`, and that host is added to the sandbox network list at spawn time by `phase3AddZendeskMcp` via `manifestWithExtraNetworkHosts` + `hostnameFromUrl` (the ArgoCD/Metabase/Grafana runtime-merge pattern — the static `nimbus.extension.json` + `first-party-manifests` network list is intentionally empty). HTTP **Basic** auth where the username is `<email>/token` and the password is the API token (`Authorization: Basic base64(<email>/token:<api_token>)`; never logged), from the three required vault keys `zendesk.url` / `zendesk.email` / `zendesk.api_token`; `created_at` / `updated_at` are ISO-8601 strings parsed to epoch-ms via `parseIsoMs` (NOT verbatim, NOT epoch seconds), `modifiedAt` = updated_at ?? created_at ?? syncedAt; title = the `subject` (trimmed) else `Ticket <id>`; bodyPreview = the plain-text `description` (Zendesk's description is already the first comment as plain text) else the status label else the title; the `zendesk:ticket` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — consistent with the batch default to omit, avoiding surprise OpenAI spend for hybrid-mode users; promotion is a documented follow-up); three read tools (`zendesk_list` / `zendesk_get` / `zendesk_search`); `hitlRequired: []`; **v1 tickets only — comments / users / organizations / Help Center articles + reply / solve / assign write tools deferred**
- [x] **Intercom** (2026-05-25, Phase 5 Tier 1) — `intercom:conversation` items via `mapIntercomConversationToItem` (`GET /conversations?per_page=150` reading the `{ type: "conversation.list", conversations, pages, total_count }` envelope, following the cursor at `pages.next.starting_after` while it is a non-empty string, `MAX_PAGES=20`); get-by-id is the PLURAL `GET /conversations/{id}`; `external_id` = `String(<numeric conversation id>)` (the row is skipped when the id is missing/non-numeric — Intercom ids are numeric strings, accepted as a numeric string or number); metadata conversation_id/title/state/priority/open/read/source_type/source_author_name/source_author_email/source_subject/contact_ids/assignee_id/team_assignee_id/tags/created_at/updated_at/canonical_url (`contact_ids` from `contacts.contacts[].id`; `assignee_id` = `admin_assignee_id` else nested `assignee.id`; `tags` is the tag-NAME array from `tags.tags[].name`, tolerating non-object entries); `canonical_url`/`url` = null (the Intercom inbox deep link needs the workspace app id, which is absent from the conversation payload — deferred; the Mercury null-canonical pattern); `Authorization: Bearer <token>` auth (an Intercom Access Token; never logged) plus the `Intercom-Version: 2.11` + `Accept: application/json` request headers; vault key `intercom.token` (required); fixed SaaS host `api.intercom.io` (the US host — EU/AU regional hosts (api.eu.intercom.io / api.au.intercom.io) deferred; static sandbox network, no host override); `created_at` / `updated_at` are epoch SECONDS converted to epoch-ms via the Stripe `secondsToMs` helper (×1000; re-used, NOT redefined, NOT `parseIsoMs`, NOT verbatim); `modifiedAt` = updated_at ?? created_at ?? syncedAt; title = `source.subject` (trimmed) else `Conversation <id>`; bodyPreview = the HTML-stripped `source.body` (a simple tag-strip + whitespace collapse, no dependency) else the state label else the title; the `intercom:conversation` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — the conversation LIST endpoint only returns the first message and bodies are short, so the batch default to omit avoids surprise OpenAI spend for hybrid-mode users); three read tools (`intercom_list` / `intercom_get` / `intercom_search`); `hitlRequired: []`; **v1 conversations only — contacts / companies / tickets / admins-as-items + reply / close / assign write tools deferred**
- [x] **Stack Overflow for Teams** (2026-05-25, Phase 5 Tier 1) — `stackoverflow:question` items via `mapStackOverflowQuestionToItem` (`GET /v3/teams/<team>/questions?page=N&pagesize=100&sort=creation&order=desc` reading the v3 `{ items, totalCount, pageSize, page, totalPages, sort, order }` envelope, 1-based page number, continuing while `page < totalPages` and `items` is non-empty, `MAX_PAGES=20`); get-by-id is `GET /v3/teams/<team>/questions/{id}` (a single question, NOT wrapped in `{ items }`); `external_id` = `String(<question id>)` (the row is skipped when `id` is missing/non-numeric — SO ids are numbers, mirroring Raindrop's `_id`); metadata question_id/title/tags/score/view_count/answer_count/is_answered/owner_id/owner_name/creation_date/last_activity_date/last_edit_date/canonical_url (the question body is HTML-stripped to plain text for the body preview; `tags` is reduced to the tag-NAME array, tolerating v3 tags as either `{ name }` objects or plain strings; owner_id/owner_name come from the nested `owner` object via defensive `asRecord`); Bearer auth (`Authorization: Bearer <token>` + `Accept: application/json`; never logged) using the TWO required vault keys `stackoverflow.token` (a Stack Overflow for Teams Personal Access Token) + `stackoverflow.team` (the team slug, URL-encoded into the request PATH — the syncable and the lazy-mesh spawn both no-op unless both keys are present); fixed SaaS host `api.stackoverflowteams.com` (static sandbox network, no host override); `creationDate` / `lastActivityDate` / `lastEditDate` are ISO-8601 strings parsed to epoch-ms via a LOCAL `parseIsoMs` helper (NOT verbatim, NOT epoch seconds); `modifiedAt` = lastActivityDate ?? lastEditDate ?? creationDate ?? syncedAt; title = the trimmed `title`, else `Question <id>`; bodyPreview = the HTML-stripped body, else `bodyMarkdown`, else a tag summary, else the title; `canonical_url`/`url` = the per-question `webUrl` (the v3 API provides a real per-question URL); the `stackoverflow:question` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — promotion is a documented follow-up candidate since Q&A bodies are genuinely prose); three read tools (`stackoverflow_list` / `stackoverflow_get` / `stackoverflow_search`); `hitlRequired: []`; **v1 questions only — answers / articles / tags-as-items / users-as-items deferred**

##### HR & Recruiting

- [x] **Greenhouse** (2026-05-25, Phase 5 Tier 1) — `greenhouse:job` items via `mapGreenhouseJobToItem` (`GET /v1/jobs?per_page=100&page=N` reading a **bare JSON array** `[ ...jobs... ]` — NOT an envelope — incrementing `page` from 1 while the returned array is a full page of 100, stopping on a short/empty page, `MAX_PAGES=20`; Greenhouse also sends an RFC-5988 `Link` header with rel="next" but the walk uses the full-page-length heuristic like Netlify and does not parse it); get-by-id is `GET /v1/jobs/{id}`; `external_id` = `String(<job id>)` (the row is skipped when `id` is missing/non-numeric — Greenhouse ids are NUMBERS, so a numeric id is required, mirroring Raindrop's `_id`, NOT the Lever UUID-string accept); metadata job_id/name/status/requisition_id/confidential/department_names/office_names/office_locations/opened_at/closed_at/created_at/updated_at/canonical_url (`department_names` = `departments[].name`; `office_names` = `offices[].name`; `office_locations` = `offices[].location.name`, defensive nested access via `asRecord`); `canonical_url`/`url` = null (the Harvest API exposes no per-job public URL without a board token — deferred; the Mercury null-canonical pattern); HTTP **Basic** auth where the API key is the USERNAME and the password is EMPTY (`Authorization: Basic base64(<api_key>:)` — the trailing colon is the empty password; never logged); vault key `greenhouse.api_key` (required); fixed SaaS host `harvest.greenhouse.io` (static sandbox network, no host override); `created_at` / `updated_at` (and `opened_at` / `closed_at`) are ISO-8601 STRINGS parsed to epoch-ms via a LOCAL `parseIsoMs` helper (NOT verbatim, NOT epoch seconds); `modifiedAt` = updated_at ?? created_at ?? syncedAt; title = the trimmed job `name`, else `Job <id>`; bodyPreview = a summary joining the department names + office names/locations (e.g. "Engineering — San Francisco, CA"), else the `status`, else the title; the `greenhouse:job` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — jobs are short, avoiding surprise OpenAI spend); three read tools (`greenhouse_list` / `greenhouse_get` / `greenhouse_search`); `hitlRequired: []`; **v1 job openings only — candidates / applications deliberately deferred (candidate PII; out of scope for v1)**
- [x] **Lever** (2026-05-25, Phase 5 Tier 1) — `lever:posting` items via `mapLeverPostingToItem` (`GET /v1/postings?limit=100` reading the `{ data, hasNext, next }` envelope, following the `next` offset cursor — passed as `&offset=<next>` — while `hasNext` is true AND `next` is a non-empty string, `MAX_PAGES=20`); get-by-id is `GET /v1/postings/{id}`; `external_id` = `String(<posting id>)` (the row is skipped when `id` is missing/empty — Lever ids are UUID STRINGS, so any non-empty string id is accepted, NOT required numeric, unlike Raindrop's `_id`); metadata posting_id/text/state/team/department/location/commitment/level/tags/hosted_url/apply_url/req_code/created_at/updated_at/canonical_url (the `categories.*` sub-fields are flattened to top-level team/department/location/commitment/level; `tags` is the tag string array stored verbatim; `req_code` = `reqCode` else first of `requisitionCodes`); `canonical_url`/`url` = `hostedUrl`, else `urls.show`, else `applyUrl`, else null (defensive nested access via `asRecord`); HTTP **Basic** auth where the API key is the USERNAME and the password is EMPTY (`Authorization: Basic base64(<api_key>:)` — the trailing colon is the empty password; never logged); vault key `lever.api_key` (required); fixed SaaS host `api.lever.co` (static sandbox network, no host override); `createdAt` / `updatedAt` are epoch MILLISECONDS passed through VERBATIM (NO `parseIsoMs`, NO ×1000 — like Vercel; `0`/missing → null); `modifiedAt` = updatedAt ?? createdAt ?? syncedAt; title = the trimmed posting `text`, else `Posting <id>`; bodyPreview = a category summary joining the present team/department/location/commitment/level (e.g. "Engineering — Product — Remote — Full-time — Senior"), else the `state`, else the title; the `lever:posting` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — postings are short, avoiding surprise OpenAI spend); three read tools (`lever_list` / `lever_get` / `lever_search`); `hitlRequired: []`; **v1 job postings only — opportunities / candidates deliberately deferred (candidate PII; out of scope for v1)**

##### Design & Creative

- [x] **Figma** (2026-05-31, Phase 5 Tier 2) — `figma:file` items via `mapFigmaFileToItem` from a **two-level fetch** (`GET /v1/teams/<figma.team_id>/projects` → `{ name, projects: [{ id, name }] }`, then per project `GET /v1/projects/<id>/files` → `{ name, files: [{ key, name, thumbnail_url, last_modified }] }`, flattened across all projects with each file tagged by project name); neither endpoint paginates with a cursor, so a single forward pass per cycle bounded by `MAX_PROJECTS=200` / `MAX_FILES=2000`, cursor `{ pass }`; get-by-project is `GET /v1/projects/{projectId}/files`; **9th `OAuthProvider`** — widening the registry union forced the exhaustive 4-file `never`-switch bundle to co-land (`oauth-registry.ts` + `connector-rpc-handlers/auth.ts` `case "figma"` + `config.ts` `oauthFigma*` + `oauth-env-help-messages.ts`); OAuth shape mirrors Miro/HubSpot — authorization-code (NOT PKCE) with the client secret form-encoded in the token-exchange BODY (`secretPlacement: "body"`, distinct from Zoom/Canva's Basic-header), authorize `www.figma.com/oauth`, token `api.figma.com/v1/oauth/token`, scope `files:read`; tokens under the `figma.oauth` vault key refreshed by `getValidFigmaAccessToken` (single-flight registry lock); **second non-secret key (the `stackoverflow.team` pattern): `CONNECTOR_VAULT_SECRET_KEYS.figma = ["figma.oauth", "figma.team_id"]`, BOTH required for spawn (`ensureFigmaIfVaultCreds`) and sync, both injected at spawn (`FIGMA_TOKEN` + `FIGMA_TEAM_ID`)**; **no new Tauri `ALLOWED_METHODS` entry — reuses the generic `connector.auth` OAuth surface, like Miro/Canva/HubSpot/Zoom**; lazy-mesh spawn `ensureFigmaMcp` gated on a valid `figma.oauth` token AND `figma.team_id`, `ServerSpec` wrapped via `wrapServerSpec` (I15); fixed SaaS host `api.figma.com`; `external_id` = the file `key`; metadata name/project_name/thumbnail_url/last_modified (ISO-8601 `last_modified` via a local `parseIsoMs`); `modifiedAt` = last_modified ?? syncedAt; title = the file `name` (fallback `Figma file <key>`); `url`/`canonical_url` = `https://www.figma.com/file/<key>` (constructed from the stable key); the `figma:file` type stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — short file-name labels, sparse structured metadata); a failing per-project files call is skipped (partial coverage beats none) and a 429/401/parse error on the team-projects call degrades gracefully (cursor preserved); three read tools (`figma_list` / `figma_get` / `figma_search`); `hitlRequired: []`; **v1 = a single configured team's files only — multi-team, frames / components, comments, version history, FigJam boards deferred; comment post behind HITL deferred to Phase 6**
- [x] **Miro** (2026-05-31, Phase 5 Tier 2) — `miro:board` items via `mapMiroBoardToItem` (`GET /v2/boards?limit=50&cursor=<cursor>`, reading the `{ data, cursor?, total, size }` envelope and following the top-level `cursor` opaque cursor until absent, `MAX_PAGES=20`); get-by-id is `GET /v2/boards/{boardId}`; **7th `OAuthProvider`**; widening the registry union forced the exhaustive 4-file `never`-switch bundle to co-land (`oauth-registry.ts` + `connector-rpc-handlers/auth.ts` `case "miro"` + `config.ts` `oauthMiro*` + `oauth-env-help-messages.ts`); OAuth shape mirrors HubSpot — authorization-code (NOT PKCE) with the client secret form-encoded in the token-exchange BODY (`secretPlacement: "body"`, distinct from Zoom's Basic-header), authorize `miro.com/oauth/authorize`, token `api.miro.com/v1/oauth/token`, scope `boards:read`; tokens under the `miro.oauth` vault key refreshed by `getValidMiroAccessToken` (single-flight registry lock); **no new Tauri `ALLOWED_METHODS` entry — reuses the generic `connector.auth` OAuth surface, like HubSpot/Zoom**; lazy-mesh spawn `ensureMiroMcp` (HubSpot dedicated-spawn pattern) gated on a valid `miro.oauth` token, `ServerSpec` wrapped via `wrapServerSpec` (I15); fixed SaaS host `api.miro.com`; `external_id` = the board `id`; metadata name/description/owner_name/createdAt/modifiedAt/viewLink (ISO-8601 dates via a local `parseIsoMs`); `modifiedAt` = modifiedAt ?? createdAt ?? syncedAt; title = `name` (fallback `Miro board <id>`); `url`/`canonical_url` = the board `viewLink` (null when absent); the `miro:board` type stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — sparse structured board metadata); three read tools (`miro_list` / `miro_get` / `miro_search`); `hitlRequired: []`; **v1 boards only — items (cards / sticky notes / shapes) / comments deferred; write behind HITL deferred to Phase 6**
- [x] **Canva** (2026-05-31, Phase 5 Tier 2) — `canva:design` items via `mapCanvaDesignToItem` (`GET /rest/v1/designs?continuation=<token>`, reading the `{ items, continuation? }` envelope and following the top-level `continuation` opaque cursor query param until absent, `MAX_PAGES=20`); get-by-id is `GET /rest/v1/designs/{designId}`; **8th `OAuthProvider`** — widening the registry union forced the exhaustive 4-file `never`-switch bundle to co-land (`oauth-registry.ts` + `connector-rpc-handlers/auth.ts` `case "canva"` + `config.ts` `oauthCanva*` + `oauth-env-help-messages.ts`); **OAuth shape mirrors Zoom (PKCE + Basic-header secret), distinct from Miro/HubSpot's body-secret**: authorization-code WITH PKCE (`usesPkce: true`), client authenticated at the token endpoint via an HTTP Basic header `base64(client_id:client_secret)` alongside the PKCE `code_verifier` (`secretPlacement: "basic_header"`, `bodyFormat: "form"`, `clientSecret: "required"`), authorize `www.canva.com/api/oauth/authorize`, token `api.canva.com/rest/v1/oauth/token`, scope `design:meta:read`; no `postToken` plumbing change (Zoom already exercises basic_header + PKCE); tokens under the `canva.oauth` vault key refreshed by `getValidCanvaAccessToken` (single-flight registry lock); **no new Tauri `ALLOWED_METHODS` entry — reuses the generic `connector.auth` OAuth surface, like Miro/HubSpot/Zoom**; lazy-mesh spawn `ensureCanvaMcp` gated on a valid `canva.oauth` token, `ServerSpec` wrapped via `wrapServerSpec` (I15); fixed SaaS host `api.canva.com`; `external_id` = the design `id`; metadata title/created_at/updated_at/edit_url/view_url/thumbnail_url (timestamps are Unix epoch **seconds** → epoch-ms via local `parseCanvaTimestampMs`, tolerating ISO-8601 defensively); `modifiedAt` = updated_at ?? created_at ?? syncedAt; title = the design `title` (fallback `Canva design <id>`); `url`/`canonical_url` = the design `view_url` (else `edit_url`, else null); the `canva:design` type stays on local MiniLM embeddings (NOT in `PROSE_HEAVY_TYPES` — sparse structured design metadata); three read tools (`canva_list` / `canva_get` / `canva_search`); `hitlRequired: []`; **v1 designs only — folders and shared projects deferred**

##### Databases & Infrastructure

- [x] **Local DB Schema Indexing** (2026-06-02, Phase 5 Tier 5 — local/no-network) — `localdb:saved_query` items via `mapLocalDbQueryToItem` from saved `.sql` files that local DB tools (DBeaver, DataGrip, pgAdmin) keep on disk. A **pure, bounded, path-traversal-guarded filesystem read** — NO database connection, NO query execution, NO binary spawn (mirrors the Great Expectations / Obsidian filesystem-connector pattern). The sync handler (`localdb-sync.ts`, cursor `{ pass }` / `nimbus-localdb1:`) recursively walks the configured scripts dir for `.sql` files (`MAX_FILES=2000`, per-file size cap ~2 MiB, depth cap; empty/oversized/unreadable files skipped) and upserts one item per file: the SQL TEXT (capped 2000 chars) as the body preview — so the query is embedded for semantic recall of "that one query I wrote last month" — plus lightweight metadata (relative path, referenced table/view names via a comment-stripping heuristic extractor, statement count, size). `external_id` = the relative path; `modifiedAt` = file mtime. **Config** — a single non-secret PATH `localdb.scripts_dir`, so `CONNECTOR_VAULT_SECRET_KEYS.localdb` is `["localdb.scripts_dir"]`; the spawn `phase3AddLocaldbMcp` extends the connector manifest's `filesystem.read` with that dir at spawn (the GX/Obsidian pattern), injects `LOCALDB_SCRIPTS_DIR`, `wrapServerSpec` (I15); the MCP server (`scanSavedQueries`/`getSavedQuery` over the env dir with an `assertWithinScriptsDir` path guard) exposes `localdb_list` / `localdb_get` / `localdb_search`. Reuses the existing `"filesystem"` rate-limiter provider (no new provider). `localdb:saved_query` stays on local MiniLM (NOT in `PROSE_HEAVY_TYPES` — SQL is structured, not prose paragraphs). `hitlRequired: []`. **v1 saved-query files only — live schema introspection / query-history DB files (pgAdmin sqlite) deferred.**
- [x] **Vercel** (2026-05-25, Phase 5 Tier 1) — `vercel:deployment` items via `mapVercelDeploymentToItem` (`GET /v6/deployments?limit=100`, `pagination.next` epoch-ms `until` walk, `MAX_PAGES=20`); `external_id` = the deployment `uid`; metadata uid/name/state(readyState||state)/target/url/inspector_url/commit_sha/commit_message/commit_ref/pr_id/creator/created_at/canonical_url (canonical prefers `inspectorUrl`, else `https://<vercel.app host>`, else null); `Authorization: Bearer` auth; vault keys `vercel.token` (required) + `vercel.team_id` (optional — appended as `&teamId`); fixed SaaS host `api.vercel.com` (static sandbox network, no host override); `created` is epoch ms surfaced verbatim; three read tools (`vercel_list` / `vercel_get` / `vercel_search`); `hitlRequired: []`; **v1 deployments only — projects / domains / env vars / aliases / build logs deferred**
- [x] **Netlify** (2026-05-25, Phase 5 Tier 1) — `netlify:site` items via `mapNetlifySiteToItem` (`GET /api/v1/sites?per_page=100&page=N`, page-paginated bare-array walk, `MAX_PAGES=20`, stop on a short/empty page); `external_id` = the site `id`; metadata site_id/name/url/admin_url/ssl_url/repo_url/repo_branch/deploy_state/deploy_id/deploy_branch/commit_ref/commit_url/deploy_url/account_name/created_at/updated_at/canonical_url (canonical prefers `admin_url`, else `ssl_url`, else `url`, else null; the embedded `published_deploy` supplies deploy status, preview URL, and commit ref — no N+1 per-site deploy walk); ISO-8601 timestamps parsed to epoch-ms (NOT passed through verbatim); `Authorization: Bearer` PAT auth; vault key `netlify.token` (required); fixed SaaS host `api.netlify.com` (static sandbox network, no host override); three read tools (`netlify_list` / `netlify_get` / `netlify_search`); `hitlRequired: []`; **v1 sites + embedded published-deploy status only — per-deploy history / forms / functions / env vars / DNS deferred**

##### Feature Flags

- [x] **LaunchDarkly** (2026-05-24, Phase 5 Tier 1) — first-party MCP connector `nimbus-mcp-launchdarkly` + gateway-side syncable. Walks `GET /api/v2/projects → GET /api/v2/flags/{projectKey}` (offset-paged 100/page, 20 pages per project cap) and upserts feature flags as `launchdarkly:feature_flag` items via `mapLaunchDarklyFlagToItem`. Metadata exposed: `key`, `name`, `kind` (boolean/multivariate), `project_key`, `tags`, `temporary`, `archived`, `maintainer`, `maintainer_id`, `description`, `variation_count`, `environments`, `env_states` (per-env on/off), `created_at`, `updated_at`, `canonical_url` — critical for incident correlation ("was this flag enabled when the alert fired?"). API-token auth (raw `Authorization` header). Vault keys: `launchdarkly.token` (required API access token), `launchdarkly.base_url` (optional regional override → default `https://app.launchdarkly.com`; sandbox runtime-merge for regional/federal hosts inherits the same Task 14 follow-up as `sentry.url`), `launchdarkly.project_key` (optional single-project restriction). Three read-only MCP tools: `launchdarkly_list` / `launchdarkly_get` / `launchdarkly_search`. `hitlRequired: []` — `launchdarkly.flag.toggle` is a deferred Phase 8 follow-up.
- [x] **Flagsmith** (2026-05-24, Phase 5 Tier 1) — first-party MCP connector `nimbus-mcp-flagsmith` + gateway-side syncable. Walks `GET /api/v1/projects/ → GET /api/v1/projects/{id}/features/` (DRF-paged 100/page, 20 pages per project cap) plus one `GET /api/v1/projects/{id}/tags/` call per project to resolve feature tag ids to labels, and upserts feature-flag definitions as `flagsmith:feature_flag` items via `mapFlagsmithFeatureToItem`. Metadata exposed: `name`, `type`, `default_enabled`, `initial_value`, `description`, `tags` (resolved labels), `is_archived`, `owner_count`, `project_id`, `project_name`, `created_at` (parsed from the ISO-8601 `created_date`), `canonical_url` (project page) — useful for incident correlation ("did this flag exist when the alert fired?"). Admin-API-token auth (`Authorization: Token <token>`). Vault keys: `flagsmith.token` (required), `flagsmith.api_base` (optional regional / self-hosted host root → default `https://api.flagsmith.com`; requests go to `${api_base}/api/v1/...`; sandbox runtime-merge for non-SaaS hosts inherits the same Task 14 follow-up as `sentry.url`). Three read-only MCP tools: `flagsmith_list` / `flagsmith_get` / `flagsmith_search`. `hitlRequired: []`. **v1 indexes flag definitions only — per-environment on/off state + segments are deferred.** `flagsmith.flag.toggle` is a deferred Phase 8 follow-up.

##### GitOps & Deployment

- [x] **ArgoCD** (2026-05-25, Phase 5 Tier 1) — `argocd:application` items via `mapArgocdApplicationToItem`; metadata name/namespace/project/sync_status/health_status/repo_url/path/target_revision/dest_server/dest_namespace/revision/created_at/canonical_url; vault keys `argocd.url` + `argocd.token` (Bearer); single `GET /api/v1/applications` walk (no pagination); self-hosted host extended into the sandbox network list from `argocd.url` (Grafana pattern); three read tools (`argocd_list` / `argocd_get` / `argocd_search`); `hitlRequired: []`; applications-only — AppProjects + per-app sync history deferred; `argocd.app.sync` / `argocd.app.rollback` writes deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)
- [x] **Flux** (2026-05-25, Phase 5 Tier 1) — `flux:resource` items via `mapFluxResourceToItem` across 9 CRD kinds (kustomization, helm_release, git/oci/helm_repository, bucket, image_repository/policy/update_automation); vault keys `flux.api_url` + `flux.token` (SA Bearer); `status.conditions` Ready health (ready_status/reason/message), suspend, last_applied/attempted_revision; three read tools (`flux_list` / `flux_get` / `flux_search`); `hitlRequired: []`; self-hosted host extended into the sandbox network list from `flux.api_url` (Grafana pattern); TLS note (needs CA-trusted endpoint — self-signed K8s certs rejected by Bun fetch in v1); `flux reconcile` / `flux suspend` writes deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)

##### Data Warehouses, Orchestration & BI (Personal-Auth)

- [x] **Databricks** (2026-05-25, Phase 5 Tier 1) — `data_pipeline` items via `mapDatabricksJobToItem` (`/api/2.1/jobs/list` token-paged + `/api/2.1/jobs/runs/list` for latest-run enrichment); metadata job_id/name/creator_user_name/schedule_cron/format/created_at/latest_run_status/latest_run_started_at/latest_run_duration_ms/latest_run_cluster_id/latest_run_triggered_by/canonical_url; vault keys `databricks.host` + `databricks.token` (PAT); three read tools (`databricks_list` / `databricks_get` / `databricks_search`); `hitlRequired: []`; **v1 jobs only — clusters / SQL warehouses / notebooks deferred**; `job.trigger` / `job.cancel` / `cluster.restart` (HITL) deferred to Phase 6; per-workspace host extended into the sandbox from `databricks.host` (Grafana pattern) — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)
- [x] **Metabase** (2026-05-25, Phase 5 Tier 1) — `metabase:dashboard` items via `mapMetabaseDashboardToItem` (`GET /api/dashboard` + `/api/collection` for collection-name resolution); metadata dashboard_id/name/description/collection_id/collection_name/creator_id/archived/card_count/created_at/updated_at/canonical_url; vault keys `metabase.url` + `metabase.api_key`; API-key auth via the `x-api-key` header (NOT `Authorization`); three read tools (`metabase_list` / `metabase_get` / `metabase_search`); `hitlRequired: []`; **v1 dashboards only — saved questions/cards deferred**; self-hosted host extended into the sandbox from `metabase.url` (Grafana pattern)
- [x] **Superset** (2026-05-25, Phase 5 Tier 1) — `superset:dashboard` items via `mapSupersetDashboardToItem` (`POST /api/v1/security/login` → Bearer, `GET /api/v1/dashboard/` Rison-paged); metadata dashboard_id/title/slug/published/status/owner_count/changed_by/changed_at/canonical_url; vault keys `superset.url` + `superset.username` + `superset.password`; three read tools (`superset_list` / `superset_get` / `superset_search`); `hitlRequired: []`; **v1 dashboards only — charts/datasets/saved queries deferred**; self-hosted host extended into the sandbox from `superset.url` (Grafana pattern)
- [x] **Apache Airflow (OSS) / Prefect / Dagster** (API token) (2026-05-31, Phase 5 Tier 1) — all three orchestrators delivered: Airflow (`airflow:dag`), Prefect (`prefect:deployment`), and Dagster (`dagster:job`), each a read-only per-tenant-host connector with three read tools and `hitlRequired: []`. v1 indexes the orchestration unit definitions only (DAGs / deployments / jobs); individual runs, tasks/task-groups, run statuses, and logs are deferred, and the `orchestration.run.trigger` / `orchestration.run.cancel` HITL write tools are deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5). The `data_pipeline` umbrella item type from the original line item was realized as three service-specific types (one per orchestrator) rather than a single shared type.
  - [x] **Apache Airflow** (2026-05-31, Phase 5 Tier 1) — `airflow:dag` items via `mapAirflowDagToItem` (stable REST API v1 `GET /api/v1/dags?limit=100&offset=<n>`, body-based `total_entries` + offset walk, `MAX_PAGES=20`); metadata dag_id/is_paused/is_active/owners/description/schedule_interval/tags/fileloc/next_dagrun/last_parsed_time/canonical_url; vault keys `airflow.base_url` (non-secret) + `airflow.username` + `airflow.password` (secrets); HTTP Basic auth (gateway builds the header inline; MCP server reuses the shared `encodeBasicAuthHeader`); three read tools (`airflow_list` / `airflow_get` / `airflow_search`); `hitlRequired: []`; self-hosted host extended into the sandbox from `airflow.base_url` (Dependency-Track pattern); **v1 DAG definitions only — DAG runs / task instances / logs deferred**; `orchestration.run.trigger` / `orchestration.run.cancel` (HITL) deferred to Phase 6.
  - [x] **Prefect** (2026-05-31, Phase 5 Tier 1) — `prefect:deployment` items via `mapPrefectDeploymentToItem` (`POST <api_url>/deployments/filter` with body `{ limit: 100, offset, sort: "CREATED_DESC" }` — a POST-with-body filter returning a bare JSON array, offset walk, `MAX_PAGES=20`); metadata deployment_id/name/flow_id/description/tags/paused/work_pool_name/work_queue_name/schedule/status/created/updated/canonical_url; vault keys `prefect.api_url` (non-secret workspace API root — Cloud `.../accounts/<id>/workspaces/<id>`, Server `<host>:4200/api`) + `prefect.api_key` (secret); Bearer auth (gateway builds the header inline; MCP server omits it when keyless); `canonical_url`/`url` always null (no clean permalink — Ramp posture); three read tools (`prefect_list` / `prefect_get` / `prefect_search`); `hitlRequired: []`; per-tenant host extended into the sandbox from `prefect.api_url` (Dependency-Track pattern); **v1 deployments only — flow runs / task runs / logs deferred**; `orchestration.run.trigger` / `orchestration.run.cancel` (HITL) deferred to Phase 6.
  - [x] **Dagster** (2026-05-31, Phase 5 Tier 1) — `dagster:job` items via `mapDagsterJobToItem` (single **GraphQL** query `POST <base_url>/graphql` walking `repositoriesOrError → nodes[].pipelines[]`, flattening to jobs in one response — NOT cursor-paginated — with a defensive `MAX_JOBS=2000` cap; a top-level `errors` array → `parse_error` and a `PythonError` typename → empty list, both graceful degrade with cursor preserved, mirroring Wiz); metadata name/repository/location/description/is_job/tags/tag_keys/canonical_url; vault keys `dagster.base_url` (non-secret host root — Cloud `https://<org>.dagster.cloud/<deployment>`, OSS `http://<host>:3000`) + `dagster.api_token` (secret, sent as the `Dagster-Cloud-Api-Token` header; OSS users set any non-empty placeholder); **`external_id` = the stable `<location>:<repository>:<jobName>` triple — NOT the opaque base64 `id`**; `canonical_url`/`url` = `<base_url>/locations/<location>/jobs/<jobName>` (best-effort, null when location/base-url unavailable); three read tools (`dagster_list` / `dagster_get` / `dagster_search`); `hitlRequired: []`; per-tenant host extended into the sandbox from `dagster.base_url` (Dependency-Track pattern); **v1 jobs only — runs / assets / logs deferred**; `orchestration.run.trigger` / `orchestration.run.cancel` (HITL) deferred to Phase 6. **Last of the bundle — with Dagster delivered, the Airflow / Prefect / Dagster bundle row is now checked.**
- [x] **Kibana / Elasticsearch** (2026-06-01, Phase 5 Tier 3 — no-row-data) — `elasticsearch:index` items via `mapElasticsearchIndexToItem` from the **Elasticsearch REST metadata endpoints** over `connectorFetch` (`GET /_cat/indices?format=json&bytes=b` for the index listing — page-capped `MAX_INDICES=500`, ES system/hidden `.`-prefixed indices skipped; per index `GET /<index>/_mapping` flattened to `fields: [{ name, type }]` with dotted nested paths, capped `MAX_INDEX_DETAIL=200`); single forward pass, cursor `{ pass }` (`nimbus-es1:`); metadata index/health/status/docsCount/storeSizeBytes/primaryShards/replicas/uuid/fields; `external_id` = the index name; `modifiedAt` = `syncedAt` (`_cat/indices` has no mtime); `url`/`canonical_url` null. **Own per-tenant creds (NOT cloud-cred-reuse, NOT CLI-shelling — the Dependency-Track REST shape)** — two own vault keys `elasticsearch.url` (non-secret cluster root) + `elasticsearch.api_key` (secret, `Authorization: ApiKey`), both required, so `CONNECTOR_VAULT_SECRET_KEYS.elasticsearch` is `["elasticsearch.url", "elasticsearch.api_key"]`; lazy-mesh spawn `phase3AddElasticsearchMcp` rides the phase3 bundle, the parsed host added to the sandbox at spawn via `hostnameFromUrl` + `manifestWithExtraNetworkHosts` (empty static `permissions.network`), routed through `wrapServerSpec` (I15). **STRICTLY NO ROW DATA** — forbidden endpoints (`_search`, `_doc`, `_mget`, `_sql`, `_async_search`, `_pit`, `_scroll`, anything returning `hits.hits._source`) NEVER called; index path segments `encodeURIComponent`-guarded; the **no-row-data contract test** calls `assertNoRowDataTools(ELASTICSEARCH_TOOL_NAMES, "elasticsearch")` (a future `elasticsearch_scan` / `elasticsearch_get_records` / `elasticsearch_query` tool fails CI; `elasticsearch_search` over index NAMES is allowed). Three read tools (`elasticsearch_list` / `elasticsearch_get` / `elasticsearch_search` — metadata only, search is over index names NOT documents); `hitlRequired: []`; **v1 index metadata only — saved searches / dashboards / Watcher alerts / document contents deferred (document contents out of scope for the no-row-data tier).**
- [x] **AWS CloudWatch Logs** (2026-05-31, Phase 5 Tier 3 — no-row-data) — `cloudwatch:log_group` items via `mapCloudwatchLogGroupToItem` from the **AWS CLI's CloudWatch Logs metadata commands** (walk `aws logs describe-log-groups --limit 50` with `--next-token` pagination, page-capped `MAX_LOG_GROUPS=500`; per group a best-effort `aws logs describe-log-streams --order-by LastEventTime --descending --limit 50` peek for a stream COUNT + last-event timestamp — stream METADATA only); single forward pass, cursor `{ pass }`; metadata logGroupName/arn/retentionInDays/storedBytes/metricFilterCount/streamCount/lastEventTimestamp/creationTime; `external_id` = `arn ?? logGroupName`; `url`/`canonical_url` null. **Cloud-cred REUSE** — no new vault key: reuses the existing `aws.*` creds via the shared `_lib/aws-cli.ts` helper (injectable `runAwsCli`), so `CONNECTOR_VAULT_SECRET_KEYS.cloudwatch` is `[]`; lazy-mesh spawn `phase3AddCloudwatchMcp` rides the phase3 bundle gated on AWS creds, routed through `wrapServerSpec` (I15); static manifest mirrors the aws exec/filesystem shape + `sts.amazonaws.com` base, with the regional `logs.<region>.amazonaws.com` host added per-region at spawn. **STRICTLY NO ROW DATA** — forbidden commands (`get-log-events`, `filter-log-events`, `start-query`, `get-query-results`, `tail`, `start-live-tail`) NEVER called; the **no-row-data contract test** calls `assertNoRowDataTools(CLOUDWATCH_TOOL_NAMES, "cloudwatch")` (`ROW_DATA_TOOL_SEGMENTS` now also rejects `event`/`events`, so a future `cloudwatch_get_log_events` tool fails CI). Three read tools (`cloudwatch_list` / `cloudwatch_get` / `cloudwatch_search` — metadata only); `hitlRequired: []`; **v1 log-group metadata only — log-event contents / metric data points / alarms / dashboards deferred.**
- [x] **GCP Cloud Logging** — the sibling of AWS CloudWatch Logs above (reuses `gcp.*` creds like BigQuery): routing-sink config metadata (`cloud_logging:sink`); `gcloud logging sinks list/describe`; **NEVER** `gcloud logging read` / `entries list` (log entries = row data); no-row-data contract test
- [x] **BigQuery** (2026-05-31, Phase 5 Tier 3 — the no-row-data infra-prover) — `bigquery:table` items via `mapBigqueryTableToItem` from the **BigQuery REST metadata API** (walk `GET /bigquery/v2/projects/<project>/datasets?maxResults=100&pageToken=<token>` → per-dataset `GET .../datasets/<id>/tables` → enrich the first `MAX_TABLE_DETAIL=50` tables/dataset with `GET .../tables/<id>` for `schema.fields`; page-capped `MAX_DATASETS=100` / `MAX_TABLES_PER_DATASET=500`, single forward pass, cursor `{ pass }`); metadata project/datasetId/tableId/tableType (TABLE/VIEW/EXTERNAL/MATERIALIZED_VIEW)/schemaFields (name+type only)/numRows/numBytes/creationTime/lastModifiedTime; `external_id` = `<project>:<datasetId>.<tableId>`; `url`/`canonical_url` null. **Cloud-cred REUSE** — no new vault key: reuses the existing `gcp.credentials_json_path` + `gcp.project_id` and mints a token by shelling `gcloud auth print-access-token` (GOOGLE_APPLICATION_CREDENTIALS → ADC), so `CONNECTOR_VAULT_SECRET_KEYS.bigquery` is `[]`; lazy-mesh spawn `phase3AddBigqueryMcp` rides the phase3 bundle gated on `gcp.credentials_json_path` (BigQuery appears whenever GCP does), routed through `wrapServerSpec` (I15); static manifest mirrors the gcp exec/filesystem shape + network hosts `bigquery.googleapis.com` / `oauth2.googleapis.com` / `www.googleapis.com`. **STRICTLY NO ROW DATA** — forbidden endpoints (`/queries`, `jobs.query`/`getQueryResults`, `tabledata.list`) NEVER called; the **no-row-data contract test** calls `assertNoRowDataTools(BIGQUERY_TOOL_NAMES, "bigquery")` (added in a5a18267) so any future row-fetch tool fails CI — this is the executable backstop for the tier's "no row-fetch tools on the MCP surface" acceptance criterion. Three read tools (`bigquery_list` / `bigquery_get` / `bigquery_search` — metadata only); `hitlRequired: []`; token-mint is dependency-injected for tests; **v1 table metadata only — row data / query results / routines / models deferred (out of scope for the no-row-data tier).** First Tier-3 connector — sets the template the next six (Snowflake / Athena / CloudWatch Logs / etc.) reuse.
- [x] **AWS Athena** (2026-05-31, Phase 5 Tier 3 — the AWS-side no-row-data infra-prover) — `athena:table` items via `mapAthenaTableToItem` from the **AWS CLI's Athena metadata commands** (walk `aws athena list-data-catalogs` → per-catalog `aws athena list-databases --catalog-name <c>` → per-database `aws athena list-table-metadata --catalog-name <c> --database-name <db>`; page-capped `MAX_CATALOGS=50` / `MAX_DATABASES_PER_CATALOG=200` / `MAX_TABLES_PER_DATABASE=500`, single forward pass, `NextToken` pagination, cursor `{ pass }`); metadata catalog/database/tableName/tableType/columns (name+type only)/partitionKeys/parameters/createTime/lastAccessTime; `external_id` = `<catalog>/<database>.<tableName>`; `url`/`canonical_url` null; timestamps parsed defensively (ISO or epoch-seconds). **Cloud-cred REUSE** — no new vault key: reuses the existing `aws.access_key_id` + `aws.secret_access_key` + `aws.default_region`/`aws.profile` via the shared `_lib/aws-cli.ts` helper (`awsCredentialsExtra` + `awsCliJson`, extracted from `aws-sync.ts`), so `CONNECTOR_VAULT_SECRET_KEYS.athena` is `[]`; lazy-mesh spawn `phase3AddAthenaMcp` rides the phase3 bundle gated on AWS creds (Athena appears whenever AWS does), routed through `wrapServerSpec` (I15); static manifest mirrors the aws exec/filesystem shape + `sts.amazonaws.com` base, with the regional `athena.<region>.amazonaws.com` host added per-region at spawn via `manifestWithExtraNetworkHosts` (the RFC-1123 validator rejects the wildcard, like Salesforce's per-tenant host). **STRICTLY NO ROW DATA** — forbidden commands (`start-query-execution`, `get-query-results`, `get-query-execution`, `list-query-executions`, `get-named-query`) NEVER called; the **no-row-data contract test** calls `assertNoRowDataTools(ATHENA_TOOL_NAMES, "athena")` so any future row-fetch tool fails CI. Three read tools (`athena_list` / `athena_get` / `athena_search` — metadata only); `hitlRequired: []`; the AWS-CLI runner is dependency-injected for tests; **v1 catalog/database/table metadata only — query execution / results / saved-query bodies deferred (out of scope for the no-row-data tier).** Proves the AWS-side cred-reuse template (the GCP-side was BigQuery); SageMaker + CloudWatch reuse the shared `_lib/aws-cli.ts` helper next.
- [x] **dbt Cloud** (2026-05-25, Phase 5 Tier 1) — `dbt:job` items via `mapDbtJobToItem` from the Administrative API v2 (`/accounts/ → /accounts/{id}/jobs/`, offset-paged); metadata job_id/name/account_id/project_id/environment_id/dbt_version/state/schedule_cron/triggers/created_at/updated_at/most_recent_run_status/canonical_url; `Authorization: Token` auth; vault keys `dbt.token` + `dbt.api_base` + `dbt.account_id`; three read tools; `hitlRequired: []`; **v1 indexes jobs + run status only — model lineage (`data_model` upstream/downstream via the Discovery GraphQL API) deferred**; `dbt.job.trigger` HITL deferred to Phase 6
- [x] **MLflow** (2026-05-25, Phase 5 Tier 1) — `ml_model` items via `mapMlflowModelToItem` (`GET /api/2.0/mlflow/registered-models/search`, token-paged on `next_page_token`, `MAX_PAGES=20`); metadata name/description/version_count/latest_version/latest_stage/latest_status/latest_run_id/created_at/updated_at/tags/canonical_url (latest version prefers the `Production`-stage entry, else the highest numeric version); `Authorization: Bearer` auth; vault keys `mlflow.host` + `mlflow.token` (no SaaS default); three read tools (`mlflow_list` / `mlflow_get` / `mlflow_search`); `hitlRequired: []`; **v1 registered models only — experiments / runs / metrics / params / artifacts deferred**; timestamps are epoch ms surfaced as-is; the `#/models/<name>` canonical URL is the UI fragment route (name URL-encoded); tracking-server host extended into the sandbox from `mlflow.host` (Grafana pattern); `ml.model.promote` / `ml.model.transition-stage` (HITL) writes deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)
- [x] **SageMaker** (2026-06-01, Phase 5 Tier 3 — no-row-data; reuses existing AWS vault credentials from Phase 3 AWS connector) — `sagemaker:model` items via `mapSagemakerModelToItem` from the **AWS CLI's SageMaker metadata commands** (walk `aws sagemaker list-models` with `--next-token` pagination, page-capped `MAX_MODELS=500`, then a page-capped `MAX_DESCRIBE=50` per-model `aws sagemaker describe-model --model-name <name>` enrichment for `PrimaryContainer.Image` + `PrimaryContainer.ModelDataUrl` S3 pointer + `ExecutionRoleArn`; single forward pass, cursor `{ pass }` / `nimbus-sm1:`); metadata modelName/modelArn/containerImage/modelDataUrl (a pointer URI, not bytes)/executionRoleArn/creationTime; `external_id` = `ModelArn ?? ModelName`; title = `ModelName`; `url`/`canonical_url` null; `CreationTime` parsed defensively (ISO or epoch-seconds). **Cloud-cred REUSE** — no new vault key: reuses the existing `aws.*` creds via the shared `_lib/aws-cli.ts` helper (`awsCredentialsExtra` + `awsCliJson`), so `CONNECTOR_VAULT_SECRET_KEYS.sagemaker` is `[]`; lazy-mesh spawn `phase3AddSagemakerMcp` rides the phase3 bundle gated on AWS creds (SageMaker appears whenever AWS does), routed through `wrapServerSpec` (I15); static manifest mirrors the aws exec/filesystem shape + `sts.amazonaws.com` base, with the regional `api.sagemaker.<region>.amazonaws.com` host added per-region at spawn via `manifestWithExtraNetworkHosts`. **STRICTLY NO ROW DATA** — `aws sagemaker-runtime invoke-endpoint` (inference) and any training-data / model-artifact-bytes fetch NEVER called; the **no-row-data contract test** calls `assertNoRowDataTools(SAGEMAKER_TOOL_NAMES, "sagemaker")` so any future invoke/predict/records/query tool fails CI. **Security** — every tool-input CLI arg (model name) is `isSafeCliArg`/`cliArg`-guarded against argv flag-smuggling at both the MCP schema boundary and the sync handler's `describe-model` spawn (a `-`-prefixed `list-models` name is mapped but never passed to `describe-model`). Three read tools (`sagemaker_list` / `sagemaker_get` / `sagemaker_search` — metadata only); `hitlRequired: []`; the AWS-CLI runner is dependency-injected for tests; **v1 model-registry metadata only — training jobs, processing jobs, endpoints, experiments deferred.** Write tools (`ml.endpoint.update`, `ml.endpoint.delete`, `ml.job.stop`) deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)
- [x] **Vertex AI** (2026-06-01, Phase 5 Tier 3 — no-row-data; reuses existing GCP credentials from Phase 3 GCP connector) — `vertex_ai:model` items via `mapVertexAiModelToItem` from the **gcloud CLI's Vertex AI metadata command** (`gcloud ai models list --region <region> --project <project> --format json` returns a JSON ARRAY of `[{ name, displayName, versionId, createTime, updateTime }]`; single forward pass, page-capped `MAX_MODELS=500`, cursor `{ pass }` / `nimbus-vertex1:`); metadata model resource name/displayName/versionId/region/createTime/updateTime; `external_id` = the model resource `name` (`projects/.../models/<id>`; fallback `<region>/<displayName>`); title = `displayName` (fallback the id segment of `name`); `url`/`canonical_url` null; RFC3339 timestamps via a LOCAL `parseIsoMs`. **Cloud-cred REUSE** — no new required vault key: reuses the existing `gcp.credentials_json_path` + `gcp.project_id` (so `CONNECTOR_VAULT_SECRET_KEYS.vertex_ai` is `[]`), shelling the native `gcloud ai` CLI directly (like Cloud Logging, no token-mint). **Regional** — reads an OPTIONAL non-secret `gcp.region` config key (added to the gcp connector's optional config; default `us-central1`), validated by an inline argv-flag-smuggle guard before use. **Security** — every tool-input CLI arg (region + model id) is `isSafeCliArg`/`cliArg`-guarded at the MCP schema boundary, and the resolved region is re-guarded before both the MCP spawn and the gateway sync spawn. Lazy-mesh spawn `phase3AddVertexAiMcp` rides the phase3 bundle gated on GCP creds (Vertex AI appears whenever GCP does, like BigQuery + Cloud Logging), injecting `GOOGLE_APPLICATION_CREDENTIALS` + `GOOGLE_CLOUD_PROJECT` + `VERTEX_AI_REGION`, routed through `wrapServerSpec` (I15); static manifest declares `aiplatform.googleapis.com` + `oauth2.googleapis.com` + `www.googleapis.com`, with the regional `<region>-aiplatform.googleapis.com` host added per-region at spawn via `manifestWithExtraNetworkHosts`. **STRICTLY NO ROW DATA** — `gcloud ai endpoints predict` / `explain` / `raw-predict` and any batch-prediction output read NEVER called; the **no-row-data contract test** calls `assertNoRowDataTools(VERTEX_AI_TOOL_NAMES, "vertex_ai")` so any future predict/records/query tool fails CI. Three read tools (`vertex_ai_list` / `vertex_ai_get` / `vertex_ai_search` — metadata only); `hitlRequired: []`; the gcloud runner is dependency-injected for tests; **v1 indexes the model registry only — experiments, custom training jobs, pipeline runs, and endpoints deferred.** Write tools (`ml.endpoint.update`, `ml.pipeline.cancel`) deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)
- [x] **Great Expectations** — validation run results parsed from CI artefacts (no live creds required); `data_quality_test` item type indexed with suite name, batch id, expectation name, success/failure, observed value; read-only
- [x] **Local data profiling** (Filesystem v2+) (2026-06-03, Phase 5 Tier 5 — local/no-network, no-row-data) — `dataprofile:data_model` items via `mapDataModelToItem` from local `.parquet` / `.csv` / `.jsonl`(`.ndjson`) / `.json` files in a configured dir: column names, column types, column count, row-count estimate, file size. **Explicitly never indexed:** cell values, row samples, first-N-row previews, header-row data values — a `data-profile-sync` test feeds files with PII cell values and asserts none reach the index. **Parquet** schema + row count come from the file FOOTER metadata via `hyparquet` (pure-JS, no row data crosses the wire); **CSV** column names from the header line (+ row estimate = line count − 1); **JSONL/JSON** field names + JS kinds from the top-level structure (keys/types only, never values). The sync handler (`data-profile-sync.ts`, cursor `{ pass }` / `nimbus-dataprofile1:`) walks the dir (`MAX_FILES=2000`, depth cap) with an injectable Parquet footer reader; `external_id` = relative path; reuses the `"filesystem"` rate-limiter. **Config** — a single non-secret PATH `dataprofile.dir`, so `CONNECTOR_VAULT_SECRET_KEYS.dataprofile` is `["dataprofile.dir"]`; spawn `phase3AddDataprofileMcp` extends `filesystem.read` with the dir at spawn (the GX/localdb pattern), injects `DATAPROFILE_DIR`, `wrapServerSpec` (I15); MCP tools `dataprofile_list` / `dataprofile_get` / `dataprofile_search`. **The no-row-data contract test** (`mcp-connectors/dataprofile/test/no-row-data.test.ts`) calls `assertNoRowDataTools(DATAPROFILE_TOOL_NAMES, "dataprofile")` so a future `dataprofile_sample` / `dataprofile_get_rows` tool fails CI. `dataprofile:data_model` stays on local MiniLM (structured, NOT `PROSE_HEAVY_TYPES`). `hitlRequired: []`. **Deviations from the original spec:** a dedicated `dataprofile` service (not `provider="filesystem"`, which already emits code/repo items) + a `dataprofile.dir` config key (not `[[filesystem.roots]]`), for consistency with the localdb/storybook per-connector pattern. **ORC deferred** — no maintained pure-JS ORC schema reader exists (`orc-tools`/`apache-orc`/`node-orc` all absent from npm); revisit when one ships.

##### Security & Vulnerability Tooling

- [x] **Snyk** (2026-05-21, Phase 5 Wave A) — first-party MCP connector `nimbus-mcp-snyk` + gateway-side syncable; open source vulnerabilities, licence issues, container scan results, IaC misconfigs; API token; `vulnerability` item type indexed with severity, CVE ID, affected package, fix availability; enables CVE-to-repo-to-open-PR correlation queries from the local index
- [x] **SonarQube / SonarCloud** (2026-05-22, Phase 5 Tier 2) — first-party MCP connector `nimbus-mcp-sonarqube` + gateway-side syncable. Walks `GET /api/components/search?qualifiers=TRK` → `GET /api/issues/search` (paged 100/page, capped 20 pages per project) and upserts open issues (status `OPEN`/`CONFIRMED`/`REOPENED`; types `BUG`/`VULNERABILITY`/`CODE_SMELL`) as `sonarqube:code_issue` items via `mapSonarIssueToItem`. Metadata exposed: `severity` (5-tier `BLOCKER`→`INFO`), `type`, `status`, `rule`, `component`, `project_key`, `file_path`, `line`, `tags`, `effort`, `debt`, `author`, `message`, `creation_date`, `update_date`, `canonical_url`, `organization`. Vault keys: `sonarqube.token` (required), `sonarqube.organization` (required for SonarCloud SaaS), `sonarqube.url` (optional override → default `https://sonarcloud.io`; sandbox runtime-merge for arbitrary self-hosted hostnames inherits the same Task 14 follow-up as `sentry.url`). Three read-only MCP tools: `sonarqube_list` / `sonarqube_get` / `sonarqube_search`. `hitlRequired: []` — `sonarqube.hotspot.review` + `sonarqube.issue.transition` are deferred Phase 8 follow-ups.
- [x] **Semgrep** (2026-05-22, Phase 5 Tier 2) — first-party MCP connector `nimbus-mcp-semgrep` + gateway-side syncable. Walks `GET /api/v1/deployments → /api/v1/deployments/<slug>/findings` (paged 100/page, capped 20 pages per cycle) and upserts open findings as `semgrep:finding` items via `mapSemgrepFindingToItem`. Metadata exposed: `severity` (5-tier critical→info), `confidence` (high/medium/low), `rule_name`, `rule_message`, `categories`, `file_path`, `line`, `end_line`, `column`, `repository`, `repository_url`, `branch`, `triage_state` (untriaged/triaged/ignored/muted), `status` (open/fixed/removed/ignored), `created_at`, `relevant_since`, `line_of_code_url`. Vault keys: `semgrep.token` (required PAT), `semgrep.deployment_slug` (optional — auto-discovered from `/deployments` when unset). Three read-only MCP tools: `semgrep_list` / `semgrep_get` / `semgrep_search`. `hitlRequired: []` — `semgrep.finding.triage` (ignore/suppress/accept-risk) is a deferred Phase 8 follow-up.
- [x] **Wiz** (2026-05-24, Phase 5 Tier 2) — first-party MCP connector `nimbus-mcp-wiz` + gateway-side syncable. Authenticates via OAuth `client_credentials` at `https://auth.app.wiz.io/oauth/token`, then walks the `issues(first, after, filterBy)` GraphQL query at `https://api.app.wiz.io/graphql` (paged 100/page, capped 20 pages per cycle) and upserts open issues (CSPM findings, misconfigurations, toxic combinations) as `wiz:issue` items via `mapWizIssueToItem`. Metadata exposed: `severity` (5-tier `CRITICAL`→`INFORMATIONAL`), `status` (`OPEN`/`IN_PROGRESS`/`RESOLVED`/`REJECTED`), `type`, `source_rule_id`, `source_rule_name`, `entity_id`, `entity_name`, `entity_type`, `project_ids`, `project_names`, `description`, `remediation`, `created_at`, `updated_at`, `resolved_at`, `canonical_url`. Vault keys: `wiz.client_id` + `wiz.client_secret` (required), `wiz.api_url` + `wiz.auth_url` (optional regional overrides → default to the US-east SaaS tenant; sandbox runtime-merge for arbitrary regional/self-hosted hostnames inherits the same Task 14 follow-up as `sentry.url`). Three read-only MCP tools: `wiz_list` / `wiz_get` / `wiz_search`. `hitlRequired: []` — `wiz.issue.resolve` + `wiz.issue.assign` are deferred Phase 8 follow-ups.
- [x] **SBOM / supply chain tracking — Dependency-Track** (2026-05-31, Phase 5 Tier 1) — implemented as a first-party MCP connector `nimbus-mcp-dependencytrack` + gateway-side syncable for [OWASP Dependency-Track](https://dependencytrack.org/), the canonical open-source SBOM/supply-chain platform. Walks `GET /api/v1/project?pageSize=100&pageNumber=<n>&excludeInactive=false` (reading a **bare JSON array** of project objects, 1-based `pageNumber` forward walk while a full 100-row page comes back, stopping on a short/empty page, `MAX_PAGES=20`) and upserts each project as a `dependencytrack:project` item via `mapDependencyTrackProjectToItem`; get-by-id is `GET /api/v1/project/{uuid}`. `external_id` = the project `uuid` (a stable Dependency-Track-supplied string, NOT a generated UUID — row skipped when missing/empty). **Per-tenant-host auth (the Metabase/ArgoCD shape):** `X-Api-Key: <key>` header (secret) + a non-secret `dependencytrack.base_url` host root; the sync handler and the lazy-mesh spawn (`phase3AddDependencytrackMcp`) both no-op unless BOTH are present, and the parsed host is merged into the sandbox network allow-list at spawn time (`hostnameFromUrl` + `manifestWithExtraNetworkHosts`) so the static manifest `permissions.network` is empty. Two required vault keys `dependencytrack.base_url` (non-secret) + `dependencytrack.api_key` (secret). Metadata exposed: `uuid`, `name`, `version`, `classifier`, `active`, `last_bom_import` (kept verbatim as epoch-ms), `tags` (from each `{name}` entry), and the embedded `metrics` counts `critical` / `high` / `medium` / `low` / `vulnerabilities` / `components`, plus `canonical_url` (`<base_url>/projects/<uuid>` via `ctx.baseUrl`); `modifiedAt` = `last_bom_import ?? syncedAt`; title = `<name> <version>` (200-char `…` truncation) with a name-only fallback; the `dependencytrack:project` type stays on local MiniLM embeddings (NOT added to `PROSE_HEAVY_TYPES` — sparse structured metadata). Three read-only MCP tools: `dependencytrack_list` / `dependencytrack_get` / `dependencytrack_search`. `hitlRequired: []`. **NOTE — pagination deviation:** Dependency-Track returns an `X-Total-Count` header for exact pagination, but the shared `connectorFetch` helper surfaces only the parsed body + byte count (no response headers); the connector uses the proven page-number forward walk with short-page / `MAX_PAGES` termination and a `{ pass }` cursor rather than introducing a header-exposing fetch helper. v1 indexes projects only — individual findings / components deferred. (The CycloneDX/SPDX-from-CI-artefact ingestion path remains a possible future complement.)
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

- [x] **Multi-model embedding** (delivered via T6 PR 3, 2026-05-15 — see below) — add `vec_items_1536` virtual table for OpenAI `text-embedding-3-small` (and compatible) embeddings alongside the existing `vec_items_384` (`all-MiniLM-L6-v2`); `embedding_chunk.dims` and `embedding_chunk.model` are already recorded — schema is pre-positioned (Phase 3); per-item-type model routing: code symbols use local MiniLM by default; prose items use the configured model; `nimbus index reembed --model <id>` triggers selective backfill; multiple models can be active simultaneously with queries fan-out across matching vec tables and RRF-merged
- [x] **T2 PR 1 — Sandbox PAL + 3-OS isolation** (2026-05-17, Phase 5 T2 PR 1) — enforce full syscall/network isolation for extension child processes: seccomp BPF filter + bwrap + nimbus-sandbox-helper (`cap_net_admin+ep`) + per-host iptables on Linux, sandbox-exec SBPL profile on macOS, AppContainer + `internetClient` capability + orphan-reap on Windows; network access and filesystem read/write paths must be declared in `nimbus.extension.json` under `permissions.{network,filesystem}` and enforced at the kernel level; replaces the Phase 3 honour-system env restriction; extensions without `permissions.network` run fully offline; new security invariant **I15** wires `wrapServerSpec(...)` → `sandbox-wrapper.ts` → `runner.spawn(...)` as the single sandbox-execution boundary, enforced statically by `D10` in `check-nimbus-invariants.ts` and at runtime by `security-invariants.test.ts`; `runSandboxContractTests()` ships in `@nimbus-dev/sdk` for first- and third-party connector authors; pre-T2 extensions hard-disabled until reinstall. **Merged 2026-05-17.**
- [x] **T2 PR 2 — Verified publisher (Ed25519-signed manifests)** (2026-05-18, PR #343, Phase 5 T2 PR 2) — extension manifests carry an optional `publisher: { id, key }` field + an embedded `signature` field; Ed25519 verification fires at install AND every Gateway startup before the extension is allowed to spawn; new structural security invariant **I16** wires `verifyManifestSignature(...)` at `extensions/install-from-local.ts` + `extensions/verify-extensions.ts` (signature pass added to `verifyExtensionsBestEffort`); hard-disable on failure via the new `SignatureDisabledRegistry` singleton (parallel to PR 1's `PreT2DisabledRegistry`); new CLI: `nimbus extension keygen`, `nimbus extension sign`, `nimbus extension sync`, `nimbus extension install --publisher-key`; tabular `nimbus extension list` with a Publisher column and dim-yellow `(unverified)` rendering on TTY when `NO_COLOR` is unset; publisher pubkeys cached at `extension.publisher_key.<id>` (D11 vault-key allow-list extended); IPC `extension.sync` is CLI-only — added to `FORBIDDEN_OVER_LAN` per `I5`, NOT in Tauri allowlist per `I7`; crypto primitives (`canonical-json`, `verify-signature`) moved into `@nimbus-dev/sdk` (MIT) so connector authors can sign manifests without an AGPL dep; gateway re-exports through thin shims at the old paths.
- [x] **T2 PR 3 — Auto-update with per-bump HITL** (2026-05-20, PR #367, Phase 5 T2 PR 3) — in-process polling daemon (`ExtensionAutoUpdater`, default 24h via `[extensions].update_check_interval_hours` 1..168, 30–300s startup jitter, air-gap-aware) that calls the registry to detect newer versions of installed signed extensions and writes them into an in-memory `AutoUpdateCache` keyed by extension id (no DB persistence — recovered on next poll); two new HITL action types `extension.autoUpdate` (forward) and `extension.downgrade` (backward) added to `HITL_REQUIRED_BACKING`; two new IPC methods `extension.checkForUpdates` + `extension.update` are CLI/UI-only — added to `FORBIDDEN_OVER_LAN` per `I5` and alphabetically inserted into Tauri `ALLOWED_METHODS` (60 → 62) per `I7`; three new CLI verbs `nimbus extension update [<id>] [--check] [--to <version>] [--json]`, `nimbus extension downgrade <id> --to <version>`, and `extension.info` extended with `prevVersion` + `cachedUpdate`; two-version on-disk directory layout `<extRoot>/<id>/{active,_prev/<v>}` enables `nimbus extension downgrade` as a thin `fs.rename` swap; atomic upgrade swap with revert-on-failure (older `_prev/*` move aside to a holding dir, restore on swap failure); startup crash recovery in `verify-extensions.ts` promotes the most-recent `_prev/<v>/` when `active/` is missing and audits `extension.autoUpdate.crash_recovered`; tarball download enforces a 50 MiB content-length + body cap with `AbortSignal` plumbing; manifest schema gains optional `updateChannel: "stable" | "beta"` (default `"stable"`) and `changelog?: string` (≤ 4 KiB after NFC) — both absent on disk by default so pre-PR-3 signed manifests verify unchanged. No new structural invariant — composes on top of I2/I3/I4/I5/I7/I14/I16.
- [x] **T2 PR 4 — Dependency resolution + V31 `extension_dependency`** (2026-05-21, PR #374, Phase 5 T2 PR 4) — manifest `dependsOn: Record<string, string>` (semver ranges) + custom backtracking solver in `extensions/dependency-graph.ts` (recursive DFS with per-frame `pinned` / `ranges` and an explicit `ancestors: Set` so diamond DAGs never false-positive as cycles), V31 `extension_dependency` table + `idx_extension_dependency_reverse` index, install path runs `resolveClosure` after signature verify and refuses with `DependencyConflictError` / `OfflineDependencyResolutionError` before any disk mutation, install closure unpacked leaf-first with per-session `createdDirs` cleanup on failure, `recordInstall` writes forward edges in one transaction, `extension.install_complete` audit row carries the full version map; remove path consults `reverseDeps` and refuses unless `--force`; auto-update daemon runs the solver per detected bump with `activeConstraints` covering every installed extension and surfaces a new `conflicts?: DependencyConflict[]` field on `AvailableUpdate`; startup integrity adds two new offline-safe passes — backfill `extension_dependency` rows from on-disk manifests, then completeness guard (iterates to fixed point, marks dependent extensions whose deps are missing or unsatisfied via new `MissingDependencyRegistry` singleton parallel to PR 1's `PreT2DisabledRegistry` and PR 2's `SignatureDisabledRegistry`; cascade-disables transitively); new CLI: `nimbus extension info --deps`, `nimbus extension list --tree` (NO_COLOR-aware, cycle-safe ASCII renderer), `nimbus extension remove --force` (HITL preview surfaces danglingDeps via existing `extension.uninstall` confirmation flow); `extension.info` IPC returns `forwardDeps` + `reverseDeps`; local-first `RegistryFetcher` ensures installed ids resolve from on-disk manifest without a network call. No new structural invariant — composes on `I9` (bound parameters for `extension_dependency` writes), `I14` (`dbRun` / `dbExec` for every write), `I16` (solver runs after signature verify on every closure node). `fast-check` property tests gate cycle / satisfiability correctness over random DAGs ≤ 12 nodes.

#### T6 — B1 hardening + semantic layer prep

Phase 5 Core item 5. Four sequential PRs in the order below. Each PR followed the T4-wrap-up cadence (brainstorm → spec → plan → execute → PR). Bridge work between T4 and T2 (sandbox + Marketplace v2).

- [x] **T6 PR 1 — I10 timing-safe helper consolidation** (2026-05-14, PR #292) — migrated `ipc/lan-pairing.ts`'s local `timingSafeEqual` and `ipc/http-auth.ts`'s local `constantTimeStringEqual` into the canonical helper at `packages/gateway/src/util/timing-safe-compare.ts`; finishes the I10 consolidation that `extensions/verify-extensions.ts` and `updater/updater.ts` already follow. Updated `SECURITY-INVARIANTS.md` I10 row and `security-invariants.test.ts`. No migration.
- [x] **T6 PR 2 — `tool_call_log` audit table (V29)** (2026-05-15) — closes "Structured tool-call result auditing (S8-F10)" below; complements the `<tool_output>` envelope (I11) by recording the envelope's contents at audit time via `writeToolCallLog` (best-effort — internal try/catch never breaks the LLM-facing path; envelopes >64 KiB are truncated with a `...[truncated, N bytes total]` marker). New `audit.toolCalls` IPC method (read-only) is IPC-only — NOT LAN-callable per `I5`, NOT in Tauri `ALLOWED_METHODS` per `I7`, NOT exposed via the read-only HTTP API. Composite (`calledAt`, `id`) cursor pagination handles same-millisecond rows deterministically; `sessionId=''` is the explicit NULL-session sentinel. Wired at both `wrapToolOutput` sites in `engine/agent.ts` (`wrapToolForLlm`) and `connectors/lazy-mesh/mesh.ts` (`listTools`); I11 enforcement test extended to assert both `wrapToolOutput` AND `writeToolCallLog` are present at each site. No new invariant — strengthens I11.
- [x] **T6 PR 3 — `vec_items_1536` + per-type routing + reembed CLI (V30)** (2026-05-15) — closes "Multi-model embedding" above; per-`(service, type)` model routing with `text-embedding-3-small` for the 14 prose-heavy pairs in `embedding/routing.ts:PROSE_HEAVY_TYPES` (gated on `openai.api_key` in vault, default = MiniLM-only fallback when missing) and a `nimbus index reembed --model <id> [--item-type <key>] [--service <name>] [--limit N] [--batch-size N] [--dry-run] [--yes] [--json]` CLI for selective backfill. New `vec_items_1536` virtual table (V30) coexists with `vec_items_384`; query-side `vectorSearchChunksDual` merges KNN results across both. `index.reembed` / `index.reembedCancel` are CLI-only — added to `FORBIDDEN_OVER_LAN` per `I5`, NOT in Tauri allowlist per `I7`. `provider = "openai"` promoted to 1536-dim everywhere; new `provider = "hybrid"` selects the routing pipeline.
- [x] **T6 PR 4 — Typed `dbRun` / `dbExec` migration (2026-05-16, 163 sites)** — closes "Typed `dbRun` / `dbExec` migration (S5-F4)" below; migrated 163 direct `db.run()` / `db.exec()` / `stmt.run()` call sites across every package to the centralised `dbRun` / `dbExec` / `dbStmtRun` wrappers in `db/write.ts`; new `D12` static-audit rule in `check-nimbus-invariants.ts` banning direct calls outside the `DB_RUN_EXEC_ALLOW_LIST`; new security invariant **I14** wired and enforced in `security-invariants.test.ts` + `SECURITY-INVARIANTS.md`; `db-run-census.json` baseline updated to 3 entries (the wrapper internals only).

#### Security audit follow-ups (B1)

Items deferred from the Phase 4 internal security audit (B1, 2026-04-25) that fit naturally with Phase 5's hardening pass.

- [x] **Typed `dbRun` / `dbExec` migration (S5-F4)** (2026-05-16, Phase 5 T6 PR 4) — 163 sites migrated; `D12` static-audit rule + invariant `I14` enforce the wrapper at CI time
- [x] **Structured tool-call result auditing (S8-F10)** (2026-05-15, Phase 5 T6 PR 2) — V29 `tool_call_log` table; `writeToolCallLog` wired at both `wrapToolOutput` sites; `audit.toolCalls` IPC read surface
- [x] **`tool_call_log` retention policy** (2026-06-04, Phase 5) — `[audit].tool_call_log_retention_days` (default 90; `0` disables) parsed in `config/nimbus-toml.ts`; a daily `startToolCallLogRetention` job (prune once at startup, then every 24h; registered in `platform/assemble.ts` on the `sidecarStops` list) deletes `tool_call_log` rows older than the threshold and, when any were removed, appends a single `tool_call_log.pruned` entry to the chained `audit_log` with the deleted-row count. The chain is **append-only** — never rewritten or pruned — so the BLAKE3-chained `audit_log` proper is untouched. No migration (the table is V29; `called_at` is already indexed).
- [x] **`nimbus security scan` v2** (2026-06-04, Phase 5) — all six enhancements shipped in one PR: (1) `[security.allowlist]` fingerprint mute-list (`sha256(service:external_id:pattern:redacted:sha256(context))`, fixed-literal-safe, no secret bytes); (2) `--fail-on-finding` CI exit code; (3) opt-in extended low-confidence pattern tier behind `[security].extended_patterns` / `--extended`; (4) `--service <name>` scope filter; (5) `security.scan` as a cancellable `LongRunningJobRegistry` job with `security.scanProgress`/`scanDone`/`scanError` (streaming iterator, `security.scanCancel`); (6) line-level git-blame via the V32 `git_blame_line` table populated at filesystem-sync time over indexed `code_symbol` excerpt ranges (`code_symbol` now stores `excerptStartLine`; scan-time attribution is a pure indexed lookup, no `git` subprocess). Backfills on the next `nimbus connector sync filesystem`. See `docs/superpowers/specs/2026-06-04-security-scan-v2-design.md`.

#### Extension Marketplace v2

- [ ] Community ratings and reviews per extension
- [x] Verified publisher badges (Ed25519-signed manifest from a registered publisher) (2026-05-18, PR #343, Phase 5 T2 PR 2)
- [x] Auto-update with changelog preview; user approves each version bump (2026-05-20, PR #367, Phase 5 T2 PR 3)
- [x] Extension dependency resolution (one extension can depend on another) (2026-05-21, PR #374, Phase 5 T2 PR 4)
- Extension monetization (paid extensions, license key enforcement, revenue sharing) deferred to Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5)

#### Wave B — Mobile & Frontend Engineering (stretch)

Connector breadth for mobile and frontend engineering disciplines that didn't fit the original Phase 5 categories. Each is read-only in Phase 5; write tools (releasing a build, dismissing a Web-Vitals regression) land in Phase 8 (Security Engineering) or Phase 12 (Enterprise) depending on shape. Does not gate Phase 5 completion.

- [x] **Bitrise** — mobile CI builds, workflows, releases, certificates state, app dashboards; read-only (2026-05-21, Phase 5 Wave B; `bitrise:app` + `bitrise:build` items via `/v0.1/me/apps` → `/v0.1/apps/<slug>/builds`; mandatory read-tool surface; vault key `bitrise.token`; `permissions.network = ["api.bitrise.io"]`)
- [x] **Codemagic** (2026-06-03, Phase 5 Wave B) — Flutter/RN/native mobile CI; read-only. `codemagic:app` + `codemagic:build` items via `GET /apps` → `GET /builds?appId=<id>`; mandatory read-tool surface (`codemagic_list`/`codemagic_get`/`codemagic_search`); vault key `codemagic.token` (sent in the `x-auth-token` header); `permissions.network = ["api.codemagic.io"]`
- [ ] **Microsoft App Center** (or successor where deprecated) — mobile build pipelines, distribution groups, crash analytics, in-app analytics; read-only. **Cancelled (2026-06-04, Wave B close-out):** Visual Studio App Center was **retired by Microsoft on 2025-03-31** — `api.appcenter.ms` no longer serves data (the residual Analytics & Diagnostics surface expires 2026-06-30), so a read connector would be dead code. No drop-in successor exposes the same token-auth read API. Wave B closed without it. Revisit only if a successor with a clean token-auth read API emerges; not a gate.
- [x] **Firebase App Distribution** (read-only) — release observability; read-only. **Delivered (2026-06-03):** Cloned from the Codemagic/TestFlight pattern. Indexes each configured app's recent **releases** as `firebase:release` (gateway sync `firebase-sync.ts`, cursor `{ pass }` / `nimbus-firebase1:`, walks `GET /v1/projects/<projectNumber>/apps/<appId>/releases?pageSize=50` per configured app id; the project number is the 2nd colon-segment of the app id; pure mapper `mapFirebaseReleaseToItem` in `firebase-release-mapping.ts`). Release `external_id` = the App Distribution release resource `name` (`projects/N/apps/A/releases/R`), title `<displayVersion> (<buildVersion>)`, metadata `{ app_id, display_version, build_version, create_time, release_notes_text, firebase_console_uri, testing_uri, binary_download_uri }` — the `binary_download_uri` is **stored only, never fetched**. **Auth** — App Distribution's REST API is a Google Cloud API; a short-lived OAuth2 access token is minted from a Google **service-account key** via the RS256 **JWT-bearer grant** (`node:crypto`, scope `cloud-platform`, exchanged at `oauth2.googleapis.com/token`) — no `googleapis` dependency; the gateway sync and the MCP server share the signer via `@nimbus-dev/sdk` (`mintGoogleAccessToken`). Vault keys `firebase.service_account_json` + `firebase.app_ids` (comma-separated). MCP server (`mcp-connectors/firebase`) exposes read-only `firebase_list` / `firebase_get` / `firebase_search`, caching the minted token in-process. Rate-limiter provider `firebase` (40 rpm / burst 8). `permissions.network = ["firebaseappdistribution.googleapis.com", "oauth2.googleapis.com"]`. `firebase:release` stays on local MiniLM (NOT in `PROSE_HEAVY_TYPES`). `hitlRequired: []`. v1: read-only releases; write actions (distribute a build, manage tester groups) deferred.
- [x] **TestFlight** (read-only via App Store Connect API) — build groups, tester sessions, feedback; read-only. **Delivered (2026-06-03):** Cloned from the Codemagic connector. Indexes App Store Connect **apps** + recent TestFlight **builds** as `testflight:app` / `testflight:build` (gateway sync `testflight-sync.ts`, cursor `nimbus-testflight1:`, walks `GET /v1/apps → GET /v1/builds?filter[app]=<id>&sort=-uploadedDate&limit=50`; pure mappers in `testflight-build-mapping.ts`; build metadata `{ app_id, version, processing_state, expired, uploaded_date, min_os_version, uses_non_exempt_encryption }`, canonical URL null). **Auth** — short-lived ES256 JWT minted from `testflight.issuer_id` + `testflight.key_id` + `testflight.private_key` (the `.p8` PEM) via `node:crypto` (`dsaEncoding: "ieee-p1363"`, `exp` <= 20 min, `aud: appstoreconnect-v1`); the gateway sync and the MCP server share the signer via `@nimbus-dev/sdk` (`signAppStoreConnectJwt`). MCP server (`mcp-connectors/testflight`) exposes read-only `testflight_list` / `testflight_get` / `testflight_search`. Rate-limiter provider `testflight` (50 rpm / burst 10). `hitlRequired: []`. v1: read-only apps + builds; write actions (expire build, tester groups, beta feedback) deferred.
- [x] **Storybook** (2026-06-02, Phase 5 Tier 5 — local/no-network) — `storybook:story` items via `mapStorybookStoryToItem` from the local Storybook manifest (`index.json` v7+ or legacy `stories.json` v6) that `storybook build` writes to disk. A **pure filesystem read of one JSON manifest** — NO browser launched, NO dev-server connection, NO component code executed. The sync handler (`storybook-sync.ts`, cursor `{ pass }` / `nimbus-storybook1:`) reads `<dir>/index.json` (falling back to `<dir>/stories.json`) from the configured `storybook.dir`, and the pure `parseStorybookIndex` handles both the v7 `{ entries }` and v6 `{ stories }` shapes (with `kind`/`story` aliases). One item per story: `external_id` = the Storybook story id, title = `<componentTitle> / <storyName>`, metadata = component title, story name, import path, tags, entry type; `modifiedAt` = the manifest file mtime else syncedAt. **Config** — a single non-secret PATH `storybook.dir`, so `CONNECTOR_VAULT_SECRET_KEYS.storybook` is `["storybook.dir"]`; the spawn `phase3AddStorybookMcp` extends `filesystem.read` with that dir at spawn (the GX/localdb pattern), injects `STORYBOOK_DIR`, `wrapServerSpec` (I15); the MCP server (`loadStories` over the env dir) exposes `storybook_list` / `storybook_get` / `storybook_search`. Reuses the `"filesystem"` rate-limiter. `storybook:story` stays on local MiniLM (NOT in `PROSE_HEAVY_TYPES` — story metadata is structured). `hitlRequired: []`. Design-system component coverage feeds Phase 7 service-catalog `component` items. **v1 story-level metadata only — per-story args/parameters and MDX docs bodies deferred.**
- [ ] **Chromatic** — visual-regression test results, baseline diffs, build approvals; read-only; `chromatic.build.approve` HITL. **Deferred (2026-06-03):** Chromatic's token-auth public GraphQL API (`index.chromatic.com/graphql`, `createAppToken` → bearer) exposes only `Project.lastBuild` (a single build) — there is **no paginated builds-list field** in the documented public schema. Enumerating a project's build history requires undocumented internal `app.*` roots or an OAuth-session JWT (not a stable headless token), the same posture that deferred Loom/Expensify. **Wave B closed (2026-06-04) without it** — re-confirmed the public schema still exposes only `Project.lastBuild`, so a build-history connector is not feasible from a headless token. Revisit if Chromatic publishes a listable builds API; not a gate.
- [ ] **LogRocket / FullStory / Datadog RUM** — frontend session replays metadata (no replay-payload bodies indexed by default), error events, Web Vitals (LCP, FID, CLS, INP); read-only; opt-in to indexing PII-redacted metadata
- [ ] **Web-vitals watcher** — fires when LCP/FID/CLS p75 regresses past configurable threshold over a 24-h window for a tracked service; surfaces in morning briefing; ties into Phase 7 DORA dashboard

#### Acceptance Criteria

- A user with a Fastmail account can run `nimbus connector auth fastmail` and have their inbox indexed within 5 minutes using the IMAP connector
- A HubSpot deal update initiated by the agent triggers HITL before any outbound API call
- The `nimbus-dev/query-action` GitHub Actions action successfully queries a running Gateway's HTTP API and blocks a deploy when an active P1 incident is detected for the target service
- A repo containing `openapi.yaml` is indexed and `nimbus ask "which services have a POST /payments endpoint?"` returns the correct service name from the local index without a live API call
- `nimbus security scan` detects a deliberately introduced test credential in a filesystem root configured at `summary` depth and reports the file path, pattern match type, and connector — verified in `packages/gateway/test/e2e/scenarios/security-scan.e2e.test.ts`
- **(Tracked in Phase 9.5 — not a Phase 5 gate.)** A community extension published via the **Marketplace Registry** can be installed, enabled, and used without the author having access to Nimbus core source. This depends on the public registry host (`registry.nimbus-agent.dev`) and the seed/publish flow, which are the deliverables of **[Phase 9.5 (Marketplace Registry)](#phase-95--marketplace-registry)** (Planned), so it is tracked there and does not gate Phase 5 completion. Phase 5's own extension surface — install-from-directory, Ed25519-signed verified-publisher badges, changelog-previewed auto-update, and extension dependency resolution — is complete (see Extension Marketplace v2 above).
- `nimbus ask "which repos have critical Snyk vulnerabilities with open PRs touching the affected packages?"` returns results from the local index without any live API call
- `nimbus metrics dora --service payment-service --since 30d` returns all four DORA metrics computed from indexed GitHub and PagerDuty data
- An ArgoCD application sync failure is indexed and correlatable with the triggering Git commit within one sync cycle
- `nimbus ask "which dbt models feed the failing Tableau dashboard?"` returns a lineage chain once Phase 6 Tableau lands; intermediate Phase 5 variant works end-to-end against Metabase / Superset dashboards linked to dbt models
- No raw row data or binary extract crosses the connector boundary for any warehouse or BI connector — verified by a contract test that asserts the absence of row-fetch tools on each connector's MCP surface
- **Downstream Impact Analysis** — `nimbus ask "if I change the revenue calc in this PR, which Looker dashboards break?"` resolves via `traverseGraph` over `code_symbol` → `data_model` → `dashboard` relations in the Phase 3 relationship graph; returns affected dashboards in under 500 ms from the local index
- Local data-file profiling indexes column names + types + row-count estimates from `.parquet`, `.csv`, `.jsonl`, and `.json` files under configured filesystem roots (**`.orc` deferred** — no maintained pure-JS ORC schema reader exists on npm; revisit when one ships); contract test asserts the connector surface exposes no row-sample or cell-read tool; manual audit confirms only file footers / header lines / line counts are read — never row contents
- MLflow / SageMaker / Vertex AI experiments and models are indexed with framework, metric snapshots, and stage transitions (read-only in Phase 5; the `ml.model.promote` HITL write path lands in Phase 6 — see [§ Phase 6 → Deferred from Phase 5](#deferred-from-phase-5))
- `nimbus expert src/billing/retry.ts` returns a ranked list of team members with evidence drawn from indexed PR authorship, review history, and incident involvement — answered from the local index without a live API call
- `nimbus catchup --since 3d` returns a digest prioritized by the authenticated user's historical involvement, with higher-ranked items matching services and repos the user has recently contributed to — verified by seeding two connectors with different activity levels and confirming the more-relevant one ranks first
- `nimbus impact src/billing/retry.ts` returns at minimum the set of services that depend on the file and the pipelines that would be affected, resolved from the local relationship graph without a live API call

---

<a id="phase-6-team"></a>

### Phase 6 — Team ✅

> **Status: ✅ Complete (2026-06-18).** Slices 1 (Federation Core) and 3 (Identity — SSO/OIDC + SCIM) shipped 2026-06-05; Slice 2 (Team Vault + Quorum HITL) and Slice 4 (Org Policy + Admin + Observability) shipped 2026-06-07; Slice 5 (ChatOps) shipped 2026-06-09; Slice 6 (Cross-colleague intelligence — 6a/6b/6c) shipped 2026-06-11 → 2026-06-12; Slice 7 (Data Warehouse & BI connectors — Waves 7a–7c) shipped 2026-06-13/14; Slice 8 (Share & Virality — Waves 8a–8d) shipped 2026-06-17/18; Slice 9 (deferred-from-Phase-5 items) shipped 2026-06-14 → 2026-07-19 — Wave A (Mendeley) 2026-06-14, Waves E/W1 + Workday 2026-06-21, the web clipper (gateway side) 2026-06-22 and its browser extension 2026-07-19 (see [`docs/CHANGELOG.md`](./CHANGELOG.md)). Three Slice-9 items remain explicitly deferred, not outstanding: SageMaker / Vertex AI writes (CLI-credential connectors — no discrete token; S5-demoted) and paid extensions (rides Phase 9.5 Marketplace v2). **The build order from here is the [Phase 7+ Sequencing Spine](#phase-7-sequencing-spine) overlay — the current slot is [S1 — Local Brain](#active).**

**Goal:** Make Nimbus a collaborative layer for engineering teams — shared intelligence without surrendering local sovereignty.

> **Composes with Phase 7 (Engineering Excellence):** the federation primitives, Team Vault, ChatOps, admin console, and org-level policy engine in this phase are the multipliers for Phase 7's service catalog, DORA metrics, feature-flag, and shared knowledge graph features. Phase 6 ships independently of Phase 7 — but when both are present, the `@nimbus excellence` ChatOps shortcut, embedded DORA panels in the admin console, and federated synchronisation of the Phase 7 knowledge graph + automation library all light up.

#### Delivery Slices

Phase 6 bundles several independent subsystems; it ships as **9 sequenced delivery slices** (one consumer-oriented slice was moved out to the new Phase 20 — Personal & Household Federation). **Slice 1 — Federation Core** is the substrate every other slice depends on. Each slice gets its own spec → plan → implementation cycle.

| # | Slice | Depends on |
|---|-------|-----------|
| 1 | **Federation Core** — E2EE peer pairing, mDNS discovery, consent-scoped federated query primitive, shared scoped namespaces, expertise routing, protocol-layer RBAC, audit integration, invariant I17 (✅ delivered 2026-06-05) | Phase 4 E2EE LAN + audit chain |
| 2 | Team Vault + Multi-user/Quorum HITL (✅ delivered 2026-06-07, invariants I19/I20/I21) | 1 |
| 3 | Identity — SSO/OIDC/SAML + SCIM (✅ OIDC device-code + SCIM trust-anchor delivered 2026-06-05, invariant I18; SAML deferred) | 1 |
| 4 | Org Policy Engine + Admin Console + Observability (✅ delivered 2026-06-07, invariant I22) | 1 |
| 5 | ChatOps (Slack/Teams bot, HITL-via-chat) (✅ delivered 2026-06-09, invariant I23) | 1, 2 |
| 6 | Cross-colleague intelligence (ghost reviewers, conflict detection, cloud janitor, huddle, tribal-knowledge, blast-radius preflight) — **Slice 6a** (ghost / conflicts / huddle agents + V38 known-namespaces cache) ✅ 2026-06-11; **6b** (cloud janitor + blast-radius preflight, I24) ✅ 2026-06-12; **6c** (tribal-knowledge extraction, I25/V39) ✅ 2026-06-12 — Slice 6 COMPLETE | 1 |
| 7 | Data Warehouse & BI connectors (Snowflake, Tableau, Looker, PowerBI, Monte Carlo, Bigeye) — **Wave 7a ✅ delivered 2026-06-13** (read-only connectors + V40 cross-warehouse lineage); **Wave 7b ✅ delivered 2026-06-14** (optional Team-Vault credentials via the I19 principal-polymorphic gate + unified paginated spawn transport; no new invariant/migration; deferred: live-API cursor verification, cross-gateway audit-identity-subject); **Wave 7c ✅ delivered 2026-06-14** (HITL-gated warehouse/BI writes, invariant I26) | 2, 3 |
| 8 | Share & Virality primitives (`nimbus share`, verify-share, referral, recipe, replay) — **✅ delivered 2026-06-17/18** (Waves 8a–8d; invariant I27 / static D21; V41 share_records, V42 recipe params, V43 share_inbox) | 1, Phase 4 signing |
| 9 | Deferred Phase 5 items — **✅ complete** (except three explicitly-deferred items): Wave A (Mendeley) 2026-06-14; Workday + Wave E (Apple Mail / iCloud Calendar) + Wave W1 (ArgoCD / Flux / MLflow writes, I26) 2026-06-21; web clipper gateway side (I30) 2026-06-22 and its Chrome/Firefox MV3 extension 2026-07-19. **Still deferred:** SageMaker + Vertex AI writes (CLI-credential connectors, S5-demoted) and paid extensions (rides Phase 9.5) | mostly independent |

Slices 2–8 may proceed in parallel once Slice 1 lands; Slice 7 waits on 2+3; Slice 9 is independent. Each slice maps to the feature subsections below as follows:

- **Slice 1** ↔ "Federated Query Consent (foundational)" + the federation/namespace/discovery/conflict-detection parts of "Shared Infrastructure"
- **Slice 2** ↔ "Shared Infrastructure" (Team Vault, Quorum HITL) + "Identity & Access" (Multi-user HITL)
- **Slice 3** ↔ "Identity & Access" (SSO/OIDC/SAML, SCIM, role-based access control)
- **Slice 4** ↔ "Shared Workflows & Policy" (org-level policy engine + enforcement) + "Admin & Observability"
- **Slice 5** ↔ "ChatOps"
- **Slice 6** ↔ "Shared Infrastructure" (ghost reviewers, cross-user conflict detection, cross-team cloud janitor) + "Shared Workflows & Policy" (huddle briefing, tribal-knowledge extraction, blast-radius preflight) — **Slice 6a** ✅ 2026-06-11: ghost / conflicts / huddle agents + V38 `federation_known_namespaces` cache; **6b** ✅ 2026-06-12: cloud janitor + blast-radius preflight (I24); **6c** ✅ 2026-06-12: tribal-knowledge extraction (repeated-question detection → owner-approved Notion/Confluence KB capture; I25/D19; V39 `tribal_clusters`). **Slice 6 COMPLETE.**
- **Slice 7** ↔ "Data Warehouses & BI (SSO-gated)"
- **Slice 8** ↔ "Share & Virality Primitives"
- **Slice 9** ↔ "Deferred from Phase 5"

**Slice 1 — Federation Core: ✅ delivered (2026-06-05).** The federation substrate ships: the V33 schema (`federation_namespaces` / `_filters` / `_grants` + `audit_log.federation_json`), the namespace store with per-peer RBAC grants, the session consent cache, the `DiscoveryProvider` (mDNS via `bonjour-service` + in-memory + manual fallback), mutual-approval peer pairing, content-free expertise ranking, and the **I17 query gate** — `answerFederatedQuery`, the only path that answers an inbound `federation.query`: grant + role + consent + declared-filter scoping, leak-proof `FederatedItem` shape (never `metadata`), every outcome audited into the Blake3 chain. Wired through the `federation.*` JSON-RPC dispatcher (LAN admits only `federation.query` / `federation.expertise`; the management methods are local/Tauri-only — I5), the `[federation]` config section, the `nimbus team` CLI, the Tauri renderer allowlist (5 local management methods; `federation.pair` stays CLI-only), invariant **I17** (runtime test + static **D13**), and an integration-tested acceptance suite.

> **Over-the-wire seams delivered (2026-06-05):** the three previously-deferred Slice-1 seams are now wired — outbound LAN pair/query client (`ipc/lan-client.ts`), `LanServer` constructed and started at gateway boot (`federation/federation-server.ts` `buildFederationLanServer` + `platform/assemble.ts`, gated on `[federation].enabled`), and the owner-consent round-trip (`federation/consent-broker.ts` + `federation.consentRespond`). Two gateways can now exchange federated queries over the NaCl-box channel. The answering `peerId` is forced from the NaCl-authenticated session (I17/R1).

**Slice 3 — Identity & Access (OIDC + SCIM): ✅ delivered (2026-06-05).** Enterprise identity on the Slice 1 substrate, gated by new structural invariant **I18**. The V34 schema (`identity_session` / `scim_user` / `identity_binding` / `oidc_jwks_cache` — no secret values in any column; tokens live only in the Vault), the `identity/` modules (OIDC discovery + device-code flow, a TTL'd fail-closed `JwksCache`, the **I18 canonical `IdTokenVerifier`** — the ONLY ID-token validation path: RS256 via Bun WebCrypto, `iss`/`aud`/`exp`/`nbf` checks, no new npm dependency — plus the pure synchronous `isOperatorValid()` the federation gate consults, an `IdentityStore`, and `identity-vault.ts` as the sole constructor of the `identity.oidc.*` / `identity.scim.bearer` Vault keys), and a trust-anchor SCIM 2.0 Users endpoint on the **I13** HTTP write surface (`scim-http-routes.ts` / `scim-service.ts` — the 3 `/scim/v2/Users` routes in `WRITE_ROUTE_ALLOWLIST`, every write through the `dispatchWriteRoute` pipeline with `identity.scim.bearer` auth + per-token rate-limit + `scim.provision_rejected` audit-on-rejection), with a SCIM **deprovision → federation-grant auto-revoke** tie-in. **Federation tie-in:** `answerFederatedQuery` consults `isOperatorValid()` before answering when identity is enabled, so a deprovisioned/expired operator session fails federation closed (raw `ask`/`search` are never affected — identity gates federation only). Wired through the `identity.*` / `scim.*` JSON-RPC dispatcher (forbidden over the LAN wire), the `[identity]` + `[scim]` config sections, the `nimbus identity` + `nimbus scim` CLI, the Tauri renderer allowlist (6 read/login methods; the credential-mutating `identity.bind`/`unbind` + `scim.setToken`/`deprovision` stay CLI-only — I7), and invariant **I18** (runtime test + static **D14**). **SAML deferred.**

**Slice 2 — Team Vault + Multi-user/Quorum HITL: ✅ delivered (2026-06-07).** Team-scoped credentials and approvals on the Slice 1 substrate, gated by three new structural invariants **I19/I20/I21**. The V35 schema adds `team_vault_entries` / `team_vault_grants` (live-checked per-`(entry,peer,tool)` RBAC) + `hitl_delegations` — secret *bytes* never live in these tables (metadata + RBAC only; the bytes live in the OS Vault under the `teamvault.<entry>.<connectorKey>` keyspace). **Team Vault** (`teamvault/`): a `TeamVaultStore`, the **D15 keyspace home** `team-vault-keys.ts` (the ONLY composer of the `teamvault.` prefix), a tamper-evident `team-vault-audit.ts` (folds into the BLAKE3 chain), and the **I19** consumption path — `federation/invoke-gate.ts` `answerFederatedInvoke` (identity → live RBAC → quorum → run), which returns only `{ ok, result }`; the secret is read by a read-only vault overlay (`team-vault-view.ts`, never falls through to the operator's own key) and injected into an ephemeral team-credentialed connector (`team-tool-spawn.ts` — inherits `extensionProcessEnv` I1 + `wrapServerSpec` I15), then drained. **Fail-closed:** a missing team secret / OAuth-only-or-unknown service / missing grant aborts before any spawn — never falling through to the operator's local credential. **Quorum (I21):** a session-only `QuorumCoordinator` counts only DISTINCT authenticated peers (deny aborts, window timeout) behind a `[hitl.quorum."<action-type>"]` config table. **Delegated HITL (I20):** a scoped, time-boxed `DelegationStore` + `resolveDelegatedApproval` wired into the executor gate — an owner's HITL approval routes to a live, in-scope, identity-valid delegate (else falls back to the local owner prompt; the wire is never trusted). Wired through three answerable over-the-wire methods (`federation.invoke` / `federation.quorumRespond` / `federation.approvalRespond`, `peerId` forced from the NaCl-authenticated session) + asker-side `federation.askInvoke`, the local management dispatchers `teamvault.*` (`put`/`delete` HITL-gated, I2) + `hitl.*` (LAN-forbidden, I5), the `[hitl.quorum]` config loader, the `nimbus team vault|invoke|delegate` CLI, the Tauri renderer allowlist (5 renderer-safe methods; the secret/RCE-class methods stay renderer-FORBIDDEN — I7), and invariants **I19** (static **D15**) / **I20** / **I21** (each with a runtime test). **Integration acceptance:** a two-gateway invoke test (pair → grant → ok+leak-proof → RBAC → impersonation → revoke → no_grant → audit) and a quorum test (single approval stays locked; two distinct unlock).

**Slice 4 — Org Policy + Admin + Observability + Team Audit + GDPR Purge: ✅ delivered (2026-06-07).** The org-governance layer ships: the `policy/` subsystem (`nimbus.policy.toml` schema+parser, Ed25519 sign/verify over canonical bytes, V36 `org_policy_state` + `policy_anchor_pin`, a `PolicyStore`, and the **I22 `PolicyGate`** that resolves a monotonic-stricter `EnforcedPolicy` — tighten-only, fail-closed to last-valid/baseline — driving connector-allowlist + retention-floor + quorum/HITL enforcement, peer distribution via `federation.policy` + pubkey pinning + `nimbus policy trust`, and an audit-log shipper `federation.auditExport`); GDPR purge (V37 `gdpr_purge_job` + `gdpr_purge_request` ledger, `team.purge` orchestration, HITL-gated `federation.purge` serve emitting signed deletion records, sync-cycle retry); the `status/` subsystem (`GatewayStatus` snapshot + Prometheus exposition at `GET /metrics`); and the dependency-free `packages/admin-console` served at `GET /admin/*`. Wired through `policy.*` / `team.purge` / `team.auditMerged` / `admin.status` IPC, the HTTP read routes + the `PUT /v1/admin/policy` write route (**I13**; `WRITE_ROUTE_ALLOWLIST` 4 → 5), the Tauri renderer allowlist (read-only `admin.status` / `policy.show` / `team.auditMerged`; privileged `policy.sign` / `trust` / `refetch` + `team.purge` stay CLI-only — I7), invariant **I22** (runtime test + static **D16**), and `CURRENT_SCHEMA_VERSION` → 37.

**Slice 5 — ChatOps (Slack/Teams bot, HITL-via-chat): ✅ delivered (2026-06-09).** A bidirectional `@nimbus` bot on the Slice 1–4 substrate, gated by new structural invariant **I23** (static **D17**). **No new migration** — channel↔namespace bindings + resource→owner ownership live in the Slice 4 signed org policy (`[policy.chatops.channel."<id>"]` + `[policy.chatops.ownership]`, parsed in `policy/chatops-policy.ts`, carried through `EnforcedPolicy`); the identity-email cache is in-memory; the Teams JWT path reuses `oidc_jwks_cache`. **`chatops/` subsystem:** a transport-agnostic graph — `identity-mapper.ts` (platform-userId → email (TTL-cached) → SCIM identity, with a **live, local** authz re-check every message so a deprovision takes effect immediately), `command-parser.ts` (normalize → NL-read vs structured-`run` split → write grammar; unknown actions refused, never guessed), `owner`-routing via `chatops-request-context.ts` (AsyncLocalStorage) + `approval-presenter.ts` (owner-routed Approve/Reject card → the real **I20** `resolveDelegatedApproval`), `intent-router.ts` (read→engine, write→owner-gated executor, refusal audit), and the **I23** `reply-dispatcher.ts` — the SOLE operational (non-HITL) post path, whose destination is ONLY a server-derived `ReplyTarget` (originating channel or a policy `notify` channel), never caller-supplied; arbitrary-destination posting remains only via the HITL-gated `*.message.post` action types. **Transports:** Slack Socket Mode (adapter-owned WS via the connector `slack_socket_open` tool; envelope-ack, reconnect/backoff, bounded FIFO dedupe) + Teams webhook on the **I13** write surface (`POST /v1/messaging/teams/events`, `WRITE_ROUTE_ALLOWLIST` 5 → 6; auth = a Bot Framework JWT validated in-route, fail-closed). **Connectors:** `slack`/`teams` gain operational `*_chat_post` + `*_user_info` (+ `slack_socket_open`) tools using bot/app credentials (new Team-Vault keys `slack.bot_token`/`app_token`, `teams.bot_app_id`/`bot_app_password`); D17 confines the `*_chat_post` tool references to the dispatcher/transports + the connector definition sites. **Surfaces:** `chatops.*` IPC (`status`/`start`/`stop`/`test`, forbidden over the LAN wire), `nimbus chatops` CLI, and the read-only `chatops.status` on the Tauri allowlist (5→6 — 82 → 83; `start`/`stop`/`test` stay off the renderer surface, I7). Watcher alerts route to a namespace's notify channels via `makeChatopsWatcherNotify`. Invariant **I23** (runtime test + static **D17**); the triple lands together. *Follow-up: gateway-boot wiring (`chatopsRpcCtx` + `resolveTeamsEventsSurface` in `platform/assemble.ts`, incl. executor-gate + lazy-mesh connector invocation + Team-Vault bot-token injection) to make the built graph reachable in a running gateway; the slice's components are unit- + integration-tested in-process.*

#### Dependencies

- Phase 4 encrypted LAN remote access (E2EE channel foundation for Nimbus-to-Nimbus)
- Phase 4 tamper-evident audit log (required for org-level compliance controls)
- Phase 4 Plugin API v1 (team connectors can ship as extensions)
- Phase 3.5 configuration profiles (team policy interacts with per-user profile config)

#### Federated Query Consent (foundational)

These two primitives are the **foundation** every cross-colleague feature stands on. Today the cross-colleague ideas — ghost reviewers, the cross-team cloud janitor, the Phase 7 federated agents, reviewer-tailored briefs — each implicitly assume "your agent can query a teammate's index." That assumption must be a *designed, audited, revocable* capability, not a free side effect, or federation becomes surveillance. Build these **before** anything that reads a peer's index.

- [x] **Consent-scoped federated query primitive** — a first-class sharing-scope + per-query consent mechanism over the federation channel. Each peer declares which `item` types + services + namespaces are queryable by whom; every federated query carries a stated purpose; the answering Gateway records every inbound query in its local audit log and can require interactive consent (or a standing per-peer grant) before answering. Revocable per peer, per scope, at any time — revocation takes effect within one sync cycle. Every cross-colleague feature in Phases 6–10 routes through this primitive rather than reinventing access.
- [x] **Privacy-preserving expertise routing** — the *safe* answer to "who knows about this code/system?". Instead of a peer exposing index *content*, each peer's Gateway locally scores its own relevance to the query and returns **only a rank** ("Alice: high, Bob: low") — never the underlying items. The asker learns who to talk to; the data never leaves the owner's machine. The privacy-preserving substrate for ghost reviewers and the Phase 7 federated agents.

#### Shared Infrastructure

- [x] **Nimbus-to-Nimbus federation** — two Gateways share a scoped index namespace over E2E-encrypted channel (NaCl box); no relay server; each side controls which `item` types and services it exposes; revocable per peer
- [x] **Cross-user conflict detection** — use the federated index to detect "Work-in-Progress collisions" (e.g., Alice editing `auth.ts` while Bob is assigned to the related Jira ticket); notifies the user before starting changes ✅ (Slice 6a: 2026-06-11 — `agents.conflicts` / `nimbus conflicts`)
- [x] **Team Vault** — shared credential store; one Gateway acts as trust anchor; role-based read/write access to named vault entries; credentials never leave the LAN ✅ (Slice 2: 2026-06-07)
- [x] **Shared index namespaces** — user publishes a named namespace (e.g. `project:zurich`) as a filtered slice of their index; teammates subscribe over the federation channel; changes propagate on next sync cycle
- [x] **LAN discovery** — Gateways advertise each other via mDNS; `nimbus team discover` lists available peers; pairing requires explicit mutual approval
- [x] **"Ghost" reviewers** — when you open a complex file, your Gateway uses the consent-scoped federated query primitive (above) to surface ambient teammate context: *"Alice resolved a similar race condition here 3 months ago (PR #142) — pull her context or draft her a Slack message?"*. Strictly an opt-in pull; context is weighted by recency and whether the referenced code still exists (a fix against since-rewritten code is suppressed). Turns the team's past experience into an ambient, queryable graph without requiring exhaustive documentation. Built on the federated-consent + expertise-routing primitives. ✅ (Slice 6a: 2026-06-11 — `agents.ghost` / `nimbus ghost`)
- [x] **Quorum HITL (the "two-man rule")** — extends Multi-user HITL: for the most destructive actions (e.g. `terraform destroy`, force-push to `main`, drop a production DB), the Team Vault requires *two* federated peers to approve within a bounded window before the credential unlocks. Enforced in the executor's HITL gate (`I2`), not the prompt — two-person control executed entirely over the local-first mesh with no central broker. The action-type → quorum-size mapping lives in the org-level policy engine. ✅ (Slice 2: 2026-06-07 — `QuorumCoordinator` counts only DISTINCT authenticated peers, invariant **I21**)
- [x] **Cross-team cloud janitor** — a designated "janitor" agent queries the team mesh (via the consent primitive) to ask each peer's Gateway whether any local terminal, repo, or recent activity has touched a given cloud resource (e.g. AWS instance `i-12345`). If every peer reports no recent local context for ≥ N days, the janitor proposes a cleanup workflow through the team HITL queue. Bridges infrastructure state (the cloud) and *human* developer context (who's actually using what) — the gap that lets idle test databases and forgotten instances balloon cloud spend. ✅ (Slice 6b: 2026-06-12 — `agents.janitor` / `nimbus janitor`; a content-free `federation.probe` recency fan-out, and a peer that doesn't answer is never counted as idle)

#### Identity & Access

- [x] **SSO/OIDC/SAML** — enterprise identity provider integration; tokens stored in the Vault; Gateway validates ID token on every session *(Slice 3: OIDC device-code + SCIM trust-anchor delivered — RS256 ID-token validation via `identity/verifier.ts` (I18), Vault-only tokens, SAML deferred)*
- [x] **SCIM user provisioning** — automated user lifecycle driven by IdP; deprovisioned users' shared namespaces revoked automatically *(Slice 3: OIDC device-code + SCIM trust-anchor delivered — bearer-authed SCIM 2.0 Users endpoint on the HTTP write surface; deprovision auto-revokes federation bindings)*
- [x] **Role-based access control** — `owner`, `editor`, `viewer` roles per shared namespace; enforced at the federation protocol layer, not just the UI *(Slice 1: roles stored + enforced in the query gate; cross-org RBAC + SCIM-driven provisioning are Slice 3)*
- [x] **Multi-user HITL** — workspace owner delegates HITL approval rights to a named team member for a specific workflow; delegate sees a pending approval queue; every delegation recorded in audit log ✅ (Slice 2: 2026-06-07 — scoped, time-boxed `DelegationStore` + `resolveDelegatedApproval` wired into the executor gate, invariant **I20**)

#### Data Warehouses & BI (SSO-gated)

Depends on Team Vault (above) so service-account / SSO credentials can be shared across a workspace without each user re-authenticating.

All six shipped in **Slice 7**: the read-only connectors + the V40 cross-warehouse lineage graph in **Wave 7a** (2026-06-13), optional Team-Vault credentials in **Wave 7b** (2026-06-14), and the HITL-gated write tools in **Wave 7c** (2026-06-14, invariant **I26** / static **D20**). The no-row-data contract is enforced by a per-connector test.

- [x] **Snowflake** (SSO / OAuth / Key-Pair) — databases, schemas, tables / views (column names + tags only), tasks, pipe status, recent query history metadata; `data_model` item type indexed with database, schema, table, column tags, row-count estimate, last-altered; `snowflake.tag.set` / `snowflake.comment.set` behind HITL; strictly no row data ✅ (Slice 7: 7a read 2026-06-13, 7c writes 2026-06-14)
- [x] **Tableau Server / Cloud** — dashboards, reports, views, workbooks, authors, folders, extract refresh status; `dashboard` item type; read-only except `tableau.datasource.refresh` / `tableau.workbook.refresh` behind HITL; links Tableau views to upstream Snowflake tables via data-source metadata ✅ (Slice 7: 7a 2026-06-13, 7c 2026-06-14)
- [x] **Looker** — dashboards, Looks, Explores, LookML models, content folders; `dashboard` + `data_model` item types; read-only; `looker.datagroup.trigger` / `looker.schedule.run_once` behind HITL; links Looker Views to the underlying dbt models in GitHub via LookML `sql_table_name` ✅ (Slice 7: 7a 2026-06-13, 7c 2026-06-14)
- [x] **PowerBI** — workspaces, reports, dashboards, datasets (schema only), dataflows; `dashboard` item type; read-only except `powerbi.dataset.refresh` / `powerbi.dataflow.refresh` behind HITL ✅ (Slice 7: 7a 2026-06-13, 7c 2026-06-14)
- [x] **Monte Carlo** (SSO) — data quality incidents, freshness alerts, schema change logs, monitored tables; `data_quality_test` item type indexed with monitor id, table, incident status, severity, first-seen-at; read-only; `montecarlo.incident.acknowledge` / `montecarlo.incident.resolve` behind HITL ✅ (Slice 7: 7a 2026-06-13, 7c 2026-06-14)
- [x] **Bigeye** (SSO) — data quality metrics, SLA breaches, monitored schemas, anomaly records; `data_quality_test` item type; read-only; `bigeye.issue.acknowledge` / `bigeye.issue.resolve` behind HITL ✅ (Slice 7: 7a 2026-06-13, 7c 2026-06-14)

#### Shared Workflows & Policy

- [ ] **Team-owned workflow pipelines** — pipelines in a shared namespace; any team member can trigger; write steps require HITL from the triggering user; no credentials embedded in pipeline YAML. **Deferred out of Phase 6** (2026-06-18) — the federated-invoke (I19) + quorum (I21) + org-policy (I22) substrate it needs all shipped, but the shared-pipeline authoring surface itself belongs with the automation-template library, which the spine overlay puts in **S4** (see [Phase 7+ Sequencing Spine](#phase-7-sequencing-spine)).
- [x] **Team "Huddle" Briefing** — aggregate morning briefing summarizing team achievements across PRs, tickets, and incidents without manual status reporting ✅ (Slice 6a: 2026-06-11 — `agents.huddle` / `nimbus huddle`)
- [x] **Tribal-knowledge extraction** — agent watches Slack / Teams for repeated questions ("how do I deploy X?") and proactively suggests saving the answer to a shared Notion / Confluence page or as a Phase 7 Wave 4 automation template; upstream pattern detector that feeds the automation library ✅ (Slice 6c: 2026-06-12 — `nimbus tribal`, V39 `tribal_clusters`, owner-HITL KB capture to a config-pinned destination, invariant **I25** / static **D19**)
- [x] **Cross-team blast-radius pre-flight** — before merging a PR, the upstream service owner's agent sends a "preflight request" to the agents of downstream service owners; downstream agents simulate the change against their local integration tests / environments only after the downstream owner approves via their HITL queue (no auto-execution on the upstream owner's say-so); aggregated results return to the upstream PR; stops cascading failures across team boundaries without a centralised staging environment ✅ (Slice 6b: 2026-06-12 — `agents.preflight` / `nimbus preflight`, downstream owner's local HITL + local-config-only command resolution, invariant **I24** / static **D18**)
- [x] **Org-level policy engine** — `nimbus.policy.toml` enforces: connector allowlists, `retentionDays` floor, HITL threshold overrides, audit log shipping destination; interacts with per-user profile config from Phase 3.5 *(Slice 4: signature-verified `nimbus.policy.toml` (Ed25519 over canonical bytes) → `PolicyGate` resolves a monotonic-stricter `EnforcedPolicy`; V36 `org_policy_state` + `policy_anchor_pin`; invariant **I22** / static **D16**)*
- [x] **Policy enforcement at the Gateway** — policy loaded on startup; connectors not in the allowlist disabled before the mesh starts; violations logged to audit trail *(Slice 4: connector allowlist + retention floor + quorum/HITL resolver all read `EnforcedPolicy` (fail-closed to last-valid/baseline); distributed via `federation.policy` serve + pubkey pinning + `nimbus policy trust`, with an audit-log shipper)*

#### ChatOps

- [x] **Bidirectional Slack/Teams bot** — team members interact with the shared Nimbus Gateway via `@nimbus` in a channel; read queries (`@nimbus who's on call for payment-service?`) answered from the shared index; write commands (`@nimbus run deployment.rollback service=payment-service version=v1.4`) route to the HITL queue of the appropriate team member before executing — the bot never bypasses the consent gate
- [x] **HITL via Slack/Teams** — pending HITL approvals surfaced as interactive Slack/Teams messages; approver clicks Approve/Reject in-channel; decision recorded in audit log with approver identity; deep link to the full approval context
- [x] **Notification routing** — watcher alerts and incident summaries optionally routed to a designated Slack/Teams channel; configurable per watcher rule and per team namespace
- [x] **Bot security model** — bot token stored in Team Vault; bot can only act on behalf of the requesting user's authorised scope; channel-to-namespace mapping enforced in policy; no bot command can exceed the requesting user's permission level

#### Admin & Observability

- [x] **Admin console** — web UI served locally by the Gateway: user list, namespace health, connector status across the team, audit log viewer, policy editor *(Slice 4: dependency-free static console — `packages/admin-console`, served bearer-gated at `GET /admin/*`; backed by `admin.status` (a `GatewayStatus` snapshot from the new `status/` subsystem) + `policy.show` + `team.auditMerged`)*
- [x] **Team audit log** — federation events appended to each member's local audit log; owner can request a merged view *(Slice 4: `team.auditMerged` IPC + the `federation.auditExport` audit-log shipper)*
- [x] **GDPR/compliance at org level** — `nimbus team purge --user <id>` removes a user's contributions from all shared namespaces; writes a signed deletion record *(Slice 4: `team.purge` orchestration over the V37 `gdpr_purge_job` + `gdpr_purge_request` ledger; HITL-gated `federation.purge` serve emits signed deletion records, with sync-cycle retry)*

#### Share & Virality Primitives

The project lacks viral primitives today. The federation channel + audit chain + signed-output infrastructure already shipped in Phase 4 / Phase 11 are exactly the substrates needed; this section is the user-facing surface.

- [x] **`nimbus share <session-id> [--redact <patterns>] [--expires <duration>]`** — produces a **signed, redacted, content-addressed** transcript of a Nimbus session. Default redaction strips: vault key names, email addresses, internal hostnames, Slack handle prefixes, credit-card patterns, JWT-shaped strings, IP addresses; explicit `--redact` patterns add more. The transcript is signed with the Gateway's Vault-only share-signing Ed25519 keypair (`share.signing.privkey`) so anyone with the matching pubkey can verify the share was not doctored after publish. Output options: write to a local `.nimbus-share.json` file, upload to a configurable HTTP endpoint (default off — only enabled if the user explicitly configures one; no Nimbus-hosted relay), or publish through the sovereign mesh to a paired peer. Audit-logged on the local Gateway with the redaction-pattern set actually applied (so the user can later prove what was and wasn't shared). ✅ (Slice 8 Wave 8a: 2026-06-15 — `nimbus share create`, default+caller redaction, owner-approved preview via the `share.publish` HITL action, Ed25519-signed, V41 `share_records`; invariant **I27** / static **D21**)
- [x] **Verify-share CLI primitive** — `nimbus verify-share <file-or-url>` checks the signature against the origin Gateway's published share-signing pubkey; the same `eaf-verify`-shaped binary primitive shipped in the S — Standards track. Lets a reviewer drop the binary in their CI to validate user-shared snippets before incorporating into a sales / community / academic write-up. ✅ (Slice 8 Wave 8a: 2026-06-15 — `nimbus verify-share <file|url>` checks the body signature against the origin gateway's pubkey)
- [x] **Sovereign-mesh referral** — when paired peers share a brief via the federation channel, the receiving end sees an attribution chip on the brief ("forwarded from Asaf's Gateway, 3 hops away"); receivers without Nimbus see a one-line install prompt embedded in the encrypted envelope (only revealed after their *own* paired Gateway decrypts it on first install — no plaintext bootstrap). P2P viral primitive that's a strictly opt-in pull, not a push. ✅ (Slice 8 Wave 8d: 2026-06-18 — `nimbus share forward` / `share inbox` over the federation wire, immutable provenance hop-chain + attribution chip, deferred reveal on first pairing, V43 `share_inbox`; receiving is inert)
- [x] **`nimbus share <session-id> --as-recipe`** — flag on the share command that strips the conversation entirely and emits only the **declarative workflow** the user followed (which connectors were queried, which graph traversals ran, which thresholds triggered) as a YAML "recipe" file that can be applied to any other Nimbus installation. Closes the `nimbus recipes` near-term initiative item by giving recipes a natural origin point — every successful session is a candidate recipe. ✅ (Slice 8 Wave 8b: 2026-06-17 — deterministic, LLM-free declarative tool-call DAG rebuilt from the session's logged tool calls, V42 `tool_call_log.params_json`)
- [x] **Audit-replay of a received share** — `nimbus verify-share <file|url> --replay` reruns the shared session locally against the receiver's own indexed data and shows where the answers diverge. Sales-prop: "watch what Nimbus did on Asaf's data run on yours." Catches "this only works for Asaf because he has X connector" issues. ✅ (Slice 8 Wave 8c: 2026-06-17 — delivered as `nimbus verify-share <file|url> --replay`; deterministic, LLM-free, read-only enforced by a POSITIVE allowlist — a non-read tool is skipped, never executed)

<a id="deferred-from-phase-5"></a>

#### Deferred from Phase 5

Items moved here from Phase 5 per the T1 sequencing spec. Read-only counterparts of split items remain in Phase 5.

##### Browser & Reading

- [x] **Web clipper (gateway side)** ✅ delivered 2026-06-22 — the Chrome+Firefox MV3 extension (Plan B, separate) clips the readable article or a text selection into the local index as `nimbus:web_clip` items via `POST /v1/clips` (I13); the extension's on-demand "sidecar" overlay (Plan B) reads related local items via the gateway route `POST /v1/clips/related`; pairing-handshake auth (`nimbus clip pair`/`status`/`revoke`) mints a labeled Vault token behind new invariant **I30** (fail-closed pairing window). Clips surface in `nimbus search` alongside Drive files and emails. The `nimbus clip list` / `clip delete` management commands followed 2026-07-16, and a per-route body cap so real articles fit under the I13 write-surface limit on 2026-07-19
- [x] **Web clipper (browser extension, Plan B)** ✅ delivered 2026-07-19 — the Chrome + Firefox **MV3** extension ships from its own repo [`nimbus-agent/nimbus-web-clipper`](https://github.com/nimbus-agent/nimbus-web-clipper) (MIT; mirrors the `nimbus-vscode` satellite repo), released as `v0.1.0`. Readable-article extraction (Mozilla Readability) or selection capture → `POST /v1/clips`; the on-demand Shadow-DOM "sidecar" panel → `POST /v1/clips/related`; owner-consented pairing by redeeming the `nimbus clip pair` 6-digit code at `POST /v1/clips/pair/confirm` (I30). Beyond the gateway contract it adds an offline retry queue, connection management (pairing status + unpair), and quick-clip context-menu / keyboard entry points. **Loopback-only by design** — `host_permissions` are `http://127.0.0.1/*` + `http://localhost/*`, no remote hosts, no telemetry. Tag-driven publishing to the Chrome Web Store + Firefox AMO is wired; **the live store listings await their one-time account bootstrap** (sideload / dev-load works today)
- [x] **Mendeley** — index whitepapers, PDFs, and citations alongside technical docs; `reference` item type; read-only (✅ delivered 2026-06-14; reuses the `reference` item type, read-only)

##### Email & Calendar (macOS-only)

- [x] **Apple Mail + iCloud Calendar** — ✅ **delivered 2026-06-21** (Slice 9 Wave E, connector `apple`; originally scoped as "macOS Calendar", delivered as iCloud Calendar over CalDAV — cross-platform). iCloud Mail via IMAP (`imap.mail.me.com:993`); iCloud Calendar via CalDAV (`caldav.icloud.com` → per-account `p##-caldav.icloud.com`); calendar events indexed as `apple:event` items, mail as `apple:email` items with a ≤2000-char preview (metadata-only — no bodies/attachment bytes); `apple_calendar_event_create` / `apple_calendar_event_delete` + `apple_mail_send` / `apple_mail_draft_create` behind the executor I2 HITL gate (forced `From`); two Vault keys (`apple.icloud_email` / `apple.icloud_app_password`). **macOS-only label relaxed → cross-platform** — the IMAP/CalDAV transport has no native macOS dependency, so the connector ships and is tested on Windows/macOS/Linux. See [`CHANGELOG`](./CHANGELOG.md#2026-06-21).

##### HR

- [x] **Workday** — time off, headcount, org chart, job postings; read-only where API access allows. Lifted to Phase 6 because typical Workday tenancy is org-wide and pairs naturally with team identity / SSO already landing in this phase (✅ delivered 2026-06-21; read-only; REST workers/time-off/job-postings + RaaS reports; directory-safe PII allowlist; no migration/HITL/invariant)

##### GitOps (Write Tools)

- [x] **ArgoCD writes** ✅ delivered 2026-06-21 (Slice 9 W1) — `argocd.app.sync`, `argocd.app.rollback` behind HITL (I2); personal + I19 team credentials; I26/D20 generalized to all connector writes (see [`docs/CHANGELOG.md`](./CHANGELOG.md))
- [x] **Flux writes** ✅ delivered 2026-06-21 (Slice 9 W1) — `flux.kustomization.reconcile`, `flux.helmrelease.reconcile` behind HITL (I2); reconcile via the `reconcile.fluxcd.io/requestedAt` annotation PATCH (needs the SA's `patch` RBAC verb)

##### ML/AI (Write Tools)

- [x] **MLflow writes** ✅ delivered 2026-06-21 (Slice 9 W1) — `mlflow.model.promote`, `mlflow.model.transition_stage` behind HITL (I2); `POST /api/2.0/mlflow/model-versions/transition-stage` (promote defaults `archive_existing_versions=true`)
- [ ] **SageMaker writes** — `ml.endpoint.update`, `ml.endpoint.delete`, `ml.job.stop` behind HITL. **Remains deferred** — CLI-credential connector (reuses the shared AWS `_lib/aws-cli.ts` creds; no discrete token), so it does not fit the team-vault/discrete-token write model the Slice 9 W1 write path is built on; S5-demoted.
- [ ] **Vertex AI writes** — `ml.endpoint.update`, `ml.pipeline.cancel` behind HITL. **Remains deferred** — CLI-credential connector (reuses the gcloud CLI / GCP creds; no discrete token), so it does not fit the team-vault/discrete-token write model the Slice 9 W1 write path is built on; S5-demoted.

##### Marketplace v2 Monetization

- [ ] **Paid extensions** — license-key enforcement via local validation; revenue sharing to publisher; depends on Marketplace v2 ratings/reviews/verified-publisher work landing in Phase 5 T2

#### Acceptance Criteria

> **Status: ✅ all criteria satisfied (2026-06-18).** Slices 1–5 (2026-06-05 → 2026-06-09) cover the federation, identity, Team Vault/quorum, org-policy, and ChatOps criteria; Slice 6 (6a 2026-06-11, 6b/6c 2026-06-12) closed cross-colleague intelligence; Slice 7 (Waves 7a–7c, 2026-06-13/14) closed the cross-warehouse lineage criterion; Slice 8 (Waves 8a–8d, 2026-06-15 → 2026-06-18) closed Share & Virality. Slice 9's deferred-from-Phase-5 backlog continued past the phase close (through 2026-07-19) and carries no acceptance criterion of its own.

- Two Nimbus instances on the same LAN establish a federated namespace in under 60 seconds with no external server involved ✅ (Slice 1)
- A team member's HITL approval on a shared workflow is recorded in both the approver's and the workspace owner's local audit log ✅ (Slice 2)
- Revoking a peer's federation access removes their read access within one sync cycle; no data retained on their machine after revocation ✅ (Slice 1)
- An org policy disallowing the Slack connector prevents `nimbus connector auth slack` from succeeding on any member's machine while the policy is active ✅ (Slice 4)
- A `@nimbus rollback` command issued in Slack routes to the on-call engineer's HITL queue and does not execute until they approve; the approval is recorded in the audit log with their identity ✅ (Slice 5)
- Cross-warehouse lineage query `nimbus ask "why is the Q1 revenue Tableau dashboard stale?"` resolves the chain Tableau view → Looker view → dbt model → Snowflake table → Airflow DAG → failing PR from the local index in under 500 ms; no live warehouse or BI API call is made during the query ✅ (Slice 7 Wave 7a: 2026-06-13 — V40 lineage edges + `normalizeDataModelKey` convergence, served entirely from the local index)
- A federated query for an item type outside the peer's declared sharing scope returns empty and is recorded as a rejected query in the answering Gateway's audit log; revoking a peer's scope stops further answers within one sync cycle ✅ (Slice 1)
- A quorum-gated action (e.g. `terraform destroy`) does not unlock its Team Vault credential until two distinct federated peers approve within the configured window; a single approval leaves the credential locked and logs the partial approval ✅ (Slice 2)
- Expertise routing returns a ranked peer list for "who knows `auth.ts`?" without transmitting any indexed item content from the answering peers — verified by asserting the federated response payload contains only ranks, not item bodies ✅ (Slice 1)

---

## Active

### Spine S1 — Local Brain

> **Status: in progress (opened 2026-06-20).** Phase 6 closed 2026-06-18. From here the build order is the [Phase 7+ Sequencing Spine](#phase-7-sequencing-spine) overlay (Track 1: **S1 → S5**) rather than the phase numbers — the numbered sections under [Planned](#planned) stay the canonical *detail* for each item; this section says what is being built *now*.

**Goal (S1 — Local Brain):** the highest-stickiness, mostly-cheap increment that needs **no new connectors** — implicit-knowledge agents over the already-indexed graph, plus the provable-boundary primitives that anchor the moat early.

**Delivered so far**

- [x] **Egress ledger + `nimbus prove`** ✅ 2026-06-20 (#698) — the always-on, append-only, BLAKE3-chained ledger of every authorized outbound action, appended from the executor chokepoint before `connectors.dispatch` (invariant **I29** / static **D22**; schema **V44** `egress_ledger`), with `nimbus prove` / `nimbus egress [verify|prune]`. Pulled forward from Phase 8 (M7) + Phase 7 Wave 6 per the spine overlay. Auditor-grade portable per-answer receipts stay in Phase 12.5 / Phase 22.
- [x] **Research briefs (gateway surface)** ✅ 2026-07-22 — an owner-triggered multi-source research pass over the already-indexed graph: `POST /v1/briefs` opens a run, `POST /v1/briefs/{id}/sources` feeds captured articles into in-memory-only run state (source bodies never touch disk; a restart drops in-flight runs), `POST /v1/briefs/{id}/run` synthesizes a citation-validated report (quotes verified against the captured sources, typed `synthesis: {model, remote, disclosure?}` provenance), and `POST /v1/briefs/{id}/save` persists the finished report to the local index (`nimbus:research_brief`, joining `PROSE_HEAVY_TYPES`). Four new I13 write routes plus a bearer-gated `GET /v1/briefs/{id}` (`WRITE_ROUTE_ALLOWLIST` 8 → 12); the run-concurrency cap fails closed with `503 briefs_busy` (deliberately not `429` — no `Retry-After` that could be honored). `[briefs]` is default-off in `nimbus.toml`; `nimbus clip status` reports the enable-state so a paired user isn't surprised by a 404 on their first brief. No new invariant, no migration. Spec: [`docs/superpowers/specs/2026-07-21-research-briefs-design.md`](./superpowers/specs/2026-07-21-research-briefs-design.md); plan: [`docs/superpowers/plans/2026-07-21-research-briefs-gateway.md`](./superpowers/plans/2026-07-21-research-briefs-gateway.md).

**Remaining in S1**

- [ ] **Implicit-knowledge agent triad** — `nimbus why` / `glossary` / `decisions` (+ `pre-mortem`, `negotiate`), pulled forward from Phase 7 Wave 5; see [Phase 7 — Engineering Excellence](#phase-7--engineering-excellence) for the full definitions
- [ ] **Answer-quality surfaces** — devil's-advocate mode, agent-persona configuration, first-class negation + aggregation queries (Phase 7 Wave 6)
- [ ] **Ownership graph from already-indexed data** — service/code ownership derived from the existing GitHub + PagerDuty index; dedicated IDP connectors (Backstage et al.) stay demoted to S5

**Started, currently parked (S3 — Open Surface, harvested early)**

- [ ] **Nimbus as a local MCP *server*** — expose the private index as an MCP endpoint that Claude Code / Cursor / other agents connect *to*; stdio transport by default (no network port). Design + Wave 1 plan landed on `dev/asafgolombek/phase7-mcp-gateway-server` (last commit 2026-06-18); the branch is **parked**, not abandoned. Invariant **I28** stays reserved for its owner-sink and is reconciled against the I29/I30 ceiling at merge.

**Recently landed alongside the spine** (not S1 features — platform/distribution harvest): the web clipper's browser extension (satellite repo, 2026-07-19), the `@nimbus-dev/sdk` + `@nimbus-dev/client` npm extractions, the installer/distribution program, and the release-health + GitHub-App CI hardening. Dated detail: [`docs/CHANGELOG.md`](./CHANGELOG.md).

---

## Planned

### Phase 7+ Sequencing Spine

> **Status: the live build order (overlay added 2026-06-17; in force since Phase 6 closed 2026-06-18).** The current slot is **[S1 — Local Brain](#active)**, whose egress-ledger primitive shipped 2026-06-20. This section re-sequences everything from Phase 7 onward for **time-to-value × differentiation (moat)** without renumbering. Phase *numbers* below stay stable (the doc cross-links them everywhere); this overlay defines the real **build order** as three tracks and pulls the cheap moat primitives forward. Design rationale: [`docs/superpowers/specs/2026-06-17-roadmap-phase7-plus-resequence-design.md`](./superpowers/specs/2026-06-17-roadmap-phase7-plus-resequence-design.md).

**Why an overlay, not a renumber:** the deepest-moat work (Verifiable Negatives, the Unexfiltratable Agent, Provable Governance — things a cloud relay *structurally cannot* do) sat at Phases 22–26, behind ~14 phases of connector breadth, even though several of their *primitives* are cheap. The biggest 2026-model lever (computer-use, code execution, runtime tool-gen — Phase 14) sat mid-list. And one linear list conflated near-term product with a long-range research manifesto. The fix is to **harvest cheap primitives early** and split the list into three tracks.

#### Track 1 — The Near-Term Spine (build order S1 → S5)

Ordered for time-to-value × moat. Each increment cuts across today's phase numbers. `[↑P<N>]` = pulled forward · `[↓demote]` = pushed back · `[NEW]` = net-new idea.

| Spine | Theme | Contents | Why here |
|---|---|---|---|
| **S1** | **Local Brain** | `nimbus why`/`glossary`/`decisions`/`pre-mortem`/`negotiate` [↑P7 W5]; devil's-advocate, agent personas, first-class negation + aggregation queries [↑P7 W6]; ownership graph from already-indexed GitHub/PagerDuty (IDP connectors deferred [↓demote]); **elevate the egress ledger (P8 M7 substrate) + `nimbus prove` (P7 W6) to an always-on S1 primitive** [↑P8 / P7 W6] — ✅ **shipped 2026-06-20** (I29/D22/V44) | Highest stickiness, mostly cheap, **no new connectors**; anchors the provable-boundary moat early and co-locates the ledger with its `prove` surface (removing the pre-existing P7-reads-P8 ordering oddity). P22's portable per-answer receipts sit on top later. |
| **S2** | **Local Compute Fleet** | Sandboxed code execution, local computer-use loop (HITL-gated, screenshots never leave), runtime tool generation, multimodal I/O [↑P14]; **[NEW] overnight sub-agent fleets on zero-marginal local compute** [↑P27]; **[NEW] bring-your-own-frontier-model routing with local fallback** | The biggest 2026-model lever; local computer-use + free local compute are both high-TTV *and* unfakeable by metered clouds |
| **S3** | **Open Surface** | **[NEW] Nimbus as a local MCP *server*** — expose the private index as an MCP endpoint Claude Code / Cursor / other agents connect *to*. **Defaults to stdio transport (no network port);** any HTTP/SSE variant must honor I6 loopback bind + I5 `LanServer` method checks + I10 constant-time pairing-token auth (write surface stays I13-gated). Marketplace registry [↑P9.5] + extension maturity | Ecosystem whitespace: makes Nimbus the private-context backend for the user's whole agent stack |
| **S4** | **Autonomous Agent** | **[NEW] Connector Write-Enablement [P9.7]** — the HITL-gated write surface the act-loop consumes (rides `I26`/`I29`/`I2`; framework-first, then productivity → code → infra by blast radius); watch → learn → act loop, proactive SRE automation, `incident-brief` [≈P10]; fold in the On-Call Copilot (predict/mitigate/coordinate) [↑P17] | Natural capstone of the spine; the interactive + standing halves of one loop — **inert without writes, so P9.7 is its foundation.** |
| **S5** | **Engineering Excellence breadth** | DORA/metrics connectors, feature-flag connectors [↓P7 W2–3]; security tooling + agents [↓P8]; ML/AI tooling [↓P9]; the deferred IDP/ownership connectors from S1 | Commodity, API-fakeable → **not a moat**; community/marketplace-leaning, demoted behind the spine |

**Shape:** S1–S3 are moat + 2026 levers (mostly cheap or model-driven); S4 is the capstone; S5 is fakeable commodity breadth that can lean on the community.

**Phase 7 Wave 4 (capstone) splits across slots** (it is not a single unit): the private-context pieces — cross-team knowledge graph, automation-template library, pattern recognition, ADR auto-drafter, living-architecture map — ride with **S1/S4** (the learn-and-act substrate); `nimbus excellence` + the excellence dashboard *render* the S5 commodity metrics, so they land with **S5**; the team-policy library composes with the Phase 6 policy engine (Track 2).

**Composes-with integrity:** because this is an overlay (numbers + prose unchanged), every existing "composes-with" cross-reference still resolves. Demotions only ever move a dependency *later relative to the spine*, never break a reference; the one promotion that touches cross-refs — the egress ledger — moves *earlier*, which only helps the P12.5 / P21 / P22 / P23 phases that build on it.

#### Track 2 — Scale & Surface

Productization/distribution; lands after the spine, much of it parallelizable, none of it research.

- **Independent-slot** (not spine-gated): Desktop Distribution [P13] — depends only on already-shipped Phase 4; land when adoption needs it.
- **Mobile Companion [P13.5]** — *not* freely independent: depends on Phase 11 (mesh addressing) + Phase 17's assembled-brief schema, so it slots after those.
- **Commercial/scale band** (depend on Phase 6 federation): Enterprise [P12], Platform Layer / Team-OS [P16], Cross-Org Federation [P15].
- **Compliance Receipts [P12.5]** — commercial-tier, but its prerequisites are Phase 8 (egress ledger) + Phase 9 + the EAF Standards track, **not** Phase 6 federation.
- **Opportunistic expansion surfaces:** Sovereign Mesh / multi-device + physical [P11], Vertical Personas [P18], Ambient Surfaces [P19] (already flagged highest-risk), Personal & Household Federation [P20].

#### Track 3 — Research Horizon

The North-Star "M-number" manifesto. The full vision stays; each entry's cheap *primitive* is harvested into the spine when ready. **Principle: a research frontier whose primitives we mine early — not phases reached in a decade.**

| Phase | Full form (stays Horizon) | Primitive → harvested |
|---|---|---|
| P22 — Proof Layer / Verifiable Negatives | Portable, offline-checkable **per-answer** EAF receipts | the always-on ledger + `nimbus prove` read-surface land early in **S1** (sourced from P8 / P7 W6, not P22 itself); only the per-answer receipts stay here |
| P27 — The Agent Society | Standing safe agent-organization | overnight local sub-agent fleet → **S2 (done)** |
| P23 — Inert to Injection (Unexfiltratable Agent) | Egress severed structurally on attacker-influenced turns + conformance bundle | candidate: egress-severing hook (pairs with S1 egress ledger) |
| P21 — Sovereign Trust Substrate | — | candidate: extract when S1 boundary work matures |
| P24 — Agent Archaeology / Causal Twin | Replay reasoning as-of any timestamp | candidate: signed derivation log (pairs with S1 ledger) |
| P25 — Confidential Mesh Compute | Operator-free cross-org learning (M4) | gated on Cross-Org Federation [P15] |
| P26 — Provable Governance | Policy compiled into the gate + boot attestation (M12) | candidate: compile a policy fragment into the `I2` gate |

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
- [ ] **Living architecture / legacy-code archeology** — point Nimbus at an undocumented codebase ("map this out") and it generates an interactive architecture model: Mermaid diagrams + a derived OpenAPI spec, correlated with live traffic patterns from the Datadog / observability connectors so the map reflects what actually runs, not just what's declared. A watcher keeps it **living** — when a route or resource changes, the agent drafts an HITL-gated commit updating the generated diagrams to match reality (composes with the ADR auto-drafter's draft-and-gate pattern above). Turns "inherit a 10-year-old monolith" from archaeology into a query.

#### Wave 5 — Implicit Knowledge Surfaces

A trio of read-only agents that turn the local index into the "shared brain" every engineering team thinks they have but doesn't. Each is buildable on the Phase 7 ownership graph + the Phase 3 relationship graph + the existing indexed connectors — no new connectors required, no new infrastructure. The leverage is exposing data that's *already* in the index but isn't yet queryable in a conversational shape. Single-user-first like the rest of Phase 7; Phase 6 federation makes each one richer.

- [ ] **`nimbus why <file>:<line> | <symbol>`** — for any source location: emits a brief explaining who wrote it (PR author + commit SHA + date), why (linked PR description + reviewer thread + linked Linear/Jira ticket + the Slack thread referenced in the PR if any), what incident or feature drove it (incident-correlation via Phase 3 graph + Phase 5 deploy annotation), and which downstream services depend on it. Effectively `git blame + context + ownership + impact` in one query. Read-only; emits `agents.why.briefReady`. Ships with a corresponding VS Code lens (`nimbus-vscode` extension reads the brief inline above the line on hover). Cloud agents can't do this — they don't see the team's private Slack threads or Linear tickets.
- [ ] **`nimbus glossary [<term>]`** — extracts and indexes domain-specific terminology from Slack threads + Confluence/Notion pages + Linear/Jira ticket bodies + ADRs + commit messages. New `glossary_term` item type with fields: `term`, `definitions` (the cluster of phrasings the team has used), `first_seen_at`, `last_seen_at`, `top_sources` (the 5 most-cited threads/docs that define it), `synonyms`, `near-misses` (terms confusingly similar). `nimbus glossary` with no argument prints a sorted-by-frequency list; with a term prints the consolidated definition. Onboarding accelerator: a new engineer asks "what does CDR mean here?" and gets the team's actual usage, not Wikipedia's. Generated via a periodic agent over indexed content (cheap; uses local LLM for the consolidation step, no live API call).
- [ ] **`nimbus decisions [--since <duration>] [--service <name>]`** — implicit ADR extractor. Identifies decisions buried in Slack/Notion/Linear threads using the pattern "we decided X because Y, alternatives were Z" + corroborates via downstream actions (the PR that implemented the decision, the migration file, the IaC diff). Output is a chronological list of decisions with confidence scores and evidence links. **Composes with M1 (Org's Living Memory)** — this is the read-side that makes M1 queryable. **Composes with the Wave 4 ADR auto-drafter** — when `nimbus decisions` finds a decision with no explicit ADR, it offers to draft one.
- [ ] **`nimbus negotiate [--cycle <quarter|year>] [--peer-benchmark]`** — agent assembles a compensation-conversation prep brief from already-indexed performance evidence: PRs merged + reviewed (count + complexity), incidents resolved with attributed authorship, deploys triggered without rollback, ADRs authored, on-call shifts (PagerDuty data), 1:1 themes from indexed Notion/Linear notes (with consent — the agent asks before reading 1:1 docs). Optionally `--peer-benchmark` pulls anonymized Phase 6 federated comp ranges when M4 is opted in. Output: Markdown brief with evidence-citation links, ready to copy into a self-eval form or share with a manager. Read-only; HITL doesn't apply because nothing is sent anywhere. The slightly-spicy framing puts Nimbus in conversations cloud agents are explicitly designed to stay out of.
- [ ] **`nimbus pre-mortem <epic-id>`** — when a new Epic is created (Jira / Linear), the agent analyzes similar historical epics across the index — and, when Phase 6 federation + the consent primitive are present, across the team mesh — to identify why comparable work was delayed or failed ("usually blocked on 3rd-party API rate limits"), then proactively schedules watcher alerts on those specific risks before they materialize. Brings the team's actual historical failure patterns to project planning instead of generic estimates. Read-only; emits `agents.premortem.briefReady`. Composes with the Phase 6 consent-scoped federated query primitive for the cross-team history.
- [ ] **Implicit-knowledge dashboard** — Tauri page combining a recent-decisions feed, the team's glossary growth curve, and the top-N hottest "why" queries from VS Code lens activations. Surfaces the institutional-memory signal without forcing an explicit query.

#### Wave 6 — Agent UX Upgrades

Cross-cutting UX improvements that apply to every agent surface the project ships. Bundled into a Phase 7 wave because Phase 7 is the natural home for "how the agent presents itself" work — Phase 7 is where the engineering-excellence framing collides with the everyday query shape.

- [ ] **Devil's-advocate mode** — `nimbus ask --devil` toggles a prompt-level mode that makes the agent argue *against* the user's plan, surfacing risks, edge cases, and alternative interpretations. Confirmation-bias antidote. Five-line prompt change; large practical value. Composes with the agent-honesty surfaces in Phase 9 Wave 6 — the calibration curve gets a separate column for devil's-advocate-mode confidence vs default-mode confidence so the user can see which mode the agent calibrates better in for their query class. When Phase 6 federation + the consent-scoped federated query primitive are present, `--devil` grounds its objections in the team's *real* history — past failed projects, production incidents, and post-mortems related to the proposed design ("this migration matches the one that took down prod in 2023") — rather than generic reasoning alone.
- [ ] **Agent personas** — extends the Phase 3.5 configuration profiles with a `[profile.<name>.persona]` block: `tone` (terse / formal / casual / verbose), `voice` (neutral / opinionated / first-person-plural), `confidence_threshold` (how often the agent volunteers "I'm not sure"), `tool_caution` (eager / measured / paranoid — affects HITL escalation defaults). Switching profiles via `nimbus profile switch <name>` already exists; this wave makes the persona configurable per profile so "work Asaf" can be terse + measured and "personal Asaf" can be verbose + opinionated.
- [ ] **First-class negation queries** — explicit support in `nimbus query` and `nimbus ask` for negation predicates ("PRs that *don't* touch tests," "deploys with *no* downstream incident," "engineers who *haven't* reviewed code this week"). The structured index already handles negation natively; LLMs are notoriously bad at it. Surfacing as a deliberate capability with documentation, examples, and a `--explain` flag that shows the SQL the structured side ran for transparency.
- [ ] **First-class aggregation-over-time queries** — explicit support for "how many X this quarter vs last," "rolling 7-day MTTR trend," "PR merge throughput by week for the last 90 days." Already possible via SQL but under-marketed. Ships with a `nimbus stats <metric> [--window <duration>] [--bucket <duration>]` CLI surface that's a thin wrapper over the structured query layer, returning ready-to-render time-series JSON.
- [ ] **`nimbus principles` + `nimbus prove`** — `nimbus principles` prints the seven non-negotiables from `CLAUDE.md` and which invariants (`I1`–`I16`) are currently wired with their last passing test ID. `nimbus prove [<query>]` runs an interactive proof mode: shows the egress ledger before and after a query so the user watches in real time that zero outbound calls occurred. Pairs with the killer demo's transparency surface and the M7 egress-ledger primitive.
- [ ] **"What's Nimbus doing right now?" tray item** — Tauri tray addition surfacing in-flight sync cycles, in-flight queries, pending HITL approvals, and the last-3 audit-log entries. Builds trust because users can *see* the agent isn't doing anything spooky in the background. One-day work; high every-user-every-day value.

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
- Wave 5: `nimbus why packages/gateway/src/engine/executor.ts:42` returns a brief naming the PR author, the linked Linear ticket, the incident that drove the change (if any), and the downstream service consumers from the relationship graph, all from the local index in under 10 s on a mid-range laptop
- Wave 5: `nimbus glossary <term>` returns the team's actual usage of the term across at least 3 source threads with first-seen / last-seen dates; the consolidated definition is generated by the local LLM with zero live API calls
- Wave 5: `nimbus negotiate` returns a Markdown brief with citation links covering at minimum: PRs merged + reviewed, incidents resolved, ADRs authored, on-call shifts — sourced only from data the user already has read access to in the source systems
- Wave 6: `nimbus ask --devil "ship the migration tonight"` produces a response whose risk surface explicitly contradicts the question framing — verified by an integration test that asserts the response contains at least 3 distinct counter-arguments
- Wave 6: switching `nimbus profile switch personal` then querying produces output with the persona-configured tone (terse vs verbose, etc.) — verified by an integration test that toggles persona mid-session and asserts the response shape changes
- Wave 6: `nimbus query --negate "pr touches tests"` returns the correct PR set (compared against a known fixture); the `--explain` flag prints the SQL that ran
- Wave 6: `nimbus prove "find my PRs this week"` shows the egress ledger before and after the query confirming zero outbound calls; the tray item flashes the in-flight query for the duration of the response
- Wave 4: pointing `nimbus` at an unfamiliar service produces a Mermaid architecture diagram + derived OpenAPI spec correlated with indexed Datadog traffic; a subsequent route change triggers an HITL-gated draft commit updating the diagram
- Wave 5: `nimbus pre-mortem PROJ-123` returns a brief naming at least 2 comparable historical epics, their delay/failure causes, and the watcher alerts it scheduled against the matching risks — all from the local index

---

### Phase 8 — Security Engineering

> **Sequencing (2026-06-17 overlay):** Build-order slot **S5** (Track 1) — demoted commodity. The connector surface is API-fakeable, so it is *not* a moat; lands behind the spine, community/marketplace-leaning. The built-in security *agents* may pull forward opportunistically. See [§ Phase 7+ Sequencing Spine](#phase-7-sequencing-spine).

**Goal:** Bring the security practitioner's tool surface into the local index and ship the four built-in security agents that turn that surface into actionable briefs. Read-first; every write tool gates on HITL with rich diff preview because security writes (acknowledging vulnerabilities, rotating secrets, suppressing findings) are decisions with downstream consequences.

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

#### Wave 3.5 — Contextual Dependency Intelligence

A focused wave dedicated to **a single agent that beats Dependabot/Renovate by being context-aware**. Dependabot's failure mode is well-known: it surfaces an upgrade as safe (semver-patch, no CVEs) when the user's own codebase or community-issue history would have flagged a regression. The local index makes Nimbus uniquely positioned to add that context.

- [ ] **`nimbus deps update [<pkg>] [--service <name>] [--json]`** — agent that for every open Dependabot/Renovate PR (read-only — surfaced via the existing GitHub/GitLab connectors), assembles a brief with:
  - Which files in the user's own codebase import the affected symbols (via the existing `code_symbol` table from the Filesystem v2 intelligence)
  - Whether the affected files were touched in the last incident (via Phase 7 ownership graph + Phase 3 incident-correlation graph)
  - Open GitHub issues against the target version of the package (via a one-time live fetch through the GitHub MCP — *only* for the package's repo, never the user's; explicitly excluded from M7 egress ledger background-call quota because the call is user-initiated)
  - Snyk / Wiz / Semgrep findings on the target version (via the Wave 1–2 connectors)
  - Compatibility risk against the user's own integration tests indexed in the local index (last passing CI run on a similar bump)
  - One-paragraph "you would have caught this before merging" verdict at the top
- [ ] **`deps-watch` watcher** — fires when a new Dependabot/Renovate PR opens AND `nimbus deps update` would have rated it >0.6 risk; surfaces in the morning briefing with the brief inline. Composes with Phase 7 Wave 1 ownership routing so the brief goes to the *team that owns the affected service*, not just the PR author.
- [ ] **`nimbus deps audit-history [<pkg>]`** — for a package, surfaces the user's own historical experience: every past version installed, how long each was deployed, whether any incidents tagged it. Stops "is this a flaky package?" from being a guessing game.
- [ ] **HITL stays at the merge boundary** — the agent never auto-merges; the deliverable is the brief, not the action. The user retains the merge button. Composes with the existing Phase 4 HITL gate.

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
- [ ] **Egress ledger (`nimbus egress`)** — the local, signed record of every outbound host contacted by the gateway and each sandboxed connector, built on the `I15` per-host network allowlist + the BLAKE3 audit chain; `nimbus egress [--since <dur>] [--json] [--sign]` emits a verifiable report ("this agent contacted only these hosts"). The North-Star **M7 (Provable Locality)** capability; the auditor-grade, externally-anchored export lands in Phase 12.

#### Wave 5 — Local Data-Handling & Credential Hygiene

The workstation-side complement to the cloud-facing waves above: keep tainted data and live credentials from leaking off the machine, using Nimbus's local position rather than network-level controls developers hate.

- [ ] **Taint-barrier data provenance** — Nimbus tags the provenance of indexed data; data originating from a production-database / PII connector carries a `tainted:prod-pii` marker. Enforcement is **local and context-aware, not a browser DLP proxy**: a Git pre-commit / pre-push hook (and the workflow executor) block committing tainted data to a repo, with an HITL override that is audit-logged. The realistic, shippable half of the original "block paste into ChatGPT" concept — the git/commit boundary is where Nimbus can actually enforce.
- [ ] **Provenance-aware HITL escalation** — extends the executor's HITL gate (`I2`): when an action's inputs carry a `tainted:prod-pii` provenance marker, the gate auto-escalates the required tier (a normally-single-approval action demands quorum; a normally-silent action demands explicit consent). Wires data provenance straight into the existing structural consent gate instead of a separate enforcement path — the taint travels with the data into the approval decision.
- [ ] **Just-in-time ephemeral credentials** — when a workflow needs a privileged credential (e.g. a prod-DB connection), Nimbus requests a short-lived JIT credential from the backing secret store (HashiCorp Vault dynamic secrets / cloud STS) and injects it via an **env-scoped child process** (`extensionProcessEnv()`, `I1`) for that operation only — never the local disk, never the clipboard, **not** raw process-memory injection — then the credential expires / is revoked when the operation ends. Achieves the "credential never persists" goal through the spawn-scoping Nimbus already enforces.
- [ ] **`nimbus panic` — emergency revoke** — one command, the mesh kill switch: revoke all federated peer grants, rotate the LAN pairing keys, and disable the HTTP write surface in a single audited operation. Composes with the Phase 6 federation revoke path (per-peer revoke is the granular form; `panic` is the all-at-once form) and the `I13` write-surface toggle. For "my laptop may be compromised — sever everything now."

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
- Wave 3.5: `nimbus deps update` on a seeded open Dependabot PR assembles a brief naming the affected source files in the user's own codebase, the relevant open issues against the target version, the matching Snyk/Semgrep findings, and the historical incident correlation — all in under 15 s from the local index plus one user-initiated GitHub MCP call
- Wave 3.5: the `deps-watch` watcher fires on a controlled test (a Dependabot PR for a known-regression version) and routes the brief to the affected service's owner team via the Phase 7 Wave 1 ownership graph; the agent never auto-merges
- Wave 5: a commit containing data tagged `tainted:prod-pii` is blocked by the pre-commit hook; the override path requires explicit HITL and writes the override to the audit chain
- Wave 5: an action whose inputs carry a `tainted:prod-pii` marker triggers a higher HITL tier than the same action on untainted inputs — verified by an e2e test asserting the escalated consent prompt fires
- Wave 5: `nimbus panic` revokes every federated peer grant, rotates the LAN pairing key, and flips the write surface to disabled in one operation; a subsequent peer query and a subsequent HTTP write both fail, and the whole sequence appears in the audit log

---

### Phase 9 — AI Engineering Loop

> **Sequencing (2026-06-17 overlay):** Build-order slot **S5** (Track 1) — demoted commodity (API-fakeable ML/AI connector breadth). The `nimbus model-health` / `rag-health` agents may pull forward; the connector ingestion lands behind the spine. See [§ Phase 7+ Sequencing Spine](#phase-7-sequencing-spine).

**Goal:** Bring the tool surface that ML engineers and AI-product teams already use into the local index, and ship `nimbus model-health` + `nimbus rag-health` to surface actionable status without a live API call. Read-first for ingestion; HITL on the few write tools (`prompt.deploy`, `model.promote-stage`, `feature.publish`) because pushing a prompt or promoting a model is a production change.

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
- [ ] **Model-weight integrity** — optional digest pinning / signature verification of local GGUF weights, reusing the existing SHA-256 / Ed25519 machinery; `nimbus llm verify`; pin known-good digests in config. Two modes: **`warn`** (default — log drift, continue) and **`strict`** (fail-closed — refuse to load the model / run inference on a verification mismatch). Because a substituted model is a total compromise of the agent's reasoning, `strict` is the recommended posture for security-sensitive deployments and can be pinned fleet-wide via the Phase 16 team baseline / Phase 12 org policy. Closes the "Local model supply chain" residual risk in [`SECURITY.md`](./SECURITY.md); becomes a structural invariant (wiring + invariants-file row + enforcement test) only once wired.

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

#### Wave 5 — Extension Eval Framework (Marketplace prerequisite)

This wave delivers the **author-facing eval surface** that the Phase 9.5 Marketplace consumes as the quality column. Scoped narrowly to *extension authors*, not to end users — per-user calibration UIs are explicitly deferred until the post-Phase 9.5 install base supports statistically meaningful per-user sample sizes. The framing is **transparency, not comparison**: there are no "cloud equivalent cost" numbers (legally risky, gameable, and the providers reprice faster than we can chase). The framing is "here's what this extension scored against its own evals on a reproducible harness."

- [ ] **`nimbus eval` CLI + runner** — `nimbus eval [--extension <id>] [--suite <path>] [--json]`. Reads `evals/*.yaml` from the extension's package root (a frozen schema with `name`, `input`, `expected`, `rubric`, `weight` fields), runs each case against the extension's MCP tool surface inside the same sandbox the gateway uses at runtime (`I15`), and writes a deterministic numeric score plus a per-rubric breakdown. Output format is the canonical input to the marketplace quality column.
- [ ] **Eval schema in `@nimbus-dev/sdk`** — frozen at SDK v1.1.0 (additive minor bump, no breaking change). Authors `import { defineEvalSuite } from "@nimbus-dev/sdk/eval"` and get a typed schema with editor autocomplete. Schema covers deterministic rubrics (string match, JSON shape match, set membership) only in v1; LLM-as-judge rubrics are a v1.2 follow-up (gated on a regression study against the deterministic baseline).
- [ ] **Registry-side reproducibility check** — the Phase 9.5 publish hook re-runs `nimbus eval` in a fresh registry-side sandbox against the author-declared suite and verifies the score matches what the author submitted (within rounding). Mismatches reject the publish. Closes the "authors ship evals that pass for them but not anyone else" attack vector.
- [ ] **Quality score persistence** — score + per-rubric breakdown stored as a signed field in the manifest at publish time; the gateway carries it in the extension registry table; the Tauri marketplace tile reads it directly with no live registry call. Score is part of the `I16`-signed manifest, so it cannot be tampered post-publish.
- [ ] **Local quality regression test for end users** — `nimbus eval --installed` runs every installed extension's declared suite against the local environment. Useful for the user who wants to confirm an extension still scores what the marketplace claimed when their local connectors are configured. Exit code 1 on a configurable regression threshold; integrates with the auto-update HITL prompt (see Phase 9.5 "Quality regression watcher").
- [ ] **Built-in agent eval suites** — the first-party `expert`, `impact`, `catchup`, `oncall`, `meeting-prep`, `standup`, `model-health`, `rag-health` agents ship with `evals/*.yaml` of their own. The CI gate runs them on every PR and refuses regressions beyond a threshold (default 5 points). The agents are dogfooding the framework before the registry hook does.
- [ ] **Transparency-framed cost surface (not comparison)** — every brief output by the built-in agents carries a footer: `tokens: <local-count>, outbound: <count> calls, time: <wallclock-ms>`. **No "cloud equivalent" numbers** — the framing is "here's what we used," not "here's what a different product would have charged." Easy to add later if competitive framing becomes a deliberate marketing choice; safer to omit by default.

#### Wave 6 — Agent Honesty Surfaces

User-facing trust surfaces. "AI safety" as a product feature, not a marketing word. The framing is: every time the agent runs, the user accumulates evidence about *this specific Nimbus instance's behaviour on their data*. Phase 9 turns that evidence into legible surfaces. None of these are possible for cloud agents at the per-user level because cloud agents don't have an honest record of refusals + per-user calibration + per-user bias signals.

- [ ] **Calibration audit (`nimbus audit calibration [--since <dur>]`)** — for every agent claim that carried a confidence score, the audit looks at whether the user subsequently corrected, retried, or rejected the result, and computes a personal calibration curve (claimed vs observed). Output: 2-D scatter plot (Tauri dashboard) + numeric Brier score + per-agent breakdown (`expert` calibrates better than `impact` on this user's data, say). Calibration curve is also exposed to the router so the router can demote agents whose confidence is over-stated for this user.
- [ ] **Bias detection diagnostics** — analyzes the agent's output history for systematic skews on this user's queries. Catalog of detectors in v1: (a) reviewer-recommendation gender skew (compares the gender-detected suggested reviewer rate vs the team's actual rate), (b) recency-over-relevance skew (compares how often the agent's top result is the most-recent vs the actual highest-ranked by other signals), (c) seniority-attribution skew (does the agent attribute decisions to senior engineers when ownership graph shows otherwise), (d) service-coverage skew (the agent under-surfaces results from connectors with lower volume even when relevant). Output is a diagnostic per user — not a fix, just transparency. Cloud agents cannot offer this honestly because the diagnostic depends on the user's own ground-truth correction history.
- [ ] **Refusal log** — every time the agent refuses to do something (insufficient context, low confidence, HITL not granted, missing connector, prompt-injection guard fired), the refusal is logged with reason code + the originating query + the would-be tool call. `nimbus audit refusals [--since <dur>]` surfaces the log. Lets the user contest a refusal ("the agent refused to give me X — why?") and feeds the bias detector. Many cloud agents *silently* refuse or substitute a generic answer; visible refusals are a Nimbus differentiator.
- [ ] **`nimbus audit replay <session-id>` honesty extension** — extends the M3 replay format to include refusal events + confidence-score evolution across the session (where did the agent's confidence climb, where did it dip), so the replay is not just "what did the agent do" but "what did the agent *think it knew* and how did that evolve."
- [ ] **Confidence-rebuilds-trust loop** — when the user corrects an answer (via the existing "wrong answer" one-keystroke feedback), the calibration curve updates, and the router uses the new calibration to lower the agent's claimed confidence on similar queries. The loop is **personal and local** — no aggregation, no fleet learning, no surveillance.
- [ ] **`[ai_engineering.honesty]` config block** — opt-out toggle (default on) for the calibration tracking. Privacy-conservative default: honesty surfaces operate on data the user could already see in their own audit log; nothing new is collected; the surfaces are *views* of existing data.

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
- Wave 5 reproducibility gate: `nimbus eval --extension <id>` against a sample first-party extension produces the same numeric score (within rounding) inside a fresh sandbox as the score persisted in that extension's signed manifest at publish time — verified by an integration test that publishes a test extension, fetches it back, runs `nimbus eval`, and asserts equality. This is the property Phase 9.5's registry-side reproducibility check depends on.
- Wave 5 built-in-agent CI gate: the first-party `expert`, `impact`, `catchup`, `oncall`, `meeting-prep`, `standup`, `model-health`, `rag-health` agents each ship with an `evals/*.yaml` suite; the CI gate refuses PRs that drop any agent's score by more than 5 points.
- Wave 6: `nimbus audit calibration` against a seeded session history (100 user corrections across 5 agents) produces a per-agent Brier score and renders a 2-D calibration scatter in the Tauri dashboard
- Wave 6: the bias-detector diagnostic against a controlled fixture (seeded reviewer-recommendation history with a known skew) correctly identifies the gender / recency / seniority / coverage axis the skew is on, with no false positive on a balanced fixture
- Wave 6: `nimbus audit refusals` lists every refusal of the seeded session with reason code and originating query; contesting a refusal (`--contest <refusal-id>`) opens the would-be tool call for the user to inspect

---

### Phase 9.5 — Marketplace Registry

**Goal:** Turn the connector + extension ecosystem into a discoverable, trustworthy, quality-scored economy without yet operating a payment processor. The v0.1.1 trigger "5 seed community extensions in the registry" is elevated to a full phase because the marketplace is the **ecosystem flywheel** that compounds every other piece of work — once authors are publishing, every new SaaS the world produces becomes a Nimbus connector within days. Payments wait until install base is large enough to support author rent (post-Phase 12); this phase ships the **registry, the quality layer, and the trust layer** only.

> **Composes with Phase 9 (AI Engineering Loop):** quality scores in the marketplace listing are produced by the **`nimbus eval` framework** delivered in Phase 9 Wave 5 — see [§ Phase 9 → Wave 5](#phase-9--ai-engineering-loop). Wave 5 is a hard prerequisite delivered in the immediately preceding phase, so the marketplace UI consumes its quality scores from day one.
>
> **Composes with the S — Standards track:** registry-published extensions carry a Signed Connector Manifest produced by the same `I16` Ed25519 chain the Gateway already enforces at install + startup. The published manifest schema is the reference implementation for the SCM artifact in the [§ S — Standards (cross-phase)](#s--standards-cross-phase) track.

#### Dependencies

- Phase 3 Extension Registry v1 (manifest + sandbox + signing infra)
- Phase 4 Plugin API v1 frozen + `@nimbus-dev/sdk` v1.0.0 published
- Phase 4 `I16` extension-signature verification (publisher Ed25519 chain)
- Phase 9 Wave 5 — `nimbus eval` framework + quality-score persistence (gating the marketplace UI's quality column)
- Phase 4 auto-update daemon (`extension.checkForUpdates` / `extension.update` IPC; CLI-only)

#### Hosted Registry

- [ ] **`registry.nimbus-agent.dev`** — public read-only HTTP registry serving signed extension manifests + tarball URLs + version metadata. **No user accounts on the registry itself.** Authors publish via a one-shot signed POST whose payload is verified against a public-key chain rooted in the publisher Ed25519 key — the same chain `I16` already enforces at install. Registry is stateless against authorship: the keys are the identity. Static-hosting-friendly (S3 / R2 / GCS + CDN); no relational database; manifest index materialized from the on-disk tarball tree on each publish.
- [ ] **Author publishing flow** — `nimbus extension publish` CLI: signs the manifest with the publisher key, uploads the tarball + manifest to the registry, returns a registry URL. Idempotent against a `<id>@<version>` tuple; refuses to overwrite an existing version (`I16` chain integrity). Pre-publish runs `nimbus eval` against the extension's declared eval suite (see Phase 9 Wave 5) and persists the score into the manifest.
- [ ] **`nimbus extension search <query>` + `nimbus extension info <id>`** — CLI surfaces over the registry's manifest index. Output includes install count, quality score, last-published date, publisher verification status, declared `permissions`, and the cryptographic fingerprint of the signing key.
- [ ] **Manifest browser at `nimbus-agent.dev/extensions`** — static-site catalog with search + filter by category / connector kind / quality threshold / verified-publisher only. Renders per-extension pages with the README, sandbox manifest, eval-suite summary, and the install command. No JavaScript on the read path; static HTML so it's archivable + auditable.

#### Private & Composable Registries

- [ ] **"Bring your own registry"** — `nimbus config set registry.url https://internal.acme.corp/nimbus` points the CLI + Tauri UI at a private registry (queried instead of, or alongside, the public `registry.nimbus-agent.dev`). Each private registry carries its **own publisher trust root**: a per-registry baked pubkey set so an enterprise's internal extensions verify against the `I16` chain without trusting public keys. A static S3 / R2 / GCS bucket is a valid registry — no relational DB required. The on-ramp for enterprises whose internal connectors (bespoke deploy engines, internal HR systems) can never be published to the public internet; bridges the gap before the Phase 12 enterprise features.
- [ ] **Extension dependencies** — extensions declare dependencies on other extensions in `nimbus.extension.json` (e.g. `"dependencies": {"github-connector": ">=1.2.0"}`); `nimbus extension install` resolves and installs the tree. **Scoped conservatively for v1:** exact-pin + explicit-trust only — every transitive dependency is surfaced and must be trusted by the user before install; no naive semver auto-resolution, because a silently-pulled transitive dependency would expand the sandbox/signature trust surface past what the user chose. Lets a community "Code Review Agent" depend on the official GitHub connector instead of reinventing auth + indexing.
- [ ] **Starter packs (curated collections)** — publish + install named bundles: `nimbus extension install @nimbus/frontend-pack` pulls Vercel + Figma + Sentry + a React-expert agent in one step. A pack is a thin meta-manifest listing member extensions; install reuses the dependency resolver above. Turns first-run from a scavenger hunt into a one-click persona setup (DevSecOps / Frontend / PM).

#### Quality Layer

- [ ] **Quality score surfaced in marketplace UI** — both the CLI (`nimbus extension info`) and the Tauri Marketplace panel (already shipped in Phase 4 WS5-D) read the per-extension quality score persisted at publish time via Phase 9 Wave 5. Score is a numeric 0–100 plus a per-rubric breakdown (mandatory tool surface, HITL declaration correctness, item id format compliance, contract-test pass rate, eval-suite pass rate against the author's own evals).
- [ ] **Cross-author eval cross-check** — the registry-side publish hook re-runs the contract tests in a fresh Bun sandbox before accepting the publish, so an author cannot ship a passing score they couldn't reproduce. The contract-test suite from `@nimbus-dev/sdk` is the canonical source.
- [ ] **Quality regression watcher** — when an installed extension publishes a new version with a quality score lower than the installed version's score by more than a configurable threshold (default 10 points), the auto-update daemon **does not** apply the update; it queues an HITL prompt with the regression breakdown. Composes with the Phase 4 auto-update daemon.
- [ ] **Permission transparency at install** — surface the exact sandbox permissions an extension declares (network hosts, filesystem read/write scope), read from the `I15` `ServerSpec` the sandbox already enforces, prominently on the registry page, in `nimbus extension info`, and in the interactive install confirmation. The Quality Score **auto-penalizes over-requesting**: an extension that declares `*` network or full-filesystem-write but is categorically a formatter is marked down, nudging authors toward least privilege. Composes with the Phase 9 Wave 5 eval framework that computes the score.
- [ ] **`nimbus extension audit`** — observes what an installed extension *actually* calls at runtime (outbound hosts hit, filesystem paths touched) versus what its manifest *declared*, and flags drift (declared `*`, only ever contacted `api.github.com`). Feeds observed evidence back into the permission-transparency penalty so the Quality Score reflects real behaviour, not self-reported manifests. Built on the `I15` sandbox + the egress-ledger primitive (Phase 8 Wave 4).
- [ ] **Connector liveness + golden-transcript replay** — connectors rot when the upstream SaaS API changes. The publish hook records a connector's MCP responses against a fixture once (the "golden transcript"); a periodic registry-side probe replays them to detect API drift **with no live call against any user's data**, and surfaces a "works as of `<date>`" freshness badge in the catalog. A connector whose golden transcript no longer reproduces is flagged stale.

#### Trust Layer (Verified Publishers)

- [ ] **Verified Publisher tier** — annual subscription ($X/yr; pricing decided when the tier opens, not on this commit) that funds the signing + verification operation. Subscribers get: (a) a checkmark next to their publisher name in CLI + marketplace, (b) their publisher key pre-shipped in the gateway's trust store so end users do not have to fetch it on first install, (c) KYC + abuse-monitoring SLA. Verification is on the **publisher**, not on individual extension quality.
- [ ] **Pre-shipped trust store + first-install offline path** — gateway ships with a baked-in JSON manifest of verified-publisher pubkeys. Installing a verified-publisher extension from a tarball with no network call still verifies against this baked store. Refreshed on each gateway release; an out-of-band update mechanism is **explicitly out of scope** for this phase (the gateway release cadence is the rotation cadence; emergency publisher-key revocation is a Phase 12 enterprise concern).
- [ ] **Publisher key rotation procedure** — documented one-time rotation flow: publisher signs a "next pubkey" announcement with the *current* key; the next gateway release picks it up; subsequent installs verify against the new key. No automated revocation list (CRL) — too much infra for this phase.
- [ ] **Abuse reporting + takedown** — `nimbus extension report <id>` posts a structured complaint to a maintainer inbox. Takedowns are a manual moderation action that removes the manifest from the registry index (the tarball is left in place under its content-addressed URL — anyone who explicitly trusts the content hash can still install). Logged in a public moderation ledger so takedowns are themselves auditable.
- [ ] **Reproducible-build / source-provenance attestation** — the registry verifies that a published tarball was built from the claimed source commit (SLSA-style build provenance) and records the attestation alongside the `I16` Ed25519 signature. The signature proves *who* published; the attestation proves *what source* it was built from. Surfaced as a "provenance verified" badge; verifiable offline against the baked trust store like the signature chain itself.

#### Author Onboarding

- [ ] **`nimbus connector init --from-openapi <url-or-path>`** — pre-M6 author tool that scaffolds a connector skeleton from an OpenAPI / AsyncAPI spec. Generates the manifest, the sync handler, the mapping function, and a contract test against the spec. Authors customize from there. Does **not** make the agent self-extending (that's still M6); it makes a human author 10× faster.
- [ ] **20-extension grant program** — $1k/connector marketing spend to seed the registry with 20 community-authored extensions targeting categories the first-party set under-serves (e.g., niche vertical SaaS, regional SaaS, OSS tooling). Treated as marketing budget, not marketplace seed — authors keep the code AGPL or MIT under SDK terms; no Nimbus equity, no royalties.
- [ ] **Extension Author Hub** — `nimbus-agent.dev/authors` static page consolidating: the SDK reference, the contract-test guide, the signing-keypair quickstart, the publishing workflow, the eval-suite authoring guide, the Verified Publisher application form, and the grant-program details.
- [ ] **Author sponsorship** — a `funding` array in the extension manifest (GitHub Sponsors / Patreon / BuyMeACoffee / Stripe Payment Link); `nimbus extension sponsor <id>` opens the configured link and a "Sponsor Author" button appears on the registry page + Tauri Marketplace tile. Kickstarts the creator economy *before* the Marketplace v2 monetization (deferred to Phase 6) ships — zero payment infra on Nimbus's side, no tax, refund, or routing liability.
- [ ] **`nimbus extension clone <id>`** — for any extension published under an open-source license, downloads the tarball, unpacks it locally, and registers it as a local development extension ready to edit. Reuses the existing dev-extension path (unsigned local code runs in the sandbox; signature verification is bypassed for local dev only). Makes "fork the community Code-Reviewer agent and tweak its system prompt for our C++ style guide" a one-command operation; leans into the open-source ethos.

#### Acceptance Criteria

- `registry.nimbus-agent.dev` is live and serves at least 30 distinct extensions (the 15 first-party Phase 5 connectors that migrate plus the 15 first-completed grant-program submissions) with valid signed manifests verifiable against the Phase 4 `I16` chain.
- `nimbus extension publish` round-trips against the live registry: a new version of a test connector is published, becomes searchable, installs cleanly on a fresh gateway, and verifies the signature offline against the baked trust store.
- At least 5 Verified Publishers (counted by distinct pubkeys, not extensions) are active and their keys are baked into the current gateway release's trust store; an installer of one of their extensions never sees a "publisher unknown" warning.
- Phase 9 Wave 5 quality scores appear on every published extension's registry page and Tauri Marketplace tile; the score is reproducible by running `nimbus eval --extension <id>` locally and matches within rounding.
- The quality-regression watcher fires on a controlled test: a v1.0.1 published with a deliberately worse eval-suite score does not auto-update an installed v1.0.0, and surfaces a structured HITL prompt with the per-rubric delta.
- The abuse-reporting + takedown flow is exercised once against a deliberately-misbehaving test extension submitted by a maintainer; the takedown appears in the public moderation ledger within the agreed SLA.
- Installing an extension that declares `*` network access surfaces an interactive over-request warning in both the CLI and Tauri install flow, and its registry Quality Score shows the least-privilege penalty.
- `nimbus extension clone <id>` on an MIT/AGPL-licensed published extension round-trips to an editable local development extension that spawns in the sandbox without a signature error.
- An extension installed from a configured private registry verifies its signature against that registry's own publisher trust root with no call to `registry.nimbus-agent.dev`.

---

### Phase 9.7 — Connector Write-Enablement (The Acting Roster)

> **Sequencing (overlay):** **Track 1 — spine.** The write-substrate the autonomy arc assumes: Phase 10 (standing approvals / scheduled write-workflows), Phase 16 (team writes / runbook-as-agent), and Phase 17 (mitigation actions) all *consume* a broad write surface that no phase currently delivers. Numbered 9.7 (fractional insert — no renumber) so it lands immediately before Phase 10: build it before, or in lockstep with, the autonomy work that depends on it. See [§ Phase 7+ Sequencing Spine](#phase-7-sequencing-spine).

**Goal:** Promote the connector roster from a read-only *index* into an *acting* agent. Today ~88 first-party connectors index data but only a handful can write (Looker datagroup/schedule triggers, ArgoCD `app_sync`, Flux, MLflow). The write *machinery* already exists — the `I26` write-registry (`connector-write-registry.ts`), the `I29` egress ledger, and the executor HITL chokepoint (`I2`) — but is barely exercised. This phase systematically builds HITL-gated write tools across the existing roster on that machinery, ordered by blast radius, so every new write is **gated, previewed, ledgered, and peer-unreachable by construction.**

#### Dependencies

- `I26` connector-write registry + the per-group write-tool SSoTs (`warehouse-write-tools.ts`, `gitops-ml-write-tools.ts`) — generalized in Wave 1
- `I29` egress ledger (every write appends one row before `connectors.dispatch`)
- `I2` HITL frozen-set gate (every write action type is gated in the executor)
- Phase 10 standing-approval **taint barrier** (attacker-influenceable tool output can never satisfy a standing rule) — co-designed; any write that auto-fires must respect it
- Phase 3 connector mesh + each target connector's existing read-side sync

#### Non-negotiable guardrails

- Every write tool id is confined to the `I26` SSoTs and the connector/transport sites — the `D20` static audit fails on any leak.
- The federated peer invoke gate (`answerFederatedInvoke`) fail-closed rejects every write-classified tool id (`isWriteForbiddenToolId`): a peer can never trigger a connector write.
- Every gated write appends exactly one `egress_ledger` row before dispatch; an append failure aborts the action (fail-closed; `I29`).
- Infra/production writes (Wave 4) are preview-mandatory and excluded from standing-approval auto-fire by default.

#### Structure — four waves, ordered by blast radius

#### Wave 1 — Write-Authoring Framework *(prerequisite substrate)*

- [ ] **Generalized connector-write contract** — promote the per-group `I26` registries into one authoring path so a connector can declare write tools without bespoke wiring at each coupling site.
- [ ] **HITL consent preview renderer** — the consent dialog renders a before/after diff (action target + payload summary) so the owner approves the *exact* change, not just an action name.
- [ ] **Egress-ledger coverage proof** — a contract test asserts every registered write tool id appends an `egress_ledger` row on the gated path (extends `I29`).
- [ ] **Standing-approval + taint integration** — write tools become eligible for Phase 10 standing rules only behind the taint barrier; an untrusted-tainted trigger falls back to HITL.

#### Wave 2 — Productivity Writes *(low blast radius, reversible)*

- [ ] **Drafting & comments** — Gmail/Outlook create-draft; GitHub/GitLab issue + PR comment; Jira/Linear comment.
- [ ] **Item create + transition** — Jira/Linear issue create + status transition; GitHub/GitLab issue create + label/assign.
- [ ] **Knowledge writes** — Notion/Confluence page append (composes with the `I25` tribal-knowledge write-gate).
- [ ] **Messaging** — Slack/Teams/Discord post (already HITL via the `*.message.post` action types; folded in for completeness).

#### Wave 3 — Code & Change Writes *(medium blast radius)*

- [ ] **VCS changes** — GitHub/GitLab branch create, commit, PR create/update; HITL preview shows the diff + target branch.
- [ ] **Incident ops** — PagerDuty / OpsGenie acknowledge + resolve.
- [ ] **Feature-flag writes** — flag toggle / rollout update; supplies the shared write-authoring path Phase 7 Wave 3's flag-write surface consumes (not duplicated).

#### Wave 4 — Infra & Production Writes *(high blast radius — strictest gating)*

- [ ] **Orchestration & IaC** — Kubernetes apply; Terraform/IaC plan→apply (preview shows the plan); generalizes the existing ArgoCD/Flux GitOps writes.
- [ ] **Deploy triggers** — Vercel / Netlify deploy; CI pipeline trigger (Jenkins / CircleCI / Bitrise).
- [ ] **Data & ML writes** — generalizes the existing warehouse (`looker_*`) and ML (`mlflow`) write surface under the Wave 1 contract.

#### Acceptance Criteria

- A representative write in each of Waves 2–4 executes only behind the `I2` HITL gate, renders a before/after preview, and appends exactly one `egress_ledger` row before dispatch.
- The same write, requested by a federated peer via `answerFederatedInvoke`, is rejected fail-closed by `isWriteForbiddenToolId` — no dispatch, and a `blocked` ledger row.
- The `D20` static audit passes with every new write tool id confined to the `I26` SSoTs.
- A Wave 4 (infra/production) write cannot be auto-fired by a standing rule without an explicit preview, and an untrusted-tainted trigger falls back to HITL.

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
- [ ] **Standing-approval taint barrier (proposed invariant)** — attacker-influenceable tool output (any connector / indexed / federated content) can never satisfy a standing rule, skill-pack auto-approve, or template auto-adopt; matched via a `trusted` / `untrusted` provenance tag riding the existing `I11` envelope, falling back to HITL on `untrusted` triggers. Ships *with* standing approvals as a full invariant triple (taking the next free invariant number when wired). Canonical statement in [`SECURITY.md`](./SECURITY.md); shared with Phase 16 (skill packs / federated Q&A) and Phase 17.
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

#### Public Dogfooding Telemetry (vulnerability-as-marketing)

A single primitive that turns the Phase 3.5 telemetry pipeline into a public-trust artifact. The Nimbus maintainers run their own Gateways with telemetry **deliberately enabled** and **deliberately published** to a public dashboard. The dashboard shows aggregate (no-content) metrics about the maintainers' day-to-day usage: how often HITL fires on them, how often the agent admits it doesn't know, p95 query latency, the cost-per-brief ratio. The marketing argument writes itself: "watch what running this thing actually looks like." The argument cuts deeper because Nimbus is the only product in the category that can honestly publish these numbers — cloud agents would have to release competitive performance data they're motivated to hide.

- [ ] **Public dogfooding dashboard at `nimbus-agent.dev/dogfood`** — static site rendered from the same `[telemetry]` payload-safety-gated aggregate counters Phase 3.5 already collects; updated daily from the maintainers' own Gateways. Visible categories: HITL fire rate, refusal rate, average tokens-per-brief, p95 query latency, top-N most-used agents, ratio of corrections to confirmations. **No per-query content.** **No per-user PII.** The dashboard is renderable as static HTML so it's archivable + cryptographically verifiable.
- [ ] **Telemetry publication primitive** — `nimbus telemetry publish --to <signed-endpoint>` extends the existing telemetry flush to optionally publish to a known-pubkey endpoint. The dashboard's endpoint is one such; users who want to run their own dashboard (a team's internal dogfood dashboard) point their telemetry at a different endpoint. Honesty primitive: any user can run the same dashboard against their own team.
- [ ] **Verifiable provenance** — every published dashboard row carries a signature from the originating Gateway's release key. A skeptical reader can verify the dashboard is showing real data from real Gateways and not curated marketing. Composes with the S — Standards EAF verifier CLI shape (same primitive, different payload type).
- [ ] **"What the agent doesn't know" feed** — a publicly-visible feed of the refusal log entries from the maintainers' own Gateways (aggregate, scrubbed of identifying content). Demonstrates the agent does refuse and on what categories of question. Counter-narrative to the "AI is overconfident" framing.
- [ ] **Calibration leaderboard (consensual)** — the maintainers' own per-user calibration curves (from Phase 9 Wave 6) published as opt-in. "Here's how often Nimbus says it's 90% confident and is actually right." Shipping a calibration score publicly is a credibility move no cloud agent has made.
- [ ] **Privacy contract — public-payload safety gate** — extends the existing `bun run test:coverage:telemetry` gate with a `--public-payload` mode that checks the *published* payload (subset of the existing telemetry payload) against an even stricter safety policy: no query strings, no item IDs, no item types beyond their category, no engineer handles. Failing the gate refuses publish.

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
- Public dogfooding dashboard at `nimbus-agent.dev/dogfood` updates daily from at least three maintainer Gateways with verifiable Ed25519 provenance per row; the `--public-payload` payload-safety gate refuses publish on any payload containing a query string, item ID, or engineer handle
- A non-maintainer user can run `nimbus telemetry publish --to <their-endpoint>` and stand up their own equivalent dashboard against their own team's Gateways without touching the maintainers' infrastructure

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
- [ ] **Provable-locality export (M7)** — auditor-grade, Ed25519-signed export of the Phase 8 egress ledger + audit-chain head, scheduled and pushed to an external append-only sink (the same SIEM targets as audit log shipping) so the local chain is externally anchored; bounds the same-UID local-rewrite window. Completes the North-Star **M7 (Provable Locality)** capability.
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

### Phase 12.5 — Compliance Receipts

**Goal:** Give an individual engineer the artifacts they need to unblock their own organization's security review **without a sales motion.** This phase explicitly does not target procurement, audit firms, or sales — it targets the engineer who has Nimbus installed and now needs to satisfy their CISO before it can be used at work. The deliverable is *receipts* — a structured bundle of evidence that maps to a framework's controls — not third-party attestation, not a BAA, not a vertical starter pack. Cloud agents cannot produce this artifact for the user's specific deployment because they don't know what's installed locally; Nimbus can.

> **Composes with Phase 8 (Security Engineering):** the audit chain + egress ledger + supply-chain attestations Phase 8 delivers are the raw evidence the bundle assembles. Phase 12.5 is the *assembler*, not the source.
>
> **Composes with the S — Standards track:** the egress-ledger section of every bundle is rendered in the EAF reference-impl format from the [§ S — Standards (cross-phase)](#s--standards-cross-phase) track. Bundles that include EAF can be independently verified by any third party with the EAF verifier CLI.
>
> **Composes with the M7 North-Star (Provable Locality):** M7 *is* the egress-ledger primitive; Phase 12.5 is the **product surface** that turns it into a self-service compliance artifact.

#### Dependencies

- Phase 4 tamper-evident BLAKE3-chained audit log
- Phase 8 egress ledger + supply-chain attestations (M7 substrate)
- Phase 9 model-weight integrity + model-policy registry (control evidence for AI-specific frameworks)
- S — Standards track: EAF reference implementation + verifier CLI

#### Compliance Bundle

- [ ] **`nimbus compliance bundle --framework <name> [--output <path>]`** — produces a `.zip` containing:
  - **Cover memo** (Markdown + PDF render) explaining what this bundle is, what it isn't (not third-party attestation), and how to use it in a security review.
  - **Control mapping spreadsheet** (XLSX + CSV) — one row per control in the framework, listing: control ID, control name, evidence file path, evidence type (config / audit extract / signed log / configuration snapshot / N/A), and a one-sentence summary of *how* this Nimbus deployment satisfies the control. N/A rows are explicit about why the control doesn't apply.
  - **Audit-log extract** — the BLAKE3-chained audit log for the configured window (default last 90 days), exported in the existing `nimbus audit export` format with the chain-verification proof.
  - **Egress attestation** — the M7 egress ledger for the same window, rendered as a signed EAF artifact (reference-impl format).
  - **Configuration snapshot** — `nimbus.toml` (secret values redacted), connector list with health states, vault key inventory (key *names* only, not values), installed extensions with signed manifests + publisher fingerprints, sandbox manifests per connector (I15 evidence).
  - **Cryptographic attestation** — the bundle itself is signed with the gateway's release Ed25519 key. The included `verify.sh` script (POSIX) and `verify.ps1` (Windows) verify the bundle against the published gateway pubkey.
- [ ] **Frameworks in v1** — `soc2` (CC6 + CC7), `iso27001` (Annex A controls), `gdpr` (Articles 5, 25, 30, 32), `eu-ai-act` (Article 13 transparency report), `hipaa` (technical safeguards only — administrative + physical safeguards explicitly out of scope), `nist-csf` (Identify + Protect + Detect functions).
- [ ] **SOC2 pilot first** — ship `--framework soc2-pilot` as the first dogfood target. Pilots against the maintainer's own SOC2 controls; iterates against three independent security teams' feedback before opening the rest of the frameworks. The other frameworks are template work once the SOC2 evidence-collection plumbing is right.
- [ ] **What's explicitly NOT in scope** — third-party attestation, BAA contracts, vertical starter packs (legal / healthcare / finance specific tooling), penetration test reports, formal risk assessments. These are sales-motion artifacts; Phase 12.5 is receipts only.

#### Data Subject Request (GDPR Article 15 + Article 22)

- [ ] **`nimbus dsr <subject-identifier> [--output <path>]`** — produces a per-subject artifact answering "what does this agent know about person X" + how to delete it.
  - **Subject identifier** — email, GitHub login, Slack handle, or any handle the people graph resolves; the command runs `resolvePerson` first and dumps the resolved identity graph as part of the artifact.
  - **Output bundle** — JSON + PDF render of: every indexed `item` referencing the subject (across all connectors), every `person` row + cross-service handles, every `audit_log` row mentioning the subject, every relationship-graph edge incident to the subject's nodes, and a per-row "source of record" pointer to the originating connector.
  - **Deletion plan** — second half of the artifact is a Markdown checklist of what `nimbus data delete --service <name> --subject <identifier>` would do per connector, with dry-run row counts. **Does not execute** without explicit `--execute` + HITL approval; the artifact alone is read-only.
- [ ] **Article 22 (right to explanation) extension** — when a DSR is run for a subject who has been the target of an HITL-approved action by a Nimbus agent, the artifact additionally includes the M3 replay trace for that action (reasoning + evidence + decision path). Composes with the M3 North-Star.

#### Doc & Sample Artifacts

- [ ] **`docs/compliance/`** — one Markdown file per supported framework, explaining the control-to-evidence mapping in narrative form. Used by engineers prepping their security review to anticipate questions.
- [ ] **Sample bundle per framework** — pre-rendered example bundle (with synthetic data) committed under `docs/compliance/samples/`. Lets a prospective adopter see the artifact shape before installing Nimbus.
- [ ] **Reviewer's quickstart** — `docs/compliance/reviewer-quickstart.md`, a one-page guide for a security team reviewing a bundle: what the chain-verification proof means, what EAF guarantees vs doesn't guarantee, what's signed vs unsigned, how to cross-check against a fresh `nimbus diag` snapshot.

#### Acceptance Criteria

- `nimbus compliance bundle --framework soc2-pilot --output ./bundle.zip` produces a self-verifying zip whose `verify.sh` succeeds offline against the published gateway pubkey on a fresh machine with no Nimbus installed.
- The SOC2 pilot bundle is reviewed by three independent engineers' security teams; each confirms the bundle unblocks (or would unblock, in a sandboxed review) Nimbus adoption inside their org without any further questions Nimbus could not have anticipated.
- `nimbus dsr <test-subject>` against a seeded test corpus produces a JSON artifact whose contents round-trip cleanly through the matching `nimbus data delete --service ... --subject ... --dry-run` and report identical row counts (i.e., the DSR view is the same view the deletion plan would act on — no drift).
- Every framework in v1 has at least one rendered sample bundle under `docs/compliance/samples/` and a narrative doc under `docs/compliance/`.
- An end-to-end privacy contract: the bundle never contains a vault value or a credential body; only key names, manifest hashes, and signed manifest contents. Verified by a `bun run audit:compliance-payload-safety` gate analogous to the existing telemetry payload-safety gate.

---

### Phase 13 — Desktop Distribution

> **Sequencing (2026-06-17 overlay):** **Track 2 — independent-slot.** Not spine-gated; land whenever adoption demand justifies the release-vehicle work. See [§ Phase 7+ Sequencing Spine](#phase-7-sequencing-spine).

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
- [ ] **Perf surfaces S3 (dashboard first paint) + S5 (HITL popup paint) — renderer instrumentation** — the two desktop perf-bench UX surfaces are stubbed (`renderer instrumentation pending (Tauri perf marks)` in `packages/gateway/src/perf/surfaces/bench-dashboard-first-paint.ts` + `bench-hitl-popup.ts`; both return `[]` → `samples_count=0 → skipped(stub)`, so they gate nothing today). Instrument the Tauri renderer to emit first-paint / popup-paint perf marks (Paint Timing API → a stdout/IPC marker the bench driver reads — mirrors the S4 TUI `[tui] first-frame` marker pattern), implement the two drivers, drop the stubs, and confirm/adjust their `gateClass` (both are provisionally `trend` in `slo-thresholds.ts`; reclassify per whether the implemented driver spawns a process). Thresholds are already pinned (S3 ≤1500 ms ref / ≤7500 ms GHA; S5 ≤200 ms ref / ≤1000 ms GHA). Closing these completes the S1–S11 perf surface set so the reference runner gates the full surface roster. (Deferred here from the perf-strategy workstream because faithful first-paint timing needs the launchable desktop UI this phase delivers.)

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

### Phase 13.5 — Mobile Companion

> **Sequencing (2026-06-17 overlay):** **Track 2.** Depends on Phase 11 (mesh addressing) + Phase 17's assembled-brief schema, so it slots after those — *not* freely independent (unlike Phase 13). See [§ Phase 7+ Sequencing Spine](#phase-7-sequencing-spine).

**Goal:** Solve the on-call engineer's "the agent is on the laptop in my bag" problem by shipping a **passive viewer** mobile app that pairs to the user's own desktop gateway over the existing Phase 11 sovereign-mesh primitive. The mobile app **does not execute the agent locally** — it receives push notifications for HITL consent and assembled briefs, and forwards the user's approve/reject decision back through the mesh. iOS first; Android follows in a v0.2 of the same phase. Discipline: this phase is one platform, one persona (the user already running on-call from their own desktop), one job (receive + decide). Resist scope creep into "agent on phone."

> **Composes with Phase 11 (Sovereign Mesh):** the laptop ↔ phone link is the existing NaCl-box pairing flow, extended with an opt-in push relay through APNs (Apple Push Notification service). Messages sent over the relay are *already encrypted* end-to-end by the mesh; APNs sees only an encrypted envelope.
>
> **Composes with Phase 17 (The On-Call Copilot):** Phase 17's predict/understand/mitigate/coordinate loop generates the briefs the mobile companion displays. The companion is the **mobile presentation layer** for the Phase 17 agent, not a re-implementation.

#### Dependencies

- Phase 4 encrypted LAN remote access (NaCl-box wire format, peer-pairing flow)
- Phase 11 sovereign mesh (peer addressing across networks)
- Phase 17 (or earlier) assembled-brief format — the schema the mobile app renders
- Apple Developer Program enrollment (also a Phase 13 prerequisite)

#### iOS (v0.1)

- [ ] **`nimbus-companion` iOS app — passive viewer only** — SwiftUI app, minimum iOS 17. Three screens: (a) **Pairing**, a one-time setup that exchanges X25519 keys with a host gateway using the existing 120-bit base58 pairing code displayed on the host CLI / Tauri UI, (b) **Inbox**, a list of HITL consent requests + assembled briefs received from paired hosts, (c) **Brief Detail**, a read-view of a single brief or HITL request with Approve / Reject buttons. **No query input. No on-device agent. No local index.** Resist the temptation to add either.
- [ ] **APNs push relay (encrypted envelope)** — the host gateway sends a NaCl-box-sealed envelope to APNs targeting the paired device token; APNs forwards the wakeup; the iOS app decrypts the envelope using the locally-stored shared key. APNs sees only the encrypted blob + device token; it cannot read brief contents or HITL action details. **APNs is a wakeup channel, not a data channel** — the device pulls the actual brief over the sovereign-mesh link after wake.
- [ ] **HITL round-trip** — Approve / Reject in the iOS app builds an `agents.hitl.respond` payload, encrypts it with the same shared key, sends it back through the mesh (with APNs as the wakeup if the host is asleep). The host's existing HITL gate is the source of truth — the phone is a remote consent surface, not a separate authorization path.
- [ ] **Multi-host pairing** — a single iOS app can be paired to multiple host gateways (the user's laptop + the user's desktop + a shared on-call machine). Inbox shows the source host on every row; Approve/Reject is per-message routed to the originating host.
- [ ] **Offline behavior** — when the host is unreachable (laptop closed, no network), inbox displays the last-known cached briefs but Approve/Reject is disabled with a clear "host offline" indicator. No queueing — pending HITL gates the action; if the user wants the action they re-trigger from the desktop when reachable.
- [ ] **App Store distribution** — submitted to the App Store under the same Apple Developer Program enrollment that funds Phase 13's macOS notarization. Open-source under AGPL alongside the rest of the gateway; the App Store binary is a distribution channel, not a closed fork.
- [ ] **Privacy + tracking posture** — explicit "no analytics, no third-party SDKs" stance in the App Store privacy nutrition label. The only network calls are APNs (Apple) and the paired hosts (the user's own machines). Confirmed in app review.

#### Companion-Aware Gateway Surface

- [ ] **`nimbus companion pair` CLI** — generates the 120-bit base58 pairing code, displays it for the user to type into the iOS app, opens a 5-minute pairing window using the existing LAN pairing flow.
- [ ] **`nimbus companion list-devices`** — shows paired devices with last-seen time and last-received-message time.
- [ ] **`nimbus companion revoke-device <id>`** — removes a device's stored shared key; sends a final "you've been unpaired" message; the device's inbox stops receiving on next poll.
- [ ] **HITL push routing config** — `[companion].push_categories = ["hitl", "incident", "agent-brief"]` per-category opt-in; e.g., a user can opt into HITL pushes but not into morning briefings.
- [ ] **Tauri Companion settings panel** — list paired devices, revoke, regenerate pairing code, configure push categories.

#### Stretch (does not gate phase completion)

- [ ] **Android companion v0.2** — Kotlin / Jetpack Compose app, same surface shape, Firebase Cloud Messaging as the wakeup relay (envelope encryption identical to APNs; FCM sees only the encrypted blob).
- [ ] **Voice approval on iOS** — Siri shortcut + voice intent: "Hey Siri, ask Nimbus to approve the deploy" round-trips an approval. Stretch because the Siri intent UX is a non-trivial design surface and the security review needs more work.
- [ ] **Apple Watch companion** — receive + Approve / Reject from a watch face. Builds on top of the iOS app's pairing + key store. Stretch — watchOS adds a per-platform surface for marginal incremental value.
- [ ] **Voice-only ambient mode** — a session mode optimized for hands-free use (walks, driving, cooking, the gym). Pulls the existing Phase 4 STT/TTS primitives onto the iOS app via the sovereign-mesh link: the user speaks a query on the phone, audio is streamed encrypted to the desktop Gateway where Whisper.cpp transcribes locally (audio never reaches Apple's servers), agent runs, TTS response is streamed back. Conversations stay continuous via a configurable wake-phrase ("Hey Nimbus") and silence-detection. Briefs are auto-shortened to "speakable" length (configurable; default 3 sentences for ambient-mode delivery). **Discipline:** no on-device STT/TTS in v0 — the mesh-to-Whisper round-trip is the privacy story; on-device falls back to the cloud sandbox iOS provides, which is the exact compromise this phase exists to avoid.

#### Acceptance Criteria

- A fresh iOS device pairs with a fresh gateway in under 60 seconds using the `nimbus companion pair` flow, exchanging X25519 keys via the existing pairing primitive with no third-party broker.
- An HITL consent request fired on the laptop arrives as an iOS push within 5 seconds when both devices are online; the approve / reject decision arrives back at the laptop within 3 seconds of the user's tap; the host's HITL gate sees the decision as if the user had clicked Approve in the Tauri popup.
- The APNs envelope never carries plaintext brief content or HITL action details — verified by inspecting the APNs payload in transit during an integration test against Apple's sandbox APNs environment.
- The App Store privacy nutrition label correctly reports "no analytics, no third-party SDKs" and the App Store reviewer approves on first submission.
- A revoked device's inbox stops receiving messages within 60 seconds; the host gateway logs the revocation in the audit chain.
- An offline-host scenario degrades gracefully: the iOS app displays cached briefs read-only and disables Approve / Reject with a clear "host offline" message; no spurious approvals or queued-but-lost decisions.

---

### Phase 14 — Agent Evolution / AI v2

> **Sequencing (2026-06-17 overlay):** **Pulled forward to slot S2** (Track 1) — the biggest 2026-model lever. Local computer-use (screenshots never leave the machine), sandboxed code execution, and runtime tool-gen are high-time-to-value *and* unfakeable moat. Joined in S2 by the [NEW] overnight local sub-agent fleet (from Phase 27) + BYO-frontier-model routing. See [§ Phase 7+ Sequencing Spine](#phase-7-sequencing-spine).

**Goal:** Expand Nimbus's intrinsic agent capabilities along four dimensions — multimodal I/O, isolated code execution, computer use, and runtime tool generation. Highest risk-blast-radius phase; structured Core / Stretch so the phase remains shippable even if the most research-adjacent capabilities slip.

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

### Phase 18 — Vertical Personas

**Goal:** Lift Nimbus out of pure dev-tool framing by shipping a tight set of **persona-targeted built-in agents** that turn the existing indexed data into category-defining experiences for audiences with high willingness to pay and high evangelism potential. Each persona is built **only on already-indexed data** — no new connector categories required. The bet: Nimbus is uniquely positioned to serve narrow audiences cloud agents can't (because the data is private, regulated, or low-volume per-customer); each persona becomes a viral wedge into that audience. Discipline: this phase is **read-only built-in agents**, not new feature areas — every persona is a Markdown brief over data already in the index.

> **Composes with Phase 5 connectors:** every persona's data sources are already-shipped Phase 5 connectors. Solo founder reads Stripe + Mercury + Intercom; OSS maintainer reads GitHub + Slack/Discord + Linear; indie creator reads Stripe + indexed analytics exports; academic reads Zotero + arXiv. **No new mandatory connectors gate this phase.**
>
> **Composes with Phase 9 (Agent Honesty Surfaces):** every persona agent is subject to the same calibration audit / bias diagnostic / refusal log primitives. Niche audience does not mean reduced rigor.

#### Dependencies

- Phase 4 multi-agent orchestration + LLM router + Plugin API v1
- Phase 5 Tier-1 connectors landed (Stripe, Mercury, Intercom, Zendesk, Greenhouse, Lever — already shipped; remaining tiers in flight)
- Phase 9 Wave 5 eval framework (each persona agent ships with `evals/*.yaml` and is gated by it)
- Phase 9.5 marketplace registry (long-tail personas land as community extensions; first-party set bounded)

#### Persona Briefs (read-only built-in agents)

- [ ] **`nimbus founder` — solo-founder dashboard** — parallel sub-agents over Stripe (MRR / ARR / churn / top customers), Mercury (runway / burn rate / inflows), Intercom + Zendesk (top customer questions this week), Calendar (sales-call prep for the next 7 days), GitHub (this week's commits-to-features attribution). Output is a Markdown brief structured as: Money, People, Product, Calendar. Read-only; no HITL. **Composes with Stripe + Mercury connectors already shipped.** Daily watcher variant pushes the brief on the user's configured morning schedule. Cloud agents structurally can't do this — they don't have read access to Stripe + Mercury + Intercom + Calendar in one place under any reasonable enterprise contract.
- [ ] **`nimbus maintainer` — open-source maintainer brief** — for OSS maintainers running Nimbus against their own project: parallel sub-agents over GitHub (new issues + pattern-match against historical bug clusters via the relationship graph, "this is a duplicate of #1234" detection, PR reviewer recommendations via the people graph, neglected PRs sorted by age × contributor seniority), Discord / Slack community channels (top-N questions asked but unanswered this week, sentiment trend), Linear (if the project uses it). Output is a Markdown brief structured as: Issues, PRs, Community, Contributors. Read-only; no HITL. **High-status audience** — OSS maintainers are advocates and influencers; this is a recruitment vector disguised as a feature.
- [ ] **`nimbus creator` — indie-creator analytics agent** — for YouTubers / Patreon creators / Twitch streamers / newsletter-runners: pulls from a thin set of indexed connectors (YouTube Analytics export via the existing Filesystem v2 path, Patreon API, Twitch API, ConvertKit / Substack / Beehiiv export, Stripe for creator-economy revenue, Discord for community engagement). Output: per-week brief on what your audience asked for, which content matched, where churn fired, which platform's audience is most engaged. New first-party connectors here are minimal — most data lands via filesystem export from creator-platform CSVs. **Stretch:** dedicated YouTube + Patreon + Twitch MCP connectors land as community extensions per the Phase 9.5 marketplace pattern.
- [ ] **`nimbus academic` — research mode** — for researchers / grad students / academics: parallel sub-agents over Zotero (citation graph traversal, "which papers cite paper X that I've already read"), arXiv exports / RSS feeds (new papers in user-configured topic categories matched against the user's bibliography), Readwise / Raindrop (the user's own highlights + saved articles), filesystem (LaTeX project tree → "which papers are cited but not yet read"). Output: a "literature review pulse" brief per topic + per-paper "context" briefs ("what does my existing reading say about this paper's claims"). Closes the "Mendeley/Zotero never had AI" gap. Read-only; no HITL.
- [ ] **`nimbus taxes` — annual tax-prep agent** — once-a-year flagship feature. Assembles a CPA-ready bundle from Stripe + Mercury + Expensify (Phase 5 deferred) + Ramp (Phase 5 deferred) + Mercury (the connector already shipped surfaces transactions but not categorized — the agent does the categorization). Output: a `.zip` containing categorized expense tables (XLSX + CSV), 1099 / international-equivalent receipt index, charitable-contribution summary, business-vs-personal split, cover memo. Annual willingness-to-pay is enormous; sticky feature; cloud agents can't legally aggregate financial data across providers under most consumer banking T&Cs.
- [ ] **`nimbus health` — personal health-data brief (stretch)** — opt-in, off by default. For users who import Apple Health / Garmin / Whoop / Strava data via filesystem export, the agent surfaces a weekly brief: sleep + recovery trends, training load, anomalies. **Strict privacy contract:** the data never leaves the machine; the connector is read-only; the data is excluded from any federated namespace by default; a contract test asserts no `health.*` item type can be exposed in a Phase 6 federation namespace. Cloud agents face HIPAA-like constraints that make this category radioactive for them.

#### Persona-Configuration Surface

- [ ] **`[persona.<name>]` config blocks** — each persona's morning-brief frequency, brief sections to include/exclude, alerting thresholds, and connector-source preferences live in TOML. Composes with the Phase 3.5 profile system and the Phase 7 Wave 6 agent-persona block — a `persona = "founder"` profile auto-enables `nimbus founder` daily and routes its output to the user's configured surface (Slack DM, mobile push, terminal).
- [ ] **Persona discovery** — `nimbus persona list` shows available personas; `nimbus persona enable <name>` switches the active default; `nimbus persona configure <name>` opens the TOML block in the user's editor. Onboarding lift — the wow query for a solo founder is `nimbus founder`, not the generic `nimbus ask`.

#### Acceptance Criteria

- `nimbus founder` against a seeded test corpus (synthetic Stripe + Mercury + Intercom data) produces a Markdown brief covering MRR / runway / top-3 customer questions / next-7-days calendar in under 15 s on a mid-range laptop, with no live API call beyond what's already in the local index.
- `nimbus maintainer` against a seeded OSS-project corpus correctly identifies a duplicate-issue cluster (verified against a labeled fixture) and recommends a reviewer via the people graph with citation links.
- `nimbus academic` against a seeded Zotero corpus + a manually-imported arXiv paper produces a "context" brief naming the user's own previously-read papers that bear on the new paper's claims; brief includes per-claim evidence links.
- `nimbus taxes --year 2026 --output ./taxes-2026.zip` produces a self-verifying ZIP whose `verify.sh` passes against the gateway's release pubkey; the bundle contains categorized expense tables totaling the same gross revenue as the underlying Stripe + Mercury raw data (verifiable by cross-sum).
- Every persona ships with an `evals/*.yaml` suite consumed by the Phase 9 Wave 5 framework; the per-persona quality score is published in the marketplace listing.
- Privacy contract: `nimbus health` data is excluded from federated namespace shapes by construction — verified by a contract test that issues a `health.*` namespace export and asserts it fails the namespace shape validator.

---

### Phase 19 — Ambient Surfaces

**Goal:** Make Nimbus present-tense across non-screen surfaces — wearables, voice-first, head-mounted displays, and physical actuation — while keeping the **local-first, no-relay, HITL-gated** architecture intact. This is the highest-risk phase in the roadmap: small audiences, hardware constraints, platform sandboxes (visionOS, Home Assistant, etc.) that may shift under us. Structured Core / Stretch so the phase ships if any one ambient surface lands; the rest can slip.

> **Composes with Phase 11 (Sovereign Mesh):** every ambient surface is a *paired peer* in the mesh — no new wire format. The XR companion, the voice-only deep mode, and the Home-Assistant integration all use the existing NaCl-box channel + the same biometric-HITL primitive Phase 13.5 ships.
>
> **Composes with Phase 13.5 (Mobile Companion):** the voice-only mode declared as a stretch in Phase 13.5 is **promoted to Core here** because the phone is the dominant ambient surface; XR is the secondary surface. Phase 13.5 keeps the iOS passive-viewer code; Phase 19 adds the always-listening + always-speaking layer on top.

#### Dependencies

- Phase 4 STT/TTS primitives + voice wake-word loop
- Phase 11 sovereign mesh + biometric HITL + audit-log signing
- Phase 13.5 mobile companion (the platform the voice layer rides on)
- Apple Developer Program enrollment (also a Phase 13 + Phase 13.5 prerequisite); Meta Quest developer account (for the XR stretch)

#### Core — Voice-First Ambient Mode

The flagship ambient surface. Promoted from Phase 13.5 stretch to Phase 19 core because the on-call + commute + cooking + workout use cases are real and the existing STT/TTS infrastructure is most of the work.

- [ ] **Always-listening mode (opt-in)** — extends the Phase 4 wake-word loop to run continuously on the mobile companion with the existing "Hey Nimbus" trigger. Audio buffer is **encrypted on the phone before mesh transit** (NaCl box keyed to the paired Gateway); the audio never reaches Apple / Google's servers. Whisper.cpp transcription runs on the paired Gateway. Idle audio (no wake-word match within the configurable rolling window) is discarded — never stored, never indexed.
- [ ] **Conversational continuation** — successive queries in a 60-second window share session context without re-stating; silence-detection ends the session naturally. Configurable session timeout. HITL surface for any action shifts to the biometric primitive in Phase 11 — voice-only approve requires FaceID confirmation, not a voice "yes."
- [ ] **Speakable brief format** — every brief output by the built-in agents gets a `--speakable` mode that returns a 1–3 sentence summary version optimized for TTS playback. Long form available on follow-up ("Nimbus, tell me more"). Read-only; no HITL.
- [ ] **Ambient-mode privacy mode** — when paired Gateway detects mesh activity from the always-listening surface (any wake-word event), an in-band signal triggers the tray indicator + a brief audit-log entry. User can `nimbus voice mute` at any time on either side to suspend the loop; mute persists across sessions until explicitly resumed. Defensive privacy posture: there is no silent always-on; the loop's presence is always visible.

#### Stretch — XR Companion

- [ ] **visionOS companion** — Vision Pro passthrough sidebar that renders assembled briefs while the user is doing something else. Pairs with the desktop Gateway via the same mesh primitive as the iOS app. Briefs render as fixed panels in the user's environment; no agent execution on the headset; HITL prompts surface as native visionOS modals with biometric (Optic ID) approval. **Discipline:** read-only briefs in v0; no in-headset query input (the visionOS keyboard UX is genuinely poor and would push the design in the wrong direction). Stretch because the audience is tiny and visionOS APIs are still settling.
- [ ] **Meta Quest companion** — same shape as visionOS, different SDK. Lower priority but socially-shared because the audience is younger. Stretch.
- [ ] **Apple Watch passive viewer** — already a Phase 13.5 stretch; cross-referenced here.

#### Stretch — Physical Actuation (Home Assistant integration)

- [ ] **Home Assistant connector** — index a local Home Assistant deployment (rooms, devices, automations, sensors); read-only. New `home_device` / `home_automation` item types.
- [ ] **Context-aware home actuation behind HITL** — `nimbus ask "dim the lights, I'm shipping a hotfix"` resolves to a Home Assistant scene change via the existing HITL gate. The phrase "context-aware home automation that knows your codebase context" sounds bizarre until you try it; the local-first model is exactly what enables it.
- [ ] **Bridge-to-physical-actuator security model** — every physical actuation (lights, locks, thermostats) is classified by reversibility (light = reversible, lock = irreversible, thermostat = bounded-reversible) and gated accordingly. Locks default to never-HITL-auto (always require explicit user) per Phase 17's reversibility-is-classified-not-assumed rule.

#### Stretch — Wearable Health Companions (read-only)

- [ ] **Whoop / Oura / Garmin / Apple Health integration via filesystem export** — already covered as a stretch in Phase 18's `nimbus health`. Referenced here because the ambient-surface framing fits — the device is the source, the Gateway is the index. **Strict privacy contract:** as in Phase 18, never federated by default.

#### Acceptance Criteria (track-level; not gated by any single sub-section)

- Core voice-first mode round-trips a "Hey Nimbus, what's burning?" query end-to-end (wake-word detection on phone → mesh-encrypted audio transit → Whisper.cpp transcription on Gateway → agent execution → TTS playback on phone) in under 10 seconds on a mid-range laptop + iPhone 15 / Pixel 9; audio never leaves the user's devices, verified by network inspection.
- The always-listening mode's mute toggle suspends the wake-word loop within 1 second on both ends; the audit log records every mute / unmute event.
- An XR-companion brief renders in visionOS within 5 seconds of being pushed from the Gateway; HITL approval via Optic ID round-trips back to the Gateway within 3 seconds.
- A Home Assistant scene change triggered via `nimbus ask` always gates on HITL with a structured before/after preview; locks never bypass HITL regardless of session-level standing approvals.

---

### Phase 20 — Personal & Household Federation

**Goal:** Extend the Phase 6 federation primitive to consumer/household use cases that have **no cloud-vendor equivalent** — a personal CRM no third party ever sees, family/couples shared agents for joint logistics, and friend-group coordination — without compromising the local-first, no-relay, HITL-gated architecture.

> **Relocated from Phase 6** per guiding-principle #7 (Nimbus is built for professionals; consumer-oriented affordances are out of scope for the professional phases). These modes build **for free** on the Phase 6 Slice 1 federation core — no new infrastructure, only narrower namespace shapes and a different audience. Sequenced this late deliberately: the professional team-federation surface (Phase 6) must prove out first. A *professional* form of the narrowest-export-shape privacy proof stays in Phase 6 Slice 1; the family-namespace variant lives here.

#### Dependencies

- Phase 6 Slice 1 — Federation Core (E2EE peer pairing, scoped namespaces, the consent-scoped federated query primitive, audit integration)
- Phase 6 federation protocol-layer RBAC + the narrowest-export-shape privacy contract (professional form)

#### Wave 0 — Personal Data Sources *(read-only ingestion; prerequisite for the federation modes below)*

Phase 20 federates household data but assumes it is *already indexed* — yet nothing ingests it today. This wave builds the personal data-source connectors that *feed* the household federation. This is the data class where local-first is a genuine moat: no one pastes their bank login or health history into a cloud AI, but a machine-local index that never leaves the device is exactly the trust model that fits. All Wave 0 sources are read-only and default to **non-federatable**.

- [ ] **Finance** — Plaid / SimpleFIN aggregator; read-only `account` + `transaction` item types; local-only, never exposed through a household namespace unless explicitly added to its shape.
- [ ] **Health & wearables** — Apple Health export / Google Fit / Oura / Whoop; `health_metric` item type.
- [ ] **Home** — Home Assistant; `home_device` + `home_event` item types.
- [ ] **Media / memories** — Plex / Jellyfin / local photo library (`media_item`); composes with the existing `google_photos` connector.
- [ ] **Wave-0 privacy default** — Wave 0 sources are non-federatable by default; a `health_metric` / `transaction` / `home_event` is exposable through a household namespace only when explicitly declared in that namespace shape. Extends the narrowest-export-shape contract (household variant) below.

#### Wave 1 — Personal & Household Federation

The federation primitive is intentionally general — once two Gateways can share a scoped namespace, the same mesh primitive serves use cases that cloud agents cannot legally or commercially handle.

- [ ] **Personal CRM** — a `person` table extension + `interaction` item type that indexes a user's relational history from already-indexed connectors: email threads (Gmail / Outlook), calendar attendees, Slack DMs + tagged channels, LinkedIn export (manual import), GitHub mentions. New built-in agent `nimbus contacts` answers "tell me about the last time I talked to Sara before our call," "who at Acme did I meet at the conference last year," "draft a follow-up to the people I had coffee with this week." Read-only; data never leaves the machine.
- [ ] **Family / couples mode** — a `family` namespace shape with two-to-six paired Gateways; shared item types limited to a conservative set (`event` from Calendar, structured `shopping_list` items, joint `expense` rows, custody/handover scheduling). HITL on every cross-device write. A contract test asserts no `email`, `pull_request`, `incident`, or work-item types are exposable through the family shape.
- [ ] **Friend-group mode** — same federation primitive as family mode, scoped to long-tail use cases with no cohesive home today: D&D campaign trackers, fantasy-league rosters, "who's free this weekend" coordination without surrendering full calendar visibility, group-photo sharing without a cloud upload.
- [ ] **Group-namespace policy fragments** — `[group.<name>].include_types = [...]` + `[group.<name>].exclude_services = [...]` enforced at the federation protocol layer; per-namespace HITL policy fragments live alongside `nimbus.policy.toml` so a family namespace can carry stricter rules than a work namespace on the same Gateway.
- [ ] **Privacy contract — narrowest-export-shape proof (household variant)** — for every group/family namespace shape, the test asserts the federation protocol cannot expose any item type or `raw_meta` field not declared in the namespace shape. Verified by attempting a federated query for a non-included type and asserting empty result + audit log entry recording the rejected query.

#### Acceptance Criteria

- Two paired personal Gateways share a `family` namespace; a contract test asserts no `email`, `pull_request`, `incident`, or work-item type is exposable through the family shape.
- `nimbus contacts` answers a relational-history query entirely from the local index with no outbound call.
- A federated query for a non-included type against a group namespace returns an empty result plus an audit-log entry recording the rejected query.

---

> **Phases 21–27 — the Sovereign-Proof arc.** Seven phases that promote the local-first thesis from a *property* into a *product*: a root of trust (21), then verifiable negatives (22), structural injection-inertness (23), counterfactual/provenance cognition (24), surveillance-free collective intelligence (25), provable governance (26), and accountable always-on autonomy (27). Sequenced so **21 ships first** — every downstream attestation roots its key, clock, and index there. The competitive thesis: cloud agents share one architecture (private data + untrusted content + a live egress vector in a multi-tenant process behind a vendor-controlled API), and that architecture makes each of these categories structurally impossible for them. None of these phases bump the *wired* invariant count (`I1`–`I21`) or North-Star count until their triples land; the new invariants (`I22`–`I24`) and pillars (`M9`–`M12`) are **planned**, recorded here and wired with their phase per the triple rule. **Suggested build order:** 21 (root of trust) → 23 (the taint cut — which also lands the per-connector provenance-tag mechanism Phases 10/24/27 all depend on) → 22, then 24/25/26/27; all seven are listed as planned, but the build is staged behind 21 + 23 rather than committed as one push.

### Phase 21 — Sovereign Trust Substrate

> **Sequencing (2026-06-17 overlay):** **Track 3 — Research Horizon** (Phases 21–27). The North-Star "M-number" frontier; the full vision stays, but its cheap *primitives* are harvested into the spine early (egress ledger → S1; local sub-agent fleet → S2 — both done). Not a decade-out sequence: a frontier we mine. See [§ Phase 7+ Sequencing Spine](#phase-7-sequencing-spine).

**Goal:** Ship the root of trust every downstream proof silently assumes. `M7`'s egress ledger, the EAF verifier, the Phase 12.5 bundle, and the Phase 22–26 attestation surfaces all sign with a gateway key and stamp a timestamp — yet nothing today says how an auditor anchors that key offline, what the timestamp is worth against a same-UID attacker who can rewind the clock, or whether the local index a claim reasons over was complete. This phase supplies the missing halves: key transparency, verifiable time, index freshness, and proof ergonomics. **It ships before Phases 22–27 — their attestations are only as trustworthy as the key, clock, and index underneath them.**

> **Composes with `M7` + S — Standards/EAF + Phase 12:** Phase 21 makes `M7`'s "proof this agent touched only these hosts" rest on a key an auditor anchored out-of-band and a clock they can trust; EAF v0.2 gains a key-transparency-inclusion field and a time-anchor field. Phase 12's external append-only sink remains the single public-anchoring path (KT heads ride it).
>
> **Composes with Phase 6 / Phase 11:** the relay-free NaCl-box channel + out-of-band peer pairing are how a box identity reaches a peer today; the KT log gossips identities over that same channel so a third gateway / auditor / insurer verifies a peer's key without a fresh pairing ceremony. Endpoint/measured-boot integrity is delivered in Phase 11 (hardware-vault home), not here.

#### Dependencies

- Phase 4 BLAKE3 audit chain (the chain verifiable time folds into; `db/audit-chain.ts`)
- Phase 6 federation NaCl-box gateway identity + out-of-band peer pairing (`federation/federation-identity.ts`, `federation/peer-pairing.ts`)
- `I16` verify-every-boot pattern; `I12` Vault (rotation key material, never on disk in the clear)
- S — Standards track: EAF v0.1 + `eaf-verify` (the verifier this phase extends)

#### Non-negotiable guardrails

- **No new trusted third party.** Key transparency is gossiped over the relay-free mesh; public-log anchoring is optional and additive (a witness, never a dependency). An air-gapped gateway still produces and verifies a complete attestation against its local mirror.
- **Fail-closed on trust ambiguity.** An attestation whose issuer key is absent/revoked in the verifier's KT view fails verification (never "warns"); a claim that cannot establish index freshness is emitted with explicit `freshness: unknown`, never silently treated as fresh.
- **Vault-only key material** (`I12`) — only public keys + signatures cross IPC / log / config boundaries.

#### Wave 1 — Key Transparency (the root)

- [ ] **Append-only key-transparency log (`kt_log`)** — a BLAKE3-chained, append-only log of `(subject, pubkey, valid_from, valid_to, supersedes)` for gateway + operator identities, via a generic `computeChainRowHash(prevHash, fields[])` factored out of the audit-chain writer (audit chain and `kt_log` both call it — the chain *pattern* is reused, not the fixed audit tuple). Proposes invariant **`I22`** (KT append-only + monotone head; triple when wired).
- [ ] **Offline trust-anchor (`nimbus trust export/import-anchor`)** — the keystone: a signed, human-fingerprinted one-pager (pubkey + KT genesis + BIP39-style out-of-band phrase) that lets an auditor / insurer / peer establish trust in a gateway key over a side channel with **zero network round-trip**; thereafter every EAF artifact verifies offline. No cloud attestor can answer "how does an air-gapped auditor trust your key with no network at all" — they root in an online CA / OIDC handshake / transparency-log fetch.
- [ ] **Gossiped mesh mirror + split-view detection** — KT heads + inclusion proofs propagate over the relay-free NaCl-box channel; a third gateway verifies a peer's current key + rotation lineage from its local mirror. Honest bound: split-view detection is **multi-peer-only**; a solo / air-gapped gateway gets monotone-head-only.
- [ ] **Rotation + revocation with cryptographic continuity (`I23`)** — the outgoing key signs its successor; a revoked key invalidates exactly its signing window (`supersedes` lineage). Recovery when an outgoing key is lost falls back to the out-of-band re-pairing flow (the downgrade seam is stated, not hidden). Proposes invariant **`I23`** (revocation-with-continuity).

#### Wave 2 — Verifiable Time

- [ ] **Monotonic high-water-mark in the chain** — a Vault-persisted monotonic counter folded into each BLAKE3 link; `verifyAuditChain` rejects a non-advancing counter. The offline guarantee is stated precisely: it detects **chronological inversion relative to the last-written row**, not absolute wall-clock duration.
- [ ] **Optional roughtime anchor** — opt-in, additive trusted-timestamp anchor (carved out of the `M7` background-call quota like the existing user-initiated fetches); offline installs degrade to monotonic-only with a clearly-labeled attestation. Lease / quorum / standing-approval expiry **fail-closed** when the system-clock↔counter delta crosses a safety threshold.
- [ ] **`Date.now()` ban in security-decision paths** — a static lint (sibling to the structure-audit D-checks) forbidding wall-clock reads in a named allow-list (quorum / delegation / standing-approval / lease expiry). *(Verifiable time is shipped as substrate hardening + an EAF field, **not** a standalone invariant — `eaf-verify` already checks timestamp monotonicity and the Phase 15 lease design depends on a wall-clock `expires_at`, which this reconciles rather than forbids.)*

#### Wave 3 — Freshness & Proof Ergonomics

- [ ] **Index freshness & completeness attestation** — a per-connector `synced_fraction` / staleness / `known_gaps` signal (with a per-connector-class definition: paginated REST cursor vs `[[filesystem.roots]]` walk). Every downstream provenance / oracle / "lie-detector" claim cites it; a claim that can't establish it emits `freshness: unknown`. Proposes the freshness-contract invariant (single `attachFreshness()` seam + a static rule that no export path bypasses it).
- [ ] **Index-at-rest tamper-evidence** — `nimbus index attest` produces a signed Merkle root over the index; `nimbus index verify` checks it; a mismatch sets the freshness contract to `tampered` (one detection, two outputs — single seam).
- [ ] **Roll-up verification (`eaf-verify`)** — human-legible aggregate verdicts over many receipts so a non-cryptographer auditor can triage volume; receipt expiry / revocation is surfaced. *(Sampled audit deferred to whichever phase first emits proof volume.)*

#### Acceptance Criteria

- An auditor on an air-gapped machine imports a gateway's trust anchor over a side channel, then verifies an EAF artifact offline with `eaf-verify`, zero network round-trip; a tampered or revoked-key artifact fails closed.
- A same-UID clock rewind followed by an audit append fails `nimbus audit verify` (the monotonic counter breaks the chain); the offline guarantee is documented as inversion-detection, not absolute-time.
- `nimbus index attest` then a mutation of an index row sets the freshness contract to `tampered`; a claim built on a `tampered` / `unknown` connector is emitted with that contract, never as fresh.
- A key rotation carries a continuity proof and a revocation invalidates exactly the post-revocation window (pre-revocation artifacts still verify), proven by an enforcement test.

---

### Phase 22 — The Proof Layer (Verifiable Negatives)

> **Research Horizon — primitive harvested (2026-06-17 overlay):** the always-on egress ledger + `nimbus prove` read-surface land early in **Track 1 / S1** (sourced from Phase 8 + Phase 7 W6). What stays here: portable, offline-checkable **per-answer** EAF receipts. See [§ Phase 7+ Sequencing Spine](#phase-7-sequencing-spine).

**Goal:** Promote EAF from a Phase 12.5 bundle artifact to a **per-answer live primitive** — portable, offline-checkable receipts that prove *what did not happen*. Anchors North-Star **`M9` (Verifiable Negatives)**. A relay vendor *is* the egress and *is* the data sink, so it can only assert non-egress / non-disclosure in a PDF; only a local-first, no-relay, `I15`-sandboxed, HITL-gated gateway can mint a credible negative.

> **Composes with Phase 21 (every receipt roots its key + clock there — hard blocker), `M7` (the egress negative is `M7` presented), S — Standards/EAF (receipts are EAF payload types verified by the same `eaf-verify` binary — hard blocker), `I17` (the non-disclosure receipt), Phase 12.5 (the deletion plan becomes a signed proof).**

#### Dependencies

- **Phase 21 substrate (hard blocker)** + **EAF v0.1 + `eaf-verify` (hard blocker)**
- `I17` query gate (non-disclosure receipt); the `I15` egress chokepoint (proof-of-silence)

#### Wave 1 — Receipts on already-shipped primitives

- [ ] **Notarized Non-Disclosure Receipt (headline)** — the answering peer hands the asker a portable, offline-verifiable proof that a federated query disclosed nothing beyond the declared `I17` shape. The one artifact a relay architecture *structurally cannot* produce (there is no relay that could have seen the bodies). **Bound to the query nonce / session** over the NaCl-box channel so it cannot be detached and replayed to vouch for a later leaky query.
- [ ] **Counterfactual Consent Receipt** — proof of an irreversible action the agent was about to take but didn't, backed by the gate's `hitlStatus` (`I4`) + the frozen `action.type` + a declared blast radius. *(The `M3`-trace-enriched version is stretch — `M3`'s reasoning trace is unbuilt substrate.)*

#### Wave 2 — Receipts needing new instrumentation

- [ ] **Egress-event instrumentation (prerequisite, net-new work)** — instrument the `I15` sandbox to emit per-query host-connect events. Cross-platform reality: per-host gating is degraded on Windows (AppContainer all-or-nothing; the spawn FFI is a tracked follow-up) and helper-dependent on Linux — so any receipt **fails closed to `indeterminate`** where the chokepoint cannot attribute.
- [ ] **Proof-of-Silence receipt (`nimbus prove --receipt`)** — a **new subcommand in the existing `nimbus prove` namespace** (Phase 11 ships the interactive before/after egress display; this adds the durable signed artifact) emitting `outbound_egress_events: 0` (connect()-level, **not** packet-level), `local_rows_read: N`, verifiable offline. Emits `indeterminate` (never a green zero) on a degraded platform; the acceptance corpus pins a fully-gated platform. Proposes the invariant: the negative is computed only from the chokepoint, never connector self-report, in a leak-proof receipt shape.
- [ ] **Provable Forgetting** — a signed deletion certificate proving a datum is gone **and** (citing the `M7` ledger for its lifetime) was never replicated; the non-replication leg emits `unprovable-before-T` if the datum predates ledger genesis or arrived via the non-`I15` filesystem path.
- [ ] **Receipt metadata hygiene** — bucket counts (`rows read: 10–50`), add issuance jitter, and rate/granularity-bound the publishable set (mirrors `I17` returning ranks, not raw scores) so the receipt itself is not a side-channel.

> **Cut / folded (per stress-test):** the Provable Air-Gap Beacon → an `M7`-export flag (`nimbus egress --beacon`), it is the empty-egress special case of the same scheduled export; the TEE-attested LLM-hop receipt → a stated non-goal ("we do not attest off-box hops; the canonical path is zero off-box hops via the router air-gap"), a hardware-vendor trust root contradicts the thesis. zk-EAF → a research note (one-fixture prototype at most).

#### Acceptance Criteria

- A federated query returns under the `I17` shape; the asker receives a Non-Disclosure receipt that `eaf-verify` validates offline against the answerer's Phase-21-anchored key; a replayed receipt from a prior query fails verification.
- On a fully-gated platform, `nimbus prove --receipt` over a local-only query emits a signed `outbound_egress_events: 0` artifact verifiable offline; on a degraded platform the same query emits `indeterminate`, never a false zero.
- A `nimbus dsr` deletion executed with `--execute` yields a deletion certificate whose non-replication leg reads `unprovable-before-T` for data older than the egress-ledger genesis.

---

### Phase 23 — Inert to Injection (The Unexfiltratable Agent)

**Goal:** Make prompt-injection **structurally inert, not filtered** — a successful injection can make the agent reason wrong but cannot exfiltrate, because the local process severs egress capability the moment attacker-influenceable content enters a turn, and proves it with a buyer-rerunnable conformance bundle that needs zero vendor trust. Competitors' best documented defense is sanitizers / MCP-gateways with **measured 60–72% attack-success rates**.

> **Composes with `M7` (the `I15` chokepoint), `I11` (the provenance seam — extended here), Phase 10 (the standing-approval taint-barrier proposal — *subsumed* by `I24` here, one invariant not two), Phase 8 (honeytokens + egress ledger), S — Standards/EAF (the attestation is an EAF payload). Distinct from `M7`, which proves *where* the agent went; this proves the agent *could not have leaked* while compromised.**

#### Dependencies

- `I11` wrapToolOutput envelope (extended here with a provenance tag); `I15` sandbox; Phase 4 multi-agent / `sub_task_results` plumbing; Phase 21 signing

#### Non-negotiable guardrails

- **Fail-closed on a degraded sandbox:** where the platform cannot prove the host-scoped cut, the network-bound action is **refused**, never silently allowed.
- **Untagged provenance = untrusted** (fail-closed) — but only once the tag-production mechanism exists (owned here).
- **Out of scope (stated honestly):** covert channels through an allowlisted-and-still-permitted host (DNS-name encoding, request timing) — `I24` cuts network-*write* capability, not every side channel.

#### Wave 1 — The cut

- [ ] **Provenance-tag production mechanism** — manifest-declared read-tool taint classes + an executor-side default, so a connector *declares* `trusted` / `untrusted` on the `I11` envelope (Phase 10 only *consumed* an undefined tag). Owned here so "fail-closed on untagged" is buildable without bricking every connector on day one.
- [ ] **Capability-revocation-on-taint (proposes `I24`)** — a **turn-scoped capability state object** in `engine/executor.ts`: the instant a turn ingests `untrusted` content, the executor **refuses further network-tool dispatch for the rest of the turn** — a *dispatch-time* gate (cross-platform, lives in the engine today), not a live mutation of the OS-sandbox network allowlist. **Subsumes the Phase 10 standing-approval taint barrier.** The gate consults the provenance tag only, never the tool name / payload (mirrors `I3`). Static complement (next free D-descriptor) + enforcement test.
- [ ] **Re-entry / re-clean path (own acceptance-gated sub-spec)** — when egress is severed mid-task, the re-clean gesture shows the write payload **verbatim + provenance-diffed against the untrusted source** (anti-laundering — a human approving a plausible ticket is exactly how injection launders), opening a fresh clean-provenance turn. The make-or-break UX; the canonical "read untrusted email → file ticket" workflow is the gating test.

#### Wave 2 — The proof

- [ ] **Signed per-response attestation** — a "this turn could not have exfiltrated" EAF payload (reuses the envelope / signing / verifier from `M7` + S — Standards; anchored outside the local chain per the same-UID caveat).
- [ ] **Buyer-rerunnable adversarial conformance bundle (headline)** — a signed binary the customer runs against **their own** gateway, with their connectors + data: it first **attests the sandbox-enforcement tier honestly**, then drives an injection corpus and shows the egress cut fire where the platform can prove it. "We are not asking you to believe a benchmark." Guards the corpus against supply-chain poisoning and never red-teams a live API in a way that abuses the user's real account.

> **Deferred out:** active honeytoken plant + scan → **Phase 8 W5** (Phase 8 already ships synthetic-credential honeytokens + the egress ledger; only the connector-quarantine state machine is net-new — land it there); the auditor-mode "behavior without data" appliance → a research bet (an unbounded information-flow problem).

#### Acceptance Criteria

- On a fully-gated platform, a turn that ingests an `untrusted`-tagged tool result cannot subsequently reach any allowlisted host (enforcement test); on a degraded platform the network action is refused, not silently passed.
- The conformance bundle, run on a fresh independently-provisioned gateway, reports the sandbox-enforcement tier and demonstrates the cut where provable; a seeded canary-exfil payload is blocked and the connector quarantined with a signed incident record.
- The "read untrusted email → file ticket" workflow completes through the re-clean path with the write payload shown verbatim + provenance-diffed; an untagged tool result is treated as `untrusted` (fail-closed).

---

### Phase 24 — Agent Archaeology

**Goal:** Put the past and the present in one process — replay the agent's reasoning *as of* any timestamp, re-litigate the incident corpus against today's code, and bind every asserted fact to a signed, replayable derivation. Anchors **`M10` (Causal Twin)** + **`M11` (Provenance-Bound Cognition)**.

> **Composes with `M8` (`item_history` state), `M5` (the static causal floor — the overlap is acknowledged, not re-minted), `M3` (the reasoning / evidence trace), `M1` (living memory), Phase 17 (the blast-radius engine), Phase 9 (calibration), Phase 12.5 (Article-22).**

#### Dependencies

- **`M8` `item_history` (hard prerequisite)** — the `--at` point-in-time recall must exist first (Phase 10 ships the flag; this phase standardizes on `--at` and keeps `--as-of` as a back-compat alias)
- `M3` reasoning / evidence trace; Phase 3 dependency graph; Phase 21 signing (federated leaves)

#### Wave 1 — Reasoning replay

- [ ] **`nimbus ask --at <t>`** (alias `--as-of`) — replays the agent's **decision + evidence-leaf set** against the `item_history` view at `t`, with a "what I knew then vs now" split. **Determinism is scoped to the decision + retrieved rows + recorded tool I/O** — any LLM-re-invoking step is labeled `modeled, not replayed` (LLM output is not byte-deterministic; this also corrects the existing roadmap's unqualified "reconstructs deterministically"). A recorded model no longer loadable → `model-substituted, not faithful`. The replay executor is **egress-incapable**: a replay path that attempts a connector call aborts fail-closed at `gate()`.

#### Wave 2 — The counterfactual court (anchor demo)

- [ ] **Merge-time extinction ledger** — a standing watcher re-runs the historical incident corpus against today's code via the `M5` static simulator on every merge and posts mechanical verdicts: *"incident class X is now extinct — PR #4412 removed the null path; class Y would still page."* **Incremental** (re-litigates only classes whose causal path touches the merged diff; a corpus / time ceiling lives in `[archaeology]`). An `extinct` verdict carries **coverage / blind-spots** ("extinct within statically-reachable paths; N dynamic paths unanalyzed") — a false extinction is dangerous, so it bears an asymmetric honesty bar. Feeds `M2`'s "incidents prevented" with a real signal. Verdicts are `I11`-untrusted / advisory and can never satisfy a standing rule (the taint barrier already covers replay output).

#### Wave 3 — Provenance-bound cognition (`M11`)

- [ ] **Per-claim evidence DAG** — every asserted fact in an admissible artifact ships a content-addressed, replayable evidence DAG, **default-collapsed and lazily computed** (ordinary answers untaxed). Per-leaf signing is **federated-only** (intra-box leaves are covered by the BLAKE3 chain; cross-gateway leaves carry the originating gateway's `I16` signature). A claim with no retrieved leaf is emitted `ungrounded` and is **structurally barred from carrying a signature** (proposes the evidence-DAG invariant). Exported DAGs pass an `I17`-style leak-proof shape (ranks / hashes / declared shape, not bodies / raw row IDs unless grant-scoped).
- [ ] **Erasure reconciliation** — the append-only DAG / memory vs GDPR erasure (Phase 12.5 Article-17) is reconciled via tombstone-with-proof / salted hashes / chain-segment rotation; evidence leaves eligible for admissible artifacts pin against the `M8` prune via `[archaeology].evidence_pin_retention_days`.

> **Deferred out:** HITL-dialog enrichment / surprise-detection → **Phase 17** (keep only "render blast-radius inside `gate()` for all gated actions", reuse Phase 17's engine); the learned dynamics twin → a research flag (needs a metric / trace TSDB the item-shaped index lacks; gated on a go/no-go Brier-score floor); chained agent memory → **Phase 10** episodic-memory hardening; the legally-admissible decision record → a one-line cross-reference from Phase 12.5 Article-22 to the evidence-DAG invariant.

#### Acceptance Criteria

- `nimbus ask --at <t> "<incident question>"` reconstructs the decision + evidence-leaf set against the `item_history` view at `t`; LLM-re-invoking steps are labeled `modeled`; a replay that attempts a write aborts fail-closed.
- A seeded merge that removes a null path flips the matching incident class to `extinct` with the citing PR and a stated coverage caveat; a distant change that silently revives a path does **not** produce a false `extinct`.
- A `nimbus dsr` / Article-22 artifact carries a per-claim evidence DAG whose leaves verify offline; an `ungrounded` claim cannot be signed; an exported DAG carries no item body or raw row ID outside its declared shape.

---

### Phase 25 — Confidential Mesh Compute

**Goal:** Cross-org learning where there is **no operator who could see member data** — because there is no operator. The substrate that finally realizes North-Star **`M4`**. A cloud benchmarker that can tell you "47 orgs had this" *is* the operator that saw 47 orgs' incidents; Nimbus answers over the relay-free mesh carrying only sketches and aggregates, never bodies.

> **Composes with `M4` (its delivery home), `M2` (cross-org preventive ops), `I21` (DISTINCT-peer counting), `I17` (the leak-proof discipline — this is *stricter*, see below), Phase 15 (the cross-org lease envelope), Phase 21 (the eventual Sybil-resistance root), `M7` (each round attestable as relay-free).**

#### Dependencies

- Phase 6 federation (NaCl-box channel); `I20` / `I21` identity-valid + DISTINCT-peer quorum
- Phase 21 key-transparency (the eventual Sybil root) — but the security-critical floor **also stands on the shipped `I18` + Phase 6 peer-pairing** so it does not hard-depend on a later phase

#### Non-negotiable guardrails

- **Opt-in at the team / org level via `nimbus.policy.toml`, off by default, never per-engineer** (per `M4`).
- **Body-free by construction** — frames carry only fixed-width sketch / secret-share / PSI-token / DP-scalar shapes, with a **size + structure bound** (not just a "no body field" name-check, so a compressed body can't ride inside an opaque blob). Note this is **stricter than `I17`**, whose query gate deliberately shares a 280-char snippet under consent — *not* an extension of it.

#### Wave 1 — Sketch tier (ships first; herd immunity)

- [ ] **Federated incident-pattern Bloom/MinHash mesh** — `nimbus mesh seen <fingerprint>`: "has anyone seen this change-fingerprint / incident-signature?", carrying only sketches. **Surveillance-free herd immunity** (extends `M2`): "this fingerprint preceded outages at 47 *distinct* peers (real `I21` count), pattern only — never a single peer's incident." Honest threat model: MinHash leaks similarity by design, so the claim is bounded ("reveals no more than declared similarity to a probe a peer already holds; no literal path / identifier string") and a **probe-budget per asking peer** prevents sweeping the fingerprint space (the membership-oracle hole — and this is the tier that ships first).
- [ ] **Body-free frame invariant** — every mesh-compute frame routes through one `federation/mesh-compute-gate.ts`; proposes the invariant + a static complement.

#### Wave 2 — Secure aggregation (research deliverable)

- [ ] **Additive-secret-sharing reference round** — a single protocol-level deliverable (small-N reference round + a published threat model) under **experimental-exit criteria, not phase-completion criteria**. DP budget is tracked at a **per-box global ceiling** (composition across overlapping cohorts, not per-cohort); the k-anonymity floor states its honest-but-curious assumption (it collapses under k-1 colluding members). *(PSI, the k-anon DORA benchmark CLI, and the DP model-routing commons are cut as me-too / lowest-confidence; MTTR-as-aggregate survives only as an example inside the DP item.)*

#### Wave 3 — Trust floor

- [ ] **Sybil-resistant admission + Byzantine-robust aggregation** — a contribution is admitted only from an attested identity (`I18` + peer-pairing now; a KT-inclusion proof once Phase 21 lands); rounds use robust estimators (trimmed mean / coordinate-wise median) + share-consistency checks bounding any single peer's influence; a deny / abort / malformed share fails the whole round (reuses `I21` fail-closed). Cross-peer round integrity rests on the per-box Phase 12 external-sink push (a same-UID peer can truncate its own view).

#### Acceptance Criteria

- A peer queries `nimbus mesh seen <fingerprint>` and learns a DISTINCT-peer match count with no item body, query string, or peer identity disclosed; a peer exceeding its probe budget is throttled; a frame carrying a body field is rejected at the federation boundary.
- An injected poisoning peer cannot move a released aggregate beyond the proven influence bound and a single abort fails the round; a contribution from an unattested / Sybil key is dropped and audit-logged.

---

### Phase 26 — Provable Governance

**Goal:** Turn governance from advisory middleware into **structural, attestable law** — policy compiled *into* the same gate that backs `I2`, with an offline-verifiable proof that the running gate-set equals the signed policy. Anchors **`M12` (Provable Governance)**. Cloud "guardrails" are server-side filters an admin configures away; the gate is the only place actions execute, so compiled policy is unbypassable and the boot attestation is checkable with no vendor trust.

> **Composes with Phase 6 org-policy + Phase 12 policy-as-code (adds the enforcement attestation neither has), Phase 16 (generalizes + *subsumes* the skill-pack "cannot loosen HITL" rule — load-time → boot-attested), `I20` / `I21` (quorum), Phase 15 (leases), Phase 17 (rollback), Phase 21 (anchoring).**

#### Non-negotiable guardrails

- **Break-glass can suspend a policy-added class only — never an `I2` frozen-set member, never the irreversible boundary**; rate-ceilinged.
- **Drift / attestation evidence anchored outside the local chain** (same-UID truncation), else it proves nothing against a post-RCE adversary.

#### Wave 1 — Compiled gate + attestation

- [ ] **Signed `nimbus.governance.toml` → compiled gate (proposes the policy-boot-attestation invariant)** — the signed policy compiles at boot into additional HITL classes / quorum thresholds / reversibility floors enforced by the same `gate()` as `I2` / `I3` / `I4`; the compiler is **loosening-incapable** (may only add to the effective set / raise thresholds; rejects any attempt to remove from the frozen `HITL_REQUIRED` set). Generalizes and subsumes the Phase 16 skill-pack rule (the load-time check becomes its fast-fail). A boot attestation binds `BLAKE3(compiled gate-set) == BLAKE3(signed policy)`, verifiable offline. On a single-user install with no signed external policy it attests against the baked-in frozen set (a tamper-evidence check, not an authority check).
- [ ] **Dry-run simulator + break-glass** — `nimbus policy simulate` shows what a policy would block before it goes live (the gate is unbypassable, so a misconfigured policy could brick an on-call engineer); the mandatory break-glass escape suspends a single policy-added class for one incident, witnessed by quorum. (`nimbus policy explain` is folded into this UX, not a separate command — it duplicates Phase 16's `nimbus config explain`.)
- [ ] **Drift Sentinel** — a low-frequency loop re-emits the boot attestation and fails the affected capability **closed** on any divergence between the running gate-set and the certified policy, writing a `governance_drift` entry (anchored externally).

#### Wave 2 — Bounded autonomy primitives

- [ ] **Witnessed quorum without a server** — true M-of-N threshold signatures over the action payload (extends `I20` / `I21` from counting to crypto proof; a trusted-dealer bootstrap ships, DKG is stretch); fail-closed on an under-threshold / duplicate-signer proof.
- [ ] **Capability leases + egress-budgeted autonomy** — time-boxed, revocable, signed grants of what the agent may *do*, and a spendable network-calls envelope decremented **at the `I15` boundary** (extends `I15` / static D10, fail-closed mid-action, checked immediately before the connector call); reuses the Phase 10 standing-approval storage (one grant system, not two).
- [ ] **Reversibility insurance** — pre-commit undo snapshots + a **provable** undo-coverage-% computed from per-connector inverse-op availability; writes with no inverse (`email.send`, `repo.push`, `pipeline.trigger`) are **0% = irreversible by construction** and never asserted reversible (per Phase 17's "never claim reversible it can't prove").

#### Acceptance Criteria

- An org ships a signed `nimbus.governance.toml`; on boot the gateway compiles it into the gate and emits an attestation an auditor verifies offline that the running gate-set == the policy hash; a policy attempting to remove a frozen-set member is rejected at compile.
- An irreversible action gated by M-of-N quorum unlocks only when a valid threshold signature verifies; an under-threshold / duplicate-signer proof fails closed; break-glass cannot touch a frozen-set member.
- An autonomous task's egress budget is decremented at the `I15` boundary and refuses the over-budget call fail-closed; a write with no connector inverse is classified irreversible (0% coverage).

---

### Phase 27 — The Agent Society

> **Research Horizon — primitive harvested (2026-06-17 overlay):** the overnight local sub-agent **fleet** lands early in **Track 1 / S2**. What stays here: the full standing, safe agent-organization. See [§ Phase 7+ Sequencing Spine](#phase-7-sequencing-spine).

**Goal:** Exploit zero-marginal, rate-limit-free local compute to run what metered clouds can't — a tireless tier-0 on-call Captain and a standing agent organization — **made safe only by the structural irreversible boundary + a do-no-harm host scheduler**. Embodies **`M3` (Accountable Autonomy)** (not a new North-Star). The killer demo, productized.

> **Composes with Phase 26 (leases / egress budgets / reversibility floors — hard dependency), Phase 17 (the interactive copilot it escalates from), Phase 10 (standing approvals + the taint barrier), Phase 4 (multi-agent), Phase 11 (biometric irreversible-edge HITL), Phase 23 (`I24` taint barrier).**

#### Non-negotiable guardrails

- **The taint barrier is a hard dependency:** a Captain mitigation whose trigger derived from attacker-influenceable content (a poisoned log line) **falls back to HITL** — injected content can never drive an autonomous action, even a reversible one (`I24`). *(The single most important guardrail in this phase.)*
- **Rotation-slot accountability:** the human on-call is always notified the Captain holds / held the slot; the Captain hands the slot back / escalates within a bounded timeout; no silent autonomous tenure.
- **Do-no-harm to the host:** autonomy yields to the user's real work; an incident lease carries precedence over background society tasks.

#### Wave 1 — The Captain

- [ ] **Autonomous on-call Captain** — Phase 17's copilot **minus the human-in-the-loop on reversible actions**: it receives the page, runs the Phase 17 investigation (referenced, not recapitulated), performs pre-authorized reversible mitigations bounded by a Phase 26 capability lease + egress budget + bonded undo + reversibility floor, and pulls a human in via Phase 11 biometric HITL **only at the irreversible edge** with a confidence + cited-evidence brief. Safe only because the executor structurally forbids crossing the irreversible boundary.

#### Wave 2 — The society + its economy

- [ ] **Local compute economy (load-bearing prerequisite)** — one PAL-resident scheduler: probe host class (laptop / workstation / NPU) → select a capability tier → admit / defer per live battery / thermal / contention, with graceful degradation. "Free FLOPs" is real on an idle workstation and a thermal / UX disaster on a laptop on battery; this scheduler is what makes standing autonomy honest.
- [ ] **Nimbus Guild** — a persistent local multi-agent org with roles + a tamper-evident minutes book (anchored externally); every Guild item inherits the `I11` / `I24` taint constraint and runs as a host-idle society task (including `M1` / Phase-10 memory consolidation — not a separate "dream loop").

> **Deferred / cut:** on-device speculative-reasoning ensembles → stretch (unproven on local FLOPs; value hinges on a trustworthy verifier — the open problem); a nightly "dream" loop → folded into Phase 10 memory + the idle scheduler; energy-attested autonomy → cut (per-process joule telemetry isn't uniform across the win32 / darwin / linux PAL backends → fails platform equality by construction).

#### Acceptance Criteria

- On a seeded reversible bad-deploy incident, the Captain investigates, performs the pre-authorized reversible rollback within its lease + egress budget, and surfaces an irreversible follow-up step for biometric HITL only; `nimbus audit replay <incident-id>` reconstructs every step and the human on-call was notified the Captain held the slot.
- A Captain mitigation whose trigger derived from `untrusted`-tagged incident content falls back to HITL (does not auto-act); an over-budget or lease-expired action aborts before the connector.
- On a battery-constrained host the scheduler defers non-incident society tasks while an incident lease still runs (precedence stated); the Guild minutes book is anchored externally.

---

### North-Star Capabilities (cross-phase)

Audience-agnostic "no other tool does this" pillars, each enabled **because** of local-first / no-relay / HITL / audit. They thread through several phases rather than living in one; M1 and M3 are each strong enough to anchor a late phase.

- [ ] **M1 — The Org's Living Memory** — the org's permanent, queryable institutional memory (*"why did we choose Kafka in 2024?"*, *"we tried this migration before — why did it fail?"*). Extends Phase 7 ADR drafter + Phase 10 episodic/point-in-time + Phase 16 collective Q&A.
- [ ] **M2 — Preventive Ops** — learns from *your own* incident history the patterns that precede outages and warns at change time; headline signal **incidents prevented** (a heuristic — pattern-match + engineer-acted-on-warning — not a provable counterfactual). Extends Phase 17 W1 + Phase 9 local fine-tune.
- [ ] **M3 — Accountable Autonomy** — multi-step loops end-to-end, HITL only at irreversible steps, **every decision replayable** (`nimbus audit replay`). *(Substrate: faithful replay needs the agent's reasoning/evidence trace captured, not just actions + HITL status — an extension beyond `audit_log` + `tool_call_log`, designed with the replay feature.)* Extends Phase 10 + Phase 14.
- [ ] **M4 — Surveillance-Free Collective Intelligence** — cross-team/cross-org benchmarking + shared incident-pattern learning via secure aggregation over the relay-free mesh, **with nobody's data leaving their machine. Opt-in at the team/org level via `nimbus.policy.toml`, off by default, never per-engineer.** Extends Phase 6/11/15; **delivered by Phase 25 (Confidential Mesh Compute)** — the sketch/secure-aggregation substrate + the Sybil-resistant, Byzantine-robust trust floor.
- [ ] **M5 — Counterfactual / Time-Travel Ops** — v1 is *static/causal analysis* (config + code paths + dependency graph + indexed integration-test history); live simulation of stateful external systems is out of scope. Extends Phase 10 point-in-time + Phase 14.
- [ ] **M6 — The Self-Extending Agent** — notices its own gaps (toil heatmap) and **drafts its own connector/automation**: read-only by default, contract-tested against the SDK, generated only against an authoritative published spec (never hallucinated), sandboxed (`I15`), HITL-installed + `I16`-signed; never auto-tests writes against a live API. Extends Phase 14 + Phase 16.
- [ ] **M7 — Provable Locality** — a continuous, cryptographically-attestable **egress ledger**: every network host the gateway and each sandboxed connector contacted, exportable as an auditor-grade artifact (*"proof this agent touched only these hosts this quarter"*). Uncopyable **because** of local-first + no-relay + `I15` — the sandbox already enforces a per-host network allowlist per connector, so the ledger is a faithful record, not a self-report; a cloud competitor (which *is* the egress) structurally cannot produce one. Promotes the killer demo's "0 outbound network calls" from a demo flourish to a product. Extends Phase 8 (the ledger + `nimbus egress` + signed report) and Phase 12 (auditor-grade compliance export); built on `I15` + the BLAKE3 audit chain. The chain is tamper-*evident*, not tamper-*proof* (a same-UID attacker could truncate + regenerate it); the Phase 12 export is **scheduled and pushed to an external append-only sink**, and that cadence — not the local store — is what bounds the rewrite window.
- [ ] **M8 — Time-Travel** — point-in-time queries over the structured `item` table: `nimbus ask --at "2026-04-15T14:00Z" "..."` (alias `--as-of`; `--at` is the shipped Phase 10 flag). The local index becomes an append-only audit-grade timeline of every change to every connected system the user touched. Scoped narrowly: **structured items only**, not vectors (vector-index snapshots blow up disk — 1M items × delta × 365 days is hundreds of GB before compression). 30-day default retention; configurable via `[index].timetravel_retention_days`. Use cases: incident retrospectives ("what did our deploy state look like 30 seconds before the alert fired?"), legal discovery, post-mortem reconstruction, "what did we know when we made this decision." Uncopyable **because** local-first plus the BLAKE3 chain — cloud agents discard intermediate states; only the user's own machine has the raw history. Extends Phase 10 point-in-time + the existing audit chain; relates to M5 (counterfactual) which uses M8 as substrate. Implementation: per-write snapshot row to a `item_history` shadow table with TTL-driven prune; vector recall stays current-state-only.
- [ ] **M9 — Verifiable Negatives** — portable, offline-checkable receipts that prove *what did not happen*. The egress negative is **M7 presented as a negation**; the net-new surface is the **taint negative** ("no untrusted-tagged content crossed into a privileged action" — hard-depends on the Phase 23 provenance tag; **fail-closed/unprovable when the tag is absent, never vacuously true**) and the **residency negative** ("this subject's data never left the box"). Uncopyable **because** an architecture that *is* the network cannot sign "I didn't egress." Delivered by Phase 22 on the Phase 21 substrate; verified offline with `eaf-verify`. Same-UID caveat: a receipt is only as strong as the external-sink anchor cadence (per M7).
- [ ] **M10 — Causal Twin / Counterfactual Cognition** — past and present in one process. The net-new atom is the **merge-time extinction ledger** (mechanically asserting an incident class extinct-or-surviving against today's code, with a stated coverage caveat), not a new simulator: the **floor** is M5's static causal analysis over M8 state with the M3 trace (the overlap is acknowledged, not re-minted); the **ceiling** is a learned per-customer dynamics twin (research, gated behind Phase 9 calibration so confidence is always shown). Determinism is scoped to the decision + evidence-leaf set; any LLM-re-invoking step is `modeled, not replayed`. Delivered by Phase 24.
- [ ] **M11 — Provenance-Bound Cognition** — every asserted fact bound to a content-addressed, replayable evidence DAG; agent memory append-only + BLAKE3-chained; the agent emits `ungrounded` (and **refuses to sign**) rather than confabulating when a leaf can't be reconstructed. Per-leaf signing is **federated-only** (intra-box leaves are covered by the chain). Uncopyable **because** only the local machine holds per-leaf provenance back to the raw indexed source. Delivered by Phase 24; extends M3 + M1 + Phase 12.5 Article-22.
- [ ] **M12 — Provable Governance** — policy compiled *into* the consent gate (not advisory middleware) with an offline-verifiable boot attestation that the running gate-set equals the signed policy hash. Uncopyable **because** the gate lives in the executor and a cloud agent *is* the runtime (its attestation would be self-attested). Sits beside M7: M7 proves *where bytes went*; M12 proves *what the gate would and wouldn't allow*. Delivered by Phase 26.

**Connective tissue** (the substrates that make the above one product): the **proactive meta-agent** ("what should I look at right now?" — routes to the right brief by context across ~15 built-in agents); the **Impact Ledger** (one tamper-evident measurement spine feeding the team ROI report, the evaluator "look what it did this week," and M2); a **causal/temporal event spine** (under M1/M2/M5); a first-class **transparency surface** (always-visible "Local Only" egress indicator — M7 is its signed, exportable form — plus inspect/delete-everything + decision replay); and the **"when the agent is wrong" backbone** (calibrated confidence with the humility to say "I'm not sure," one-keystroke undo, wrong-recommendation feedback that lowers future confidence — shared with Phase 17's remediation).

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

<a id="s--standards-cross-phase"></a>

### S — Standards (cross-phase track, reference-impl only)

A standing track that publishes the format specs Nimbus consumes anyway, as **reference implementations** other tools can read. Explicitly **not** an attempt to win an IETF / CNCF / NIST process — adversarial review of the "own a standard" framing made it clear that a small vendor cannot push a spec through a standards body without prior share, and that "if we publish it, they will come" is the standards graveyard. The track ships specs as a marketing artifact + a verifier CLI; whether they become de facto is determined downstream by adoption, not upstream by lobbying.

Three of the four original standardization candidates (LAIP, PAT, SCM) are demoted to internal formats — referenced by name in the relevant phase but not standardized. The fourth, EAF, survives because it has an existing constituency (security teams reviewing the user's deployment, per Phase 12.5) that no other party currently serves.

#### EAF — Egress Attestation Format (anchor)

- [ ] **EAF v0.1 published** at `standards.nimbus-agent.dev/eaf/v0.1` (or the `nimbus-standards/` directory if `nimbus-agent.dev` doesn't yet host a standards subpath) — JSON Schema + narrative spec describing the egress-ledger record format, the BLAKE3 chain primitive, the signed-envelope envelope, and the verification semantics. License: Apache 2.0 so derivative implementations are unblocked.
- [ ] **`eaf-verify` CLI** — small standalone Bun (or Go for portability) binary that takes an EAF artifact + the issuer's public key and verifies: (a) chain integrity, (b) issuer signature on the envelope, (c) timestamp monotonicity, (d) every claimed egress event has a complete record (no `null` host fields). Distributed as a single binary so a security reviewer can drop it into their CI without installing Nimbus.
- [ ] **Reference fixtures** — committed under `docs/standards/eaf/fixtures/` — a golden valid artifact, a golden tampered artifact (chain break), a golden truncated artifact, a golden re-signed artifact (replayed envelope). Used as a conformance suite for any derivative implementation.
- [ ] **EAF in Phase 12.5** — every compliance bundle's egress-ledger section is an EAF v0.1 artifact (already noted in Phase 12.5). The Phase 12.5 bundle's `verify.sh` invokes `eaf-verify` against the included egress section.

#### Demoted formats (referenced internally, not standardized)

- [ ] **LAIP (Local Agent Interop Protocol)** — internal wire format for Nimbus-to-Nimbus federation (Phase 6, Phase 11). Documented in `docs/protocols/laip.md` as an internal spec. Not pursued as an external standard — bilateral protocol adoption requires industry incentive that doesn't exist.
- [ ] **PAT (Portable Agent Trace)** — internal format for the M3 replay trace (reasoning + evidence + decision path). Documented as part of the M3 substrate work. The cross-agent handoff exporter (`nimbus export-session`) writes PAT; importers in Claude Code / Cursor are demoted from "phase deliverable" to "demo + courtesy bridge if a third party wants to consume it." No bet on bilateral adoption.
- [ ] **SCM (Signed Connector Manifest)** — already implemented as the `I16` chain; the Phase 9.5 published manifest schema is its reference implementation. Documented as a section of the Phase 9.5 spec rather than a standalone RFC.

#### Acceptance Criteria (track-level, not gated by a single phase)

- EAF v0.1 + its verifier CLI + its conformance fixtures are published and reachable from `docs/standards/eaf/`.
- Phase 12.5 bundles include EAF artifacts that the `eaf-verify` binary validates offline against the published Nimbus issuer pubkey.
- At least one third party (an auditor, a security consultancy, or another local-first agent vendor) has run `eaf-verify` against a Nimbus-produced artifact and provided feedback — even rejecting feedback counts; the existence of an outside reader proves the artifact has crossed a credibility threshold.
- The PAT and LAIP internal specs are documented enough that a future contributor can implement against them; SCM's reference implementation matches the Phase 9.5 manifest schema 1:1.

---

## How to Update This Document

- When a phase becomes active, update its status in the overview table and add a progress note (e.g. "~14 of 21 items complete").
- Check off individual items (`[x]`) as they land on `main`; update the progress count in the phase status note.
- When a phase completes, add a **Delivered** section (see Phases 1 and 2 for the format) and update the status table.
- Do not add new items to an active phase without a corresponding issue and team discussion.
- Planned phase items can be reprioritised between phases — open a discussion, then update this file and `CLAUDE.md` and `GEMINI.md` (AI assistant context files at the repo root that carry architecture and convention summaries for AI-assisted development) to match.
- New phases can be added after the last planned phase; do not insert phases between active/complete phases.
- Update the "Last updated" note at the top whenever significant waves of work land on `main`.
