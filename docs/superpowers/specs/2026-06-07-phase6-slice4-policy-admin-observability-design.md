# Phase 6 Slice 4 — Org Policy Engine + Admin Console + Observability — Design

- **Status:** Draft for review
- **Date:** 2026-06-07
- **Branch:** `dev/asafgolombek/phase6-slice4-policy-admin-observability`
- **Builds on:** Slice 1 Federation Core (PR #519) + over-the-wire federation (PR #521) + Slice 3 Identity (PR #523) + Slice 2 Team Vault / Quorum HITL (PR #527, merged — I19/I20/I21)
- **Roadmap:** [`docs/roadmap.md`](../../roadmap.md) → Phase 6 → "Shared Workflows & Policy" (org-level policy engine + enforcement) + "Admin & Observability" (Slice 4)

## 1. Summary

Slice 4 is the **governance and operability layer** over everything Slices 1–3 built. It introduces an
org-level policy engine, the local Admin Console web UI, and an observability surface, plus two
adjacent "Admin & Observability" roadmap items (team audit merged view, GDPR purge) and the explicit
policy × per-user-profile interaction.

The load-bearing idea: in a local-first mesh with **no central server**, "org policy" cannot mean a
server that everyone obeys. Instead, the trust-anchor Gateway (already established in Slices 2/3) holds
a **canonical `nimbus.policy.toml` signed with an org admin Ed25519 key**. Peers fetch it over the
existing NaCl-box federation channel, **verify the signature**, persist it, and **enforce it locally**.
Authorship is central and tamper-evident; enforcement stays local-first. Policy can only ever make
enforcement **stricter** — it can raise a quorum or add a HITL requirement, never lower or remove one —
which keeps non-negotiable #2 (HITL cannot be configured away) intact. This property and the
signature requirement are codified as a new structural invariant **I22**.

Slice 4 ships as **one combined PR** spanning eight build lanes (§13).

## 2. Non-negotiables honored

- **Local-first** — no relay; policy rides the existing Slice 1 NaCl-box LAN channel; enforcement is
  local. A gateway with no org policy runs fully (un-governed, local config only).
- **HITL is structural** — policy feeds the executor `gate()` / quorum coordinator (I2/I3/I21) and can
  only make them stricter. Policy can never disable or weaken a HITL/quorum requirement.
- **No plaintext credentials** — the org signing **private** key lives only in the anchor's OS Vault
  (added to the vault-key allow-list). The audit shipper transmits **metadata only**, never `actionJson`.
- **MCP as connector standard** — the connector allowlist gates which MCP servers start; no direct cloud
  calls are introduced.
- **Platform equality** — no OS-specific committed code; the console is a dependency-free static bundle;
  paths via `path.join`.
- **No `any`** — `unknown` for wire/external data; strict mode throughout.

## 3. Decisions (resolved during brainstorming)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Slice 2 quorum-mapping coupling | **#527 is merged.** The policy engine becomes the **authoritative** home for the action-type → quorum-size mapping; `nimbus.toml` `[hitl.quorum]` becomes the local default. |
| D2 | Policy trust / distribution model | **Trust-anchor signed + local enforce.** Anchor signs `nimbus.policy.toml` with an org admin Ed25519 key; peers fetch over the federation channel, verify, persist, enforce locally; fail-closed. |
| D3 | Admin Console stack | **Dependency-free static bundle** (vanilla TS → small JS + HTML/CSS) in a new `packages/admin-console`, served by the Gateway HTTP server; no React/Vite. |
| D4 | Admin Console shell | **Left sidebar + top status bar** (6 views: Overview, Users, Namespaces, Connectors, Audit log, Policy). |
| D5 | Adjacent scope | **All three in:** team audit merged view, GDPR purge (`nimbus team purge --user`), policy × per-user-profile interaction. |
| D6 | Observability deliverable | **Status/metrics aggregation** exposed as a JSON read API (console-rendered) **and** a Prometheus-compatible `GET /metrics` text endpoint. |
| D7 | Retention semantics | **Floor only** (minimum retention; effective = `max(local, floor)`). Ceiling/auto-purge deferred. |
| D8 | Cross-team connector status in console | **On-demand** (manual "refresh team view" fires federated status queries); local health + peer roster by default. |
| D9 | New structural invariant | **I22** (signature-verified policy + monotonic-stricter), static complement **D16**. |
| D10 | Pubkey trust establishment | **Pinned at pair-approval** (signed claim in handshake, mirroring Slice 3 D6) with a `nimbus policy trust <pubkey>` manual fallback. |
| D11 | GDPR cross-mesh purge | **HITL-gated on each peer** — owner purges its own copy and *requests* peers purge theirs via their HITL queue; no auto-execution on another machine. |

### 3.1 Explicit non-goals (deferred)

Retention ceiling / auto-purge-after-N; multi-org / multiple simultaneous policy issuers; policy key
rotation ceremony beyond re-sign-and-re-pin; a fully editable policy GUI on peers (peer console is
read-only for policy — editing happens only on the anchor where the signing key lives); live always-on
cross-team connector status; Prometheus push-gateway / OTLP export (pull `/metrics` only); SIEM-vendor
adapters beyond generic NDJSON POST.

## 4. Architecture

### 4.1 Subsystem placement

A new top-level `packages/gateway/src/policy/` (parallel to `federation/`, `identity/`, `teamvault/`)
and a new leaf web package `packages/admin-console/`.

```text
packages/gateway/src/policy/
  types.ts               # OrgPolicy, EnforcedPolicy, PolicyState, wire shapes
  policy-toml.ts         # parse/serialize nimbus.policy.toml (hand-rolled, like config/*)
  policy-signing.ts      # Ed25519 sign/verify over canonical bytes; org key in Vault (anchor)
  policy-gate.ts         # ★ I22 canonical — verify(sig) → load → EnforcedPolicy; sign() on anchor
  policy-store.ts        # persist last-known-valid policy + pinned anchor pubkey (dbRun/dbExec/dbStmtRun)
  policy-runtime.ts      # orchestrate fetch→verify→persist→re-enforce; feeds status snapshot
  policy-distribution.ts # federation.policy serve (anchor) + fetch (peer) over the NaCl channel
  profile-resolver.ts    # resolveEffectiveConfig(profile, policy, localDefault) — monotonic stricter

packages/gateway/src/status/
  gateway-status.ts      # build one GatewayStatus snapshot from existing stores
  prometheus-format.ts   # GatewayStatus → Prometheus text exposition

packages/gateway/src/audit/
  audit-shipper.ts       # batch new audit-chain entries (metadata-only NDJSON) → POST ship_to

packages/gateway/src/policy/gdpr-purge.ts   # nimbus team purge orchestration + signed deletion record

packages/admin-console/                      # dependency-free static bundle (AGPL)
  src/ (vanilla TS render functions + fetch client)  →  dist/ (index.html + bundle.js + styles.css)
```

Tests are co-located `*.test.ts` (Slice 1–3 convention) plus an integration acceptance suite under the
gateway test tree. `packages/admin-console` is a leaf: the gateway **serves its built `dist/` at runtime
by reading files** — it never imports admin-console source (dependency rule preserved).

### 4.2 `nimbus.policy.toml` schema

Lives in `<configDir>` beside `nimbus.toml`, with a detached `nimbus.policy.toml.sig` (Ed25519 over the
**canonicalized** bytes of the `.toml` — see §4.2.1).

#### 4.2.1 Signature canonicalization (cross-platform stability)

Signing and verifying operate on a **canonical byte form**, never the raw on-disk bytes, so that
CRLF↔LF rewrites by git (`core.autocrlf`) or a text editor cannot break verification across Windows /
macOS / Linux (platform-equality non-negotiable). `policy-signing.canonicalize(toml)` is the single
function both `sign()` and `verify()` call. Canonical form:

1. decode as UTF-8, strip a leading BOM if present;
2. normalize all line endings `\r\n` and `\r` → `\n`;
3. strip trailing whitespace on each line;
4. ensure exactly one trailing `\n` (no extra blank lines at EOF).

The signature covers `canonicalize(toml)`. The `.sig` is base64; the `.toml` on disk may carry either
line-ending style without affecting validity.

`canonicalize` is deliberately **byte-level, not a TOML AST round-trip** — it normalizes line endings /
BOM / trailing whitespace but does **not** reformat the document, so it avoids fragile AST
reconstruction. The consequence: **any semantically-invisible edit** (a changed comment, reordered keys,
added blank line *between* keys) still changes the signed bytes and invalidates the `.sig`. Therefore
the anchor must **re-sign after every edit** — the console policy editor (`PUT /v1/admin/policy`) signs
automatically on save, and the manual path is `nimbus policy sign`. A policy whose `.sig` does not match
its current bytes is treated as unsigned (fail-closed, §4.3 R1).

```toml
[policy]
version    = 1
org        = "acme"
issued_at  = "2026-06-07T00:00:00Z"    # staleness / rotation signal

[policy.connectors]
allow = ["github", "slack", "jira"]    # allowlist; section absent = unrestricted

[policy.retention]
min_days = 30                          # FLOOR — effective retention = max(local, floor)

[policy.hitl]
require = ["db.drop", "vault.export"]  # force HITL on these action types (union with local)
[policy.hitl.quorum]                   # absorbs Slice 2 [hitl.quorum]; authoritative home
"terraform.destroy"   = 2
"git.force_push_main" = 2

[policy.audit]
ship_to     = "https://siem.acme.internal/ingest"   # destination (absent = no shipping)
ship_format = "ndjson"
```

### 4.3 Trust / distribution

- **Org admin key** — Ed25519. The **private** key lives only in the anchor's Vault under
  `policy.signing.privkey`. This is a **non-connector** key, so it is added to the Vault **key allow-list**
  (the same mechanism Slice 3's identity tokens use, distinct from the connector-secrets manifest in
  `connector-secrets-manifest.ts`). `nimbus policy sign` re-signs after an edit.
- **Pubkey pinning** — a peer pins the anchor's policy pubkey **at pair-approval**, carried in the pairing
  handshake as a signed claim (mirroring the Slice 3 D6 `scim_user ↔ peer_id` binding), with a manual
  `nimbus policy trust <pubkey>` fallback for the deferred outbound-pair path.
- **Fetch** — a peer calls a new `federation.policy` method over the NaCl-box channel → `{ toml, sig }`.
  The peer verifies `sig` against the **pinned** pubkey, persists `{toml, sig, fetchedAt}` to
  `policy-store`, and re-enforces. Re-fetched every sync cycle; a changed-and-valid policy is hot-applied
  where safe (retention floor, HITL/quorum, audit shipping) and flagged **pending-restart** where not
  (connector allowlist — connectors are decided before the mesh starts).
- **Fail-closed (three rules)**:
  1. An unsigned / signature-invalid / wrong-key policy is **never applied**; the gateway falls back to
     the last cryptographically-valid persisted policy.
  2. If no valid policy was ever received, the gateway runs **un-governed** (local config only) but the
     status surface flags `policy: none` and the console shows an "ungoverned" banner.
  3. Policy may only make enforcement **stricter than the local baseline** — never stricter than its own
     history. "Stricter" is defined **relative to the local config/default**, *not* a historical
     high-water mark. Concretely `effective = max(localConfig, policy)` (and HITL-required = the union of
     the local set with `policy.require`). An admin **can** scale an org constraint back down — e.g. lower
     a quorum from 3 to 2 — and it takes effect, **as long as the result stays ≥ the local baseline**
     (the `nimbus.toml` default and the frozen `HITL_REQUIRED_BACKING` set). What policy can *never* do is
     drop **below** that baseline: it cannot reduce a quorum under the local default or remove a HITL
     requirement that exists locally (that would violate non-negotiable #2). There is no "lock-in" of past
     policy values; each refresh recomputes `EnforcedPolicy` from the *current* policy against the local
     baseline.

### 4.4 Data flow — peer policy refresh

```text
sync cycle (peer)
  → policy-runtime.refresh()
  → policy-distribution.fetch(anchorPeerId)         # federation.policy over NaCl channel
  ← { toml, sig }
  → policy-signing.verify(toml, sig, pinnedPubkey)  # reject on failure → keep last-valid (R1)
  → policy-toml.parse(toml) → OrgPolicy
  → policy-store.persist(OrgPolicy, sig, now)
  → policy-gate.recomputeEnforced(OrgPolicy, localDefaults)   # monotonic-stricter (R3)
  → re-enforce: retention floor, HITL/quorum map, audit shipper target
       connector allowlist delta → mark pendingRestart (R applied at next mesh start)
  → audit: policy.applied { org, version, signatureValid:true }
```

## 5. Enforcement points

Each site consults **`policy-gate.ts`'s `EnforcedPolicy`**, never the raw `.toml` (I22).

| Policy field | Enforcement site | Behavior |
|---|---|---|
| `connectors.allow` | [`platform/assemble.ts`](../../../packages/gateway/src/platform/assemble.ts), **before the mesh starts** | A connector whose id ∉ allowlist is never registered/spawned. A configured-but-blocked connector emits a `policy.connector.blocked` audit entry and surfaces in the console. Satisfies "connectors not in the allowlist disabled before the mesh starts." |
| `retention.min_days` | `startToolCallLogRetention` ([`db/tool-call-log-retention.ts`](../../../packages/gateway/src/db/tool-call-log-retention.ts)) + any retention caller | Effective `retentionDays = max(localConfig, policy.min_days)`. Floor can only *lengthen* retention. |
| `hitl.require` / `hitl.quorum` | executor `gate()` ([`engine/executor.ts`](../../../packages/gateway/src/engine/executor.ts)) + quorum coordinator ([`engine/quorum/quorum-coordinator.ts`](../../../packages/gateway/src/engine/quorum/quorum-coordinator.ts)) | Policy is the authoritative action-type → quorum-size home; `[hitl.quorum]` in `nimbus.toml` is the local default. Resolution = **strictest wins**: `effectiveQuorum = max(localDefault, policy)`; required-HITL set = union. Policy never reduces below local/default (I22). |
| `audit.ship_to` | new `audit/audit-shipper.ts` sidecar | Batches new audit-chain entries as NDJSON and POSTs to the destination with retry/backoff; ships **metadata only** (`actionType`, `hitlStatus`, `hash`, `timestamp`) — never `actionJson`. Absent destination = no shipping. |

### 5.1 Policy × Phase 3.5 profile interaction

`profile-resolver.ts` exposes `resolveEffectiveConfig(profile, policy, localDefault)`. Policy is a **hard
outer bound**; the per-user [profile](../../../packages/gateway/src/config/profiles.ts) may be **stricter,
never looser**:

- connectors: `effective = profile.enabled ∩ policy.allow` (profile can disable more, never add a forbidden connector).
- retention: `effective = max(profile.retentionDays, policy.min_days)`.
- HITL/quorum: `effective = strictest(profile, policy, localDefault)`.

Precedence is **policy clamps profile clamps default**, monotonic toward stricter. The console surfaces
the resolution ("profile requests X, policy bounds it to Y").

## 6. Observability

`status/gateway-status.ts` builds one `GatewayStatus` snapshot from existing stores (no new persistence):

```text
GatewayStatus {
  policy:     { org, version, signatureValid, lastFetchedMs, pendingRestart, source: "anchor"|"peer"|"none" }
  peers:      [{ peerId, reachable, lastSeenMs }]
  connectors: [{ id, enabled, blockedByPolicy, health, lastSyncMs }]
  namespaces: [{ name, subscribers, lastPropagateMs }]
  audit:      { chainLength, lastHash, appendRate1h }
  hitl:       { pendingApprovals, pendingQuorum }
  identity:   { operatorValid, externalId }
  syncFreshnessMs
}
```

Exposed three ways from the **same** snapshot:

- **IPC** `admin.status` (read-only) — CLI/Tauri.
- **HTTP** `GET /v1/admin/status` (JSON, bearer-auth, read surface) — the console.
- **HTTP** `GET /metrics` — Prometheus text exposition (`nimbus_peer_reachable`,
  `nimbus_connector_enabled`, `nimbus_audit_chain_length`, `nimbus_policy_signature_valid`,
  `nimbus_hitl_pending`, …) for external scraping. Distinct from the existing `/v1/metrics/dora` JSON —
  no route collision. **Auth:** `/metrics` requires the **same bearer token** as the rest of the read
  surface (it exposes peer/connector/audit posture, so it is not anonymous). A Prometheus scraper
  configures it via the standard `authorization` / `bearer_token_file` scrape-config keys
  (`Authorization: Bearer <token>`). The gateway already binds `127.0.0.1` by default (I6), so the token
  is the second layer, not the only one.
  **Token retrieval:** the bearer is the existing HTTP read-surface token (the same one SCIM/`/v1/*`
  already use — persisted in `<configDir>` and managed by the existing HTTP-auth code, not a new
  secret). To wire a scraper, the operator obtains it with **`nimbus admin token`** (prints just the
  bearer, suitable for piping into a `bearer_token_file`); `nimbus admin console` prints the same token
  embedded in the console URL fragment. No new storage mechanism is introduced.

## 7. Admin Console

Served by the Gateway HTTP server: `GET /admin/*` returns the static bundle's `dist/`
(`index.html`, `bundle.js`, `styles.css`); bearer-authed with the same token as the HTTP read surface.
`nimbus admin console` prints the local URL and the bearer token.

**Shell:** left sidebar (the 6 views) + a top status bar (org · policy signature state · operator
validity). Read-mostly; the Policy editor is the single write surface and is **active only on the anchor**
(read-only on peers, showing the enforced policy + signature status).

| View | Source | Notes |
|---|---|---|
| Overview | `admin.status` snapshot | status cards: peers, connectors (n blocked), audit chain ✓, HITL pending, sync age, policy signed |
| Users | `identity-store` (SCIM users + operator) | read-only |
| Namespaces | `federation/namespace-store` | subscribers, grants, last propagate |
| Connectors | local connector health + policy allowlist state; **on-demand** team view (D8) | "refresh team view" fires federated status queries |
| Audit log | local audit chain; **team/local toggle** → merged view (§8) | metadata only |
| Policy | `policy.show`; editor `PUT /v1/admin/policy` (anchor-only, signs locally) | read-only on peers |

The bundle is plain HTML/CSS + vanilla TS compiled to one JS file (no framework). Render logic is split
into **pure functions** (`renderOverview(status)`, etc.) so they unit-test without a DOM driver; a thin
`main.ts` wires fetch + DOM mount.

### 7.1 Build & deploy lifecycle

`packages/admin-console` carries a `build` script (`bun build src/main.ts --outdir dist --minify` +
copy `index.html`/`styles.css` to `dist/`). No framework, no Vite — Bun's bundler only.

- **Monorepo wiring** — the package is added to the workspace `build` fan-out so `dist/` is produced
  before any gateway test/package step that serves it. A preflight/CI gate asserts `dist/` exists and is
  current (hash of `src/` vs a committed manifest), so a stale or missing bundle fails fast rather than
  404-ing at runtime. `dist/` is **git-ignored** (built artifact), like other package build outputs.
- **Runtime resolution** — the gateway resolves the console root via a small `admin-console-assets.ts`
  helper: in-repo it points at `packages/admin-console/dist` (resolved relative to the gateway package,
  via `import.meta`/`path.join`, never a hardcoded separator); in a packaged release the assets are
  shipped alongside the gateway binary and resolved from the install root. If `dist/` is absent at
  runtime, `GET /admin/*` returns a clear 503 ("admin console not built — run `bun run build`") instead of
  a confusing 404.
- **Dependency rule** — the gateway only ever **reads** `dist/` files; it never imports admin-console
  source (preserves the `gateway`-imports-nothing-from-ui-class rule).

## 8. Team audit merged view

A new `federation.auditExport` method returns **only federation-related** audit entries from a peer
(consent-gated like `federation.query`, **metadata-only**, leak-proof — no `actionJson`). The owner
aggregates the per-peer streams into one merged timeline (sorted by timestamp, tagged by `peerId`),
rendered in the Audit view behind the team/local toggle and reachable via `team.auditMerged` (IPC) /
`nimbus team audit`.

## 9. GDPR purge

`nimbus team purge --user <id>` (`team.purge` IPC, CLI; **not** Tauri-exposed):

```text
nimbus team purge --user <id>
  → resolve user → peer_id via identity_binding
  → revoke all of the user's grants               # reuse Slice 3 deprovision path
  → delete the user's contributions from LOCAL shared namespaces
  → open a purge job: insert one purge_request row per known peer (status='pending')   # durable
  → for each peer: attempt federation.purge        # lands in THAT peer's HITL queue (D11)
       peer approves → peer purges its copy → returns a signed deletion record → status='done'
       peer offline / not-yet-approved          → status stays 'pending' (no failure)
  → CLI reports per-peer status (done / pending) and exits non-zero only on a hard error,
       NOT merely because some peers are still pending
  → when ALL peers are 'done': write ONE Ed25519-signed completion record into the local
       audit chain (action: team.purge.completed) and close the job
```

### 9.1 Durability across offline / partitioned peers

GDPR is a high-reliability operation, so purge state is **persisted**, not session-only. A new
`gdpr_purge_job` + `gdpr_purge_request` pair (own migration, owned by `policy-store`/`gdpr-purge.ts`)
records, per `(jobId, peerId)`: status (`pending` / `done` / `refused`), attempt count, last-attempt
time, and the returned signed deletion record. The purge **never blocks on offline peers**:

- The federation **sync cycle** retries every `pending` request (bounded backoff) until that peer returns
  a signed deletion record, then marks it `done`. A peer that comes back online days later is purged on
  its next sync — no operator re-run needed.
- The job stays **open** until every request is `done`; only then is the aggregate
  `team.purge.completed` record signed and appended. `nimbus team purge --status <jobId>` and the console
  show outstanding peers.
- No auto-execution on another machine: each peer's own HITL gate authorizes its own deletion (consistent
  with the blast-radius philosophy). The per-peer signed deletion records are the durable proof of exactly
  what was purged and when.

**Ledger lifecycle.** The `gdpr_purge_job` / `gdpr_purge_request` rows are **retained indefinitely** —
they are the compliance ledger of who was purged, when, and with which signed records. They are
**deliberately not subject to** the `retention.min_days` floor (which governs `tool_call_log` only) and
are never pruned. The size impact is negligible: purge events are rare and each row is a handful of
small fields plus one base64 signature. (The aggregate `team.purge.completed` entry also lands in the
audit chain; the table rows remain as the queryable per-peer detail behind `nimbus team purge --status`.)

## 10. Security invariant I22 (triple rule)

**I22** — *Org policy is applied only from a signature-verified bundle, and only ever makes enforcement
stricter.*

- **Wiring** — `policy/policy-gate.ts` is the single module that verifies the Ed25519 signature and
  produces the `EnforcedPolicy`. `assemble.ts` (allowlist), retention, and the executor/quorum reader
  consult **only** the gate's output. An unverified policy is never applied (fall back to last-valid; else
  un-governed + flagged).
