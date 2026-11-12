# Phase 10 — LAN forward secrecy (S3-F8)

Status: DRAFT for Antigravity review (round 1). Owner rulings (§ 2, 2026-11-12) are binding; do not reopen them.
Date: 2026-11-12. Slot: S4. Roadmap: `docs/roadmap.md` § Phase 10 → *Core — LAN Hardening (deferred
from Phase 4 B1 audit)*, row **LAN forward secrecy (S3-F8)**. The finding is recorded in
`docs/SECURITY.md` (the B1 audit row, line 80, and the "LAN remote access — trust model" section,
lines 179 and 193). Neither text says more than the roadmap row.

## 1. Goal

A LAN session between two paired Nimbus gateways is encrypted under keys that exist only for that
session. A later compromise of either gateway's long-term pairing identity (the Vault key
`federation.identity_secret`) does not decrypt a recorded past session, and a recorded handshake or
request cannot be replayed to run a request again. The long-term key still authenticates each side;
it no longer encrypts anything.

Acceptance criteria this project must meet:

- (FS-A1) *A recorded session cannot be decrypted with the pairing keys alone.* Proven by a test
  that runs a real `LanServer` and the real client over loopback through a recording proxy, then
  hands an attacker routine BOTH static secret keys and the full transcript, and shows no record
  opens. A positive control (the same routine given the test-only ephemeral secret) opens it, so the
  test cannot pass vacuously.
- (FS-A2) *A recorded request replayed in a new session is refused*, and a recorded reply replayed
  to a new request is refused.
- (FS-A3) *A peer that completed the new handshake with us once can never again be talked to in the
  old static mode* (downgrade ratchet), and `[lan] min_protocol = 2` refuses the old mode for every
  peer.
- (FS-A4) *An old peer and a new peer interoperate during the compat window* (if the owner keeps
  one, Q1), in both directions, and `nimbus lan status` names every peer still on the old mode.
- (FS-A5) Every existing federation consumer (query, invoke, delegated approval, quorum, team vault,
  share forward) passes its existing integration test unchanged over the new transport.

## 2. Owner rulings

Owner rulings, 2026-11-12 (binding; they settle the five questions § 12 listed):

- **OR-FS-1 Time-boxed compatibility window.** v2 is preferred; v1 is still accepted from a peer
  that has not ratcheted, `[lan] min_protocol` defaults to 1, `nimbus lan status` warns while any
  peer is on v1, and FS3 flips the default to 2 after two minor releases.
- **OR-FS-2 No re-pair.** Existing pairing keys carry over; the first v2 session upgrades the peer
  row. `nimbus lan rotate-identity` is recorded as a follow-up roadmap row, not built here.
- **OR-FS-3 Rekey every 1,024 records**, in both directions.
- **OR-FS-4 Noise is implemented in-repo** (`ipc/lan-noise.ts`, from the Noise spec and Bun's
  `node:crypto` X25519, HKDF and AES-256-GCM), checked against the published Noise test vectors; no
  new dependency.
- **OR-FS-5 Pairing changes in this project**: Noise XXpsk0 in slice FS2, the pairing code as the
  PSK; the code never travels on the wire.

Decided by me (not owner questions; recorded so review can challenge them):

- **D-FS-1 Noise, not a SIGMA-style signed exchange.** The identity key is an X25519 key
  (`ipc/lan-crypto.ts:9-12,44-49`, tweetnacl `nacl.box.keyPair`). X25519 cannot sign. A SIGMA design
  would need a second, Ed25519 identity per host, a new Vault key, a binding between the two keys
  that must itself be authenticated at pairing, and an exchange of both public keys with every
  existing peer row. Noise authenticates with the static DH key we already have, so no pairing
  record, no Vault key and no peer row changes its key. The Noise patterns also hide both static
  keys from a passive observer, which the current plaintext `hello` (`lan-client.ts:273-278`) does
  not.
- **D-FS-2 Pattern `Noise_IK_25519_AESGCM_SHA256` for a paired peer; `Noise_XXpsk0_25519_AESGCM_SHA256`
  for pairing.** IK fits because the initiator already pins the responder's static key
  (`lan_peers.peer_pubkey`, which `sendFederatedOverWire` takes as `peerPubkey`) and the responder
  looks the initiator up after decrypting it (`isKnownPeer`). IK needs the same number of round
  trips as today's hello plus RPC: message 1, message 2, then the request. XX fits pairing because
  neither side knows the other's key; the pairing code is mixed in as a pre-shared symmetric key
  at position 0, which authenticates the code in BOTH directions (psk3 would let a man in the middle
  who lacks the code pose as the host to the initiator). Pattern definitions and the `psk0` modifier:
  Noise Protocol Framework rev 34, § 7.5 and § 9.4; `psk` mode also mixes the ephemeral key into the
  key schedule (§ 9.2).
