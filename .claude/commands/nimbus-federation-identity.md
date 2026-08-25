---
name: nimbus-federation-identity
description: >
  Phase 6 Team federation + identity/access. Federation: the consent-scoped, leak-proof
  federated query gate (invariant `I17` / static `D13`, `federation/query-gate.ts`), shared
  scoped namespaces + per-peer RBAC grants (`namespace-store.ts`), mDNS discovery +
  out-of-band peer pairing (`discovery.ts` / `peer-pairing.ts`), content-free expertise
  routing, the consent broker, and the over-the-wire `LanServer` seam. Identity: OIDC
  device-code SSO + RS256 token verification (invariant `I18` / static `D14`,
  `identity/verifier.ts`), SCIM v2 provisioning on the `I13` HTTP write surface
  (`scim-http-routes.ts`), JWKS cache, and operator↔peer bindings. Covers the
  `federation.*` / `identity.*` / `scim.*` IPC namespaces, the `nimbus team` / `identity` /
  `scim` CLI, the V33 + V34 migrations, and the `[federation]` / `[identity]` / `[scim]`
  nimbus.toml schema. Use when adding or modifying federation or identity/SCIM behavior,
  touching `packages/gateway/src/{federation,identity}/`, wiring a federated query path,
  changing the query gate or token verifier, exposing a Phase 6 method to LAN/Tauri, or
  asking why a federated query returns empty / why identity gates only federation.
---

# Nimbus Phase 6 — Team Federation & Identity/Access

## Why This Skill Exists

Phase 6 (Team) makes Nimbus a collaborative layer **without surrendering local sovereignty**. Two coupled subsystems carry it, each with its own structural invariant:

- **Federation** (Slice 1) — a Gateway can answer a scoped query from a *paired peer* Gateway over the encrypted LAN channel, but **only** through a single leak-proof gate (`I17`).
- **Identity & Access** (Slice 3) — SSO/OIDC + SCIM **gate federation, and only federation**. Local `ask` / `search` are never affected by identity. Tokens are validated in exactly one place and live only in the Vault (`I18`).

Slice 2 (Team Vault + Quorum HITL) shipped 2026-06-07 ✅ — its surface is frozen. Covers invariants I19/I20/I21 and team-vault/delegation/quorum/purge IPC.

## File Map

**Federation** — `packages/gateway/src/federation/`

| File | Role |
|---|---|
| `query-gate.ts` | **I17** — `answerFederatedQuery`, the ONLY path that answers an inbound `federation.query`. Grant + role + consent + declared-namespace filter; returns the leak-proof `FederatedItem` shape (never `metadata`). |
| `namespace-store.ts` | Shared scoped namespaces + per-peer RBAC grants (`federation_namespaces` / `_filters` / `_grants`, V33). |
| `peer-pairing.ts` / `discovery.ts` / `mdns-discovery-provider.ts` | Mutual-approval pairing (out-of-band code) + mDNS/manual peer discovery. |
| `consent-broker.ts` / `consent-cache.ts` | Owner-consent round-trip for over-the-wire queries; session consent cache. |
| `expertise.ts` | Content-free "who knows X?" ranking (ranks only, never item bodies). |
| `federation-server.ts` / `federation-runtime.ts` | `buildFederationLanServer` (started at boot when `[federation].enabled`) + runtime wiring. |
| `federation-audit.ts` | Every federated outcome appended to the BLAKE3 audit chain (`audit_log.federation_json`, V33). |
| `federation-identity.ts` | Bridges identity bindings into federation authorization. |

**Identity** — `packages/gateway/src/identity/`

| File | Role |
|---|---|
| `verifier.ts` | **I18** — the ONLY place IdP tokens are validated (RS256). Federation consults `isOperatorValid()`. |
| `oidc-device-flow.ts` / `oidc-discovery.ts` / `jwks-cache.ts` | OIDC device-code login, discovery doc, cached JWKS. |
| `identity-store.ts` / `identity-vault.ts` | Operator↔peer bindings; raw ID/refresh tokens + SCIM bearer are Vault-only. |
| `scim-service.ts` / `scim-http-routes.ts` | SCIM v2 provisioning; inbound writes arrive on the `I13` `/scim/v2/Users` routes. |
| `deprovision.ts` | Deprovision a user → auto-revoke their federation grants/bindings. |
| `identity-boot.ts` / `identity-runtime.ts` | Boot + runtime wiring. |

## Security Invariants (the triple — wiring + docs + test land together)

- **I17** — federated answering only in `query-gate.ts`; leak-proof shape; static **D13** forbids any federation module other than `query-gate.ts` from importing the item-list query. Answering `peerId` is forced from the NaCl-authenticated session, never the request body (I17/R1).
- **I18** — IdP token validation only in `identity/verifier.ts`; raw tokens Vault-only; federation consults `isOperatorValid()`; static **D14** forbids identity-token Vault-key literals outside `identity/`. (D11 is connector-scoped, which is why non-connector identity keys needed a purpose-built D14.)