- **Docs** — a new row in [`docs/SECURITY-INVARIANTS.md`](../../SECURITY-INVARIANTS.md) + the
  CLAUDE.md / GEMINI.md invariant list.
- **Test** — `packages/gateway/src/security-invariants.test.ts`: (a) a tampered policy (bad sig) is
  rejected and the prior policy stays in force; (b) a policy that sets a quorum/HITL requirement **below
  the local baseline** cannot weaken the effective gate (`effective = max(local, policy)`), while a policy
  that *raises* a quorum and a later policy that *lowers* it back toward — but not under — the baseline
  both take effect (no historical high-water lock); (c) the connector allowlist blocks a non-listed
  connector before mesh start.
- **Static complement D16** — `scripts/structure-audit/check-nimbus-invariants.ts`: no module outside
  `policy/` reads the policy file into an enforcement path; `policy.signing.privkey` is in the vault-key
  allow-list.

I22's wiring + docs + test land in the **same commit** (triple rule).

## 11. IPC / CLI / Tauri / HTTP surface

- **IPC:** `admin.status`, `policy.show`, `policy.sign` (anchor-only), `policy.trust`, `policy.refetch`,
  `team.auditMerged`, `team.purge`.
- **CLI:** `nimbus policy {show,sign,push,trust,verify}` · `nimbus admin {status,console,token}` (`token` prints the read-surface bearer for scraper config) · `nimbus team {audit,purge}`.
- **HTTP (read surface):** `GET /v1/admin/status`, `GET /metrics`, `GET /admin/*` (static console). Policy
  edit-on-anchor adds one `WRITE_ROUTE_ALLOWLIST` entry: `PUT /v1/admin/policy` (bearer + audit,
  anchor-only — validates, then locally signs).