- **D-FS-3 AES-256-GCM, SHA-256, X25519, all from `node:crypto`.** Checked on Bun 1.3.14 / Windows
  while drafting: `diffieHellman` on X25519, `hkdfSync` and `aes-256-gcm` work, and a tweetnacl
  32-byte box secret imports through a JWK (`kty: OKP, crv: X25519, d, x`) and gives the same shared
  secret as `nacl.scalarMult`. ChaCha20-Poly1305 is NOT available (`ERR_CRYPTO_UNKNOWN_CIPHER`), so
  the ChaChaPoly suite is out. AESGCM's 96-bit nonce is 32 zero bits and the big-endian counter
  (Noise § 12.4); nonces are counters, never random, which removes the random-nonce collision bound
  that `sealBoxFrame`'s 24 random bytes carry.
- **D-FS-4 No payload in message 1.** An IK first-message payload is encrypted under `es`/`ss`
  only: not forward-secret and replayable (Noise payload security properties, § 7.7; confirm the
  section number when implementing). The request is sent as the first TRANSPORT message after
  message 2, so nothing is lost: the round-trip count equals today's.
- **D-FS-5 One logical message is split into records of at most 65,535 bytes.** Noise messages are
  capped at 65,535 bytes (§ 3). The existing 4 MiB logical cap (`MAX_ENCRYPTED_FRAME`,
  `lan-server.ts:13`) stays; a record is `u32 length || ciphertext`, and the plaintext's first byte is
  `0x01` (final record) or `0x00` (more follows), so a truncated message is detected. Reassembly is
  bounded by the same cap and by `MAX_PENDING_BYTES`.
- **D-FS-6 Pairing moves to XXpsk0 in this project (slice FS2).** Today the pairing code travels in
  a plaintext JSON frame (`lan-client.ts:320-326`) and the host's key comes back in plaintext, so a
  passive observer reads the code and an active one can race it. The code is single use, which limits
  the damage, but leaving it plaintext while the transport is hardened would leave the weakest link
  where new peers are made. The PSK is `HKDF-SHA256(salt = "nimbus-lan/2 pair psk", ikm = code,
  info = "psk0", L = 32)` (RFC 5869). The user-facing flow (open a window, read the 20-character
  code aloud, `nimbus team pair`) does not change.
- **D-FS-7 Session keys, and no labels of our own.** Noise derives every key with its own HKDF
  (RFC 5869 with the chaining key as salt and empty info; Noise § 4.3), keyed by the protocol name
  hashed into the initial state. We add exactly two things: the PROLOGUE `"nimbus-lan/2" || version ||
  pattern byte` (so a header edit breaks the handshake), and the PSK derivation above. We define no
  other labels and no key schedule of our own.
- **D-FS-8 In-session rekey by message count, no signalling.** Both directions call Noise `Rekey()`
  (§ 11.3) on their sending and receiving CipherState after every 1,024 records. Both sides count
  the same records, so no control message exists to forge or drop. Rekey is one-way, so a key taken
  at record 3,000 does not open records 1 to 2,048. The interval is Q3.
- **D-FS-9 The first frame tells the versions apart.** A legacy first frame is JSON, so its first
  byte is `0x7B`. A v2 first frame starts `0x4E 0x4C` ("NL"), a version byte (`0x02`) and a pattern
  byte (`0x01` IK, `0x02` XXpsk0). Any other first byte closes the socket with no reply and counts a
  handshake failure (as `lan-server.ts:182-189` does for unparseable input).
- **D-FS-10 Message 1 failure is silent.** If the responder cannot decrypt message 1 (a stale pinned
  key, a forged message) it closes with no reply: no oracle that says "unknown peer" versus "bad key".
  The cost is a worse diagnostic on the client (§ 9).
- **D-FS-11 A handshake deadline on the server.** Today `LanServer` has no timer on a socket that
  has not completed a handshake: `socket.data` is created at `open` (`lan-server.ts:69-75`) and
  nothing closes an idle one, only a client-side 5 s timeout exists (`lan-client.ts:12`). The new
  server closes any socket that has not finished the handshake in 10 s and counts it as a failure.
