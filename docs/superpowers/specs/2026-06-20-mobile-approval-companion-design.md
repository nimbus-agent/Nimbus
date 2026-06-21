# Mobile Approval Companion (HITL owner-sink) — Design

**Date:** 2026-06-20
**Status:** Design — pending user review
**Roadmap home:** Track 2 / Phase 13.5 — Mobile Companion (`docs/roadmap.md` §"Phase 13.5 — Mobile Companion", lines 1673–1722). Builds the **mobile-companion consumer layer** on top of — and strictly *consuming* — the I28 owner-sink consent re-routing seam that the unmerged MCP-gateway-server Wave 2 authors (invariant **I28**, reserved). This spec authors the use-case/transport-to-phone half (companion app + APNs wakeup + device registry); it does **not** author or complete the I28 owner-sink seam itself — that remains Wave 2's, and this design blocks on it (see "Depends on" below and Open question 1).
**Scope:**

- **New gateway subsystem** `packages/gateway/src/companion/` — device-token registry, APNs wakeup sender, encrypted-envelope builder, paired-device key store, the `companion.*` IPC namespace, and the `consent` owner-sink writer that bridges a HITL request to a paired phone.
- **New CLI** under `packages/cli/src/commands/companion.ts` — `nimbus companion pair|list-devices|revoke-device`.
- **Extends** `packages/gateway/src/ipc/consent.ts` (owner-sink registration — depends on I28 Wave 2), `packages/gateway/src/ipc/lan-server.ts` + `lan-rpc.ts` (pairing reuse + LAN-forbidden additions), `packages/gateway/src/platform/types.ts` (no change — reuses `NotificationService`), `nimbus.toml` (`[companion]` block).
- **New native app** (separate, AGPL, NOT a workspace member): `apps/nimbus-companion-ios/` — SwiftUI passive viewer. Designed here but built outside the Bun monorepo build graph.
- **Out of scope (do NOT redesign):** the MCP gateway server itself and the I28 owner-sink *consent re-routing* core — specced on `dev/asafgolombek/phase7-mcp-gateway-server`. This spec consumes that wiring; it does not author it.

---

## Motivation / Goal

The on-call engineer's agent runs on a laptop that is "in their bag." When a watcher or the on-call copilot wants to take an action that trips the HITL gate (`engine/executor.ts` `gate()`), the consent prompt today can only be answered by a **live, locally-attached IPC session** — a CLI on the same box or the Tauri window (`ConsentCoordinatorImpl` resolves a request only to the writer for the originating `clientId`; verified in `packages/gateway/src/ipc/consent.ts` lines 33–53). If the owner is away from the keyboard, the action stalls until they return.

Goal: ship a **passive phone app** that is the HITL "owner-sink" — it receives an OS push when an agent wants to act, lets the owner tap **Approve / Reject**, and reads assembled briefs on the go. The phone is a *remote consent surface*, never a separate authorization path: the desktop gateway's HITL gate stays the source of truth (Non-Negotiable #2), nothing executes locally on the phone (roadmap line 1692: "No query input. No on-device agent. No local index."), and no plaintext HITL detail or credential ever reaches Apple.

---

## Where this fits (roadmap home + not-already-shipped evidence)

**Not already shipped — verified in-tree:**

- `packages/mcp-gateway-server/` **does not exist on main** (`Glob packages/mcp-gateway-server/**` → no files). I28 and its owner-sink consent re-routing are specced only on the unmerged Wave 2 branch.
- `ConsentCoordinatorImpl` (read in full, `consent.ts`) has **no owner-sink registry**. Its only re-route axis is `clientId`: `requestConsent(clientId, …)` looks up `this.getWriter(clientId)` and `handleRespond` rejects a foreign approver (`entry?.clientId !== clientId` → `-32602 "Unknown or foreign consent request"`). There is no `attachOwner`, no role parameter, no device routing.
- No mobile app exists anywhere in the repo (no `apps/`, no Swift/Xcode files; `Glob` for the package dir empty).
- The roadmap section (lines 1673–1722) is **planned, unchecked** — every `[ ]` checkbox.