- **Tauri allowlist (I7):** expose read-only `admin.status`, `policy.show`, `team.auditMerged`.
  **Exclude** `policy.sign`, `policy.trust`, `team.purge` (RCE/destructive-class → CLI/local-only).
- **Federation LAN methods (I5):** admit `federation.policy` (serve signed bundle) and `federation.purge`
  (HITL-queued) to the LAN allowlist; `federation.auditExport` is consent-gated like `federation.query`.

## 12. Testing strategy

- **Unit / co-located `*.test.ts`:** policy-toml parse/serialize; **`canonicalize()` stability across
  CRLF/LF/BOM/trailing-whitespace inputs (§4.2.1)**; signing/verify; policy-gate monotonic resolution
  **including the raise-then-lower-toward-baseline case and the below-baseline floor (§4.3 R3)**;
  profile×policy resolver; gateway-status snapshot; **`/metrics` bearer-auth (401 without token, 200
  with)**; audit-shipper batching (metadata-only proof); Prometheus formatter; console pure render
  functions.
- **Integration (real SQLite + Bun subprocess):** connector allowlist blocks-before-mesh; retention floor;
  signed fetch→verify→enforce round-trip between two gateways; tampered-policy rejection keeps last-valid;
  GDPR purge fan-out with HITL **+ an offline-peer case: the request persists `pending` and a later sync
  cycle completes it and closes the job (§9.1)**.