- **D-FS-12 Implementation and test vectors.** The Noise state machine (`SymmetricState`,
  `CipherState`, `HandshakeState`) is written once, in `ipc/lan-noise.ts`, from the specification and
  the node primitives only, and is checked against the published Noise test vectors for the
  `AESGCM_SHA256` suites before anything uses it. This is an implementation of a standard, not a
  design of ours; the alternative (a dependency) is Q4.

## 3. Non-goals

- No change to the method allowlist model (I5), the query gate (I17), the invoke gate (I19), the
  delegated-approval fallback (I20) or quorum (I21). They sit above the transport and read the
  authenticated peer id the transport hands them.
- No post-compromise security. A live compromise of a gateway (its process memory, or its Vault key
  while it is still trusted) lets the attacker be that gateway. Rekey is one-way; it does not heal.
- No protection for recorded v1 sessions. They stay decryptable by whoever holds the static key,
  today and later. Rotating the key does not change that for a key already stolen (Q2).
- No new key type, no certificate authority, no Ed25519 identity for the LAN, no change to
  `federation.identity_secret` or to `lan_peers.peer_pubkey`.
- No TLS, no mTLS, no QUIC. The transport stays Bun TCP with the existing length framing, rate
  limiter, bind rules (I6) and loopback-host guard story (I45 does not apply: not HTTP).
- No fix for the unrelated findings in § 11 (they are recorded, not built).
- No change to `lan.*` IPC beyond one status field.

## 4. Slices (one PR each, in order)

| Slice | Content |
| --- | --- |
| FS1 | `ipc/lan-noise.ts` (Noise from primitives, with the vector test); `ipc/lan-session.ts` (records, chunking, rekey, counters); IK in `lan-server.ts` and `lan-client.ts`; v1 moved verbatim to `ipc/lan-legacy.ts`; V9x `lan_peers.proto_version`; `[lan] min_protocol`; the downgrade ratchet; the 10 s handshake deadline; invariant I5x, static rule D4x; the recorded-session, replay and downgrade tests |
| FS2 | `XXpsk0` pairing replaces the plaintext `pair`/`pair_ok` frames (initiator and responder); a post-handshake `pair_ok` record carries the peer id; `nimbus lan status` and `lan.getStatus` list peers by protocol version; `nimbus team pair` messages; the five core docs, `docs/SECURITY.md` lines 179 and 193 |
| FS3 (a later release, after the window) | `min_protocol` default flips to 2 (if the window is a time-box); then `lan-legacy.ts` is deleted with its tests, the `proto_version` column is kept. Not part of this project's closure; recorded as a roadmap sub-row |

## 5. Design

### 5.1 What exists today (verified in code)

- **Library and construction.** `ipc/lan-crypto.ts`: tweetnacl `nacl.box` (X25519 + XSalsa20-Poly1305),
  one static keypair per host. `sealBoxFrame` draws a 24-byte RANDOM nonce per frame
  (`lan-crypto.ts:19`) and the frame is `nonce || ciphertext`; `openBoxFrame` splits it back
  (`lan-crypto.ts:27-42`). Every frame in both directions of every session uses the SAME shared
  secret, `DH(own static, peer static)`.
- **Identity key.** Vault key `federation.identity_secret`, a base64 32-byte secret, load-or-create in
  `federation/federation-identity.ts:4-23`. Its public half is the peer id source:
  `peer:` + the first 8 bytes in hex (`peer-pairing.ts:25-27`, `federation-server.ts:80-82`).
- **Peer table.** `lan_peers` (V19, `index/lan-peers-v19-sql.ts`): `peer_pubkey BLOB UNIQUE`,
  `direction`, `host_ip`, `host_port`, `write_allowed`, `paired_at`, `last_seen_at`.
- **Handshake (v1), all plaintext JSON frames, 4-byte big-endian length prefix, cap 4,096 bytes**
  (`lan-server.ts:12,153-172`). `pair`: `{kind:"pair", client_pubkey, pairing_code}`; the server
  consumes the code (`lan-pairing.ts:387-400`, constant-time compare, I10), persists the client
  with `registerPeer`, answers `{kind:"pair_ok", host_pubkey, peer_id}` (`lan-server.ts:210-237`).
  `hello`: `{kind:"hello", client_pubkey}`; the server answers `hello_ok` + its public key iff
  `isKnownPeer(clientPubkey)` (`lan-server.ts:239-254`). **The hello carries no proof of key
  possession**: anyone who knows a paired peer's PUBLIC key gets `hello_ok`. The proof arrives
  implicitly with the first frame that decrypts under the static-static secret.
