# Phase 6 Planning + Slice 1 (Federation Core) — Design

**Date:** 2026-06-04
**Author:** Asaf Golombek
**Status:** Draft for review
**Branch:** `worktree-dev+asafgolombek+phase6-planning`

---

## 1. Purpose & Context

Phase 5 (The Extended Surface) closed ✅ on 2026-06-04. This document does two things:

1. **Corrects a roadmap sequencing error.** Phase 5.5 (Marketplace Registry) has a hard dependency on **Phase 9 Wave 5** (the `nimbus eval` extension-eval framework) — its acceptance criteria literally cannot be met before that framework ships. A phase numbered "5.5" cannot sit four phases ahead of its own blocker. It is relocated and renumbered to **Phase 9.5**, immediately after Phase 9.
2. **Begins planning Phase 6 (Team).** Phase 6 as written in `docs/roadmap.md` bundles 8+ independent subsystems — far too much for one implementation spec. This document **decomposes** Phase 6 into independently-shippable slices (9 retained in Phase 6 + 1 deferred), fixes the dependency order, defers the consumer-oriented federation modes out of scope, and provides the **full design for Slice 1 — Federation Core**, the foundational substrate every other slice depends on.

The actual *build* of Slice 1 is a large, separate effort that will get its own implementation plan. The deliverable of the current workstream is the **planning artifacts**: this spec + the roadmap restructuring it prescribes.

### Non-negotiables this design must honor

- **Local-first** — the machine is the source of truth; federation shares *scoped slices*, never the whole index, and never via a relay server.
- **HITL is structural** — consent for a federated query is a gate in the answering Gateway, not a prompt convention; it cannot be bypassed or configured away.
- **No plaintext credentials** — Vault only; federation never moves secrets in Slice 1 (Team Vault is a later slice).
- **Platform equality** — Windows/macOS/Linux equal; mDNS discovery must work or degrade gracefully on all three.
- **Built for professionals** — Phase 6 targets engineering teams; consumer-oriented affordances are out of scope (drives the deferral in §3).

---

## 2. Roadmap Change-Set

These are concrete edits to `docs/roadmap.md` (and one to `docs/CHANGELOG.md`), to be executed as part of the implementation plan derived from this spec.

### 2.1 Relocate & renumber Phase 5.5 → Phase 9.5

