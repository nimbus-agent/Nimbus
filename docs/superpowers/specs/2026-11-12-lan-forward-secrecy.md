# Phase 10 — LAN forward secrecy (S3-F8)

Status: APPROVED by Antigravity (round 2, 2026-11-12). Owner rulings OR-FS-1 to OR-FS-6 (§ 2) are binding; do not reopen them.
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
- (FS-A2) *A recorded request replayed in a new session is never executed*, and a recorded reply
  replayed to a new request is refused. Replaying message 1 DOES draw a message 2 (the responder
  can open message 1 and answers with a fresh ephemeral); it yields the replayer nothing, and the
  replayed transport record fails to open: no RPC reply, no `onMessage` call, a counted failure.
- (FS-A3) *A peer that completed the new handshake with us once can never again be talked to in the
  old static mode* (downgrade ratchet), and `[lan] min_protocol = 2` refuses the old mode for every
  peer.
- (FS-A4) *An old peer and a new peer interoperate during the compat window* (if the owner keeps
  one, OR-FS-1), in both directions, and `nimbus lan status` names every peer still on the old mode.
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
- **OR-FS-6 (2026-11-12) Accept the ~114-bit pairing code.** Keep the 20-character base58 code and
  `XXpsk0`; the docs state the code's security level (about 114 bits, below Noise § 14's 256-bit
  PSK guideline; offline guessing is infeasible at that size). No longer code and no PAKE.

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
- **D-FS-6 Pairing moves to XXpsk0 in this project (slice FS2; OR-FS-5).** Today the pairing code
  travels in a plaintext JSON frame (`lan-client.ts:320-326`) and the host's key comes back in
  plaintext, so a passive observer reads the code and an active one can race it. The code is single
  use, which limits the damage, but leaving it plaintext while the transport is hardened would leave
  the weakest link where new peers are made. The PSK is `HKDF-SHA256(salt = "nimbus-lan/2 pair psk",
  ikm = UTF-8 bytes of the code string (the 20 ASCII characters, no normalisation, no base58
  decoding), info = "psk0", L = 32)` (RFC 5869). The user-facing flow (open a window, read the
  20-character code aloud, `nimbus team pair`) does not change. What the code's entropy has to be,
  and where this departs from the Noise rule on PSK entropy, is § 7.1 and Q6.
- **D-FS-7 Session keys, and no labels of our own.** Noise derives every key with its own HKDF
  (RFC 5869 with the chaining key as salt and empty info; Noise § 4.3), keyed by the protocol name
  hashed into the initial state. We add exactly two things: the PROLOGUE `"nimbus-lan/2" || version ||
  pattern byte` (so a header edit breaks the handshake), and the PSK derivation above. We define no
  other labels and no key schedule of our own.
- **D-FS-8 In-session rekey by message count, no signalling (OR-FS-3).** Rekeying is per
  CipherState, not per socket: the SENDING state rekeys itself after it has encrypted a record whose
  counter `n` (after the increment) is a multiple of 1,024, and the RECEIVING state rekeys itself
  after it has opened its own 1,024th, 2,048th, ... record. Requests and replies have different
  record counts, so the two directions rekey at different times and each peer's send state is
  matched by the other peer's receive state; no shared counter exists and no control message exists
  to forge or drop. `Rekey()` is `k = REKEY(k)` (Noise § 5.1); for AES-GCM, which defines no REKEY of
  its own (§ 12.4 only defines the cipher and the nonce), REKEY is the default of § 4.2: the first 32
  bytes of `ENCRYPT(k, maxnonce, zerolen, zeros)` with `maxnonce` = 2^64-1, which the AESGCM nonce
  encoding makes `0x00000000 || 0xFFFFFFFFFFFFFFFF`, and `zeros` 32 zero bytes. That nonce value is
  reserved by Noise (§ 5.1) and never used for a record. Rekey does NOT reset `n` (§ 11.3: it
  "doesn't reset the cipherstate's `n` value"), so a nonce is never reused under one key and never
  across keys. `n` must never wrap: when incrementing it would reach 2^64-1 the CipherState signals an
  error and the session ends (§ 5.1: delete the CipherState and terminate); the implementation tests
  this with a CipherState set near the limit. Rekey is one-way, so a key taken at record 3,000 does
  not open records 1 to 2,048. Noise § 14 also advises at most 2^56 bytes per key; the 4 MiB message
  cap and 1,024-record rekey are far inside it.
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
  design of ours (OR-FS-4).