- **E2E CLI (real Gateway + mock peers):** `nimbus policy show/verify`, `nimbus admin status`,
  `nimbus team purge`.
- **Invariant:** the I22 cases in `security-invariants.test.ts`.
- **Coverage:** new source files must clear the 80%/file floor — verified against CI's
  `coverage-lcov-merged` artifact (local scoped coverage is not authoritative). Engine-touching code
  respects the Engine ≥85% gate.

## 13. Build lanes (become the TDD plan's task groups)

- **A — Policy core:** schema + parser + signing + policy-gate + I22 + D16.
- **B — Enforcement:** connector allowlist @ `assemble`, retention floor, HITL/quorum override, profile×policy resolver.
- **C — Distribution:** `federation.policy` serve/fetch, pubkey pinning at pairing, sync re-fetch.
- **D — Observability:** status aggregation, `/v1/admin/status`, `/metrics`, `admin.status` IPC.
- **E — Admin console:** `packages/admin-console` bundle + **`bun build` pipeline + monorepo build wiring +
  runtime asset resolution (§7.1)** + serving + bearer auth + 6 views (left-sidebar shell).
- **F — Team audit merged view:** `federation.auditExport` + aggregation + console view.
- **G — GDPR purge:** `gdpr_purge_job`/`_request` migration + durable per-peer ledger + sync-cycle retry
  (§9.1) + `federation.purge` + signed deletion records + CLI (`purge`, `purge --status`).
