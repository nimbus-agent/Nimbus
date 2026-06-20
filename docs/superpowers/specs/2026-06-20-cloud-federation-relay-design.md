# Nimbus Encrypted-Envelope Relay (Reachability Wakeup Pipe) — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Track 2 — Phase 13.5 (Mobile Companion) reachability primitive; reused by Phase 15 (Cross-Org Federation). NOT a new "Phase X."
**Scope:** New `packages/gateway/src/relay/` (client-side only), one new config section `[relay]` in `packages/gateway/src/config/nimbus-toml.ts`, one new outbound dispatch seam reusing `ipc/lan-client.ts` framing + `ipc/lan-crypto.ts` NaCl-box sealing, and a reference relay server shipped as a separate AGPL package `packages/relay-server/` (self-hostable). Reuses Phase 6 federation primitives (`federation/peer-pairing.ts`, `federation/federation-server.ts`, `ipc/lan-server.ts`, `ipc/lan-rpc.ts`). No change to `federation/query-gate.ts` (I17 stays local). Possible new invariant I29 + migration V44 (relay metadata only).

---

## Motivation / Goal

Phase 6 federation (shipped 2026-06-05 → 2026-06-18) works **only on the same LAN**: discovery is mDNS (`federation/discovery.ts` → `_nimbus._tcp`), and the wire transport is a direct TCP `Bun.listen`/`Bun.connect` to a peer's IP:port (`ipc/lan-server.ts`, `ipc/lan-client.ts`). Two Gateways on different networks — a teammate at home, a partner company across the internet, a phone on cellular reaching the user's desktop — cannot find or reach each other without a VPN, port-forwarding, or hole-punching. That is the single biggest blocker to "team adoption across networks" (the Phase 6 roadmap-home goal) and to the Phase 13.5 mobile companion.

The naive answer — "host a relay that routes federation queries" — is **structurally forbidden** by the codebase and the roadmap. `docs/roadmap.md` says **"no relay server"** in Phase 6 (line 780), **"without any relay server or trusted third party"** in Phase 11 (line 1426), and **"no relay server"** in Phase 16 (line 1828); Phase 22 and Phase 25 are built on the "relay-free mesh" as a selling point (lines 2138, 2231). A data-plane relay would also break Non-Negotiable #1 (local-first): the relay operator would become the de-facto data intermediary, and I17 (federated answering only in `query-gate.ts`) would have a second, off-machine answering point.

**The roadmap already contains the correct answer**, in Phase 13.5 (line 1679, 1693): an **opt-in push relay through APNs** where *"APNs sees only an encrypted envelope … a wakeup channel, not a data channel."* This spec generalizes that one pattern into a first-class, self-hostable **reachability relay**: a dumb store-and-forward pipe for NaCl-box-sealed opaque frames that the relay can never decrypt, never answers from, and that the mesh degrades away from on relay outage. The goal is *reachability*, not data routing — the data plane (the actual federated query/answer) stays exactly where it is today: end-to-end-encrypted, leak-proof at `query-gate.ts`, on the user's machine.

## Where this fits (roadmap home + not-already-shipped evidence)

- **Not shipped.** There is no `packages/gateway/src/relay/` directory, no `[relay]` config section (`config/nimbus-toml.ts` has `[lan]` and `[federation]` only — verified lines 434, 516), and no relay reference in the federation wiring (`federation/federation-server.ts` builds a `LanServer` for *direct* peer acceptance only). Confirmed.
- **Reachability is the gap.** Phase 6 ships the E2EE channel (`ipc/lan-crypto.ts` NaCl-box), out-of-band pairing (`federation/peer-pairing.ts`), the leak-proof query gate (`federation/query-gate.ts`, I17), and a store-and-forward inbox precedent (`share/share-forward.ts` queues to `share_inbox` V43 when a recipient is not yet reachable — lines 38, 19-20). What is missing is *getting bytes between two off-LAN Gateways at all.*
- **Roadmap home is Phase 13.5 + Phase 15, not a new phase.** Phase 13.5 (line 1679) already specifies APNs-as-encrypted-wakeup; Phase 15 (line 1801) reuses the Phase 6 channel + adds a lease envelope and explicitly does *not* introduce a relay. This spec is the **transport substrate** both lean on: it makes the existing NaCl-box channel reachable off-LAN without becoming a data router. It deliberately does **not** add DIDs / key-transparency (Phase 11) — it must run on Phase 6 primitives alone (constraint honored).