- **D-FS-13 The downgrade ratchet.** Responder: a v1 `hello` from a pubkey whose row has
  `proto_version = 2` is refused whatever `min_protocol` says. Initiator: for a peer at
  `proto_version = 2` the client never sends or falls back to v1. Details in § 6.
- **D-FS-14 A failed first transport record is a counted failure.** After message 2, a record that
  does not open (a replayed request, a corrupted one) ends the session and records a rate-limit
  failure for the IP, as a failed handshake does. Today a post-hello decrypt failure only ends the
  socket (`lan-server.ts:266-271`), so replays were free.
- **D-FS-15 The pairing window hands the responder the PSK, derived once.** `PairingWindow.open(code)`
  validates the code, derives the PSK, caches it in memory and zeroes it on `close()`/expiry;
  `PairingService` gains `currentPsk(): Uint8Array | undefined` (undefined when closed or expired)
  and `consumeOpen(): boolean` (closes the window; false if it was already closed or expired).
  Reason: under XXpsk0 the code never arrives on the wire, so `consume(code)` (`lan-server.ts:16-22`,
  `lan-pairing.ts:47-56`) cannot be the check; the responder needs the PSK BEFORE message 1 can be
  opened. The v1 `consume(code)` stays for the legacy `pair` frame.
- **D-FS-16 The code is validated where it enters and where it is typed.** `PairingWindow.open(code)`
  and `outboundPairHandshake` accept only exactly 20 characters from the base58 alphabet (the format
  `generatePairingCode` returns, `lan-pairing.ts:5-10`) and throw otherwise, before any network
  activity; `lan.openPairingWindow` (`dispatchers.ts:1234-1239`) is the only caller and uses the
  generator. A test pins both, and that the generator draws 15 random bytes. This keeps a future
  caller from passing a short code into a mode that assumes a high-entropy secret (§ 7.1). It checks
  FORMAT, not entropy: a string cannot prove its own entropy.
- **D-FS-17 A peer created by a v2 pairing starts at `proto_version = 2`.** `addLanPeer` takes an
  optional `protoVersion` (default 1, so the legacy `pair` and V19 rows are unchanged). Its
  `ON CONFLICT(peer_pubkey)` upsert (`local-index.ts:938-950`) never lowers it: it sets
  `proto_version = MAX(proto_version, excluded.proto_version)`. A re-pair over v2 cannot write 1.

## 3. Non-goals

- No change to the method allowlist model (I5), the query gate (I17), the invoke gate (I19), the
  delegated-approval fallback (I20) or quorum (I21). They sit above the transport and read the
  authenticated peer id the transport hands them.
- No post-compromise security. A live compromise of a gateway (its process memory, or its Vault key
  while it is still trusted) lets the attacker be that gateway. Rekey is one-way; it does not heal.
- No protection for recorded v1 sessions. They stay decryptable by whoever holds the static key,
  today and later. Rotating the key does not change that for a key already stolen (OR-FS-2).
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
  `peer:` + the first 8 bytes in hex (`peer-pairing.ts:25-27`, `federation-server.ts:57-59`).
- **Peer table.** `lan_peers` (V19, `index/lan-peers-v19-sql.ts`): `peer_pubkey BLOB UNIQUE`,
  `direction`, `host_ip`, `host_port`, `write_allowed`, `paired_at`, `last_seen_at`.