- **Peer authentication.** Client side: the reply's `host_pubkey` is compared with the pinned
  `peerPubkey` before any request is sent (`lan-client.ts:288-290`). Server side: the lookup by
  public key, then box-open of each request (`lan-server.ts:267`). The authenticated `peerId` is
  forced into the params of every served `federation.*` call (`federation-server.ts:137-142`, R1 of
  I17).
- **Sessions.** The client opens one TCP connection per RPC: hello, one sealed request (`id: 1`), one
  sealed reply, close (`lan-client.ts:182-261`). The server accepts a loop of frames per socket
  (`lan-server.ts:120-131`), but no production caller sends a second. Calls that wait for a human
  (a consent prompt, a delegated approval, a quorum round) hold the socket open for the whole wait.
- **Replay protection: none.** A grep of `ipc/lan-*.ts`, `federation-server.ts` and
  `federation-rpc.ts` for nonce tracking, sequence numbers or seen-sets finds only the random nonce
  generation. Nothing on the server binds a request to a session; nothing on the client binds a reply
  to a request (the id is always `1`). An on-path attacker who recorded `hello` + the sealed request
  can send both again and the server executes the method again; one who recorded a reply can
  substitute it for any later reply. What limits the damage today is the layer above: a consent
  prompt per federated query, quorum windows, per-`requestId` matching of responses
  (`federation-rpc.ts:346-350,396-400,526-539`), and the HITL gate on the host. No such limit exists
  for `federation.shareReceive` (a replay stores the same share again).
- **What a recorded session's ciphertext depends on.** Only on the two static secrets, plus a
  per-frame random nonce that is sent in the clear. Holding either static secret and the pcap
  decrypts every session ever recorded between those two hosts, in both directions, including the
  past. That is the S3-F8 finding, and it is exactly as stated by the roadmap row.
- **The denylist.** `checkLanMethodAllowed` (`lan-rpc.ts:285-297`) is called from
  `handleEncryptedMessage` before `onMessage` (`lan-server.ts:290`). `FORBIDDEN_OVER_LAN`
  (`lan-rpc.ts:10`) is a DENYLIST: a new namespace is LAN-reachable by default.

### 5.2 Consumers of the channel (all go through `sendFederatedOverWire`, so one client seam)

The server seam is `buildFederationLanServer` (`federation-server.ts:114`), built once in
`platform/assemble.ts`. Clients: `federation-rpc.ts` (`federation.ask`, `askExpertise`, `askInvoke`,
`auditExport`, probes, preflight; lines 320, 424, 443, 457), `peer-fanout.ts` (query, probe,
preflight, expertise fan-out; lines 86, 134, 174, 215), `engine/delegated-request-remote.ts:36`
(`federation.requestApproval`, I20), the agents `conflicts`, `ghost`, `huddle`, `janitor`,
`preflight` through `agents/_lib/fanout-deps.ts`, the `ipc/agents-rpc.ts` fan-out, and the share
forward (`platform/assemble.ts:1364`, `federation.shareReceive`, I27). Served methods: everything in
`dispatchFederationRpc` that `FORBIDDEN_OVER_LAN` does not name: query (I17), expertise, invoke
(I19), requestApproval and approvalRespond (I20), quorumRespond (I21), purge, shareReceive,
preflight (I24). Pairing is the only non-RPC use (`federation-runtime.ts:35` →
`outboundPairHandshake`).

No consumer touches the box functions directly. `sealBoxFrame`, `openBoxFrame` and
`generateBoxKeypair` are used only by `lan-client.ts`, `lan-server.ts`, `federation-identity.ts`
(and tests). That is what makes a transport swap one PR and what the static rule (§ 8) pins.

### 5.3 Wire protocol v2

```
frame        = u32 length (big-endian) || body                  (same framing as v1)
first frame  = 0x4E 0x4C || 0x02 || pattern || noise message 1  (pattern 0x01 IK, 0x02 XXpsk0)
later frames = noise message                                    (<= 65,535 bytes)
```