**What this design adds vs. what it reuses:**

- **Reuses (do not rebuild):** the NaCl-box pairing handshake + encrypted frame format (`ipc/lan-server.ts` `handleHandshake`/`handleEncryptedMessage`, `ipc/lan-crypto.ts` `sealBoxFrame`/`openBoxFrame`); the `PairingService` open/consume/expiry contract (`lan-server.ts` lines 10–16); constant-time pairing-code compare (`util/timing-safe-compare.ts` `constantTimeStringEqual`, I10); the Vault-derived stable-keypair pattern (`share/share-keypair.ts` `ensureShareKeypair`); the `NotificationService.show()` desktop fallback (`platform/types.ts` lines 20–22); the delegated-approval round-trip shape with fallback-to-owner (`engine/delegated-approval.ts`, I20).
- **Depends on (blocks on Wave 2):** the I28 owner-sink consent re-routing — `ConsentCoordinator` must learn to route a HITL request to a registered owner-sink writer and accept the answer scoped by that sink, not by the originating `clientId`. This spec calls that the **owner-sink writer seam** and assumes Wave 2 lands it.
- **Net-new here:** the off-LAN HITL *transport* (APNs wakeup sender + encrypted envelope), the device-token registry, the companion key store, the `companion.*` IPC + CLI, and the iOS client.

---

## Approaches considered

### Approach A — Phone as a paired LAN/mesh peer that registers as the owner-sink (recommended)

The phone pairs exactly like a second Nimbus box (reusing `handleHandshake` `kind:"pair"` → `registerPeer` → NaCl-box session). After pairing it holds a long-lived encrypted session over the mesh. On connect it calls a new wire method `companion.attachSink`, which registers the phone as the gateway's owner-sink writer (the I28 seam). When a HITL gate fires, the gateway:

1. sends an **APNs wakeup** (opaque encrypted envelope, no detail) to nudge the phone awake;
2. the phone re-establishes / resumes its mesh session and **pulls** the consent request body over the encrypted channel;
3. the owner taps Approve/Reject → the phone sends `companion.respondSink` over the same encrypted channel → bridges to `ConsentCoordinator.handleRespond` via the owner-sink seam.

- **Pros:** zero new wire crypto (reuses the audited NaCl-box frame); APNs is strictly a wakeup, so the local-first / no-egress story is airtight; the phone is "just another paired session," so revoke/list reuse the peer machinery; matches the roadmap's "APNs is a wakeup channel, not a data channel" mandate (line 1693).
- **Cons:** depends on Phase 11 mesh addressing for off-home-network reach; needs the I28 owner-sink seam to exist; two-step (wake → pull) adds a round-trip to the latency budget.

### Approach B — APNs carries the full (encrypted) request inline; no pull

Put the whole consent request, NaCl-box-sealed, into the APNs payload. The phone decrypts in the notification-service extension and shows Approve/Reject directly; the answer goes back over a short-lived mesh connect (or, degenerate, a second APNs to a relay).

- **Pros:** one hop for delivery; works even if the mesh link is briefly down at delivery time.
- **Cons:** APNs payload cap is 4KB including headers — an assembled brief (Phase 17) or a multi-step remediation preview will not fit, forcing a pull anyway for the realistic cases; putting request bodies (even encrypted) through Apple's servers weakens the "wakeup not data channel" invariant and the App Store privacy story; couples the design to APNs payload limits. **Rejected** — it trades the clean invariant for a marginal latency win that evaporates on any non-trivial brief.

### Approach C — Owner runs a self-hosted relay (idea #6) as the transport

Stand up a Nimbus-run (or user-run) relay that the phone always connects to; the gateway pushes to the relay; the relay holds the encrypted blob until the phone polls.