- **H — Surface & docs:** CLI/Tauri wiring, [`docs/architecture.md`](../../architecture.md), SECURITY-INVARIANTS.md, [`docs/CHANGELOG.md`](../../CHANGELOG.md), roadmap checkboxes.

A → B → C form a dependency chain; D/E/F/G hang off A+C and can proceed in parallel; H closes out.

## 14. Roadmap items closed

- "Org-level policy engine" + "Policy enforcement at the Gateway" (Shared Workflows & Policy).
- "Admin console" + "Team audit log" + "GDPR/compliance at org level" (Admin & Observability).
- The Slice 4 row in the Phase 6 delivery-slice table.

## 15. Design-review resolutions

Resolutions to [the design review](./2026-06-07-phase6-slice4-policy-admin-observability-design-review.md)
(all five fixed; none deferred):

1. **Line-ending normalization for signatures** — *Fixed.* Added §4.2.1: sign/verify operate on a single
   `canonicalize(toml)` form (LF, BOM-stripped, per-line trailing-whitespace stripped, one trailing `\n`),
   so git/editor CRLF rewrites cannot break verification across OSes. Test added (§12).
2. **Monotonicity vs policy updates** — *Fixed (clarification).* Rewrote §4.3 R3: "stricter" is relative
   to the **local baseline**, not a historical high-water mark. Admins **can** lower an org constraint
   (e.g. quorum 3 → 2) as long as the result stays ≥ the local default; policy can only never drop
   *below* that baseline. I22 test (§10) and §12 updated to cover the raise-then-lower case.