**IK (paired peers).** Known to the initiator before the exchange: the responder's static `rs`
(`lan_peers.peer_pubkey`).

```
prologue: "nimbus-lan/2" || 0x02 || 0x01
<- s                                (pre-message: rs hashed in)
-> e, es, s, ss                     (message 1, EMPTY payload)
<- e, ee, se                        (message 2, EMPTY payload)
```

After message 2 both sides `Split()` into two CipherStates (send and receive). The initiator sends
the JSON request `{id, method, params}` as the first transport record; the responder replies in
the same session. Who signs what: nobody signs. The initiator's static key authenticates through
`ss` and `se`, the responder's through `es` and `ee`/`se`; each side's static DH output is mixed into
the transcript hash and the chaining key, so a transport record opens only for a peer who holds the
matching static secret AND took part in this exchange's ephemeral DH. The ephemerals give forward
secrecy: `ee` and `se` use the responder's ephemeral secret, which is zeroed after `Split()`.

Responder steps, in order (an ordered check list, as the CLAUDE.md gate advice asks):
1. rate limiter `checkAllowed(ip)` (before any DH);
2. decrypt message 1 (fails → close silently, count a failure);
3. the decrypted `rs` of the initiator → `isKnownPeer` (unknown → close silently, count a failure);
4. check `proto_version` ratchet and `min_protocol` (§ 6);
5. send message 2; set the session's `peerMatch` from step 3; only then read transport records.
`checkLanMethodAllowed` still runs per request, unchanged, before `onMessage`.

**XXpsk0 (pairing).**

```
prologue: "nimbus-lan/2" || 0x02 || 0x02
-> psk, e                            (message 1)
<- e, ee, s, es                      (message 2: host static, encrypted)
-> s, se                             (message 3: initiator static, encrypted)
```

The responder tries the PSK of the single open window (`pairing.isOpen()`). A wrong code fails at
message 1's AEAD check on message 3 or earlier, with no oracle. On success the responder records
the initiator (`registerPeer`) and sends a first transport record `{kind:"pair_ok", peer_id}`; the
initiator persists the host only after receiving it (today it persists after `pair_ok` too:
`peer-pairing.ts:54-62`). `PairingWindow.consume` is called at message 3 so the code stays single
use.

**Records.** Each record plaintext is `flag(1) || chunk`, `flag` 0x00 more / 0x01 final, chunk at
most 65,518 bytes (65,535 minus the 16-byte tag and the flag byte). A reassembled message is capped
at `MAX_ENCRYPTED_FRAME`. Receiving counters are the AEAD nonce: a dropped, reordered or replayed
record fails to open, and the session ends.

### 5.4 Sessions longer than one request

The client uses one session per RPC and one request per session, so the common session is four
records long. The server loop supports more, and a consent wait can hold a session for minutes.
Rekey every 1,024 records (D-FS-8) is a limit nobody reaches today; it is built because the cost
is a dozen lines and the server API already accepts a stream.

### 5.5 Pairing, and what does not change

The `lan.openPairingWindow` / `closePairingWindow` flow, the 5-minute window, the 20-character base58
code, the rate limiter and the `lan_peers` rows are unchanged. The host's key still reaches the
initiator only through the pairing exchange; the user-visible "read the code aloud" step is now what
the exchange cryptographically requires from both sides.

### 5.6 Mixed-version behaviour

A server running v2 inspects the first byte. A client running v2, for a peer whose `proto_version` is
unknown or 1, sends a v2 message 1. An old server parses it as JSON, fails, and closes without a
reply (`lan-server.ts:182-185`): the client sees "closed without reply", then (compat window only,
and only for a peer not yet ratcheted) retries once in v1. There is no capability announcement an
attacker cannot suppress: mDNS TXT records would be a HINT at best. The downgrade rule is therefore
about what is remembered, not what is announced (§ 6).

## 6. Migration and compatibility

- **Schema V9x** (placeholder; V94-V96 are reserved by the incident engine): `ALTER TABLE lan_peers
  ADD COLUMN proto_version INTEGER NOT NULL DEFAULT 1`. Forward-only, per
  `nimbus-db-migrations`. `proto_version` is written to 2 by exactly one function, after a v2
  handshake completes for that peer (`LocalIndex.markLanPeerProto`), and set back to 1 by nothing
  except removing the peer and pairing again.
- **Config.** `[lan] min_protocol = 1 | 2`. Default depends on Q1. `2` refuses every v1 first frame
  (a JSON `hello` or `pair`) with no reply, counted as a failure, whoever sent it.