- **Pros:** solves enterprise-firewall NAT traversal without the user configuring WireGuard/Tailscale; decouples phone reachability from the laptop being directly addressable.
- **Cons:** **directly contradicts the roadmap's load-bearing "no relay server, no trusted third party" stance** (Phase 11 line 1426; Phase 16 line 1859 "no Nimbus relay"; the federation row line 780 "no relay server"). A relay that buffers blobs is a new always-on data sink and a new attack surface, even if blobs are E2E-encrypted. **Rejected as the default.** See "Relay dependency, honestly assessed" below — a relay is an *optional, additive* future extension for the enterprise-NAT case, not a dependency of this design.

**Recommendation: Approach A.** It reuses the audited pairing + NaCl-box transport untouched, keeps APNs as a pure wakeup (preserving local-first and the App Store privacy posture), and slots cleanly onto the I28 owner-sink seam. B loses on the 4KB cap and the weakened invariant; C violates the no-relay non-negotiable of the roadmap. The two-step latency of A fits the budget (see Design).

---

## Design (recommended)

### Architecture & components

New gateway subsystem `packages/gateway/src/companion/`:

- `companion-keystore.ts` — `ensureCompanionPairingKeypair(vault)`, mirroring `share/share-keypair.ts` `ensureShareKeypair`: derives/stores the gateway's X25519 box keypair seed under a Vault key `companion.box.privkey` (+ public half `companion.box.pubkey`). Per-device shared keys are the NaCl-box session keys established by the existing handshake; we persist each **paired device record** (deviceId, peer pubkey, APNs device token, last-seen) — but **never** the shared secret in the DB; the shared secret is re-derived from the box keypairs at session open, exactly as `lan-server.ts` does today.
- `device-registry.ts` — in-memory + Vault-backed map of paired devices. Device tokens are **not credentials** (they're addressing handles), but to be conservative they live in the Vault (`companion.device.<id>.token`) alongside the peer pubkey, never in logs/IPC responses beyond a redacted suffix.
- `apns-sender.ts` — builds the wakeup: a NaCl-box-sealed opaque envelope (`sealBoxFrame` from `ipc/lan-crypto.ts`) whose plaintext is the minimal `{ kind:"wake", requestId, host }` — **no prompt text, no action type, no payload**. Sends to APNs HTTP/2 with the device token. Implemented behind an `ApnsTransport` interface so tests inject a fake and so Android/FCM (`FcmTransport`) is a drop-in later (platform-agnostic per Non-Negotiable #5).
- `owner-sink-bridge.ts` — the glue between the I28 owner-sink seam and a paired device. Registers the phone's encrypted-session writer as the owner-sink via the Wave 2 `ConsentCoordinator` owner-sink API; on a HITL request, fires the APNs wakeup, then serves the consent-request body when the phone pulls; on `companion.respondSink`, calls the owner-sink `handleRespond` with the request scoped to **this** device + originating host.

Extended files:

- `ipc/consent.ts` — **(Wave 2 / I28 dependency)** gains an owner-sink writer registry + re-route. This design does not author it; it asserts the seam: `attachOwnerSink(writer)` (last-writer-wins, displaces prior), re-route of a relayed/agent-tripped HITL to the owner-sink, and `handleRespond` scoped by sink identity + `requestId` (idempotent duplicate rejection). If Wave 2 is not on main, this design is blocked (see Open questions).
- `ipc/lan-rpc.ts` — add `companion.attachSink`, `companion.respondSink`, and `companion.pullRequest` to the **answerable** wire methods (they are the phone, an authenticated paired peer, answering the local owner's gate — `pullRequest` is how it fetches the consent body it is about to approve), and add `companion` *management* methods (`companion.pair`, `companion.listDevices`, `companion.revokeDevice`) to `FORBIDDEN_OVER_LAN` — pairing/listing/revoking are local/CLI/Tauri-only, exactly mirroring how `federation.pair`/`federation.peers` are forbidden (lines 43–45). Wire-answerable ≠ management.
- `platform/types.ts` — **no change.** The desktop-side "you have a pending approval on your phone" toast reuses `NotificationService.show()`.
- `nimbus.toml` — `[companion]` block: `enabled` (default false), `push_categories = ["hitl","incident","agent-brief"]` per-category opt-in (roadmap line 1705), `apns_topic`, `apns_environment = "sandbox"|"production"`.

New native app `apps/nimbus-companion-ios/` (SwiftUI, iOS 17+, AGPL, **not** a Bun workspace member — excluded from `bun --filter`): three screens (Pairing / Inbox / Brief Detail) per roadmap line 1692. The X25519 device key + each paired host's box pubkey live in the **iOS Keychain only — CloudKit/iCloud-Keychain sync disabled** (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), satisfying Non-Negotiable #3.

### Data flow (HITL round-trip, happy path)

```text
agent action → executor.gate() (engine/executor.ts) trips HITL
  → ConsentCoordinator.requestConsent(...)            [unchanged core]
  → I28 owner-sink seam: a phone is the registered owner-sink
      → owner-sink-bridge: apns-sender seals {kind:"wake",requestId,host}  (no detail)
        → APNs (sees: device token + opaque blob only)  ── wakeup ──▶ phone
  → phone wakes, resumes/opens NaCl-box mesh session, calls companion.attachSink (resume)
  → phone calls companion.pullRequest(requestId)
      → owner-sink-bridge returns the consent-request body OVER the encrypted session
  → owner taps Approve/Reject → companion.respondSink{requestId, approved}
      → owner-sink-bridge → ConsentCoordinator.handleRespond (owner-sink-scoped, idempotent)
      → executor.gate() resolves; hitlStatus set ONLY by the gate (I4)
```text

APNs sees only `{device token, ~80-byte opaque blob}`. Brief/HITL bodies travel only over the NaCl-box mesh session — never through Apple. If the brief is large (Phase 17 assembled brief), it is always a pull, so the 4KB APNs cap is irrelevant.

### Latency budget (acceptance SLAs: push ≤5s, approval ≤3s)

- Gateway→APNs seal+send ≈ 200–500ms; APNs→device wake ≈ 1–3s (Apple, variable); phone resume + `pullRequest` over mesh ≈ 0.5–1.5s ⇒ first render within the 5s push SLA when both online.
- Tap → `companion.respondSink` over the live session → `handleRespond` ≈ <1s ⇒ within the 3s approval SLA (the session is already warm from the pull, so no fresh handshake).

### IPC / CLI surface

Gateway IPC (`companion.*`):

- `companion.pair` → opens a 5-minute pairing window via the existing `PairingService.open(code)`; returns the 120-bit base58 code for display. **Local/Tauri/CLI only** (FORBIDDEN_OVER_LAN).
- `companion.listDevices` → `[{ deviceId, label, lastSeen, lastMessageAt, tokenSuffix }]`. No secrets. Local only.
- `companion.revokeDevice` → drops the device record + Vault token, sends a final `{kind:"unpaired"}` envelope, audit-logs the revocation. Local only.
- `companion.attachSink` / `companion.respondSink` / `companion.pullRequest` → **wire-answerable** (the authenticated paired phone). Scoped to the authenticated peer session; never accept a host/device identity from the caller's params (forced from the session, mirroring the I17/R1 "force the peerId from the authenticated session" rule used by `federation.requestApproval`, lan-rpc.ts lines 59–63).

CLI (`packages/cli/src/commands/companion.ts`):

- `nimbus companion pair` — prints the base58 code + a 5-minute countdown (roadmap line 1702).
- `nimbus companion list-devices` — table of paired devices, last-seen / last-message (line 1703).
- `nimbus companion revoke-device <id>` — unpair + final notice (line 1704).

Tauri: a Companion settings panel is roadmapped (line 1706) but **deferred to the Tauri/Desktop phase** — out of scope here (YAGNI). The CLI is the v0 management surface.

### Security: explicit check against the 7 Non-Negotiables

1. **Local-first** — the machine stays the source of truth. The phone holds **no index, no agent** (roadmap line 1692). APNs is a wakeup only (Approach A); request bodies travel only over the user's own mesh. **Preserved.**
2. **HITL is structural** — the phone is a remote *surface* onto the same `executor.gate()` → `ConsentCoordinator`. `hitlStatus` is still set only by the gate (I4). A duplicate / replayed `respondSink` is rejected idempotently by `handleRespond` (the requestId is consumed on first answer; second answer hits the "unknown request" path, mirroring today's `pending.delete` then foreign-check in `consent.ts` lines 64–69). No auto-approve path exists. **Preserved.**
3. **No plaintext credentials** — the gateway's box keypair seed is **Vault-only** (`companion.box.privkey`), read solely to thread into in-process sealing, never returned over IPC/logged (the `ensureShareKeypair` discipline). The device token lives in the Vault and is surfaced only as a redacted suffix. On the phone, keys live in the **Keychain with iCloud sync disabled**. **Preserved.**
4. **MCP as connector standard** — no new connector and no cloud API called by the engine. APNs is reached by the **transport layer** (`apns-sender.ts`), not the engine, and carries no engine data. The phone speaks the existing IPC/NaCl-box protocol. **Preserved.**
5. **Platform equality** — the gateway code is OS-agnostic Bun/TS; `ApnsTransport` has an `FcmTransport` sibling so Android v0.2 reuses the same `owner-sink-bridge`. The brief schema is the platform-agnostic Phase 17 assembled-brief, so Android/watchOS render with shared logic. **Preserved** (the phone OS is the *client*, not a gateway platform; the gateway still runs on all three desktop OSes equally).
6. **AGPL-3.0 core / MIT sdk** — gateway/cli code stays AGPL; the iOS app ships AGPL (roadmap line 1697). No license-field change. **Preserved.**
7. **No `any`** — all new TS uses `unknown` for the wire params (e.g. `companion.respondSink` params are `unknown` then validated, exactly as `handleRespond` does in `consent.ts` lines 56–63). **Preserved.**

**Invariant impact (reuse, not new):**

- **I5 / I6 (loopback bind + LAN allowlist):** unchanged. The gateway still binds `127.0.0.1` by default (I6); the phone reaches it over the **Phase 11 mesh** (user-run WireGuard/Tailscale overlay, roadmap line 1859 "no Nimbus relay"), not by exposing a new public port. `companion.*` management methods are added to `FORBIDDEN_OVER_LAN`; only the three phone-answer methods are wire-answerable.
- **I10:** the 120-bit base58 pairing code is compared with `constantTimeStringEqual` inside the existing `PairingService.consume` path — reused verbatim.
- **I4:** `hitlStatus` set only by the gate — the owner-sink answer flows *into* the gate, never sets status directly.
- **I28 (reserved, Wave 2):** this design **consumes** the owner-sink seam; it does not author it. The phone is a *paired-peer owner-sink*, not a relayed MCP session, so it inherits I28's "second registration displaces prior" (last-writer-wins) and "scoped handleRespond" rules without a new defense.
- **No new invariant needed.** The one load-bearing structural property — *a mobile approval answers only the consent request it pulled, scoped to its authenticated session and originating host* — is a property of the owner-sink seam (force host/device from the session, never from caller params), enforceable in the I28 test, not a new defense layer. If review decides the phone-answer methods warrant their own static-confinement row, the next free number is **I29** (I28 is reserved).

**Numbering note:** I28 is reserved for the MCP-server owner-sink (branch dev/asafgolombek/phase7-mcp-gateway-server). The I29/D22/V44-style numbers here follow the *proposed* global sequence in 2026-06-20-superpowers-specs-consolidated-review.md §1 — these family ideas are mutually exclusive, so the actual number is the next-free at this spec's own merge time, reconciled by build order.

**Schema:** **No V44 migration.** Pairing keys → Vault; device records → Vault (small, key-value, no query needs). HITL approvals are audited through the existing `audit_chain` / `tool_call_log` the same as a CLI/Tauri approval. *Optional future:* if the audit context should record "which device approved," that is a V44 audit-enrichment migration — explicitly deferred (YAGNI; out of scope here).

**Fail-closed behavior:**

- No owner-sink registered / phone offline at gate time → the HITL falls back to the **local owner prompt** (the existing behavior; the gate never auto-approves), mirroring `delegated-approval.ts` `fallback_to_owner`.
- APNs send fails → log + still serve the pull if the phone is reachable; never block the gate on APNs. The gate's own timeout governs (no new indefinite hold).
- Revoked device → its session is dropped and its next `attachSink`/`respondSink` is rejected (unknown peer); a final encrypted `unpaired` notice is best-effort. Audit-logged.
- Malformed/foreign `respondSink` → `-32602`, request untouched (the `consent.ts` foreign-request guard pattern).

### Testing (layers + coverage)

- **HITL-gate test** (extends `security-invariants.test.ts` neighborhood + a `companion/owner-sink-bridge.test.ts`): prove the gate fires and resolves only via the owner-sink seam; prove a duplicate/foreign `respondSink` is rejected and the action does not double-execute; prove offline-phone falls back to the local owner prompt (no auto-approve).
- **Vault test** (`companion/companion-keystore.test.ts`): prove the box seed and device token never escape via `companion.listDevices` (only a redacted suffix) and are never logged — the standard "no secret value through any interface" assertion.
- **Integration test** (real SQLite + real Vault + a fake `ApnsTransport`): pair → attachSink → trip a HITL → assert the APNs envelope plaintext contains **no** prompt/action/payload (only `{kind,requestId,host}`); pull over the in-process encrypted session; respond → gate resolves.
- **e2e-CLI test** (real gateway subprocess + a mock APNs sink dir, mirroring the ChatOps `NIMBUS_CHATOPS_E2E_SINK_DIR` seam): `nimbus companion pair` emits a 120-bit base58 code; `list-devices` shows the paired fake; `revoke-device` stops delivery.
- **iOS app:** XCTest for the decrypt-envelope + Keychain-no-sync paths; manual smoke for pairing/approve/reject. (Outside the Bun coverage gate.)
- **Coverage floor:** every new gateway/CLI file ≥80% line+branch (baseline.json is `{}`; the floor is CI-Linux-authoritative — verify via Docker `oven/bun:latest` before first push).

---

## Non-goals (YAGNI)

- **No on-device agent / query input / local index** (roadmap line 1692 — explicit).
- **No relay server** (Approach C rejected; see honest assessment below). The home/personal case needs none.
- **No offline approval queueing** (roadmap line 1696) — a pending HITL simply gates the action; if unreachable, the owner re-triggers from the desktop. No "queued-but-lost decision" surface.
- **No Tauri Companion settings panel in v0** — CLI is the management surface; the panel is deferred to the Desktop phase.
- **No Android / watchOS / voice / Siri in this slice** — Android v0.2 is a drop-in `FcmTransport` later; voice/watch are roadmap stretch (lines 1710–1713).
- **No V44 migration** — Vault-backed records suffice.
- **No new biometric-HITL primitive** — Phase 11 owns "secure-enclave-signed HITL" (roadmap line 1927); v0 uses a standard tap behind device unlock.

### Relay dependency (idea #6), honestly assessed

A relay is **NOT a dependency** of this design for the target persona (the user approving from their own phone for their own laptop):

- APNs is a *stateless wakeup* — it is not a relay; it buffers no bodies and holds no key.
- Off-home-network reach is the **Phase 11 mesh** (the user's own WireGuard/Tailscale overlay), which the roadmap mandates be **relay-free** (lines 1426, 780, 1859). The phone reaches the laptop point-to-point, NaCl-box-encrypted.
- A relay (idea #6) becomes relevant *only* for the enterprise case where both endpoints are behind symmetric NAT/firewalls and no user overlay exists. That is an **optional, additive** transport — a future `RelayTransport` behind the same envelope contract — and an **explicit non-goal here**. If pursued, it is a separate design and must preserve "the relay sees only an opaque encrypted blob + token" (the same bar APNs meets), or it violates the no-trusted-third-party stance.

---

## Open questions

1. **I28 Wave 2 readiness (hard blocker).** This design assumes `ConsentCoordinator` gains an owner-sink writer registry (`attachOwnerSink`, last-writer-wins), re-route of a tripped HITL to that writer, and sink-scoped idempotent `handleRespond`. **Verify these exist on main before implementation begins.** What is the exact method/role surface — a new `consent.attachOwnerSink` IPC method, or an existing method with a role param? (Grounding flagged this; unresolved until Wave 2 merges.)
2. **Owner-sink contention — RESOLVED as a Wave-2 recommendation (not redesigned here).** If a phone *and* a live Tauri window are both eligible owner-sinks, which wins? Wave 2's "last-writer-wins" suggests the most-recent registrant — a phone waking could silently steal a request the owner is mid-approving at the desk. The reviewer's proposed remedy — have `ConsentCoordinator` **broadcast to ALL registered owner-sinks**, with **first-responder-wins + cancel-the-others** — is a change to the **I28 owner-sink CORE**, which is specced on `dev/asafgolombek/phase7-mcp-gateway-server` (Wave 2), **not** in this consumer spec. We therefore do **not** redesign the owner-sink here; instead this is recorded as a **RECOMMENDATION to feed into the Wave-2 owner-sink design**. Cross-branch dependency: **if Wave 2 ships single-sink last-writer-wins, this mobile spec works as-is** (the phone is the most-recent registrant and answers; the desk falls back); **multi-sink broadcast/fan-out is a strictly additive upgrade owned by the owner-sink core, not this spec** — this design's "force host/device from the authenticated session" answer-scoping holds under either model.
3. **Host identity at the app layer.** Does the Phase 11 mesh expose the originating gateway's peer pubkey to the app, or must the app keep a host-identity field from pairing? The multi-host inbox (roadmap line 1695) routes Approve/Reject per-originating-host, so host identity must be reliable. Lean: bind it at pairing (the host pubkey returned in `pair_ok`, `lan-server.ts` line 178) and key every inbox row by it.
4. **APNs entitlement + Apple Developer Program.** Requires the APNs auth key / topic / sandbox-vs-production config (`[companion].apns_*`). Confirm the Phase 13 Developer Program enrollment covers APNs.
5. **Push batching.** Multiple simultaneous HITLs — one batched wake or N wakes? Lean: one wake per requestId for v0 (simplest, idempotent); batch later if quota matters.

---

## Acceptance criteria

1. A fresh iOS device pairs with a fresh gateway in **under 60s** via `nimbus companion pair`, exchanging X25519 keys through the **existing** pairing primitive with no third-party broker (roadmap line 1717).
2. A HITL request fired on the laptop arrives as an iOS push **within 5s** (both online); the Approve/Reject decision lands back at the gateway **within 3s** of the tap; the gate sees it as if the owner clicked Approve in Tauri (line 1718).
3. The APNs envelope **never** carries plaintext brief content or HITL action detail — asserted in the integration test by decoding the sealed envelope and checking it equals `{kind:"wake",requestId,host}` only (line 1719).
4. A duplicate or foreign `companion.respondSink` is rejected and the action is **never** double-executed (HITL idempotency / I4).
5. With no owner-sink online, the HITL **falls back to the local owner prompt** — no auto-approve, no indefinite hold beyond the gate's own timeout (fail-closed).
6. The gateway's box seed and device tokens never appear in any IPC response (only a redacted token suffix) or in logs (Vault test).
7. A revoked device stops receiving within ~60s and the revocation is audit-logged (line 1721).
8. `companion.*` management methods are `FORBIDDEN_OVER_LAN`; only `attachSink`/`respondSink`/`pullRequest` are wire-answerable and force host/device identity from the authenticated session (lan-rpc test).
9. Every new gateway/CLI file ≥80% line+branch on the CI-Linux coverage floor.