- **Handshake (v1), all plaintext JSON frames, 4-byte big-endian length prefix, cap 4,096 bytes**
  (`lan-server.ts:12,153-172`). `pair`: `{kind:"pair", client_pubkey, pairing_code}`; the server
  consumes the code (`lan-pairing.ts:47-56` `consumeAt`, constant-time compare, I10), persists the client
  with `registerPeer`, answers `{kind:"pair_ok", host_pubkey, peer_id}` (`lan-server.ts:210-237`).
  `hello`: `{kind:"hello", client_pubkey}`; the server answers `hello_ok` + its public key iff
  `isKnownPeer(clientPubkey)` (`lan-server.ts:239-254`). **The hello carries no proof of key
  possession**: anyone who knows a paired peer's PUBLIC key gets `hello_ok`. The proof arrives
  implicitly with the first frame that decrypts under the static-static secret.
- **Peer authentication.** Client side: the reply's `host_pubkey` is compared with the pinned
  `peerPubkey` before any request is sent (`lan-client.ts:288-290`). Server side: the lookup by
  public key, then box-open of each request (`lan-server.ts:267`). The authenticated `peerId` is
  forced into the params of every served `federation.*` call (`federation-server.ts:117-119`, R1 of
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

The server seam is `buildFederationLanServer` (`federation-server.ts:91`), built once in
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
4. `min_protocol` check (§ 6); the match from step 3 carries the row's `protoVersion` (D-FS-13);
5. send message 2; set the session's `peerMatch` from step 3; only then read transport records;
6. a transport record that does not open ends the session and counts a failure (D-FS-14).
`checkLanMethodAllowed` still runs per request, unchanged, before `onMessage`.

**XXpsk0 (pairing).**

```
prologue: "nimbus-lan/2" || 0x02 || 0x02
-> psk, e                            (message 1)
<- e, ee, s, es                      (message 2: host static, encrypted)
-> s, se                             (message 3: initiator static, encrypted)
```

The responder takes the PSK from the open window (`pairing.currentPsk()`, D-FS-15) and refuses to
start if none is open (the rate limiter is charged). Message 1 carries a 16-byte tag keyed by the
PSK, so a wrong or absent code fails at MESSAGE 1, immediately: the socket is closed with no reply
and a rate-limit failure is recorded for the IP at that moment, not at message 3. The code is not
consumed by a failed message 1, so a wrong guess does not burn the owner's window (as with v1's
`consume`, `lan-pairing.ts:47-56`); the limiter bounds online guesses. `consumeOpen()` is called
only after message 3 opens (the initiator proved the code and sent its static key); if two
initiators with the right code race, the second `consumeOpen()` returns false and is refused. On
success the responder records the initiator (`registerPeer`, with `protoVersion = 2`, D-FS-17) and
sends a first transport record `{kind:"pair_ok", peer_id}`; the initiator persists the host (also at
`protoVersion = 2`) only after receiving it (today it persists after `pair_ok` too:
`peer-pairing.ts:54-62`).

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
the exchange cryptographically requires from both sides. Two additions: the code is validated as
exactly 20 base58 characters at `PairingWindow.open` and in `outboundPairHandshake` (D-FS-16), and
the window now holds the derived PSK for its lifetime (D-FS-15).

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
  handshake completes for that peer (`LocalIndex.markLanPeerProto`) or when a v2 pairing inserts the
  row at 2 (D-FS-17), never lowered by an upsert, and set back to 1 by nothing except removing the
  peer; a new pairing then starts at the version it was made with. Only rows that exist at the
  migration (all made over v1) start at 1.
- **`LanPeerMatch` carries the version.** `LanPeerMatch` (`lan-server.ts:30-33`) gains a REQUIRED
  `protoVersion: 1 | 2`, and `isKnownPeer` in `federation-server.ts:105-108` forwards
  `row.proto_version`. Required, not optional, so a fake or future implementer that forgets it is a
  type error and not a silent "1" (an absent value read as 1 would fail open on the ratchet). The
  legacy `hello` path compares it before replying `hello_ok` (`lan-server.ts:239-254`).
- **Config.** `[lan] min_protocol = 1 | 2`. Default is 1 until FS3 (OR-FS-1). `2` refuses every v1 first frame
  (a JSON `hello` or `pair`) with no reply, counted as a failure, whoever sent it.