- **Downgrade rule (D-FS-13, decided).** Responder: a v1 `hello` from a pubkey with
  `proto_version = 2` is refused, whatever `min_protocol` says. Initiator: for a peer with
  `proto_version = 2` the client never sends or falls back to v1. This means an active attacker can
  force v1 only against a peer that has never completed a v2 handshake with us, and only while the
  compat window is open. The ratchet is trust-on-first-use of the v2 capability, the same shape as
  the existing key pinning.
- **No re-pairing.** The static keys, peer ids and `lan_peers` rows are untouched; the first v2
  session of an existing pair upgrades the row. Q2 covers the optional rotation.
- **Rollback.** A user who installs an older gateway after the ratchet cannot talk to v2-only peers
  (their v1 is refused). The old gateway ignores the new column. Documented in the release note.
- **Old tests.** Because v1 moves verbatim into `lan-legacy.ts` and stays reachable while the
  window lasts, the tests that pin the old wire (§ 9) keep running against it; v2 gets sibling tests.

## 7. Security analysis

**Protected, with the new transport:**

| Asset | Attacker | Result |
| --- | --- | --- |
| A recorded session's contents | Later holder of one or both static secrets (Vault compromise, disk image, backup) | Not decryptable: transport keys depend on `ee`, whose secret was destroyed. Test FS-A1. |
| A recorded handshake and request | On-path replayer | Refused: the transport keys depend on the responder's fresh ephemeral, so the replayer cannot produce a valid record. Test FS-A2. |
| A recorded reply | On-path substituter | Refused: replies are under the session's own keys and counter nonces. |
| Request/response pairing | On-path | One request per session and AEAD counters; reordering and truncation fail. |
| Which two peers talk | Passive observer | Static keys are encrypted in IK message 1 and XX messages 2 and 3; today they are plaintext in `hello`. IP addresses and sizes remain visible. |
| The pairing code | Passive observer, active MITM without the code | Never on the wire; a MITM cannot finish XXpsk0. |

**Still not protected:**

- A **live compromise**: whoever holds a static secret now can authenticate as that gateway to its
  peers until the peer is removed. Forward secrecy is about the past.
- A compromised endpoint reads its own sessions' plaintext. Keys live in process memory.
- **Metadata**: connection times, addresses, message sizes and counts.
- **Recorded v1 sessions** (before the upgrade, and during the window with a not-yet-ratcheted
  peer): decryptable by a static-key holder. See Q2.
- **A forced downgrade** against a peer that has not yet completed v2 with us, during the window.
- **Weak pairing UX**: the code's confidentiality still depends on the owner passing it out of band.
  XXpsk0 removes the on-wire exposure, not a shoulder-surfed code.
- **Denial of service**: a flood of message 1 costs the responder two X25519 operations before the
  failure is known; the per-IP limiter (`lan-rate-limit.ts`) and the 10 s deadline apply, as today
  (and, unlike today, an idle socket no longer holds a connection forever).
- Key compromise impersonation follows the Noise analysis of IK and XX (fundamental patterns table,
  § 7.7): a stolen responder static lets the thief answer as the responder; it does not let the
  thief complete a session as an initiator without that initiator's static secret, because the
  session keys include `se`.