Both are asserted at runtime in `packages/gateway/src/security-invariants.test.ts` (I17/I18 describe blocks) and statically in `scripts/structure-audit/check-nimbus-invariants.ts` (D13/D14). See the `nimbus-security-invariants` skill for the triple-rule contract.

## Surfaces

- **CLI:** `nimbus team` (discover / pair / namespace publish|grant|revoke / query / who-knows / consent / listen) · `nimbus identity` (login / status / logout / list-bindings / bind / unbind) · `nimbus scim` (status / set-token / ...). Full reference: [`docs/cli-reference.md`](../../docs/cli-reference.md) §§ Team Federation, Identity & Access.
- **IPC:** `federation.*` / `identity.*` / `scim.*` — see the `nimbus-ipc` skill registry. LAN admits `federation.query` / `federation.expertise` (Slice 1), plus answerable Slice 2+ methods: `federation.invoke` / `federation.quorumRespond` / `federation.approvalRespond` / `federation.requestApproval` (team-vault invoke + quorum), `federation.purge` (GDPR), and `federation.auditExport` / `federation.policy` (audit/policy distribution) — all HITL-gated and answerable. Management methods `federation.discover`, `federation.pair`, `federation.peers`, `federation.namespace.*`, `federation.ask*`, `team.auditMerged` + identity/scim methods are CLI-only. See `lan-rpc.ts` FORBIDDEN_OVER_LAN for the authoritative blocked list (`I5`). The Tauri allowlist (`I7`, `ALLOWED_METHODS` in `gateway_bridge.rs`) includes federation/identity/scim/team read/query methods; see `nimbus-tauri-allowlist` for the current count and exact surface. Credential-mutating methods (`federation.pair`, `identity.bind`, `scim.setToken`, `teamvault.put`/`grant`, `hitl.delegate`, `federation.invoke`) remain renderer-forbidden.
- **HTTP:** SCIM provisioning writes (`POST` / `PATCH` / `DELETE /scim/v2/Users`) are 3 of 14 routes on the `WRITE_ROUTE_ALLOWLIST` (`I13`): see `nimbus-http-write-surface` for the authoritative list (currently 14: deployments, SCIM create/patch/delete, admin policy, teams events, the two web-clipper routes, the four research-brief routes, agent invoke, and targeted item fetch).
- **Schema:** V33 (federation namespaces/filters/grants + nullable `audit_log.federation_json`, folded into the chain only when present) · V34 (identity/SCIM tables). See `nimbus-db-migrations`.
- **Config:** `[federation]` (transport rides the `[lan]` section), `[identity]`, `[scim]` in `nimbus.toml` — all disabled by default.

## Slice 6a — Asker-side Fan-out (cross-colleague agents)

Phase 6 Slice 6a (2026-06-11) added an **asker-side fan-out layer** on top of the existing `federation.query` / `federation.expertise` primitives — no new invariant, no new answering-side gate (I17 continues to govern all inbound answering unchanged).

**`federation/peer-fanout.ts`** — the shared helper that iterates `PeerRegistry`, dispatches `federation.query` or `federation.expertise` to each peer in parallel (per-peer timeout + error isolation), and merges the results. Consumed only by the three new cross-colleague agents (`ghost`, `conflicts`, `huddle`).

**V38 `federation_known_namespaces`** — asker-side SQLite cache (added by the V38 migration, which set `CURRENT_SCHEMA_VERSION` to 38 at the time — the constant has since moved on; check `index/local-index.ts` for its current value) recording which remote namespaces a successful federated query touched. Lets the agents default to an ambient sweep when `--namespace` is omitted. Rows are pruned when a `no_grant` response is received or a peer is unpaired. This table lives on the **asker** side only — it carries no secret data and is not subject to I17 (which governs the answering side).

**No new invariant for Slice 6a.** The answering side remains fully gated by I17 (`query-gate.ts`). The fan-out adds asker-side orchestration only.

**Schema:** V38 (`federation_known_namespaces`). See `nimbus-db-migrations`.

## Gotchas

- **Identity gates federation ONLY.** A common wrong assumption is that enabling `[identity]` affects local `ask`/`search` — it does not. Identity validity is consulted by the federation query gate, nowhere else.
- **The query gate is the chokepoint.** Never add a second code path that returns federated results. Any new federation read must route through `answerFederatedQuery` or it violates I17/D13 (static audit fails before tests run).
- **`FederatedItem` must never carry `metadata`.** The leak-proof shape is the boundary; adding fields there is how a content leak ships.
- **Pre-V33 audit-chain column-resilience:** the `audit_log.federation_json` column is folded into the BLAKE3 hash only when present, so legacy rows hash identically — do not unconditionally include it.
- **`isOperatorValid()` grace window:** validate the units (a past bug applied a ×1000 grace). Tokens are Vault-only; never log or return them.
- **`bun test` ≠ `tsc --noEmit`** for this surface — run the typecheck; the federation/identity wiring has cross-module types that tests don't exercise.
