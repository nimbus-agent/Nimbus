# Phase 6 Slice 1 follow-up — Real two-gateway-over-the-wire federation — Design

**Date:** 2026-06-05
**Author:** Asaf Golombek
**Status:** Approved for planning
**Branch:** `dev/asafgolombek/phase6-slice1-federation-wire`
**Builds on:** [`2026-06-04-phase6-federation-core-design.md`](./2026-06-04-phase6-federation-core-design.md) (Slice 1 — Federation Core, shipped PR #519)

---

## 1. Purpose

Slice 1 (Federation Core) delivered the full federation substrate **in-process** and left three
pieces as injectable seams. This track wires them up so **two real Nimbus Gateways exchange
federated queries over the NaCl-box LAN channel**, end to end. It adds no new federation *concepts* —
it makes the existing query-gate, namespace store, audit chain, and `federation.*` RPC surface
reachable across a real encrypted socket between two processes.

The acceptance is the two-subprocess E2E that Slice 1's Task 15 deferred and stood in for with an
in-process integration suite.

### The three deferred seams (verbatim from PR #519 / the acceptance test header)

1. **Outbound LAN client** — `PeerPairing.initiatePair` calls an injectable `OutboundPairHandshake`
   that currently throws `"federation: outbound pair handshake not wired"`.
2. **`LanServer` boot wiring** — `new LanServer(...)` is never constructed in production
   (`grep -rn "new LanServer" packages/gateway/src` → tests only).
3. **Owner-consent UI round-trip** — `federation-rpc.ts` `makePrompter` emits a
   `federation.consentRequest` notification then defaults to a timeout-safe deny.

### Newly discovered prerequisite (not in the Slice 1 spec)

**Gateway federation identity keypair.** No persistent NaCl box keypair exists in production today —
`generateBoxKeypair`/`hostKeypair` appear only in tests, consistent with `LanServer` never having
been constructed in production. Both the outbound client and the `LanServer` boot need a **stable**
box keypair for this gateway. This track introduces it (§4.0). Vault-only, per non-negotiable #3.

### Non-negotiables / invariants this track must honor

- **Local-first / peer-to-peer** — no relay; strictly the LAN E2EE channel.
- **HITL/consent is structural** — the consent gate stays in `query-gate.ts`; the round-trip only
  delivers the owner's decision, it does not relocate the gate.
- **No plaintext credentials** — the identity secret key lives in the Vault only.
- **I5** — `checkLanMethodAllowed` stays intrinsic to `LanServer.handleEncryptedMessage`; not moved.
- **I6** — LAN bind defaults to `127.0.0.1`.
- **I7** — the one new renderer-callable method (`federation.consentRespond`) goes through the
  Tauri allowlist process (count + Rust assert + TS mirror). `federation.consentRequest` stays a
  notification, never renderer-callable.
- **I17** — federated answering stays intrinsic to `query-gate.ts`; the over-the-wire path derives
  the answering `peerId` from the authenticated session, never from the request body.

---

## 2. Components (each isolated, single-purpose)

| # | File | Responsibility |
|---|------|----------------|
| 4.0 | `federation/federation-identity.ts` (new) | Load-or-create the gateway's persistent NaCl box keypair from the Vault. One source of identity for server + client. |
| 4.1 | `ipc/lan-client.ts` (new) | Outbound LAN client: `outboundPairHandshake(...)` (the real `OutboundPairHandshake`) + `sendFederatedOverWire(...)` (authenticated encrypted RPC round-trip). |
| 4.2 | `platform/assemble.ts` (edit) + `federation/federation-runtime.ts` (edit) + `index/local-index.ts` (small helper) | Construct + start `LanServer` at boot when `[federation].enabled`; inject the real outbound handshake into `PeerPairing`. |
| 4.3 | `federation/consent-broker.ts` (new) + `ipc/federation-rpc.ts` (edit) + `ipc/server/dispatchers.ts` (edit) | Consent round-trip: pending-promise registry; `federation.consentRespond` local IPC method; real prompter. |
| 4.4 | `ui/src-tauri/src/gateway_bridge.rs` (edit) + `security-invariants.test.ts` (edit) | Expose `federation.consentRespond` to the renderer (I7). |
| 4.5 | `cli` — `nimbus team listen` + `nimbus team consent <id> approve\|deny` | Owner consent surfaces. |
| 4.6 | `test/e2e/scenarios/federation-two-gateway.e2e.test.ts` (new) | The payoff two-subprocess E2E. |

### 4.0 Federation identity keypair — `federation/federation-identity.ts`

`loadOrCreateFederationIdentity(vault) → BoxKeypair`. On first federation boot, generate a box
keypair (`generateBoxKeypair`) and persist the secret to the Vault; on subsequent boots, load it.
The public key is the gateway's stable peer identity (it is what a peer pins during pairing).

- **Vault key:** `federation.identity_secret` (store the 32-byte secret; the public key derives from
  it via `nacl.box.keyPair.fromSecretKey`, so only the secret is persisted). **Verify** the key
  string does not match the D11 `VAULT_KEY_RE` (it is built from *connector* secret suffixes —
  `access_token`/`refresh_token`/`api_key`/…; `identity_secret` should not collide). If it does
  collide, add `federation/federation-identity.ts` to `VAULT_KEY_ALLOW_LIST`; otherwise no
  structure-audit edit is needed.
- Loaded **once** at boot; the same `BoxKeypair` is handed to `LanServer.hostKeypair` and closed into
  the outbound handshake.

### 4.1 Outbound LAN client — `ipc/lan-client.ts`

Implemented against the wire protocol proven in `ipc/lan-server-handshake.test.ts` and
`ipc/lan-server.test.ts`: 4-byte big-endian length prefix, JSON handshake frames,
`sealBoxFrame`/`openBoxFrame` for the encrypted phase.

- `outboundPairHandshake(host, port, code, selfKp) → Promise<Uint8Array>` — connect via `Bun.connect`,
  send a framed `{ kind: "pair", client_pubkey: base64(selfKp.publicKey), pairing_code: code }`, read
  the reply frame. On `pair_ok` return `base64decode(host_pubkey)` (the responder's box public key);
  on `pair_err`, malformed reply, closed socket, or timeout, throw a typed error. This is the
  production `OutboundPairHandshake`; `selfKp` is closed in at boot. The DI seam on `PeerPairing`
  stays for unit tests.
- `sendFederatedOverWire(host, port, selfKp, peerPubkey, method, params) → Promise<unknown>` — send a
  `{ kind: "hello", client_pubkey }` handshake (the asker is now a known peer of the answerer from
  pairing), read `hello_ok` (+ `host_pubkey`, asserted to equal the pinned `peerPubkey`), then send
  one `sealBoxFrame({ id, method, params })` and read+`openBoxFrame` the reply, returning
  `result` or throwing on `error`. Used by the payoff E2E and the real `nimbus team query` /
  `who-knows` wire path. Bounded by a connect/read timeout.

### 4.2 `LanServer` boot wiring — `platform/assemble.ts`

Next to the existing `buildFederationRuntime` block, when `federationRuntime !== undefined`
(i.e. `[federation].enabled`):

- Load the identity keypair (§4.0).
- Construct `LanServer` with:
  - `hostKeypair` = identity;
  - `bind` / `port` from `[federation]` — **default `127.0.0.1` / `7475`** (I6; `7475` is already the
    `federation.pair` default port in `federation-rpc.ts`);
  - `rateLimit` + `pairing` reusing the existing `lan-pairing.ts` `PairingWindow` + LAN rate limiter
    (the same services `lan.openPairingWindow` already drives);
  - `isKnownPeer(pubkey)` = lookup `lan_peers` by pubkey → `{ peerId, writeAllowed: false }` or `null`
    (federation peers are always read-only). Add a small `LocalIndex.findLanPeerByPubkey(pubkey)`
    helper (bound-param read; reuses the existing `lan_peers` table — no migration).
  - `registerPeer(pubkey, ip)` = persist an **inbound, read-only** peer row and return its peerId.
  - `onMessage(method, params, peer)` = route into the main gateway dispatch. For
    `federation.query` / `federation.expertise`, the answering `peerId` is taken from `peer.peerId`
    (the NaCl-authenticated session) and **overrides any `peerId` in the request body** (I17). The
    consent prompter used on this path is the shared `ConsentBroker` (§4.3), and its `notify` is the
    gateway's **local** client-notification fanout (so the prompt reaches the owner's CLI/Tauri, not
    the LAN peer).
- `await lanServer.start()`; push `lanServer.stop()` to `sidecarStops`; set `ipcOpts.lanServer` so
  `lan.status` reports `enabled: true` + the listen address.
- Wire the real `OutboundPairHandshake` into `PeerPairing`. `buildFederationRuntime` gains the
  identity keypair (and the handshake fn) so `initiatePair` no longer throws.

**Mutual approval (over the wire).** Realized as *(answerer's owner opens a time-boxed pairing window
via `lan.openPairingWindow` and shares the 20-char BS58 code out-of-band)* + *(asker's owner runs
`nimbus team pair <host> <code>`)*. Opening the window **is** the answerer's structural consent; a
valid single-use code in an open window is what `registerPeer` persists. No separate over-the-wire
inbound-approval prompt is introduced. `checkLanMethodAllowed` remains intrinsic to
`handleEncryptedMessage` (I5).

### 4.3 Owner-consent round-trip — `federation/consent-broker.ts`

A process-singleton pending-promise registry:

- `request(input) → Promise<ConsentDecision>` — mint a `requestId`, emit
  `federation.consentRequest { requestId, peer, namespace, purpose, role }` to local clients,
  register and return the pending promise. (No internal timeout; `query-gate` already races the
  prompter against `consentTimeoutMs`. The broker drops the pending entry when the promise settles or
  when the gate abandons it, so it cannot leak.)
- `respond(requestId, decision) → void` — resolve the matching pending promise; no-op for an unknown
  or already-settled id.

`federation-rpc.ts` `makePrompter` is replaced to call `broker.request(...)` instead of returning a
hardcoded `"denied"`. The same broker instance is shared between the local dispatch path and the LAN
`onMessage` path (constructed at boot, threaded through both `FederationRpcContext`s).

New **local IPC** method `federation.consentRespond { requestId, decision }` → `broker.respond(...)`,
dispatched in `ipc/server/dispatchers.ts`. `decision ∈ { "approved", "denied" }`.

### 4.4 Renderer exposure (I7) — `federation.consentRespond`

Add `federation.consentRespond` to the Tauri `ALLOWED_METHODS` in `gateway_bridge.rs`; bump the Rust
count assertion (67 → 68) and the TS mirror in `security-invariants.test.ts`
(`allowlist_exact_size assertion is N`). `federation.consentRequest` is a **notification** and is
classified for global rebroadcast like other owner-facing notifications (consult
`nimbus-tauri-allowlist` for the rebroadcast list); it is **not** added to `ALLOWED_METHODS`.

### 4.5 CLI consent surfaces

- `nimbus team listen` — foreground; subscribes to `federation.consentRequest` notifications and
  prompts interactively (Ink approve/deny), calling `federation.consentRespond` with the decision.
- `nimbus team consent <requestId> approve|deny` — scriptable one-shot (what the E2E drives).

Both registered in **both** the CLI `COMMAND_HANDLERS` and `registry.ts` `COMMAND_NAMES`
(`audit:readme-cli` validates the registry).

### 4.6 Payoff E2E — `test/e2e/scenarios/federation-two-gateway.e2e.test.ts`

Two real Gateway subprocesses (reuse the LAN E2E harness), real NaCl-box channel, in-memory
discovery. Walk:

1. **discover** — B surfaces in A's `federation.discover` (seeded in-memory provider).
2. **pair** — B's owner `lan.openPairingWindow` → code; A runs `federation.pair` → real
   `outboundPairHandshake`; both peer rows persisted (A outbound, B inbound, both read-only).
3. **publish** — B publishes `project:*` namespace with declared filters.
4. **grant** — B grants A `viewer` with `standing_consent = false`.
5. **query (consented)** — A `sendFederatedOverWire("federation.query", …)`; B blocks on consent;
   B's owner drives `federation.consentRespond approve`; A receives the **scoped, leak-proof** result
   (only declared types; no `raw_meta`; no undeclared-service items).
6. **undeclared-type query** — returns empty (no leak of whether the type exists).
7. **revoke** — B revokes A's grant; the cached session consent is invalidated.
8. **query (post-revoke)** — empty + audited.
9. **audit.verify** — B's Blake3 chain still verifies, with the federation entries present.
10. **expertise** — A `federation.expertise`; rank-only, zero item content.
11. **consent-timeout** — a fresh non-standing query with no owner response resolves as
    `timeout_waiting_for_consent` after `consent_timeout_seconds` and is audited with decision
    `timeout`.

---

## 3. Data flow (over-the-wire query)

```text
A (asker)                         B (answerer)
  nimbus team query ns "q"
  → federation.pair already done (peer rows persisted both sides)
  → sendFederatedOverWire:
      hello{client_pubkey} ───────► handleHandshake → isKnownPeer(A) → hello_ok{host_pubkey}
      seal(federation.query) ─────► handleEncryptedMessage
                                      checkLanMethodAllowed (I5) ✓
                                      onMessage → dispatchFederationRpc
                                        peerId := authenticated peer.peerId  (NOT body)  (I17)
                                        answerFederatedQuery (query-gate):
                                          grant+role+namespace filter
                                          standing? → answer
                                          else → broker.request → notify owner (local)
                                                 owner: federation.consentRespond approve/deny
                                                 (race vs consent_timeout_seconds)
                                          scoped item-list read (declared types only)
                                          appendAuditEntry (federation_json)
      ◄──────────── seal(result | error)
```

---

## 4. Security requirements (explicit)

- **R1 (I17).** The over-the-wire `federation.query` / `federation.expertise` answering `peerId`
  comes from the authenticated NaCl session (`peer.peerId`), never from request params. A test asserts
  a body-supplied `peerId` cannot impersonate another peer.
- **R2 (I5).** `vault.*`, `data.*`, `audit.*`, `security.*`, `extension.*`, and the federation
  *management* methods stay forbidden over the LAN channel; only `federation.query` /
  `federation.expertise` are admitted. (Already enforced by `FORBIDDEN_OVER_LAN`; extend the I5 test
  to cover the live two-process path.)
- **R3 (I6).** Federation `LanServer` binds `127.0.0.1` by default.
- **R4 (I7).** `federation.consentRespond` is the only new renderer-callable method;
  `federation.consentRequest` is a notification only.
- **R5 (consent integrity).** A consent decision is scoped to its `requestId`; a stale/duplicate
  `consentRespond` cannot approve a different pending query. Revocation still invalidates cached
  session consent immediately (unchanged from Slice 1).
- **R6 (identity secrecy).** The identity secret key is Vault-only; it is never logged, sent over
  IPC, or written to config. Only the public key crosses the wire (in handshakes).

---

## 5. Migration

**None. V34 is ceded.** This is wiring over existing tables (`lan_peers`, `federation_*`,
`audit_log`). Consent is session-only (existing `SessionConsentCache`); each decision is already
durably recorded in `audit_log.federation_json`. Confirm `CURRENT_SCHEMA_VERSION` at implementation
time; if a sibling track has not yet taken V34, leave it untouched.

---

## 6. Config

Reuse `[federation]` (`enabled`, `mdns_enabled`, `consent_timeout_seconds`). Add `bind` / `port` keys
only if absent (defaults `127.0.0.1` / `7475`). The `LanServer` starts **only** when
`[federation].enabled`.

---

## 7. Testing strategy

- **Unit:** `lan-client.ts` (frame encode/decode, pair-ok/pair-err/timeout, hello+encrypted RPC)
  against a real in-process `LanServer`; `consent-broker.ts` (request/respond/unknown-id/settle
  cleanup); `federation-identity.ts` (create-then-load round-trip via a fake/real Vault).
- **Integration:** the existing in-process `federation-acceptance.integration.test.ts` stays green
  (its deferred-seam assertions about the deny-stub prompter are updated to the real broker).
- **E2E (the payoff):** §4.6 two-subprocess scenario; tagged/skippable only where a CI runner cannot
  bind a loopback socket (it can — no multicast needed; discovery is in-memory).
- **Security:** R1 impersonation test; R2 extended I5 admittance over the live path; I7 allowlist
  count tests (Rust + TS mirror).
- **Cross-platform:** `path.join`; loopback sockets work on all three OSes; no mDNS dependency in the
  payoff E2E.
- **Coverage:** new `federation/`, `ipc/lan-client.ts` meet the Engine ≥85% gate territory; verify
  `audit:coverage-floor` on **Linux** via Docker (`oven/bun:latest`) — it is CI-authoritative and
  Windows combined-run coverage flakes.

---

## 8. Invariant / doc updates

- `docs/SECURITY-INVARIANTS.md` — note the now-live over-the-wire wiring under I5/I17; add the
  `federation.consentRespond` renderer entry under I7. No new invariant number (I17 already covers
  the answering path; this track makes it reachable, not redefined).
- `security-invariants.test.ts` — TS allowlist mirror bump; R1 impersonation test; extended I5 test.
- `CHANGELOG.md` — dated entry: "Phase 6 Slice 1 — over-the-wire federation (outbound client,
  LanServer boot, owner-consent round-trip, two-gateway E2E)."
- `docs/roadmap.md` — flip the Slice 1 "deferred seams" note to delivered.
- `CLAUDE.md` / `GEMINI.md` — **only** if an invariant-table row changes (keep minimal; shared hot
  file with the parallel Slice 3 / Slice 9 tracks).

---

## 9. Out of scope

- Everything Slice 1 deferred to later slices (Team Vault, quorum HITL, SSO, BI connectors, ChatOps,
  share primitives).
- Persistent consent-decision log / cross-restart consent memory (session-only is the design;
  `standing_consent = true` is the durable-approval mechanism).
- A Tauri React consent **component** — this track adds the renderer-callable method and the
  notification classification; the visual card reuses existing HITL approval-UI patterns and can land
  as a thin UI follow-up.
- Real mDNS multicast in the payoff E2E (kept in the separate skippable `discovery-mdns.e2e.test.ts`).

---

## 10. Parallel-track coordination

Shared hot files (keep edits minimal; resolve against latest `main`): `platform/assemble.ts`, the
migration runner + V-number (we cede V34), the Tauri `ALLOWED_METHODS` + count + TS mirror,
`engine/executor.ts` HITL set (untouched here), `CLAUDE.md`/`GEMINI.md` invariant table, `CHANGELOG`,
`roadmap.md`.
