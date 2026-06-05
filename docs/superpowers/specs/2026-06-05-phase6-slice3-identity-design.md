# Phase 6 Slice 3 — Identity & Access (SSO/OIDC + SCIM): Design Spec

**Date:** 2026-06-05
**Branch:** `dev/asafgolombek/phase6-slice3-identity`
**Depends on:** Phase 6 Slice 1 — Federation Core (merged, PR #519). Independent of Slices 2/4–9.
**Roadmap:** [`docs/roadmap.md`](../../roadmap.md) → Phase 6 → Identity & Access (Slice 3).

---

## 1. Problem & Scope

Slice 1 delivered the federation substrate: E2EE peer pairing, scoped namespaces, per-`(namespace, peer)` RBAC grants (`owner`/`editor`/`viewer`), and the leak-proof, consent-gated `query-gate.ts`. What it does **not** have is any concept of **organizational identity**: a peer is just a box pubkey (`peer:<hex>`), unanchored to a person in a company directory. There is no way to say "Alice from Acme is a valid org member" or "Alice left the company — cut off her access everywhere."

Slice 3 adds that layer:

- **SSO via OIDC** — the Gateway authenticates its **operator** against the org's enterprise IdP (Okta / Entra ID / Auth0 / Google Workspace / any OIDC-conformant IdP) and validates the resulting ID token. Tokens live **only in the Vault** (non-negotiable #3).
- **SCIM 2.0 user provisioning** — a designated **trust-anchor** Gateway exposes a SCIM Service Provider endpoint that the org IdP pushes user lifecycle events to. A **deprovision** (`active:false` / DELETE) automatically **revokes that user's federation grants** via Slice 1's `NamespaceStore.revoke` — their next federated query gets `no_grant`.
- A new structural security invariant **I18**: IdP token validation is intrinsic to a single verifier module; raw tokens are Vault-only; federation consults the verifier before any cross-org operation.

**RBAC is already done** (Slice 1, protocol-layer, enforced in the query gate). Slice 3 is the **cross-org / IdP-driven identity + lifecycle** layer, not the in-namespace role check.

### 1.1 Design decisions (locked in brainstorming)

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **OIDC only** (no SAML in Slice 3) | SAML is XML-DSig / browser-POST-binding-centric and assumes a server-side web SP — a poor fit for a headless daemon. OIDC has native-app-friendly flows and reuses the existing OAuth substrate. SAML is a documented deferral. |
| D2 | **Device Authorization Grant only** (RFC 8628) | No loopback HTTP listener required; cleanest flow for a headless Gateway. PKCE-loopback deferred. |
| D3 | **IdP-agnostic via `.well-known/openid-configuration` discovery** | One code path covers all conformant IdPs (validated against Okta + Entra). No per-vendor adapters. |
| D4 | **SCIM on the trust-anchor Gateway, on the HTTP write surface (I13)** | No central relay exists; the trust-anchor pattern mirrors Slice 2's Team Vault. The IdP gets one base URL. Bearer-authenticated. |
| D5 | **Identity gates federation, not local use; offline-tolerant grace** | Local-first: `ask`/`search` always work. Federation requires a valid, non-expired (within grace), non-deprovisioned operator identity. |
| D6 | **`scim_user ↔ peer_id` binding via a signed claim at pair-approval, admin-overridable** | Cryptographic binding where the handshake can carry it (inbound pairing, which is real in Slice 1); manual `nimbus identity bind` fallback for the deferred outbound path. |
| D7 | **New structural invariant I18** | Token validation is invariant-worthy: one verifier, Vault-only tokens, federation consults it. Static complement D14. |
| D8 | **Local revoke only** (trust-anchor revokes grants it holds) | Mesh-wide revocation fan-out rides Slice 1's still-deferred outbound LAN client / Slice 2. |

### 1.2 Explicit non-goals (deferred)

SAML 2.0; OIDC Auth-Code + PKCE-loopback flow; mesh-wide revocation fan-out to other gateways; multiple simultaneous issuers / multi-org; refresh-token auto-rotation beyond a single refresh attempt; a UI admin console (that is Slice 4). Multi-user HITL delegation (roadmap lists it under Identity & Access but it is sequenced to **Slice 2** per the slice map, not Slice 3).

---

## 2. Architecture

### 2.1 Subsystem placement

A new top-level `packages/gateway/src/identity/` directory, parallel to `federation/`. This keeps the new surface cohesive and minimizes edits to the hot `auth/` files (which are shared with the connector OAuth registry and a rebase-conflict risk). The identity subsystem *reuses* `auth/` HTTP/discovery idioms but the Device Authorization Grant needs no PKCE.

```text
packages/gateway/src/identity/
  types.ts                # OidcConfig, ScimConfig, IdentitySession, ScimUser, IdentityBinding, wire shapes
  oidc-discovery.ts       # GET {issuer}/.well-known/openid-configuration (+ persisted cache)
  oidc-device-flow.ts     # RFC 8628: device_authorization request → poll token endpoint
  jwks-cache.ts           # fetch + persist JWKS public keys (offline-grace)
  verifier.ts             # ★ I18 canonical — validateIdToken(sig + iss/aud/exp/nbf); isOperatorValid()
  identity-store.ts       # identity_session + scim_user + identity_binding DB access (dbRun/dbExec/dbStmtRun)
  identity-runtime.ts     # orchestrates login / status / logout; session lifecycle
  scim-service.ts         # SCIM 2.0 SP logic: Users resource shape, PATCH active=false, list/get
  scim-http-routes.ts     # wires SCIM into ipc/http-write-routes.ts (I13 allowlist + bearer auth)
  deprovision.ts          # active=false → resolve bindings → NamespaceStore.revoke (audited)
```

Tests are co-located `*.test.ts` (Slice 1 convention) plus an integration acceptance suite under the gateway test tree.

### 2.2 Data flow — OIDC login (device-code)

```text
nimbus identity login
  → identity.login (IPC, long-running)
  → oidc-discovery: fetch issuer metadata (cache)
  → oidc-device-flow: POST device_authorization_endpoint {client_id, scope}
  ← { device_code, user_code, verification_uri, interval, expires_in }
  → emit progress: show verification_uri + user_code to the operator
  → poll token_endpoint (grant_type=device_code) every `interval`s until authorized/expired
  ← { id_token, access_token, refresh_token? }
  → verifier.validateIdToken(id_token)  (JWKS sig + iss/aud/exp/nbf)
  → identity-store: upsert identity_session {external_id=sub, email, issuer, claims_json, validated_at, expires_at, status='active'}
  → vault.set('identity.oidc.id_token', …); vault.set('identity.oidc.refresh_token', …)
  → identity.login done
```

### 2.3 Data flow — SCIM deprovision → grant revocation

```text
IdP ── SCIM PATCH /scim/v2/Users/{id} {active:false} ──▶ trust-anchor Gateway HTTP write surface
  → http-auth: constant-time bearer compare against vault('identity.scim.bearer')  (I10, I13)
  → scim-service: validate SCIM PatchOp; identity-store updates scim_user.active=0
  → deprovision.run(external_id):
       SELECT peer_id FROM identity_binding WHERE external_id=? AND revoked_at IS NULL
       for each (namespace, peer_id) active grant:
           NamespaceStore.revoke(namespace, peer_id)     ← Slice 1 path
       audit each revocation into the BLAKE3 chain
  → 200/204
Next federated query from that peer → query-gate getActiveGrant() returns undefined → no_grant
```

### 2.4 Data flow — federation consults the verifier (I18)

```text
inbound federation.query → query-gate.answerFederatedQuery(...)
  if identityEnabled:
      if !verifier.isOperatorValid():   # invalid / expired-past-grace / locally deprovisioned
          → audit the decision locally as `identity_invalid` (precise, for the operator's own log)
          → return the SAME opaque denial the peer already gets for no-grant (no identity-state leak)
          → do NOT read the index
  … existing grant + role + consent + filter checks …
```

**Decision encoding (resolved):** the answering side audits its own refusal precisely as `identity_invalid` in its local log, but over the wire returns the existing `no_grant`-class denial — the peer learns nothing about *why* (whether they lack a grant or the answerer's own identity lapsed). This adds one internal `FederationDecision` audit value but **no new over-the-wire `FederationWireError`**, minimizing churn on Slice 1's shared `federation/types.ts`.

Local `engine.ask` / `index.query` never consult the verifier — local-first use is unaffected.

---

## 3. Data Model — Migration V34

> **Contiguity caveat:** `CURRENT_SCHEMA_VERSION` is **33** on this branch. Migrations are strictly contiguous — verify at branch/rebase time and **take the next available number**. If a parallel track (Slice-1 follow-up / Slice 9) consumed V34 first, take V35 and renumber. Register the step in `index/migrations/runner.ts` `INDEXED_SCHEMA_STEPS` (a `simpleStep`) and append the matching gapless `BACKFILL_LABELS` entry.

All tables are additive (append-only schema rule). All writes via `dbRun`/`dbExec`/`dbStmtRun` (I14). No secret values are stored in any column.

```sql
-- The operator's OWN validated org identity (single-row-per-issuer; raw tokens are NOT here).
CREATE TABLE IF NOT EXISTS identity_session (
  issuer        TEXT PRIMARY KEY,
  external_id   TEXT NOT NULL,            -- OIDC `sub`
  email         TEXT,
  claims_json   TEXT NOT NULL DEFAULT '{}',  -- non-sensitive claims snapshot
  validated_at  INTEGER NOT NULL,
  expires_at    INTEGER NOT NULL,         -- id_token exp (ms)
  status        TEXT NOT NULL DEFAULT 'active'  -- 'active' | 'expired' | 'deprovisioned'
);

-- The org roster pushed by the IdP via SCIM (trust-anchor only).
CREATE TABLE IF NOT EXISTS scim_user (
  external_id   TEXT PRIMARY KEY,         -- SCIM resource id
  user_name     TEXT,
  email         TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  attrs_json    TEXT NOT NULL DEFAULT '{}',  -- non-sensitive SCIM attributes
  created_at    INTEGER NOT NULL,
  updated_at    INTEGER NOT NULL
);

-- external_id ↔ peer_id binding (many peers per user possible).
CREATE TABLE IF NOT EXISTS identity_binding (
  external_id   TEXT NOT NULL,
  peer_id       TEXT NOT NULL,
  bound_at      INTEGER NOT NULL,
  bound_by      TEXT NOT NULL,            -- 'handshake' | 'admin'
  revoked_at    INTEGER,
  PRIMARY KEY (external_id, peer_id)
);
CREATE INDEX IF NOT EXISTS idx_identity_binding_peer ON identity_binding(peer_id);

-- JWKS public keys cached for offline-grace ID-token verification (NOT secret).
CREATE TABLE IF NOT EXISTS oidc_jwks_cache (
  issuer        TEXT NOT NULL,
  kid           TEXT NOT NULL,
  key_json      TEXT NOT NULL,           -- public JWK
  fetched_at    INTEGER NOT NULL,
  PRIMARY KEY (issuer, kid)
);
```

**Vault keys** (raw secrets — never DB/IPC/config/logs, #3): `identity.oidc.id_token`, `identity.oidc.refresh_token`, `identity.scim.bearer`. These must be added to the static **vault-key allow-list** in `scripts/structure-audit/check-nimbus-invariants.ts`.

---

## 4. Configuration — `[identity]` + `[scim]`

Mirrors the `loadNimbusFederationFromConfigDir` pattern in `config/nimbus-toml.ts` (`DEFAULT_NIMBUS_<SECTION>_TOML` + `parseNimbus<Section>Toml` + `applyNimbus<Section>Key` + `loadNimbus<Section>FromConfigDir`). **No secret values appear in config** — the SCIM bearer token and OIDC tokens live only in the Vault.

```toml
[identity]
enabled = false
issuer = "https://acme.okta.com"        # used to build .well-known discovery URL
client_id = "0oaXXXXXXXX"
flow = "device_code"                    # only supported value in Slice 3
scopes = ["openid", "email", "profile"]
session_grace_seconds = 86400           # offline tolerance past id_token exp
revalidate_interval_seconds = 3600      # re-check cadence for long-lived sessions

[scim]
enabled = false                         # only meaningful on the trust-anchor gateway
# SCIM bearer token is set via `nimbus scim set-token` → Vault; NEVER in this file.
```

Defaults: both `enabled=false` — Slice 3 is inert until an operator opts in, preserving the single-user default experience.

---

## 5. Identity Verifier — Invariant I18

`identity/verifier.ts` is the **only** module that validates an ID token. It exposes:

- `validateIdToken(jwt: string): Promise<ValidatedClaims>` — verify JWS signature against the cached JWKS (refetch on `kid` miss), check `iss` == configured issuer, `aud` == `client_id`, `exp`/`nbf` with clock-skew tolerance. Throws a typed error on any failure.
- `isOperatorValid(now): boolean` — reads `identity_session`: status `active`, `now <= expires_at + session_grace_seconds`, and not locally `deprovisioned`. The federation gate's single question.

**Triple rule (I18):**

- **Wired at:** `identity/verifier.ts` (validation) + `federation/query-gate.ts` (consults `isOperatorValid()` before answering) + `federation/federation-runtime.ts` (before initiating). Tokens Vault-only.
- **Docs:** new row in `docs/SECURITY-INVARIANTS.md` (full rationale + anti-pattern) and the CLAUDE.md / GEMINI.md invariant tables.
- **Runtime test:** `packages/gateway/src/security-invariants.test.ts` — an `I18` block proving (a) an invalid/expired token blocks federated answering, (b) no raw token is exposed on any IPC/wire response, (c) the verifier is the path consulted.
- **Static check D14:** in `check-nimbus-invariants.ts` — (a) no `idToken` / `id_token` / `accessToken` / `refreshToken` field name appears on any IPC/wire type under `ipc/` or `identity/types.ts`; (b) the raw-token Vault keys (`identity.oidc.*`, `identity.scim.bearer`) are read only within `identity/`. Fails before the test suite.

**Anti-pattern that regresses I18:** validating an ID token anywhere other than `verifier.ts`; putting a token field on an IPC/wire shape; reading `identity.oidc.*` Vault keys outside `identity/`; a federation answer path that skips the `isOperatorValid()` consult when identity is enabled.

---

## 6. SCIM Service Provider (trust-anchor only)

A SCIM 2.0 (RFC 7643/7644) **Users** resource on the HTTP write surface:

- `POST /scim/v2/Users` — create/provision (upsert into `scim_user`).
- `GET /scim/v2/Users` / `GET /scim/v2/Users/{id}` — list/read roster (no secrets).
- `PATCH /scim/v2/Users/{id}` — `replace`/`add` ops, notably `active:false` → triggers `deprovision.run`.
- `DELETE /scim/v2/Users/{id}` — hard deprovision → `deprovision.run`.

**Security wiring:**

- Routes added to `WRITE_ROUTE_ALLOWLIST` in `ipc/http-write-routes.ts` and dispatched via `dispatchWriteRoute` (I13). No second writable DB is opened.
- Authenticated by a SCIM **bearer token** held in the Vault (`identity.scim.bearer`), compared **constant-time** (`constantTimeStringEqual`, I10).
- Per-token rate limit + audit-on-rejection, consistent with the existing write surface.
- Gated on `[scim].enabled` — returns `503 write_surface_disabled`-style when off.

`scim-service.ts` holds the pure SCIM shape logic (PatchOp parsing, resource serialization) and is unit-tested without HTTP. `scim-http-routes.ts` is the thin adapter.

---

## 7. Identity Binding

`identity_binding` maps `external_id → peer_id`:

- **Handshake path (auto, cryptographic):** at **inbound** pair-approval (`PeerPairing.approveInboundPair`, which already persists in Slice 1), a peer may present a verifiable identity claim `{ email, sub, sig }` bound to its box pubkey. The trust-anchor verifies `sub` exists/active in `scim_user`, then inserts `identity_binding(external_id, peer_id, 'handshake')`. The **outbound** claim path rides Slice 1's still-deferred outbound LAN client — wired behind the same DI seam, no production outbound binding in Slice 3.
- **Admin path (manual):** `nimbus identity bind <email> <peer_id>` / `unbind <peer_id>` — for operators paired before identity was enabled, or the deferred outbound case. Inserts/soft-revokes a `'admin'` binding.

Deprovision resolves **all** non-revoked bindings for an `external_id` and revokes each peer's grants.

---

## 8. IPC Surface

New namespaces `identity.*` and `scim.*` (`ipc/handlers/identity.ts`, `ipc/handlers/scim.ts`), registered in the IPC server dispatcher.

| Method | Kind | LAN | Tauri renderer | Notes |
|--------|------|-----|----------------|-------|
| `identity.login` | long-running | ✗ | ✓ | device-code; emits progress (verification_uri/user_code) → done. Uses the `LongRunningJobRegistry` helper. |
| `identity.status` | request | ✗ | ✓ | current operator identity + validity (no token). |
| `identity.logout` | request | ✗ | ✓ | clears session + token Vault keys. |
| `identity.bind` | request | ✗ | **✗ (CLI-only)** | admin mutation. |
| `identity.unbind` | request | ✗ | **✗ (CLI-only)** | admin mutation. |
| `identity.listBindings` | request | ✗ | ✓ | read-only. |
| `scim.status` | request | ✗ | ✓ | endpoint enabled? roster size. |
| `scim.setToken` | request | ✗ | **✗ (CLI-only)** | writes a credential to Vault. |
| `scim.listUsers` | request | ✗ | ✓ | read-only roster. |
| `scim.deprovision` | request | ✗ | **✗ (CLI-only)** | manual admin trigger. |

- **LAN:** every `identity.*` / `scim.*` method added to `FORBIDDEN_OVER_LAN` in `ipc/lan-rpc.ts` (these are local management; the only network-facing identity surface is the SCIM HTTP endpoint, which is *not* LAN-RPC). Mirrors Slice 1's management-methods-are-local rule.
- **Tauri allowlist (I7):** add the read/login surface (`identity.login`, `identity.status`, `identity.logout`, `identity.listBindings`, `scim.status`, `scim.listUsers`) to `ALLOWED_METHODS` in `ui/src-tauri/src/gateway_bridge.rs`. **`scim.setToken`, `identity.bind`, `identity.unbind`, `scim.deprovision` stay CLI-only** (write a credential / admin mutation — mirrors `federation.pair` staying CLI-only). Mark `identity.login` long-running (no timeout). Bump the Rust `assert_eq!` allowlist count **and** the TS mirror assertion in `security-invariants.test.ts`.

---

## 9. CLI Surface

Two new top-level commands (`packages/cli/src/commands/identity.ts`, `scim.ts`):

```text
nimbus identity login            # device-code; prints verification URL + code, waits
nimbus identity status           # who am I, valid until, deprovisioned?
nimbus identity logout
nimbus identity bind <email> <peer-id>
nimbus identity unbind <peer-id>
nimbus identity list-bindings
nimbus scim status
nimbus scim set-token            # prompts/streams the IdP's SCIM bearer → Vault
nimbus scim list-users
nimbus scim deprovision <email>  # manual trigger
```

Both `identity` and `scim` registered in **both** `packages/cli/src/commands/registry.ts` `COMMAND_NAMES` and `packages/cli/src/index.ts` `COMMAND_HANDLERS` (the registry is what `audit:readme-cli` validates). Add to `docs/cli-reference.md`.

---

## 10. Testing Strategy

- **Unit:** `verifier` (fake JWKS keypair, sign a test JWT, assert sig/iss/aud/exp paths); `oidc-device-flow` (fake token endpoint: pending → slow_down → authorized → expired); `oidc-discovery` (fake metadata + cache); `jwks-cache`; `identity-store` (real in-memory SQLite at V34); `scim-service` (PatchOp `active:false` → deprovision call); `deprovision` (binding resolution → `NamespaceStore.revoke` spy).
- **Integration (real SQLite, V34 migration):** SCIM deprovision end-to-end — seed a granted peer, PATCH `active:false`, assert `query-gate` then returns `no_grant`; identity-disabled → federation unaffected; expired operator token → federated answer denied, local `index.query` still works.
- **Security invariants:** the `I18` block in `security-invariants.test.ts`; the new `D14` static rule in the structure-audit test.
- **HTTP write surface:** SCIM route requires bearer; wrong/absent token → 401 + audit; `[scim].enabled=false` → disabled.
- **Coverage:** new `identity/` subsystem targets **≥85%**. The gate is `bun run preflight` (not `test:ci`). `audit:coverage-floor` is **CI-Linux-authoritative** — verify on Linux via Docker (`oven/bun:latest`, `-v "C:/path":/src:ro`, `apt install git`, `bun install`, `audit:coverage-floor:build-lcov` + `audit:coverage-floor`) before the PR.

---

## 11. Shared / Hot Files Touched (parallel-track conflict surface)

Minimize edits; resolve against latest `main` at rebase:

- `index/local-index.ts` (`CURRENT_SCHEMA_VERSION` bump) + `index/migrations/runner.ts` (`INDEXED_SCHEMA_STEPS` + `BACKFILL_LABELS`).
- `config/nimbus-toml.ts` (new `[identity]` / `[scim]` sections).
- `platform/assemble.ts` (boot wiring: construct identity runtime, register SCIM routes when enabled).
- `ipc/lan-rpc.ts` (`FORBIDDEN_OVER_LAN`), `ipc/http-write-routes.ts` (`WRITE_ROUTE_ALLOWLIST`).
- `ui/src-tauri/src/gateway_bridge.rs` (`ALLOWED_METHODS` + count) + `security-invariants.test.ts` (TS count mirror).
- `cli` `registry.ts` + `index.ts`.
- `scripts/structure-audit/check-nimbus-invariants.ts` (vault-key allow-list + D14).
- Docs: `SECURITY-INVARIANTS.md`, `CLAUDE.md` + `GEMINI.md` invariant tables, `roadmap.md` (flip the two Identity & Access rows), `CHANGELOG.md`, `cli-reference.md`.

---

## 12. Acceptance Criteria

1. An operator can `nimbus identity login` against an OIDC IdP (device-code), and the ID token is validated and stored only in the Vault.
2. `identity.status` reports the validated identity; no raw token is ever returned over IPC or logged.
3. With `[identity].enabled`, an expired-past-grace / deprovisioned operator identity blocks federated answering while local `ask`/`search` keep working.
4. The trust-anchor SCIM endpoint accepts IdP pushes under bearer auth (I13); a `active:false` / DELETE deprovision revokes that user's federation grants, and their next federated query returns `no_grant`.
5. `scim_user ↔ peer_id` binding works via the inbound-handshake claim and the admin CLI fallback.
6. Invariant **I18** is wired, documented, runtime-tested, and statically enforced (D14).
7. `bun run preflight` is green; `audit:coverage-floor` passes on Linux; new subsystem ≥85% coverage.