3. **Offline peers during GDPR purge** — *Fixed.* Added §9.1: a durable `gdpr_purge_job`/`_request` ledger;
   purge never blocks on offline peers; the federation sync cycle retries every `pending` request until a
   signed deletion record returns; the job closes (and the aggregate record is signed) only when all peers
   are `done`. Lane G + an offline-peer integration test added.
4. **`/metrics` authentication** — *Fixed.* §6 now specifies `/metrics` requires the same bearer token as
   the read surface (it exposes posture data), configured via Prometheus `authorization` /
   `bearer_token_file`; localhost bind (I6) is the second layer. Auth test added (§12).
5. **Static console build/deploy lifecycle** — *Fixed.* Added §7.1: a `bun build` script (no Vite),
   monorepo build fan-out so `dist/` precedes gateway serve/package steps, a freshness gate, runtime asset
   resolution with a clear 503 when unbuilt, and `dist/` git-ignored. Lane E updated.

The review's "Alignment with Invariants" section (I22, I7 Tauri exclusions, audit-shipper metadata-only)
recorded **no** required changes.

### 15.1 Second-round considerations (all addressed; none deferred)

The follow-up review confirmed the five above and raised three **minor** points — all documentation/clarity
(plus one tiny CLI affordance); none change the architecture:

1. **Purge ledger lifecycle & DB growth** — *Documented.* §9.1 now states the `gdpr_purge_job`/`_request`
   rows are retained **indefinitely** as the compliance ledger, are **not** subject to `retention.min_days`
   (which governs `tool_call_log` only), are never pruned, and have negligible footprint (purge events are
   rare). Behavior was already correct; the decision is now explicit.
2. **TOML canonicalization is byte-level, not semantic** — *Documented.* §4.2.1 now notes canonicalization
   normalizes line endings/BOM/trailing-whitespace but does not reformat TOML, so *any* edit (including
   comments / inter-key whitespace) invalidates the `.sig` and requires re-signing — automatic on the
   anchor console editor's save, manual via `nimbus policy sign`. This is the intended trade-off (no fragile
   AST round-trip).
3. **Prometheus scraper token retrieval** — *Fixed (doc + small affordance).* §6 documents that `/metrics`
   uses the existing HTTP read-surface bearer (no new secret) and adds **`nimbus admin token`** to print it
   for a `bearer_token_file`; §11 adds `token` to the `nimbus admin` subcommands.