- **Downgrade rule (D-FS-13).** Responder: a v1 `hello` from a pubkey with
  `proto_version = 2` is refused, whatever `min_protocol` says. Initiator: for a peer with
  `proto_version = 2` the client never sends or falls back to v1. This means an active attacker can
  force v1 only against a peer that has never completed a v2 handshake with us, and only while the
  compat window is open. The ratchet is trust-on-first-use of the v2 capability, the same shape as
  the existing key pinning. A peer made by a v2 pairing is at 2 from its first record, so the
  window never exists for it (D-FS-17).
- **No re-pairing.** The static keys, peer ids and `lan_peers` rows are untouched; the first v2
  session of an existing pair upgrades the row. `rotate-identity` is a follow-up row (OR-FS-2).
- **Rollback.** A user who installs an older gateway after the ratchet cannot talk to v2-only peers
  (their v1 is refused). The old gateway ignores the new column. Documented in the release note.
- **Old tests.** Because v1 moves verbatim into `lan-legacy.ts` and stays reachable while the
  window lasts, the tests that pin the old wire (§ 9) keep running against it; v2 gets sibling tests.

## 7. Security analysis

**Protected, with the new transport:**

| Asset | Attacker | Result |
| --- | --- | --- |
| A recorded session's contents | Later holder of one or both static secrets (Vault compromise, disk image, backup) | Not decryptable: transport keys depend on `ee`, whose secret was destroyed. Test FS-A1. |
| A recorded handshake and request | On-path replayer | The recorded message 1 still opens (it is encrypted to the responder's static key) and draws a message 2 with a fresh ephemeral; the recorded request record then fails to open, because the transport keys depend on that fresh ephemeral. Nothing executes and the IP is charged a failure. Test FS-A2. |
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
  peer): decryptable by a static-key holder. See OR-FS-2.
- **A forced downgrade** against a peer that has not yet completed v2 with us, during the window.
- **Weak pairing UX**: the code's confidentiality still depends on the owner passing it out of band.
  XXpsk0 removes the on-wire exposure, not a shoulder-surfed code.
- **Pairing offline guessing** is bounded by the code's ~114 bits, not by anything the protocol adds
  (§ 7.1); below Noise § 14's 256 bits (accepted, OR-FS-6).
- **Denial of service**: a flood of message 1 costs the responder two X25519 operations before the
  failure is known; the per-IP limiter (`lan-rate-limit.ts`) and the 10 s deadline apply, as today
  (and, unlike today, an idle socket no longer holds a connection forever).
- Key compromise impersonation follows the Noise analysis of IK and XX (fundamental patterns table,
  § 7.7): a stolen responder static lets the thief answer as the responder; it does not let the
  thief complete a session as an initiator without that initiator's static secret, because the
  session keys include `se`.

### 7.1 The pairing code as a PSK (round-2 analysis)

`XXpsk0` mixes the PSK into the key schedule before any Diffie-Hellman, so message 1's 16-byte tag
is keyed by the PSK and the public `e` alone (Noise § 9.2: `psk` is `MixKeyAndHash(psk)`, then the
`e` token adds `MixHash`/`MixKey` of the ephemeral). Anyone who records message 1 can therefore test
a candidate code OFFLINE: derive the PSK, redo the first two steps, compare the tag. No gateway is
contacted, so the limiter, the 5-minute window and the audit trail do not see it. This holds for a
passive observer; it is not a flaw of the pattern but of the input: Noise says a PSK must be "secret
values with 256 bits of entropy" (§ 14) and fixes its length partly "to deter users from mistakenly
using low-entropy passwords as pre-shared keys" (§ 15.1).

How strong the code really is (computed from `lan-pairing.ts:5-10`, not measured): 15 random bytes
(120 bits) are base58-encoded; a 120-bit value needs 21 digits about 86% of the time (58^20 is about
2^117.2), and the generator then CUTS the last digit (`slice(0, 20)`), keeping `floor(N / 58)`. The
effective code space is about 2^114.1 values and the min-entropy is about 114 bits, not the 117 or
120 an earlier draft and the review quoted. A test pins the arithmetic (D-FS-16).