- **Move** the entire `### Phase 5.5 — Marketplace Registry` section (currently the first entry under `## Planned`) to **immediately after Phase 9** (after Phase 9's closing `---`, before `### Phase 10 — The Autonomous Agent`).
- **Rename** the header to `### Phase 9.5 — Marketplace Registry`.
- **Update the Status Overview table**: move the `Phase 5.5 | Marketplace Registry | Planned` row to sit between Phase 9 and Phase 10, renamed `Phase 9.5`.
- **Update the Contents list** (the "Planned — Phases 5.5 through 19 …" line) to read "9.5" and re-order the parenthetical.
- **Reword the in-section "Composes with Phase 9" note.** It currently says Phase 9 ships Wave 5 "*before* Phase 5.5 closes" — now that 9.5 follows 9, reword to: "Phase 9 Wave 5 is a hard prerequisite delivered in the immediately preceding phase; the marketplace UI consumes its quality scores from day one."
- **Fix every cross-reference** that names "Phase 5.5" elsewhere in `roadmap.md`. Known sites (verify with a final `grep` for `5\.5` after editing):
  - The Phase 5 status note (`### Phase 5` block) — "tracked in **Phase 5.5**".
  - The Phase 5 acceptance-criteria bullet referencing `[Phase 5.5 (Marketplace Registry)](#phase-55--marketplace-registry)` — update text **and** the anchor to `#phase-95--marketplace-registry`.
  - Phase 9 Wave 5 bullets that reference "Phase 5.5's registry-side reproducibility check" / "Phase 5.5 'Quality regression watcher'".
  - The Phase 9 Wave 5 acceptance criterion mentioning "Phase 5.5's registry-side reproducibility check".
  - Phase 18 (Vertical Personas) dependency + body lines naming "Phase 5.5 marketplace registry".
  - The S — Standards track lines naming "Phase 5.5 published manifest schema" / "Phase 5.5 spec" / "Phase 5.5 manifest schema".
- **Update all anchor links** `#phase-55--marketplace-registry` → `#phase-95--marketplace-registry` repo-wide. Known external site: `docs/CHANGELOG.md` (grep `5.5` / `Marketplace Registry` there). Leave the connector-SVG asset files (they match `5.5` only as a viewBox coordinate — *not* a reference) untouched.
- **Add a dated note** to the roadmap's "Last updated" line recording the 5.5→9.5 renumber and the Phase 6 decomposition.

**Acceptance for this edit:** after the change, `grep -n "Phase 5\.5" docs/` and `grep -n "phase-55" docs/` return **zero** prose/link hits (asset-file coordinate matches excepted), the Status table reads in ascending phase order, and every link to the Marketplace Registry section resolves.

### 2.2 Defer Phase 6 sub-project #8 (personal/family/friend federation) → new Phase 20

The Phase 6 sections **"Personal Federation (beyond the engineering team)"** (Personal CRM, Family/couples mode, Friend-group mode, Group-namespace policy fragments, Privacy-contract narrowest-export-shape proof) conflict with guiding-principle #7 ("built for professionals; consumer-oriented affordances are out of scope").

- **Move** those bullets out of Phase 6 into a **new dedicated phase: Phase 20 — Personal & Household Federation**, appended after Phase 19 (the last numbered phase). A dedicated phase — rather than a subsection of Phase 19 "Ambient Surfaces" — avoids mixing the consumer-federation theme into Phase 19's wearable/voice/XR scope (review note #2).
- **Keep** the underlying *primitive* in Phase 6: Phase 20's framing note states these modes build for free on Slice 1's federation core — no new infrastructure, only narrower namespace shapes + a different audience — and that the phase is sequenced last so the professional team-federation surface proves out first.
- The **"narrowest-export-shape" privacy-contract proof** is a genuinely general safety property; a *professional* form of it (the leak-proof contract test) stays in Slice 1 (§5). The *family-namespace* variant moves to Phase 20 with the rest.

### 2.3 Record the Phase 6 delivery-slice decomposition in the roadmap

Add a short **"Phase 6 — Delivery Slices"** subsection at the top of the Phase 6 body (before "Federated Query Consent (foundational)") capturing the table in §3 below, so the roadmap reflects the sequenced shape, not just an undifferentiated feature list. Each slice links to where its features already live in the section.

---

## 3. Phase 6 Decomposition (9 retained + 1 deferred)

| # | Slice | Depends on | Notes |
|---|-------|-----------|-------|
| **1** | **Federation Core** | Phase 4 E2EE LAN + audit chain | The substrate. Specced in full in §4–§7. |
| 2 | Team Vault + Multi-user/Quorum HITL | 1 | Quorum HITL touches the write executor (I2). |
| 3 | Identity — SSO/OIDC/SAML + SCIM | 1 | Gates the BI connectors. |
| 4 | Org Policy Engine + Admin Console + Observability | 1 | `nimbus.policy.toml`, enforcement at startup. |
| 5 | ChatOps (Slack/Teams bot, HITL-via-chat) | 1, 2 | Bot token lives in Team Vault. |
| 6 | Cross-colleague intelligence (ghost reviewers, conflict detection, cloud janitor, huddle, tribal-knowledge, blast-radius preflight) | 1 | All route through Slice 1's consent + expertise primitives. |
| 7 | Data Warehouse & BI connectors (Snowflake, Tableau, Looker, PowerBI, Monte Carlo, Bigeye) | 2, 3 | SSO-gated; standard connector work. |
| 8 | Share & Virality primitives (`nimbus share`, verify-share, referral, recipe, replay) | 1, Phase 4 signing | Was sub-project #9; renumbered after #8 deferral. |
| 9 | Deferred Phase 5 items (web clipper, Mendeley, Apple Mail/Cal, Workday, GitOps/ML writes) | mostly independent | Workday pairs with SSO (Slice 3). |
| — | ~~Personal/Family/Friend federation~~ | — | **Deferred to a new Phase 20 — Personal & Household Federation** (§2.2). |

**Build order rationale:** Slice 1 is a hard prerequisite for 2–8. Slices 2, 3, 4, 6, 8 can proceed in parallel once 1 lands. Slice 7 waits on 2+3. Slice 9 is independent connector work that can slot in anywhere. Each slice gets its own spec → plan → implementation cycle; this document specs only Slice 1.

---

## 4. Slice 1 — Federation Core: Design

### 4.1 What it delivers (and nothing more)

Two Gateways discover each other on a LAN, pair with **mutual explicit approval**, one publishes a **named, filtered slice** of its index, grants a peer a **role** on it, and answers the peer's **consented, scope-enforced, audited, revocable** federated queries — including a **content-free expertise rank** ("who knows about X?"). A **leak-proof contract test** proves the protocol cannot expose any item type or `raw_meta` field the namespace did not declare.

**Explicitly out of scope** (later slices): Team Vault, multi-user/quorum HITL, ghost reviewers, conflict detection, cloud janitor, BI connectors, ChatOps, SSO/SCIM, admin console, share primitives.

### 4.2 Existing primitives this builds on

| Concern | Existing seam | Slice 1 action |
|---------|--------------|----------------|
| E2EE transport | `packages/gateway/src/ipc/lan-crypto.ts` (NaCl box: Curve25519/Salsa20/Poly1305), `ipc/lan-server.ts` (framed TCP, 4-byte length prefix) | Reuse **as-is**. |
| Pairing | `ipc/lan-pairing.ts` (single-use 20-char BS58 pairing codes, time-windowed) | Extend to drive **mutual** peer pairing. |
| Peer registry | `index/lan-peers-v19-sql.ts` — `lan_peers(peer_id, peer_pubkey, direction, host_ip, host_port, display_name, write_allowed, paired_at, last_seen_at)`; `direction IN ('inbound','outbound')` **already present** | Exercise the `outbound` direction; reuse the table. |
| LAN method allowlist (I5) | `ipc/lan-rpc.ts` `checkLanMethodAllowed` + `LanPeerContext { peerId, writeAllowed }` (intrinsic to `LanServer`) | Add the safe `federation.*` read methods; keep `vault.*`/`data.*`/`extension.*` forbidden. |
| Tamper-evident audit | `db/audit-chain.ts` `appendAuditEntry(db, fields)`; Blake3 chain via `index/audit-chain-v18-sql.ts`; session id via `audit-session-v24-sql.ts` | Append an entry per inbound federated query; extend schema with federation context (§6). |
| Index read path | `index/local-index.ts`, `index/item-list-query.ts` (`service IN (?)` filtering) | Add namespace-scoped read. |
| RPC dispatch | `ipc/_lib/dispatch-by-method.ts`; per-namespace `*-rpc.ts`; registered in `ipc/server/dispatchers.ts` | New `ipc/federation-rpc.ts` + a `tryDispatchFederationRpc()` in `dispatchers.ts`. |
| HITL write gate (I2/I3/I4) | `engine/executor.ts` | **Not touched** — federated query answering is read-only (§4.4). |

Genuinely greenfield: **mDNS discovery** and **scoped index namespaces**.

### 4.3 New components (each isolated, single-purpose)

- **`packages/gateway/src/federation/peer-pairing.ts`** — outbound/mutual pairing on top of `lan-pairing.ts` + `lan-crypto.ts`. Interface: `initiatePair(peerAddr, code)`, `approveInboundPair(req)` (requires owner approval), `listPeers()`. Persists to `lan_peers`.
- **`packages/gateway/src/federation/namespace-store.ts`** — CRUD for namespace definitions, their declared filters, and per-peer grants/roles. SQLite-backed (§6). The **single source of truth** for "what is shareable, with whom, at what role".
- **`packages/gateway/src/federation/query-gate.ts`** — *the structural gate*. Every inbound `federation.query` / `federation.expertise` passes through `answerFederatedQuery(peerCtx, req)`, which: (1) resolves the peer's grant+role for the named namespace, (2) honors a standing grant or raises an interactive consent prompt (timeout + granularity semantics in §4.6), (3) compiles the namespace's declared filter into the index read, (4) executes a **scoped** `local-index` read returning **only declared item types**, (5) appends an audit entry (answered or rejected). Returns empty + audits on any failure (unpaired / no grant / undeclared type / revoked / consent timeout).
- **`packages/gateway/src/federation/expertise.ts`** — relevance scoring that returns a coarse **rank** only (`high|medium|low|none`); asserts zero item content in the response shape.
- **`packages/gateway/src/federation/discovery.ts`** — defines a `DiscoveryProvider` interface (so tests inject a mock; §8) with an mDNS implementation advertising/browsing `_nimbus._tcp`. Degrades to manual peer-address entry when mDNS is unavailable. Discovery never implies trust — pairing still requires mutual approval.
- **`packages/gateway/src/ipc/federation-rpc.ts`** — the `federation.*` JSON-RPC dispatcher (mirrors `agents-rpc.ts`).
- **`packages/gateway/src/index/federation-v33-sql.ts`** — migration adding namespace/grant tables + audit federation-context column (§6). **V33** is the next free migration number (highest existing is `git-blame-line-v32`; confirmed against `index/` runner 2026-06-04).
- **CLI** (`packages/cli`): `nimbus team discover`, `nimbus team pair <peer>`, `nimbus team namespace publish|grant|revoke`, `nimbus team query <namespace> "<q>"`, `nimbus team who-knows "<q>"`.

### 4.4 Key architectural decision: read-only answering

Federated query *answering* is **read-only** and routes through `query-gate.ts`, **not** the write executor. This keeps Slice 1 entirely off the I2 write-gate and the `HITL_REQUIRED` set. The consent prompt for a federated query is a *new* structural gate (I17, §7) specific to answering peer queries — it is not the write-action HITL gate. Quorum HITL (Slice 2) is what extends `engine/executor.ts`; it is deliberately not in this slice.

### 4.5 `federation.*` IPC surface (initial)

| Method | Direction | Renderer-exposed (I7)? | Notes |
|--------|-----------|------------------------|-------|
| `federation.discover` | local | yes | lists mDNS-advertised peers |
| `federation.pair` | local | yes (approve UI) | initiate / approve mutual pairing |
| `federation.peers` | local | yes | list paired peers |
| `federation.namespace.publish` | local | yes | define a scoped namespace |
| `federation.namespace.grant` / `.revoke` | local | yes | grant/revoke a peer's role |
| `federation.query` | **over-the-wire** | no | inbound peer query; gated by `checkLanMethodAllowed` + `query-gate.ts` |
| `federation.expertise` | **over-the-wire** | no | inbound expertise rank; content-free |

The two over-the-wire methods are the only ones added to the I5 LAN allowlist. Renderer exposure for local management methods follows the Tauri allowlist process (I7); the over-the-wire answering methods are **never** renderer-callable.

### 4.6 Consent semantics, timeout & UI

When a query targets a namespace where the asking peer's grant has `standing_consent = false`, `query-gate.ts` raises an interactive consent prompt on the **answering** Gateway's owner UI. The semantics:

- **Timeout (review #1).** The query **blocks up to a configurable timeout — default 30 s** (`[federation].consent_timeout_seconds`). On expiry the answering Gateway resolves the prompt as a rejection, audits it (decision `timeout`), and returns the over-the-wire error **`timeout_waiting_for_consent`** to the requester. A standing grant never blocks; an absent grant is rejected immediately without prompting (no point asking the owner to approve a peer they never granted).
- **Granularity (review #2).** A non-standing consent prompt fires **once per `(peer, namespace)` per session** on the answering Gateway, and the decision is cached for that session — not per query (alert fatigue) and not persisted across restarts (that's what `standing_consent = true` is for). The session consent cache is **invalidated immediately** on grant revocation or role change, so revocation can never be out-lived by a cached approval (ties to acceptance criterion 4).
- **UI reuse (review #3).** The prompt **reuses the existing HITL approval-UI *patterns*** (the renderer's approval-card component + decision flow), surfaced via a **new notification kind `federation.consentRequest`** carrying peer display-name, namespace, stated purpose, and the role being exercised. It is a *notification to the owner's UI*, **not** a renderer-callable method, so it does **not** widen the I7 `ALLOWED_METHODS` allowlist. The backend gate stays `query-gate.ts`, distinct from `ToolExecutor.gate()` (I2). Exact Tauri component wiring + the notification's global-rebroadcast classification are deferred to implementation (consult `nimbus-tauri-allowlist` then).

**Over-the-wire error model** (returned to the requesting peer): `not_paired`, `no_grant` (empty result, audited), `namespace_unknown`, `timeout_waiting_for_consent`, `consent_denied`. None leak whether undeclared item types exist — a query outside the declared shape returns the same empty/`no_grant`-shaped result as an unmatched in-scope query.

---

## 5. Acceptance Criteria (foundation-first)

1. **Mutual pairing**: two Gateways on a LAN discover each other (mDNS) and pair only after **both** owners approve; an unpaired peer's `federation.query` is rejected and audited.
2. **Scoped answering**: owner publishes namespace `project:zurich` (declared item types + services); a peer granted `viewer` receives only matching items; a peer with no grant receives an empty result **and** an audit entry recording the rejected query.
3. **Audit completeness**: every inbound federated query — answered **or** rejected — appears in the answering Gateway's Blake3 audit chain with peer-id, stated purpose, and scope; the chain still verifies (`audit.verify`) afterward.
4. **Revocation latency**: grants are **live-checked per query**, so revoking a peer's grant takes effect immediately and **invalidates any cached session consent** (§4.6) — a subsequent query returns empty + audited, even within the same session a prior approval covered.
5. **Leak-proof contract test**: a federated query for an item type **not declared** in the namespace shape returns empty and is audited; the protocol exposes no undeclared item type and no `raw_meta` field. (Extends the existing privacy-contract test.)
6. **Expertise privacy**: `federation.expertise` returns only a rank; an assertion proves the response payload carries zero item content.
7. **Channel allowlist (I5)**: `vault.*`, `data.*`, and `extension.*` remain forbidden over the federation channel; only the two over-the-wire `federation.*` methods are admitted.
8. **I17 enforcement test** exists and fails if `query-gate.ts` is bypassed (the triple-rule test, §7).
9. **Platform equality**: the integration suite passes on Windows, macOS, and Linux; mDNS-absent environments fall back to manual peer entry without failing the suite.
10. **Consent timeout**: a query against a non-standing grant whose owner does not respond resolves as a rejection after `consent_timeout_seconds`, returns `timeout_waiting_for_consent` to the requester, and is audited with decision `timeout`.

---

## 6. Data Model (migration `federation-v33-sql.ts`)

Append-only, per the migration rules. New tables:

- **`federation_namespaces`** — `(namespace_id TEXT PRIMARY KEY, name TEXT, owner_self INTEGER, created_at INTEGER)`.
- **`federation_namespace_filters`** — `(namespace_id TEXT, filter_kind TEXT, filter_value TEXT)` — the declared item types / services / tag filters that *define the export shape*. The leak-proof property derives from compiling **only** these into the read.
- **`federation_grants`** — `(namespace_id TEXT, peer_id TEXT, role TEXT CHECK(role IN ('owner','editor','viewer')), standing_consent INTEGER, granted_at INTEGER, revoked_at INTEGER NULL)`.

Audit extension: add a **dedicated nullable `federation_json TEXT` column** to `audit_log` (peer-id, namespace, stated purpose, decision ∈ `answered|no_grant|not_paired|timeout|consent_denied`) via the same migration — **not** folded into `action_json` (review #5). `action_json` is tightly coupled to local execution contexts (tool calls); a dedicated column keeps the schemas unmixed and lets federation-specific audit queries filter in SQL (`WHERE federation_json IS NOT NULL`) without JSON parsing at the DB layer. The new field **is** folded into the Blake3 hashed payload via `appendAuditEntry`, so federation events are tamper-evident like every other entry.

All SQL uses bound parameters; identifiers via `escapeIdentifier` (I9). All writes route through `dbRun`/`dbExec`/`dbStmtRun` (I14).

---

## 7. Security Invariant I17 (new)

**I17 — Federated-query answering is intrinsic to the consent/scope gate.** Every inbound `federation.query` / `federation.expertise` is answered **only** via `federation/query-gate.ts`, which enforces peer grant + role + the namespace's declared filter; no federation answer path may read the index directly or expose an item type / `raw_meta` field outside the namespace's declared shape.

- **Wired at:** `federation/query-gate.ts` (the only function that answers peer queries); `ipc/federation-rpc.ts` routes the two over-the-wire methods through it; `ipc/lan-rpc.ts` `checkLanMethodAllowed` admits only those two methods.
- **Anti-pattern that regresses it:** a federation RPC handler that calls `local-index` directly, or a namespace read that ignores `federation_namespace_filters`.
- **Triple rule:** production wiring (above) + a row in `docs/SECURITY-INVARIANTS.md` + an enforcement test in `packages/gateway/src/security-invariants.test.ts`. Consider a static complement in `scripts/structure-audit/check-nimbus-invariants.ts` (e.g., "no `local-index` import under `federation/` except in `query-gate.ts`").

---

## 8. Testing Strategy

Per the project's testing philosophy:

- **Integration tests** with **two real Gateway subprocesses**, real SQLite, fresh temp dirs per test — no DB-layer mocks. The canonical scenario: discover → pair (mutual) → publish namespace → grant viewer → query (scoped, audited) → request undeclared type (empty, audited) → revoke → query (empty, audited).
- **Leak-proof contract test** (criterion 5) as its own focused test, extending the existing privacy-contract test.
- **I5 allowlist test** extended to cover the new `federation.*` methods (admit the two over-the-wire, forbid `vault.*`/`data.*`/`extension.*`).
- **I17 enforcement test** in `security-invariants.test.ts`.
- **Audit-chain continuity test** asserting federation events keep the Blake3 chain verifiable.
- **Discovery is behind a `DiscoveryProvider` interface (DI), not mocked at module level (review #4).** mDNS multicast is notoriously flaky in shared/containerized CI (not just Linux), so **all** unit + integration tests inject an in-memory mock `DiscoveryProvider` (deterministic peer list) — never a real broadcast. This also follows the project's "DI over `mock.module`" learning. The pairing/namespace/query/audit scenarios depend only on the mock provider, so they're stable on every OS.
- **Real mDNS broadcast is isolated to a single tagged E2E** (e.g. `discovery.mdns.e2e.test.ts`) that is **allowed to skip** when no multicast responder is present (guarded by an env flag), so it never causes intermittent CI reds while still exercising the real responder on a capable runner.
- **Cross-platform**: build paths with `path.join`; the mDNS-absent → manual-peer-entry fallback path is exercised explicitly.
- Coverage: the new `federation/` module should meet the Engine ≥85% gate territory; confirm the exact gate mapping with `nimbus-testing` when implementing.

---

## 9. Out of Scope / Deferred

- Team Vault, multi-user & **quorum** HITL (Slice 2) — quorum HITL is the part that extends `engine/executor.ts`.
- SSO/OIDC/SAML, SCIM, RBAC beyond per-namespace owner/editor/viewer (Slice 3).
- Org policy engine, admin console, merged team audit view (Slice 4).
- ChatOps, BI connectors, share primitives, deferred Phase 5 items (Slices 5–9).
- Personal/family/friend federation — **deferred to a new Phase 20 — Personal & Household Federation** (§2.2).
- A relay/broker server — never; federation is strictly peer-to-peer over the LAN E2EE channel.

---

## 10. Open Questions (resolve during writing-plans / implementation)

Resolved in this revision (post-review): **revocation** is now *live-checked per query* (immediate; §5 criterion 4), **consent timeout/granularity** is defined (§4.6), the **audit field** is a dedicated `federation_json` column (§6), and **discovery testing** is DI-based with real mDNS isolated to one skippable E2E (§8).

Resolved during planning kickoff (2026-06-04):

1. **mDNS dependency** — **Resolved: use a maintained third-party mDNS/DNS-SD library** (candidate `bonjour-service` or `multicast-dns`) added to the **gateway** package for `_nimbus._tcp` advertise/browse, kept behind the `DiscoveryProvider` interface (§4.3/§8). The gateway is not under the SDK/`shared/` dep-free constraint, so a runtime dep is acceptable; it must pass the dep-safety pre-flight (`nimbus-commands`). Real broadcast stays isolated to the single skippable mDNS E2E (§8).
2. **Migration number** — **Resolved: V33** (highest existing is `git-blame-line-v32`; confirmed against `index/` runner).
3. **Scope of "this session"** — **Building Slice 1 is now kicked off.** Scope decision: a **single implementation plan covering all of Slice 1** (vs. sub-slicing), executed in phased steps. This spec is the design of record for that plan.

Remaining (confirm during implementation):

1. **`consent_timeout_seconds` default** — 30 s is the proposed default; confirm against real LAN round-trip + human-response latency during implementation.