## Approaches considered

### Approach A — Data-plane relay (route federation queries through a hosted broker) — REJECTED

Relay terminates TLS, holds peer sessions, and forwards `federation.query`/`federation.invoke` payloads (optionally caching answers for offline peers).

- **Trade-off:** One-click onboarding, lowest-latency cross-net, async delivery. **But** the relay operator sees who-queries-whom *and* (if it ever caches answers or terminates the box) the request bodies. This is a flat violation of Non-Negotiable #1 (cloud becomes the source of truth) and gives I17 a second answering point off-machine. The roadmap rejects this pattern eight times. **Eliminated on principle, not on cost.**

### Approach B — Discovery/signaling-only relay + direct P2P NAT traversal (STUN/TURN-style rendezvous) — REJECTED for v1

Relay is a rendezvous/signaling server: peers register a presence record (pubkey → reachable endpoint), exchange ICE-style candidates, then hole-punch a *direct* peer-to-peer connection; the relay never carries data frames.

- **Trade-off:** Purest "relay never sees data" story and zero per-message relay load. **But** it requires implementing NAT traversal / hole-punching / a TURN fallback inside the Gateway — a large, platform-sensitive surface (Non-Negotiable #5 platform-equality risk: NAT behavior differs across OSes/routers) and a brand-new networking subsystem with no existing code to reuse. It also still needs a fallback relay for symmetric-NAT cases, which collapses back into Approach C anyway. **Deferred; too big for one slice and over-built for the actual need.**

### Approach C — Opaque store-and-forward envelope relay ("encrypted wakeup pipe") — RECOMMENDED

The relay is a **dumb mailbox**: a Gateway seals a federation frame with the existing `sealBoxFrame()` (NaCl box, `ipc/lan-crypto.ts`) to the *recipient peer's* X25519 box key, wraps it in a thin **routing envelope** carrying only `{ recipientPubkeyHash, senderPubkeyHash, ttlSeconds, sealedFrameBytes }`, and `POST`s it to the relay over TLS. The relay stores the opaque blob keyed by `recipientPubkeyHash` and, on the recipient's next long-poll/WebSocket, hands it over. The recipient opens it with its own box secret key (`openBoxFrame`), and the inner frame is dispatched through the **identical** `onMessage`/`checkLanMethodAllowed`/`dispatchFederationRpc` path the LAN server already uses (`ipc/lan-server.ts` line 237, `ipc/lan-rpc.ts`). The relay holds no keys, decrypts nothing, answers nothing, and is **swappable/optional** — if it is unreachable or absent, the mesh falls back to direct LAN/manual-peer connection exactly as today.

- **Trade-off:** Relay sees minimal metadata (key *hashes*, blob size, timing) — not bodies, not real pubkeys, not query content. It carries data frames (so it is busier than Approach B's signaling-only model) but it can never read them. It reuses 100% of the existing crypto + dispatch + RBAC + I17 stack — the relay adds *transport reach*, nothing semantic. Self-hostable reference impl keeps AGPL clean and removes the "trust Nimbus Inc" requirement.

**Recommendation: Approach C.** It is the one approach that (a) is the exact pattern the roadmap already blesses for mobile (APNs-as-encrypted-wakeup, line 1679/1693), (b) reuses the shipped NaCl-box + dispatch + I17 stack with zero changes to the data plane, (c) keeps every Non-Negotiable intact because the relay is provably blind, (d) is genuinely optional (mesh degrades to direct P2P), and (e) fits in one implementation slice because it is "wrap the existing sealed frame in a routing header + a mailbox server," not a new networking subsystem. Approach A is forbidden; Approach B is the right *long-term* purity story but is a much larger NAT-traversal program (the natural Phase 15.x / Phase 11 follow-on) and over-built for the v1 need.

## Design (recommended)

### Architecture & components

**Gateway client side (new `packages/gateway/src/relay/`):**

- `relay/relay-envelope.ts` — the routing-envelope codec. Defines `RelayEnvelope = { v: 1; recipientKeyId: string; senderKeyId: string; ttlSeconds: number; sealed: string /* base64 NaCl-box frame */ }`. `recipientKeyId`/`senderKeyId` are **truncated salted hashes** of the X25519 box pubkeys (BLAKE2b over `pubkey || relayPubkeyHashSalt`), *not* the pubkeys themselves, so the relay cannot enumerate the real peer key registry. The `sealed` bytes are produced by the existing `sealBoxFrame()` (`ipc/lan-crypto.ts`) over the *same* `{id, method, params}` JSON `sendFederatedOverWire` already builds (`ipc/lan-client.ts` line 245). The relay codec never touches the inner frame.
- `relay/relay-client.ts` — `postEnvelope(env)` (outbound `POST /v1/relay/send`) and `pollEnvelopes(myKeyId)` (long-poll `GET /v1/relay/recv?for=<keyId>` or a WebSocket subscription). TLS 1.3 + **relay cert pinning** (the relay's TLS pubkey is pinned in `[relay].cert_sha256`, mirroring the existing peer-pubkey pinning in `lan-client.ts` line 241). On any relay error → caller falls back to direct connection (returns "unreachable", never throws into the federation path).
- `relay/relay-receiver.ts` — drains polled envelopes: hash-checks the recipient key matches *this* gateway, `openBoxFrame()`s the sealed bytes with this gateway's box secret, then feeds `{method, params}` into the **existing** federation dispatch with the peer identity derived from the authenticated box sender (NOT the envelope header — same I17/R1 discipline as `federation-server.ts` line 117-119: `forced = {...body, peerId: peer.peerId}`). Anything that fails to open, or whose sender is not a known paired peer, is dropped silently (fail-closed; no relay-supplied identity is ever trusted).

**Reference relay server (new package `packages/relay-server/`, AGPL, self-hostable):**

- A minimal Bun HTTP server: `POST /v1/relay/send` (accept an opaque blob ≤ `MAX_ENCRYPTED_FRAME` = 4 MiB, the existing cap from `lan-server.ts` line 7, keyed by `recipientKeyId`, TTL-bounded), `GET /v1/relay/recv` (long-poll mailbox by `recipientKeyId`). In-memory + optional SQLite spool for at-rest queueing. **No decryption, no key storage, no query logging** — it stores `{recipientKeyId → [sealedBlob, expiresAt]}` and nothing else. Ships with `docker run` + `nimbus.toml` example so a company/family runs their own.

**No change to:** `federation/query-gate.ts` (I17), `ipc/lan-rpc.ts` `checkLanMethodAllowed` allowlist semantics (the *same* forbidden-over-LAN set applies to relay-delivered methods — see Security), `engine/executor.ts` HITL gate. The relay is a transport adapter in front of the *already-built* answering path.

### Data flow

1. **Reachability registration (optional):** when `[relay].enabled = true`, on boot the Gateway computes its own `myKeyId` and starts `relay-receiver` long-polling the relay for envelopes addressed to it. (Mobile/Phase 13.5 swaps the long-poll for an APNs/FCM wakeup token, line 1693 — same envelope, different doorbell.)
2. **Off-LAN send:** an asker that cannot reach a peer directly (mDNS miss + manual host unreachable) seals the federation request frame to the peer's pinned box pubkey (existing path), wraps it in a `RelayEnvelope`, and `postEnvelope`s it. The relay stores the opaque blob under `recipientKeyId`.
3. **Receive + answer:** the recipient's `relay-receiver` polls, gets the blob, `openBoxFrame`s it, derives the *authenticated* sender peerId, and runs the **existing** `checkLanMethodAllowed` + `dispatchFederationRpc` → `query-gate.ts`. The leak-proof answer is sealed *back* to the sender and posted as a return envelope. HITL gates fire locally on the answering machine exactly as on LAN.
4. **Degradation:** relay down/absent → step 2 returns "unreachable" and the caller uses the direct path (or queues to `share_inbox`-style pending, reusing the `share-forward.ts` queue-on-unreachable precedent). No federation feature *requires* the relay.

### IPC / CLI surface

All local/Tauri-only management (never callable over LAN — see Security). Reuses the `federation` IPC namespace + a small `relay`-scoped set:

- `relay.status` (read) — `nimbus relay status`: is relay configured/reachable, last-poll time, queued-inbound count. **No** peer list, **no** message contents.
- `relay.configure` (local owner only) — set/clear the relay URL + pinned cert. CLI: `nimbus relay set <url> --cert-sha256 <hash>` / `nimbus relay clear`.
- Existing `federation.ask*` asker entrypoints gain a transparent relay fallback inside their dispatch — **no new asker method**; the relay is a transport detail, not a new federation verb.
- New CLI: `nimbus relay status | set | clear`. New `[relay]` config block: `enabled`, `url`, `cert_sha256`, `key_salt` (per-gateway, in Vault), `poll_interval_seconds`.

### Security: explicit check against the 7 Non-Negotiables + invariant/schema impact

1. **Local-first (machine is source of truth):** PRESERVED. The relay carries *opaque sealed blobs and key-hash metadata only* — it never holds plaintext, keys, or answers, and is fully optional (mesh degrades to direct P2P). The source of truth remains each machine; the relay is "a connector for reachability," not a data store. Metadata minimization is structural: salted key-*hashes* not pubkeys, no query logging, TTL-expiry, no who-talks-to-whom persistence required by the protocol.
2. **HITL is structural:** PRESERVED, unchanged. A relay-delivered request runs the **identical** `dispatchFederationRpc` → executor gate path as a LAN-delivered one (`ipc/lan-server.ts` line 237). The relay cannot see, influence, or short-circuit a consent decision — it never decrypts. `federation.requestApproval`/`consentRespond` stay LOCAL-only (already in the forbidden-over-LAN set, `lan-rpc.ts` lines 49, 62-63); relay delivery does not relax that.
3. **No plaintext credentials:** PRESERVED. Credentials are Vault-only today and never appear in a federation frame; the relay sees only ciphertext. The relay's own pinned cert + the per-gateway `key_salt` live in Vault (DPAPI/Keychain/libsecret), never in logs/IPC/config — same discipline as `share.signing.privkey`. A compromised relay yields ciphertext + key-hashes only.
4. **MCP as connector standard:** PRESERVED. The relay is transport, not a cloud-API caller; the engine still reaches services only via MCP. The relay never calls any cloud API on the user's behalf.
5. **Platform equality:** PRESERVED and *improved* vs. Approach B — store-and-forward HTTP/WebSocket has no NAT-traversal/OS-router asymmetry, so Windows/macOS/Linux behave identically. Single-point-of-failure risk is mitigated by (a) self-hostability (open-source reference server) and (b) mandatory direct-P2P fallback.
6. **AGPL-3.0 core / MIT sdk:** PRESERVED. `packages/gateway/src/relay/` is AGPL like the rest of the gateway; the reference server `packages/relay-server/` is AGPL and self-hostable — the AGPL network-use clause is satisfied because the source is published and any hosted instance (Nimbus-run or self-run) serves AGPL code. License fields unchanged.
7. **No `any`:** PRESERVED. `RelayEnvelope` is a strict typed shape; external relay responses are parsed as `unknown` and validated before use (same pattern as `lan-client.ts` JSON parsing).

**Invariant impact:**

- **Reuse I5** (`checkLanMethodAllowed` intrinsic): the relay-receiver MUST route every inbound frame through the *same* `checkLanMethodAllowed` before dispatch, so the forbidden-over-LAN set (`vault`, `audit`, `data`, `security`, `federation.consentRespond`, `share.create`, etc. — `lan-rpc.ts`) applies verbatim to relay-delivered methods. A relay channel is "over the wire" for allowlist purposes.
- **Reuse I17** (federated answering only in `query-gate.ts`, leak-proof shape): UNCHANGED. The relay adds **no** answering point — answers are still produced only by `query-gate.ts` on the recipient machine; the relay forwards sealed bytes both ways.
- **Reuse I10** (constant-time compare): the recipient-key-hash match in `relay-receiver.ts` uses `util/timing-safe-compare.ts`.
- **I6 note** (LAN bind defaults to loopback): the *relay client* is an outbound connection, not a bind; it does not change the loopback default. The gateway never opens an inbound port for the relay (it polls out), so no new listening surface is added on the user's machine.
- **NEW invariant I29 — Relay Opacity (proposed, only if approved).** Wiring: `relay/relay-envelope.ts` + `relay/relay-client.ts`. Statement: every byte that leaves the machine for the relay is either (a) a NaCl-box `sealBoxFrame()` ciphertext the relay cannot open, or (b) routing metadata limited to `{salted-key-hash, ttl, blob-size}`; the gateway never sends a real pubkey, a method name, a query body, or any credential to the relay; the relay is never an answering or HITL-decision point; relay delivery is fail-closed (an envelope whose sealed frame fails to open, or whose authenticated sender is not a known paired peer, is dropped). Static complement **D22** (in `scripts/structure-audit/check-nimbus-invariants.ts`): the relay URL + the envelope `sealed`-field construction are confined to `relay/` (the relay URL never appears outside `[relay]` config + `relay-client.ts`, mirroring how HTTP-client URLs are confined). **I28 is reserved** for the unmerged MCP-server owner-sink branch (`dev/asafgolombek/phase7-mcp-gateway-server`), so this takes **I29**. I29 is load-bearing only if the relay ships; it is not added to the current relay-free codebase otherwise. Triple-rule: wiring + `docs/SECURITY-INVARIANTS.md` row + a test in `security-invariants.test.ts` land in the same commit.
- **Schema V44 (minimal, only if needed):** a `relay_inbound_pending` table to spool received-but-not-yet-drained envelopes across restarts (mirrors the V43 `share_inbox` precedent). Columns: `recipient_key_id`, `sealed_blob`, `received_at`, `expires_at`, `drained` — **no** sender identity, **no** plaintext, **no** decoded method. Append-only/forward-only, V44-numbered, in `packages/gateway/src/index/`. If we accept "drop on restart" semantics (HITL means actions re-trigger anyway, per Phase 13.5 line 1696 "no queueing"), V44 can be dropped from v1 — **YAGNI default: ship without V44**, add it only if persistence is shown to be needed.

**Fail-closed behavior:** relay unreachable → direct-path fallback (never an error surfaced to the federation caller). Envelope that won't `openBoxFrame` → dropped. Sender not a known paired peer → dropped (relay-asserted identity is never trusted; identity is derived from the box, like `federation-server.ts` line 117). Relay returns a malformed/oversized blob → rejected before buffering (reuse `MAX_ENCRYPTED_FRAME` cap, `lan-server.ts` line 7). Missing pinned cert → refuse to connect.

### Testing

- **Unit (≥80% line+branch/file, coverage-floor):** `relay-envelope.ts` codec round-trip (seal → envelope → recv → open → identical inner frame); salted-key-hash determinism + non-reversibility; oversized-blob rejection; malformed-envelope drop.
- **Integration (real SQLite + real Bun subprocess relay-server + real NaCl-box):** asker seals → posts to a real reference relay subprocess → recipient polls + opens + dispatches → leak-proof answer returns; assert the relay process *never* sees plaintext (inspect its spool: only ciphertext + key-hash). Prove relay-down → direct fallback. No mocks at the crypto/DB layer (Testing Philosophy).
- **HITL test:** a relay-delivered `federation.query` for a consent-gated namespace fires the LOCAL owner's consent gate before answering (proves the relay added no bypass) — extend the existing federation HITL test rather than a new gate.
- **I5/allowlist test:** a relay-delivered forbidden method (e.g. `vault.*`, `federation.consentRespond`, `share.create`) is rejected by `checkLanMethodAllowed` exactly as over LAN.
- **I29 enforcement test (if invariant approved):** assert no real pubkey / method name / body string ever appears in a posted envelope; assert relay-client confinement (D22 static) — added to `security-invariants.test.ts`.
- **e2e-CLI:** `nimbus relay set`/`status`/`clear` round-trip against a mock relay subprocess (real Gateway subprocess, no real cloud — E2E philosophy).

## Non-goals (YAGNI — cut anything not essential)

- **No data-plane routing / answer caching at the relay** (Approach A) — forbidden, full stop.
- **No NAT traversal / hole-punching / STUN-TURN** (Approach B) — deferred to a later purity slice; not needed for v1 reachability.
- **No DIDs, no key-transparency/gossip** — those are Phase 11; the relay runs on Phase 6 box-key pinning only (constraint honored).
- **No relay-side presence/online tracking** ("who is online") — adds threat surface (relay learns activity patterns) for marginal UX; v1 just attempts relay then falls back.
- **No mobile/APNs client in this slice** — this slice ships the *gateway-side envelope + reference relay* substrate that Phase 13.5 then consumes; the iOS app is its own phase (line 1692). The relay must be the *same* envelope so the phone is a drop-in second consumer.
- **No V44 persistence in v1** unless cross-restart queueing is proven necessary (Phase 13.5 line 1696 explicitly chooses "no queueing").
- **No new federation answering verb** — the relay is transport, reusing `federation.query`/`expertise`/`invoke`.

## Open questions

1. **Operator model for the hosted reference instance:** ship self-host-only first (lowest trust, cleanest AGPL), and offer a Nimbus-run convenience instance later? Recommendation: self-host reference + clear docs in v1; commercial hosted instance is a separate go-to-market decision, not a code dependency.
2. **Return-path addressing:** the answer envelope is sealed back to the sender's box key, but the *return* `recipientKeyId` is the sender's key-hash — confirm the sender's receiver is polling under that same `myKeyId` (it is, by construction). Edge case: an asker that is NAT'd and not polling. Acceptable: async answers require the asker to be running + polling; otherwise it re-asks (HITL-style re-trigger).
3. **Metadata-minimization vs. relay efficiency:** salted key-hashes prevent the relay from enumerating the real key registry, but the *same* hash is reused per recipient so the relay can mailbox-route. Is per-recipient-stable hashing an acceptable linkability surface, or do we want rotating routing tags? Recommendation: stable salted hash for v1 (the relay already sees timing/size); rotating tags are a Phase 22 "unexfiltratable" refinement.
4. **Does this need a roadmap amendment?** The roadmap says "no relay server" — but every such line means "no *data-routing* relay / no trusted third party that sees bodies." This design is the encrypted-*wakeup* relay the roadmap *already* prescribes for mobile (line 1679). Recommendation: add a one-line clarification to Phase 13.5/15 that "reachability relay = the APNs-style encrypted-envelope pipe, distinct from the forbidden data-plane relay," rather than treating this as a deviation.

## Acceptance criteria

- A Gateway with `[relay].enabled = true` + a pinned reference-relay URL can answer a `federation.query` from an **off-LAN** paired peer, end-to-end, with the leak-proof I17 shape, behind the LOCAL owner's HITL/consent gate — and the relay process's spool contains **only** ciphertext + a salted key-hash (asserted in an integration test).
- With the relay unreachable or `[relay].enabled = false`, all existing LAN/direct federation continues to work unchanged (degradation proven by test).
- A relay-delivered forbidden-over-LAN method (`vault.*`, `federation.consentRespond`, `share.create`, etc.) is rejected by `checkLanMethodAllowed`, identical to the LAN path.
- The reference relay server (`packages/relay-server/`) builds, runs via `docker run`, holds no keys, and logs no query content; AGPL + self-hostable.
- If I29 is approved: wiring + `docs/SECURITY-INVARIANTS.md` row + `security-invariants.test.ts` test + static `D22` in `scripts/structure-audit/check-nimbus-invariants.ts` all land in the same commit; I28 left reserved for the MCP-server branch.
- `nimbus relay status|set|clear` work; `relay.*` IPC is local/Tauri-only and absent from any LAN/relay-callable surface.
- All new files ≥80% line+branch coverage; `bun run preflight` green; platform-equal (Ubuntu PR gate + 3-OS push matrix).