| Attacker | What they can test | Cost at 114 bits |
| --- | --- | --- |
| Passive, records message 1 | Any number of candidate codes offline | About 2^114 HKDF + AES-GCM trials. At a generous 10^12 per second that is about 10^21 years. Infeasible. |
| Active, plays the responder (answers a connecting initiator) | The same offline test on what the initiator sends, plus fresh transcripts | Same; nothing is gained over passive. |
| Active, plays the initiator against a real host | One online guess per connection | The limiter bounds it; 2^114 guesses are irrelevant. |

The four fixes the review and coordinator asked about:

- **(a) Move the PSK later (`psk2`/`psk3`).** The message-1 tag then carries no PSK, so a PASSIVE
  observer has no oracle. But every message after the PSK is keyed by it AND by DH secrets, and an
  attacker who plays the other end knows those DH secrets, so the first message the victim encrypts
  after the PSK gives an ACTIVE attacker the same offline oracle (one victim run, any number of
  offline guesses). `psk3` additionally leaves the responder's message 2 unauthenticated by the code,
  so a man in the middle without the code can pose as the host to the initiator, which `psk0`
  prevents (D-FS-2). It trades a passive oracle for an active one and weakens host authentication.
  Rejected.
- **(b) A balanced PAKE (SPAKE2, RFC 9382; CPace, draft-irtf-cfrg-cpace-21, an active IRTF draft,
  not yet an RFC).** A PAKE leaves an eavesdropper or an active attacker one guess per run, so it is
  the only choice that makes a SHORT code safe. Neither is available here: `node:crypto` has no PAKE
  and no hash-to-group primitive; the repo's crypto dependencies are `tweetnacl` and `@noble/hashes`
  (`@noble/curves` is not a dependency, and the group operations would need it); writing one by hand
  contradicts "do not roll new crypto" and OR-FS-4's "no new dependency". The PAKE-to-`XXpsk`
  composition would also be a design of its own. Not needed at 114 bits; required only if the code
  were ever shortened.