**Invariant plan (the triple rule).** I recommend a NEW invariant, **I5x — a LAN session's
transport keys come from an authenticated ephemeral key exchange**, not an amendment of I5 or I17,
because those two are about WHAT a peer may call and WHICH data the gate answers; this one is about
how the bytes are protected, and its enforcement is a different file set. (I17's text mentions "the
NaCl-authenticated session" and gets a one-line edit; I5's "Wired at" does not change.)

- **Statement:** a LAN session's records are encrypted only under keys that `ipc/lan-session.ts`
  derives from `ipc/lan-noise.ts` after an exchange with an ephemeral DH from each side; the static
  identity key never encrypts a record; the v1 box path is reachable only through `ipc/lan-legacy.ts`,
  never for a peer whose recorded protocol is 2 and never under `min_protocol = 2`.
- **Wiring site:** `ipc/lan-server.ts` and `ipc/lan-client.ts` call `lan-session.ts` for every
  non-legacy frame; the downgrade check lives in one function, `lan-legacy.ts`
  `legacyAllowedFor(peer, cfg)`.
- **Docs:** `docs/SECURITY-INVARIANTS.md` section and the one-line entry in `CLAUDE.md` / `GEMINI.md`;
  the `nimbus-security-invariants` skill list; `docs/SECURITY.md` lines 179 and 193 rewritten.
- **Enforcement test (runtime):** `security-invariants.test.ts` block I5x: the recorded-session test
  (FS-A1 with the positive control), the replay test (FS-A2), the downgrade test (FS-A3), and a
  by-name test that a v1 `hello` from a ratcheted pubkey gets no reply.
- **Static rule D4x:** in `scripts/structure-audit/check-nimbus-invariants.ts`, `sealBoxFrame`,
  `openBoxFrame` and any `nacl.box(` call may be imported or called only in `ipc/lan-legacy.ts`,
  `ipc/lan-crypto.ts` and `federation/federation-identity.ts` (key creation only, via
  `generateBoxKeypair`/`boxKeypairFromSecretKey`); a call from `lan-server.ts`, `lan-client.ts` or
  any federation module fails the audit. After FS3 the legacy file is deleted and the allowance with
  it. The rule is written as what cannot pass (a direct static-DH seal), per the static-guard notes.
- **Concurrent work.** The incident-engine spec reserves schema V94-V96, rule D46 and invariant I56
  and adds `"incident"` to `FORBIDDEN_OVER_LAN` in `lan-rpc.ts`. This project uses placeholders V9x,
  D4x and I5x and edits `lan-rpc.ts` not at all (it touches `lan-server.ts`, `lan-client.ts` and new
  files). The only shared line of conflict is the `FORBIDDEN_OVER_LAN` set, which the other project
  edits alone; whichever merges second takes the final numbers.

## 8. Testing and acceptance

New tests (the existing ones are listed after):

- **Vectors.** `lan-noise.test.ts` runs the published Noise test vectors for the AESGCM/SHA256 suites
  (IK and XXpsk0 entries) and checks the handshake hash and every transport ciphertext.
- **FS-A1 recorded session.** Real `LanServer` + real client on loopback through a recording TCP proxy
  (both directions kept). The attacker routine is given both static secrets, the whole transcript and
  the pairing code, and tries: the v1 `openBoxFrame` on every record with all four key orders; a
  Noise re-derivation that has every DH output except `ee`. None opens. The positive control hands
  it the initiator's test-only ephemeral secret and the first record opens, so a bug in the
  attacker routine fails the test instead of passing it.
- **FS-A2 replay.** Replay the recorded frames to a fresh connection: no reply and no `onMessage`
  call (a spy on `onMessage`). Replay a recorded reply to a new client: its AEAD fails.
- **FS-A3 downgrade.** A v1 `hello` for a ratcheted pubkey is closed without a reply; with
  `min_protocol = 2` a v1 `pair` is refused; a client with `proto_version = 2` does not fall back when
  the v2 attempt is killed mid-handshake (the socket is reset by the test proxy).
- **FS-A4 mixed versions.** The legacy `LanServer` code path (from `lan-legacy.ts`) and the new
  client, and the reverse, with `min_protocol = 1`; `lan.getStatus` lists the legacy peer.
- **Failure modes.** Handshake timeout (a peer that opens a socket and sends nothing is closed at
  10 s; a fake clock); a stale pinned key (the client surfaces "no reply: the peer may have been
  re-paired or reset; run `nimbus team pair` again"); a corrupted record ends only that session;
  records past the cap; a rekey boundary at 1,024 records on both sides (a test sends 2,100 records);
  a wrong pairing code leaves the window open and counts a failure.
- **Wiring.** A test in the I5 block that `checkLanMethodAllowed` still precedes `onMessage` in the
  v2 path (the existing source regex plus a behavioural call).

Existing tests that pin the old wire and keep running against `lan-legacy.ts` until FS3:
`ipc/lan-crypto.test.ts`, `ipc/lan-server.test.ts`, `ipc/lan-server.edges.test.ts`,
`ipc/lan-server-handshake.test.ts` (S3-F4/S3-F6), `ipc/lan-client.test.ts`,
`ipc/lan-client.edges.test.ts`, `test/integration/lan/lan-rpc.test.ts`. These build raw `hello` frames
and `sealBoxFrame` calls against the server. Consumers that run the real wire and must pass
unchanged over v2 (FS-A5): `test/integration/federation/{federation-acceptance,two-gateway-wire,
two-gateway-janitor,two-gateway-preflight}.integration.test.ts`,
`test/integration/teamvault/{two-gateway-invoke,three-gateway-quorum,delegated-approval}.integration.test.ts`,
`test/e2e/share-forward-e2e.test.ts`, and the DI-based unit tests of the agents, `peer-fanout` and
`delegated-request-remote`, which inject `sendOverWire` and so do not see the change.

Gates: `bun run preflight`, `audit:invariants` (D4x), `audit:status-drift` for the invariant count
(I1-I5x), and the coverage scope for `ipc/` and `federation/`. Gateway-spawning tests belong in the
E2E tree (D-Bus on Linux); the recorded-session test uses in-process servers on loopback.

Docs touched (all five core docs, plus): `CLAUDE.md` and `GEMINI.md` status and the invariant line;
`docs/roadmap.md` (the row, plus an FS3 sub-row); `docs/architecture.md` (LAN transport); `docs/README.md`;
`docs/cli-reference.md` (`nimbus lan status`, `nimbus team pair`); `docs/SECURITY.md` (trust model,
residual risks); `docs/SECURITY-INVARIANTS.md`; the `nimbus-federation-identity` skill.

## 9. Failure modes

| Situation | Behaviour |
| --- | --- |
| Handshake never completes | Server closes at 10 s (D-FS-11); the client's own 5 s default applies first on its side. |
| Responder was re-installed or its identity regenerated (new static key) | IK message 1 is encrypted to the stale pin; the server cannot open it and closes silently. The client reports "closed without reply" with the hint to re-pair. This is weaker than today's explicit "pinned key mismatch" text (`lan-client.ts:288-290`), by design (D-FS-10). |
| Initiator unknown to the responder (it was removed there) | Same silent close; counted as a failure for the rate limiter. |
| Wrong pairing code | Pair fails with no oracle; the window stays open until it expires or a right code arrives; the failure is counted. |
| Peer re-paired after removal | `removePeer` deletes the row and with it `proto_version`; the next pairing starts at v2 under `min_protocol = 2`, or v1/v2 per the window. |
| Message too large / bad record | The session ends; no partial dispatch. |
| Rekey desync (a bug) | The next record fails to open and the session ends. |
| Old peer talks to a `min_protocol = 2` gateway | Refused, counted. The old peer sees "connection closed without reply". `nimbus lan status` on the new side names the refused version count. |

## 10. Stated bounds

- Forward secrecy holds for the session's key material only while the ephemeral secrets are erased.
  JavaScript gives no guarantee: the ephemeral private keys are `KeyObject`s and buffers we overwrite
  and drop, but a copy in a heap snapshot, a swap file or a crash dump is outside this design.
- The Noise state machine is ours (D-FS-12) validated by test vectors; it has not had an external
  review. Q4 is that decision.
- The downgrade ratchet is trust-on-first-use of the v2 capability (§ 6). During the compat window a
  peer that has not completed v2 with us can be forced to v1 by anyone who can drop packets.
- Message sizes and counts are visible; records are not padded.
- The pairing code's entropy (about 117 bits of base58 after the 20-character trim,
  `lan-pairing.ts:8-13`) is mixed into the PSK; a code obtained by the attacker defeats pairing.
- No clock is used, so there is no wall-clock replay window; replay is defeated structurally by the
  responder's ephemeral.
- Interop with other Noise implementations is not a goal; the prologue and the framing are
  Nimbus-specific.

## 11. Findings outside this row (recorded, not built)

- `isKnownPeer` returns `writeAllowed: false` for every peer (`federation-server.ts:130`), so
  `nimbus lan grant-write` (the `lan.grantWrite` handler, `ipc/server/dispatchers.ts:1248`) updates a
  column the federation LAN server never reads. The "paired peer with write grant" row of
  `docs/SECURITY.md` describes a capability this server does not offer.
- No server-side deadline on a connection that has not handshaken (fixed here, D-FS-11).
- `federation.shareReceive` has no replay defence at the layer above; the new transport removes the
  on-wire replay, but a legitimate peer re-sending the same share is not deduplicated.
- The `pair` path registers the peer immediately on code consumption, so the "mutual approval" in
  `PeerPairing.approveInboundPair` is not on the production path for a host that opened a window.

## 12. Owner questions (resolved)

All five were answered by the owner on 2026-11-12 with the recommended option; see § 2
(OR-FS-1 to OR-FS-5).