- **(c) A longer code.** 256 bits is 44 base58 characters (256 / 5.858). That meets § 14 to the
  letter and changes what the owner reads aloud: a UX change (against OR-FS-5's "flow does not
  change"). Raised as Q6.
- **(d) An unauthenticated `XX` followed by an out-of-band comparison of a short string (SAS).**
  Safe against an active attacker only if the owner compares on both machines every time; changes
  the pairing UX (a confirm step on both sides) and drops the code as an authenticator. Against
  OR-FS-5. Raised as Q6.

Conclusion (OR-FS-6): keep `XXpsk0` and the 20-character code; treat the code's ~114 bits as the
security level of PAIRING (the transport uses fresh DH only; sessions after pairing never use the
code); state the deviation from Noise § 14; validate the format so no caller can weaken it (D-FS-16);
keep a shorter code or any interactive step out of scope.

### 7.2 Invariant plan (the triple rule)

**Invariant plan.** I recommend a NEW invariant, **I5x — a LAN session's
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
- **FS-A2 replay.** Replay the recorded message 1 and then the recorded request record to a fresh
  connection. Expected, in order: message 2 arrives (a fresh `e`, different from the recording's),
  then the recorded record fails to open and the socket is closed; zero further bytes; the spy on
  `onMessage` was never called; the IP's failure count rose by one (D-FS-14). The test fails if
  the server stays silent after message 1 (that would mean it cannot open message 1). Replay a
  recorded reply to a new client: its AEAD fails.
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
- **Rekey and nonces.** `lan-noise.test.ts`: the vectors above include a transport run; a
  CipherState rekeys without resetting `n` (the next nonce continues, checked against a reference
  that rekeys at the same counts); asymmetric traffic (1,500 records one way, 20 the other) keeps both
  directions in step; a CipherState set to `n = 2^64 - 2` encrypts once and then errors, and the
  session ends.
- **Pairing PSK.** A wrong code closes at message 1 with no reply and one recorded failure; the
  window stays open; the right code completes and `consumeOpen()` closes it; two right-code initiators
  racing leave exactly one paired; `open()` and `outboundPairHandshake` reject a code that is not
  20 base58 characters; `generatePairingCode()` returns 20 base58 characters from 15 random bytes
  (entropy arithmetic pinned); a v2 pairing inserts the row at `proto_version = 2` and a second
  pairing of the same key cannot lower it.
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
every surface `audit:status-drift` scans for an invariant or rule CEILING range
(`CEILING_RANGE_SURFACES`, `scripts/structure-audit/check-status-drift.ts:80-91`): `CLAUDE.md`,
`GEMINI.md`, `docs/architecture.md`, `docs/README.md`, `docs/SECURITY-INVARIANTS.md`,
`.github/SECURITY.md`, `.coderabbit.yaml` (its `I1-I55` comment), `.claude/commands/nimbus-file-map.md`,
`.claude/commands/nimbus-commands.md` (its `D10–D45` rule range, which D4x raises) and
`.claude/commands/nimbus-tool-output-envelope.md`; the project runs `bun run audit:status-drift` and
fixes whichever of these it reports;
`docs/roadmap.md` (the row, plus an FS3 sub-row); `docs/architecture.md` (LAN transport); `docs/README.md`;
`docs/cli-reference.md` (`nimbus lan status`, `nimbus team pair`); `docs/SECURITY.md` (trust model,
residual risks); `docs/SECURITY-INVARIANTS.md`; the `nimbus-federation-identity` skill.

## 9. Failure modes

| Situation | Behaviour |
| --- | --- |
| Handshake never completes | Server closes at 10 s (D-FS-11); the client's own 5 s default applies first on its side. |
| Responder was re-installed or its identity regenerated (new static key) | IK message 1 is encrypted to the stale pin; the server cannot open it and closes silently. The client reports "closed without reply" with the hint to re-pair. This is weaker than today's explicit "pinned key mismatch" text (`lan-client.ts:288-290`), by design (D-FS-10). |
| Initiator unknown to the responder (it was removed there) | Same silent close; counted as a failure for the rate limiter. |
| Wrong pairing code | Fails at message 1 with no reply and no oracle; the failure is counted at once; the window stays open until it expires or a right code arrives. |
| Peer re-paired after removal | `removePeer` deletes the row and with it `proto_version`; a re-pairing over v2 inserts it at 2; only a legacy v1 `pair` (compat window, `min_protocol = 1`) inserts it at 1. |
| Message too large / bad record | The session ends; no partial dispatch. |
| Rekey desync (a bug) | The next record fails to open and the session ends. |
| Old peer talks to a `min_protocol = 2` gateway | Refused, counted. The old peer sees "connection closed without reply". `nimbus lan status` on the new side names the refused version count. |

## 10. Stated bounds

- Forward secrecy holds for the session's key material only while the ephemeral secrets are erased.
  JavaScript gives no guarantee: the ephemeral private keys are `KeyObject`s and buffers we overwrite
  and drop, but a copy in a heap snapshot, a swap file or a crash dump is outside this design.
- The Noise state machine is ours (D-FS-12) validated by test vectors; it has not had an external
  review. OR-FS-4 is that decision.
- The downgrade ratchet is trust-on-first-use of the v2 capability (§ 6). During the compat window a
  peer that has not completed v2 with us can be forced to v1 by anyone who can drop packets.
- Message sizes and counts are visible; records are not padded.
- The pairing code's min-entropy is about 114 bits (the generator cuts the last base58 digit,
  `lan-pairing.ts:8`; § 7.1), mixed into a PSK that Noise § 14 wants at 256. A passive recording of
  a pairing's message 1 allows an offline guess at 2^114 work; a code obtained by the attacker
  defeats pairing. Accepted by OR-FS-6.
- No clock is used, so there is no wall-clock replay window; replay is defeated structurally by the
  responder's ephemeral.
- Interop with other Noise implementations is not a goal; the prologue and the framing are
  Nimbus-specific.

## 11. Findings outside this row (recorded, not built)

- `isKnownPeer` returns `writeAllowed: false` for every peer (`federation-server.ts:107`), so
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

## 13. Owner questions, round 2 (resolved)

Q6 (the pairing code's entropy) was answered by the owner on 2026-11-12 with the recommended
option; see OR-FS-6 in § 2.

## 14. Review log

### Round 1 (Antigravity, 2026-11-12)

Applied:
- **F1 (blocker), offline dictionary risk of `psk0`:** valid in substance, wrong in size. Added § 7.1
  (the oracle exists for a passive observer; four fixes evaluated against primary sources); corrected
  the code's entropy from "about 117" to about 114 bits (the generator cuts a digit); found the
  stronger point the review missed (Noise § 14 asks for 256-bit PSKs) and raised it as Q6; added
  D-FS-16 (validate the code where it enters and where it is typed) and the bounds. Kept `XXpsk0`.
- **F2 (blocker), PairingWindow cannot supply the PSK:** valid (`code` is private; `PairingService`
  has only `consume(code)`). Added D-FS-15 (`currentPsk`, `consumeOpen`) and rewrote the XXpsk0
  failure text: a wrong code fails at message 1 and is counted there.
- **F3, ratchet on a newly paired peer:** valid. D-FS-17 and § 6: a v2 pairing inserts at 2; the
  upsert never lowers it.
- **F4, rekey details:** valid in substance. D-FS-8 rewritten: per CipherState, REKEY from Noise
  § 4.2 with `maxnonce` for AESGCM, `n` not reset, fail closed at the limit.
- **F5, FS-A2 server behaviour:** valid. Message 1 replayed does draw message 2; the replayed record
  fails to open; § 1, § 7 and § 8 corrected; D-FS-14 charges the failure.
- **F6, `LanPeerMatch` lacks `proto_version`:** valid. Required `protoVersion` field, forwarded by
  `isKnownPeer`.
- **F7, citations:** valid. Six ranges fixed (my earlier numbers came from a concatenated listing).
- **F8, `audit:status-drift` surfaces:** valid. All ten `CEILING_RANGE_SURFACES` listed in § 8; the
  four the review named and `nimbus-commands.md` (a `D10–D45` range) do carry ceilings.
- **F9, IKM encoding:** valid. UTF-8 bytes of the 20-character string (D-FS-6).

Rejected (parts of findings):
- F1's fix 2 as worded (validate the code to defeat low-entropy codes): a string cannot prove its
  entropy; I validate format and length and pin the generator instead (D-FS-16).
- F1's "117-120 bits": wrong; about 114 (§ 7.1).
- F4's quote "In both cases, Rekey does not reset the counter n ..." is not in the Noise text; the
  real sentence is in § 11.3 ("it doesn't reset the cipherstate's `n` value"). F4's "§ 11.1" for the
  counter limit is wrong too: § 11.1 is dummy keys; the limit is in § 5.1 and § 14.
- F5's expectation of "no reply" is what the spec said and the protocol does not do; I changed the
  spec, not the protocol.
- F2's remark that a wrong guess not consuming the code lets an attacker submit candidates until the
  limiter blocks: true and intended (a wrong guess must not burn the owner's window); failure is
  counted at message 1.

Round 2 (Antigravity, 2026-11-12): APPROVED. Three minor notes carried to the FS plans: (1) `sendFederatedOverWire` (`ipc/lan-client.ts`) takes the peer's recorded `protoVersion` so the initiator never sends or falls back to v1 for a ratcheted peer; (2) `PeerPairing.initiatePair` passes `protoVersion: 2` explicitly to `addLanPeer`, so the initiator's row ratchets with the responder's; (3) in the IK responder steps, decrypting message 1 rejects only malformed frames (anyone can build a valid message 1 under their own static key), and the `isKnownPeer` check on the decrypted `rs` is what rejects an unknown sender.
