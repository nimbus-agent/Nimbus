# Plan — LAN forward secrecy FS1: Noise IK sessions, the downgrade ratchet and `[lan] min_protocol`

Status: APPROVED by Antigravity (round 1, 2026-11-12).

Status: DRAFT for Antigravity review (round 1).
Spec: `docs/superpowers/specs/2026-11-12-lan-forward-secrecy.md` (approved, round 2; owner rulings
OR-FS-1 to OR-FS-6): § 1 (FS-A1 to FS-A5), § 2 (D-FS-1 to D-FS-17), § 4 (the FS1 row), § 5.3 (IK), § 5.6,
§ 6, § 7.2, § 8.
Roadmap row: Phase 10 *Core - LAN Hardening*, **LAN forward secrecy (S3-F8)** (`docs/roadmap.md:2032`).

After FS1: every federation RPC between two upgraded gateways runs in a `Noise_IK_25519_AESGCM_SHA256`
session (ephemeral DH from both sides, counter nonces, in-session rekey every 1,024 records); a recorded
session cannot be opened with the two static pairing secrets; a replayed request never executes; a peer that
completed a v2 session once is never talked to in the old static-box mode again (`lan_peers.proto_version`);
`[lan] min_protocol = 2` refuses the old mode for every peer; the old wire still works for peers that have not
upgraded (OR-FS-1). Pairing is UNCHANGED in FS1 (the plaintext `pair`/`pair_ok` frames stay; FS2 replaces them
with XXpsk0). FS1 adds one invariant (I5x), one static rule (D4x), one schema step (V9x) and one config key. It
adds no HITL type, no egress class, no IPC method and no `ALLOWED_METHODS` entry (`lan.listPeers` already
returns `SELECT *` rows, so `proto_version` appears there without a handler change).

## Numbers that are NOT fixed (the incident engine is in flight)

The incident engine reserved V94-V96, D46 and I56, and its IC1 (V94, D46(b)) is open. This plan therefore
writes **V9x (next free at merge)**, **D4x** and **I5x**, and the implementer re-derives all three on the day
of the merge, never earlier:

- **Schema.** `grep -n "CURRENT_SCHEMA_VERSION = " packages/gateway/src/index/local-index.ts` (93 at plan time,
  `:290`) and the last `simpleStep(` in `index/migrations/runner.ts` (`:784`, `92 -> 93`). The new number is
  that value plus one. If IC1 merged, it is 94 and ours is 95; if IC1 is still open and ours merges first, ours
  is 94 and IC1 renumbers (say so in the PR).
- **Static rule.** The highest `D<N>` implemented is `D45` (`scripts/structure-audit/check-nimbus-invariants.ts:2401`;
  `check-status-drift.ts` derives the ceiling from the auditor itself). IC1 adds D46. Take the next number
  after the highest `grep -nE "^// ---- D[0-9]+" scripts/structure-audit/check-nimbus-invariants.ts` shows on
  `main` at merge time (D47 if IC1 merged, else D46).
- **Invariant.** The highest `describe("I<N>` in `packages/gateway/src/security-invariants.test.ts` (I55 at
  `:13547` at plan time; I56 is reserved by the incident engine for its IC3) and the highest `## I<N>` in
  `docs/SECURITY-INVARIANTS.md` (`:1895`). Take the next free one (I56 or I57). `check-status-drift.ts` derives
  its invariant ceiling from the test file, so a number that skips the sequence fails `audit:status-drift`.
- **Every place a schema number is pinned** (all must move together; `bun run audit:status-drift` names most of
  them, `git grep -nE "V9[0-9]|schema 9[0-9]|CURRENT_SCHEMA_VERSION"` finds the rest):
  `packages/gateway/src/index/local-index.ts:290` (`CURRENT_SCHEMA_VERSION`);
  `packages/gateway/src/index/migrations/runner.ts` (the import next to `BRIEFING_V93_SQL` and the new
  `simpleStep`, after `:784`);
  `packages/gateway/src/index/migrations/runner.test.ts:825-828` (the test named "CURRENT_SCHEMA_VERSION is 93 ..."
  and its `toBe(93)`);
  a new `runner-v9x.test.ts` (modelled on `runner-v93.test.ts`) and the new DDL file `index/lan-peer-proto-v9x-sql.ts`;
  `CLAUDE.md` and `GEMINI.md` ("schema V93" in the status paragraph and in "Invariants I1-I55; schema V93");
  `docs/schema-reference.md` (the V93 entry is at `:1339`; add ours above or below by number);
  `docs/architecture.md` (a table pointer next to the V93 one, `:994`);
  `.claude/commands/nimbus-db-migrations.md` (the "Newest" line);
  `docs/CHANGELOG.md`, `docs/README.md` if it states the schema number. Unrelated `93`s stay.

## Spec corrections found while reading the code (each with evidence; binding for FS1)

1. **`nacl.box` is used in exactly one place, `ipc/lan-crypto.ts`** (`:10`, `:20`, `:37`, `:48`), and
   `federation-identity.ts` only calls `generateBoxKeypair`/`boxKeypairFromSecretKey` (`:1`, `:17`, `:20`). Spec
   § 7.2 allowed `federation/federation-identity.ts` in the D4x rule for "key creation only"; the rule can be
   tighter: the identifiers `sealBoxFrame` and `openBoxFrame` may appear only in `ipc/lan-crypto.ts` (defines)
   and `ipc/lan-legacy.ts` (the sole caller after FS1), and a `nacl.box(` / `nacl.box.open(` call only in
   `lan-crypto.ts`. `federation-identity.ts` needs no exemption.
2. **The frame cap is keyed on `peerPubkey`, not on a mode** (`lan-server.ts:160`: `cap = socket.data.peerPubkey ?
   MAX_ENCRYPTED_FRAME : MAX_HANDSHAKE_FRAME`). The v2 path has no `peerPubkey` set until after message 2 and a
   record frame is at most 65,535 bytes. Correction: `SessionState` gets an explicit `mode:
   "unknown" | "legacy" | "v2"` and `takeFrame` chooses the cap from it (4,096 before the handshake finishes,
   `MAX_ENCRYPTED_FRAME` for legacy transport, 65,535 for v2 records). `MAX_PENDING_BYTES` is unchanged.
3. **`LanPeerMatch` is built by 14 test fakes** (`isKnownPeer: () => ({ peerId, writeAllowed })` in
   `federation-rpc.edges.test.ts:71`, `lan-client.test.ts:439`, `lan-server.edges.test.ts:65,291`,
   `lan-server.test.ts:166,341,677,719,758`, `lan-server-handshake.test.ts`, `test/integration/lan/lan-rpc.test.ts:29`
   and the `null` ones). Spec § 6 makes `protoVersion` REQUIRED so a forgotten value is a type error and not a
   fail-open `1`. Cost: Task 7 step 1 edits them; no behaviour changes.
4. **The share-forward path has no `LanPeerRow`.** `assemble.ts:1374-1381` builds `{ host, port, pubkey }`
   (`ForwardPeer`, `share/share-forward.ts:6`) from a row and drops the rest; `deliverShareToPeer`
   (`assemble.ts:1364`) then calls the client with no row. The link policy needs the row's `proto_version`.
   Correction: `ForwardPeer` gains `protoVersion`, and `lookupForwardPeer` fills it.
5. **`sendFederatedOverWire` has 12 production call sites and 32 test call sites**: production in
   `ipc/federation-rpc.ts:320,425,443,457`, `federation/peer-fanout.ts:96,139,179,220`,
   `engine/delegated-request-remote.ts:37`, `platform/assemble.ts:1364`; the agents and `agents-rpc.ts` only pass
   the injected function through. Tests: `federation-server.test.ts` (7), `lan-client.test.ts` (12),
   `lan-client.edges.test.ts` (1), `test/e2e/share-forward-e2e.test.ts` (3), and four integration files (9).
   Correction (the coordinator's round-2 note): the function takes a REQUIRED trailing `link: LanLink`; the legacy
   body moves to `lan-legacy.ts` as `sendFederatedLegacy` with the OLD signature, and the legacy-wire tests
   (`lan-client.test.ts`, `lan-client.edges.test.ts`) import that, so they keep pinning the old bytes.
6. **A v1 `pair` for an already-ratcheted key is a downgrade of pairing** and spec § 6 is silent on it (it covers
   `hello`). The v1 `pair` path inserts through `registerPeer` -> `addLanPeer`, whose upsert does not touch
   `proto_version`, so a re-pair would not LOWER the version, but a v1 pair would still replace the stored
   address and direction of a v2 peer using the plaintext code. Decision for FS1 (flagged in Risks): the legacy
   `pair` path refuses a pubkey whose row is at `proto_version = 2` (closed with `pair_err`, a counted failure).
7. **Spec D-FS-11 (10 s handshake deadline) applies to the legacy path too.** The timer is armed in `open`
   (`lan-server.ts:69-75`), cleared when the session leaves the handshake (legacy: `peerPubkey` set after
   `pair_ok`/`hello_ok`; v2: message 2 sent), and closes the socket otherwise. Existing legacy tests that idle a
   socket (e.g. `lan-server.test.ts` "permits a small declared length without closing") run well under 10 s; the
   timer is injectable (`handshakeDeadlineMs` option, default 10,000) so tests use a short one.
8. **The D-FS-14 failure counter has no post-handshake hook today** (`lan-server.ts:267-271` ends the socket on
   a failed open and never calls `rateLimit.recordFailure`). FS1 adds the call for the v2 path ONLY; the legacy
   path stays byte-for-byte (its tests pin it). Replays of v1 frames stay free; that is the compat window's
   stated bound.
9. **`last_seen_at` is never written** (no `UPDATE lan_peers SET last_seen_at` exists). Not in FS1's scope;
   noted so nobody uses it as a "peer is active" signal in `nimbus lan status` (FS2).

## Design decisions (all FS1)

- **Files.** New: `ipc/lan-noise.ts` (Noise from primitives), `ipc/lan-session.ts` (records, chunking, rekey
  wiring, the responder and initiator drivers), `ipc/lan-legacy.ts` (the v1 box path, moved), `federation/lan-link.ts`
  (building a `LanLink` from a row and the config), `index/lan-peer-proto-v9x-sql.ts`, the vector fixture and
  the tests. Changed: `ipc/lan-server.ts`, `ipc/lan-client.ts`, `ipc/lan-crypto.ts` (unchanged functions, header
  comment only), `federation/federation-server.ts`, `index/local-index.ts`, `config/nimbus-toml.ts`,
  `platform/assemble.ts` and the call sites in Task 8.
- **Noise engine scope.** FS1 implements exactly what IK needs: `HashState`/`SymmetricState`, `CipherState` with
  AES-256-GCM, a pre-message `s`, the tokens `e s ee es se ss`, `Split()`, `Rekey()`, the handshake hash. No
  `psk` token (FS2). The pattern table is a data structure so FS2 adds `XXpsk0` as a row plus the `psk` token
  without touching the engine's shape. Ephemeral keys come from an injected `generateEphemeral` (default random)
  so the vectors can pin them; `lan-session.ts` never passes one (pinned by a test and by D4x).
- **Primitives (`node:crypto` only, checked on Bun 1.3.14 / Windows while drafting the spec):** X25519 through
  `diffieHellman` with keys built from raw 32-byte values by JWK (`{ kty: "OKP", crv: "X25519", d, x }`; a
  tweetnacl box secret is a valid X25519 scalar and gives the same shared secret as `nacl.scalarMult`);
  SHA-256 and HMAC-SHA256 (`createHash`, `createHmac`) for Noise's HKDF (Noise § 4.3: HMAC with the chaining key
  as salt; temp_key = HMAC(ck, ikm); out1 = HMAC(temp_key, 0x01); out2 = HMAC(temp_key, out1 || 0x02));
  `aes-256-gcm` through `createCipheriv`/`createDecipheriv` with a 12-byte nonce of 4 zero bytes and the
  big-endian counter (Noise § 12.4). ChaCha20-Poly1305 is NOT available in this Bun (`ERR_CRYPTO_UNKNOWN_CIPHER`).
  All-zero DH outputs are rejected (RFC 7748 § 6.1: a contributory-behaviour check; Node's `diffieHellman`
  throws or returns zeros depending on version, so `lan-noise.ts` checks the 32 bytes itself).
- **Wire.** First frame body `0x4E 0x4C 0x02 0x01 || noise message 1` (spec D-FS-9); later frames are bare
  Noise messages; frame = `u32 length || body` (the existing 4-byte big-endian length, `lan-server.ts:153-172`,
  `lan-client.ts:55-62`). Record plaintext = `flag(1) || chunk` (spec D-FS-5), `chunk <= 65,518`.
- **Server decision order** (spec § 5.3, one named step per line in the code, not helpers a reader must hunt for):
  rate limiter `checkAllowed(ip)`; open message 1 (a malformed or undecryptable message closes with no reply and
  counts a failure); `isKnownPeer(rs)` (unknown: same); `min_protocol`; send message 2; session `peerMatch` set;
  records read; a record that does not open counts a failure and ends the session; `checkLanMethodAllowed` before
  `onMessage` exactly as now (`lan-server.ts:290`).
- **Client policy (`LanLink`).** `{ known: 1 | 2; minProtocol: 1 | 2; onNegotiated?: (v: 1 | 2) => void }`.
  `known = 2` -> v2 only, never legacy (D-FS-13). `known = 1` -> v2 first; if it fails with "closed without
  reply" (an old server) or a handshake timeout AND `minProtocol = 1`, one legacy retry; a v2 success calls
  `onNegotiated(2)`, which the call site wires to `LocalIndex.markLanPeerProto`. A v2 failure that is NOT one of
  those two (a bad record, a protocol error) never falls back.
- **Ratchet.** `LocalIndex.markLanPeerProto(pubkey, version)` is the only writer of `proto_version` in FS1,
  monotonic (`UPDATE lan_peers SET proto_version = MAX(proto_version, ?) WHERE peer_pubkey = ?`). FS2 adds the
  insert-at-2 for a v2 pairing (D-FS-17).
- **Config.** `[lan] min_protocol = 1 | 2`, default 1 (OR-FS-1); any other value is ignored (the default holds),
  like the neighbouring keys in `applyNimbusLanKey` (`config/nimbus-toml.ts:899-932`).
- **`lan-crypto.ts` stays** (it is the legacy primitive and `federation-identity.ts` still creates identity keys
  through it); its header comment says the box functions are legacy-only (D4x).

## File map

| File | Change |
| --- | --- |
| `packages/gateway/src/ipc/lan-noise.ts` + `.test.ts` | new: the Noise engine (IK) |
| `packages/gateway/test/fixtures/noise/noise-ik-25519-aesgcm-sha256.vectors.json` | new: vendored vectors with a `_source` header |
| `packages/gateway/src/ipc/lan-session.ts` + `.test.ts` | new: records, chunking, rekey, drivers |
| `packages/gateway/src/ipc/lan-legacy.ts` + `.test.ts` | new: the v1 handshake and box transport moved verbatim |
| `packages/gateway/src/ipc/lan-server.ts` | changed: mode dispatch, v2 path, deadline, ratchet, `protoVersion` |
| `packages/gateway/src/ipc/lan-client.ts` | changed: `sendFederatedOverWire(... , link)` front, `outboundPairHandshake` unchanged |
| `packages/gateway/src/federation/lan-link.ts` + `.test.ts` | new: `lanLinkFor(row, cfg, index)` |
| `packages/gateway/src/federation/federation-server.ts` | changed: `isKnownPeer` forwards `protoVersion`; `minProtocol` option |
| `packages/gateway/src/index/lan-peer-proto-v9x-sql.ts` | new: the column |
| `packages/gateway/src/index/migrations/runner.ts`, `runner.test.ts`, `runner-v9x.test.ts` | changed / new |
| `packages/gateway/src/index/local-index.ts` | changed: `CURRENT_SCHEMA_VERSION`, `LanPeerRow.proto_version`, `markLanPeerProto` |
| `packages/gateway/src/config/nimbus-toml.ts` (+ its test) | changed: `minProtocol` |
| `packages/gateway/src/platform/assemble.ts`, `share/share-forward.ts` | changed: link wiring, `ForwardPeer.protoVersion` |
| `packages/gateway/src/ipc/federation-rpc.ts`, `federation/peer-fanout.ts`, `engine/delegated-request-remote.ts` | changed: pass a `LanLink` |
| `scripts/structure-audit/check-nimbus-invariants.ts` (+ test) | changed: rule D4x |
| `packages/gateway/src/security-invariants.test.ts`, `docs/SECURITY-INVARIANTS.md` | changed: invariant I5x |

## Tasks (test first; red-prove every guard by reverting the production line and watching the test fail)

### Task 0 - Preconditions

1. A NEW implementation worktree from current `main`, never the spec branch and never nested:
   `git -C C:\gitrep\Nimbus worktree add C:\gitrep\Nimbus\.claude\worktrees\p10-fs1 -b dev/asaf/p10-fs1 main`.
   Verify `git rev-parse --abbrev-ref HEAD` before EVERY commit. The spec and this plan are STRIPPED before the
   PR (specs and plans never land on main). The main checkout `C:\gitrep\Nimbus` is on a stale branch: never
   read code from it.
2. `bun install`; on Windows `pwsh -NoProfile -File ./scripts/build-sandbox-helper-win32.ps1` (a fresh worktree
   has no helper). Editor diagnostics in a fresh worktree are stale: trust `bun run typecheck`.
3. Re-derive V9x, D4x and I5x (the section above) and write them at the top of your working notes. Re-run
   `git grep -n "proto_version" -- packages` (expected: nothing) and `git grep -n "min_protocol" -- packages`
   (expected: nothing).
4. Re-confirm on the Bun the repo CI uses (1.4, `.github/actions/setup-nimbus-ci/action.yml`) what the spec
   checked on 1.3.14: `aes-256-gcm`, X25519 `diffieHellman`, JWK import of a raw X25519 key. A throwaway script
   in the scratchpad, not the repo. If ChaCha20 is available on 1.4 it changes nothing (the suite stays AESGCM).

### Task 1 - The Noise test vectors (before any engine code)

Files: `packages/gateway/test/fixtures/noise/noise-ik-25519-aesgcm-sha256.vectors.json` (new),
`packages/gateway/test/fixtures/noise/PROVENANCE.md` (new, a few lines: source, licence, retrieval date, filter).

1. Source. The Noise project's published vectors in the Noise wiki format: `vectors/cacophony.txt` in
   `centromere/cacophony` (licence: The Unlicense) and `tests/vectors/snow.txt` in `mcginty/snow` (Apache-2.0 OR
   MIT). Fetch the raw files, keep ONLY entries whose `protocol_name` is `Noise_IK_25519_AESGCM_SHA256`
   (several entries; both files carry the fixed `init_ephemeral`/`resp_ephemeral` the engine needs). **Verify
   before building on it**: I could not confirm from the repository pages that either file contains an
   IK + AESGCM + SHA256 entry (the cacophony page lists IK, AESGCM and SHA256 as supported, XXpsk0 not at
   all). Count the entries after filtering. If neither file has one, STOP and take the third source: generate
   the vectors with the MIT-licensed Python package `noiseprotocol` pinned to an exact version, with fixed
   ephemeral keys, using a generator script committed under `scripts/` (not shipped), and say so in the
   fixture's `_source`. Do not start Task 2 without at least two independent entries with at least two transport
   messages each (so rekey-free transport and the handshake hash are both covered).
2. Shape of the committed file: `{ "_source": "...", "_licence": "...", "_retrieved": "2026-11-xx",
   "_filter": "protocol_name == Noise_IK_25519_AESGCM_SHA256", "vectors": [ ... ] }`, each vector keeping the
   upstream field names unchanged (`protocol_name`, `init_prologue`, `init_static`, `init_ephemeral`,
   `init_remote_static`, `resp_prologue`, `resp_static`, `resp_ephemeral`, `handshake_hash`, `messages` with
   `payload` and `ciphertext`; all hex). Open the real file and use ITS field names; the list above is the
   documented wiki format.
3. How tests load it: `join(import.meta.dir, "..", "..", "test", "fixtures", "noise", "<file>")` and
   `JSON.parse(readFileSync(...))` (the repo already reads files relative to `import.meta.dir` in tests, e.g.
   `src/audit/format-audit-payload.test.ts:243`). A `src` test reading a file under `test/` is fine; only
   `test/**` TESTS are not loaded by a `src` run.
4. `bun run audit:js-licenses` is about dependencies and is unaffected; the Unlicense/Apache/MIT notice lives
   in `PROVENANCE.md`.

### Task 2 - The engine `ipc/lan-noise.ts`

Files: `ipc/lan-noise.ts` (new), `ipc/lan-noise.test.ts` (new).

1. `lan-noise.test.ts` first. Cases (all RED: the module does not exist):
   - For each vector: build the initiator and responder `HandshakeState` from the vector's keys with
     `generateEphemeral` injected to return the vector's ephemeral; run the three messages (initiator message 1
     with the vector's first payload, responder message 2, then transport) and assert each ciphertext equals the
     vector's, each side's handshake hash equals `handshake_hash`, and each transport message decrypts to the
     vector's payload on the other side.
   - `Split()` gives two CipherStates whose directions are not interchangeable (a message sealed by the
     initiator's send state does not open under its own receive state).
   - `CipherState`: the nonce is `00 00 00 00 || n` big-endian; `n` increments per call and is NOT reset by
     `rekey()` (assert the next nonce continues); `rekey()` equals the first 32 bytes of
     `ENCRYPT(k, 2^64-1, empty, 32 zero bytes)` (spec D-FS-8; compute the reference independently in the test
     with `createCipheriv`); a CipherState constructed with `n = 2^64 - 2` encrypts once and then throws a fixed
     `Error` (Noise § 5.1), and `decrypt` likewise.
   - A tampered ciphertext, a wrong AD, a wrong key and a truncated message (< 16 bytes) all throw the SAME
     fixed message (no oracle on which).
   - An all-zero DH result (a low-order point as the peer's static key or ephemeral) is refused.
   - A message longer than 65,535 bytes is refused by the engine (Noise § 3).
   - `readFileSync` of the fixture proves the file is not empty (`vectors.length >= 2`) so a missing fixture
     cannot make the vector test vacuous.
   Run `bun test packages/gateway/src/ipc/lan-noise.test.ts`: expected RED.
2. `lan-noise.ts`. Exports `generateStaticFromBox(secret32)` -> `{ publicKey, secretKey }` helpers are NOT
   needed (the identity is already a `BoxKeypair`); export `x25519(secretKey, publicKey)` (JWK construction,
   zero check), `class CipherState { constructor(key | undefined); encryptWithAd; decryptWithAd; rekey;
   hasKey }`, `class SymmetricState`, `class HandshakeState` and a `PATTERNS` table with the single row `IK`
   (`preMessages`, `messages` as token lists). `HandshakeState.writeMessage(payload)` / `readMessage(bytes)` /
   `split()` / `handshakeHash()` / `remoteStatic()`. Errors are fixed strings (no `err instanceof Error ?`
   ternaries, no `??` defaults that no test reaches; see Task 12). Ephemeral secrets and the handshake's
   transient buffers are overwritten with `fill(0)` after `split()` (best effort; spec § 10 states the bound).
3. GREEN: the file's own tests. Then `bun test packages/gateway/src/ipc/lan-noise.test.ts --coverage` locally to
   see unhit branches (the floor is Task 12).
4. Red-prove: change `00 00 00 00 || n` to a little-endian counter, watch the vector test fail; make `rekey()`
   reset `n`, watch the continuation test fail; remove the zero-DH check, watch that test fail.

### Task 3 - Records and sessions `ipc/lan-session.ts`

Files: `ipc/lan-session.ts` (new), `ipc/lan-session.test.ts` (new).

1. Tests first (in-memory, no sockets; the drivers take byte arrays and return byte arrays):
   - A request of N bytes is split into records of at most 65,518 plaintext bytes, flag `0x00` on all but the
     last and `0x01` on the last, and reassembles to the same bytes; N = 0, 1, 65,518, 65,519, 4 MiB exactly all
     round-trip; N = 4 MiB + 1 is refused with a fixed error BEFORE it is buffered whole (the reassembler
     counts as it goes).
   - A final record followed by more data in the same logical message, a record with a flag other than 0/1, an
     empty record and a record that fails to open each throw a fixed error that ends the session.
   - Rekey: send 2,100 records through a pair of sessions; both sides stay in step; assert the sender's key
     changed after record 1,024 and 2,048 (observable through a test-only `keyFingerprint()` that returns a
     SHA-256 of the key, NOT the key) and that a receiver which is told to skip the rekey fails at record
     1,025. Asymmetric traffic: 1,500 records one way and 20 the other; each direction rekeys on its own
     counter (spec D-FS-8).
   - A copy of the session that saw only the first 1,000 records cannot open record 1,030 after the rekey
     happened (one-way rekey).
   Run: RED.
2. `lan-session.ts`: `createResponderHandshake(opts)` and `createInitiatorHandshake(opts)` wrapping
   `HandshakeState` with the prologue `"nimbus-lan/2" || 0x02 || 0x01`, the first-frame header
   (`encodeFirstFrame` / `decodeFirstFrame`, rejecting any other magic, version or pattern byte), the
   `Session` class (`sealMessage(bytes): Uint8Array[]`, `openRecord(bytes): Uint8Array | undefined` that
   returns the whole message on the final record, the 4 MiB cap, the rekey at `n % 1024 === 0` after the
   operation, per CipherState). No socket code here: `lan-server.ts` and `lan-client.ts` own the sockets. The
   rekey interval is one named constant, `REKEY_EVERY_RECORDS = 1024` (OR-FS-3).
3. GREEN, then red-prove the rekey boundary (change `1024` to `1025` on one side).

### Task 4 - Schema V9x and the ratchet writer

Files: `index/lan-peer-proto-v9x-sql.ts` (new), `index/migrations/runner.ts`, `index/local-index.ts`,
`index/migrations/runner.test.ts`, `index/migrations/runner-v9x.test.ts` (new).

1. `runner-v9x.test.ts` first, modelled on `runner-v93.test.ts`:
   - a database migrated to `CURRENT_SCHEMA_VERSION - 1` with one `lan_peers` row (inserted through the
     pre-migration shape) then to current gains `proto_version INTEGER NOT NULL DEFAULT 1`, the existing row
     reads 1, and `PRAGMA user_version` equals `CURRENT_SCHEMA_VERSION`, which equals
     `maxRegisteredIndexedSchemaVersion()` and is `>= V9x`;
   - the column's `PRAGMA table_info` entry (type, notnull, dflt_value `1`);
   - re-running the step is idempotent: SQLite has no `ADD COLUMN IF NOT EXISTS`, so the step is written the
     way the existing additive column steps are: read `index/body-store-v48-sql.ts`,
     `index/connector-depth-v21-sql.ts` and `index/connector-configured-v56-sql.ts` for the DDL, and the
     `personTableHasColumn`-style probe at `index/migrations/runner.ts:135-140` for how a step skips a column that
     already exists; copy that guard, do not invent one.
   - `LocalIndex.markLanPeerProto(pubkey, 2)` raises 1 to 2, a later `markLanPeerProto(pubkey, 1)` leaves 2
     (monotonic), an unknown pubkey is a no-op, and `getLanPeerByPubkey` returns `proto_version`.
   Expected RED.
2. DDL file, `runner.ts` import and `simpleStep(<prev>, <V9x>, "lan peer protocol version (Phase 10 FS1)", ...)`
   after the last step; `local-index.ts`: `CURRENT_SCHEMA_VERSION = <V9x>`, `LanPeerRow.proto_version: number`
   (`:278-288`), `markLanPeerProto` next to `addLanPeer` (`:929`) through `dbRun` (I14) with bound parameters
   (I9). `addLanPeer`'s upsert (`:938-950`) is NOT changed in FS1 (FS2 adds `protoVersion`, D-FS-17).
3. `runner.test.ts:825-828`: the test name and its `toBe(...)` move to the new number. Then
   `git grep -nE "(toBe|toEqual)\(9[0-9]\)|user_version: 9[0-9]"` over `packages/` and `scripts/` and fix real pins.
4. GREEN: the new test, then `bun test packages/gateway/src/index`. `bun run audit:status-drift` is RED until the
   docs task; note it.

### Task 5 - Config `[lan] min_protocol`

Files: `config/nimbus-toml.ts`, its test file (find it with `git grep -ln "parseNimbusLanToml" -- packages`).

1. Tests first: default `minProtocol === 1`; `min_protocol = 2` -> 2; `1` -> 1; `3`, `0`, `"two"`, a float and an
   empty value leave the default (never clamped); the key is not an env override (`config-env-overrides.ts:28`
   handles only `lan.port`; do not add one in FS1).
2. `NimbusLanToml.minProtocol: 1 | 2` (`:881-888`), `DEFAULT_NIMBUS_LAN_TOML.minProtocol = 1` (`:890-897`),
   `applyNimbusLanKey` case `"min_protocol"` (`:899`). `config-explain.ts:103` already loads the `lan` section, so
   `nimbus config explain` needs no registration; run `bun test packages/gateway/src/config` to prove it.
3. `docs/cli-reference.md` configuration table row (Task 13).

### Task 6 - Move the v1 path to `ipc/lan-legacy.ts` (no behaviour change)

Files: `ipc/lan-legacy.ts` (new), `ipc/lan-server.ts`, `ipc/lan-client.ts`, `ipc/lan-legacy.test.ts` (new, small).

This task changes NO bytes on the wire and NO test expectation. It exists so Task 7 adds the v2 path beside a
legacy path that a test run proves untouched.

1. Run the legacy suites and record the baseline: `bun test packages/gateway/src/ipc/lan-server.test.ts
   packages/gateway/src/ipc/lan-server.edges.test.ts packages/gateway/src/ipc/lan-server-handshake.test.ts
   packages/gateway/src/ipc/lan-client.test.ts packages/gateway/src/ipc/lan-client.edges.test.ts
   packages/gateway/src/ipc/lan-crypto.test.ts packages/gateway/test/integration/lan/lan-rpc.test.ts`.
2. Move, verbatim: the server's `handleHandshake` (`lan-server.ts:174-255`) and `handleEncryptedMessage`
   (`:257-307`) into `lan-legacy.ts` as functions taking the `Socket<SessionState>`, the options and a small
   `LegacyHost` interface (`writeFrame`, `end`); the client's `exchangeHelloThenRpc` (`lan-client.ts:182-261`)
   and the body of `sendFederatedOverWire` (`:264-310`) as `sendFederatedLegacy` with its ORIGINAL signature.
   `lan-server.ts` keeps `LanServer`, the framing and the pairing/rate-limit interfaces; it calls
   `legacyHandleHandshake` and `legacyHandleEncrypted`. `lan-client.ts` keeps `exchangeOneFrame`,
   `makeFrameReader`, `buildFrame`, `writeFrame`, `replyKindForMessage` and `outboundPairHandshake`
   (pairing is unchanged in FS1) and, for now, re-exports `sendFederatedLegacy as sendFederatedOverWire` so
   nothing else changes yet.
3. After this task `sealBoxFrame`/`openBoxFrame` are imported ONLY by `lan-legacy.ts`
   (`git grep -n "sealBoxFrame\|openBoxFrame" -- packages/gateway/src` outside tests and `lan-crypto.ts`).
4. GREEN: the same command as step 1, identical results. Commit this task alone.

### Task 7 - The v2 path in `LanServer`

Files: `ipc/lan-server.ts`, `ipc/lan-server.v2.test.ts` (new), the 14 test fakes of correction 3.

1. First edit the fakes: every `isKnownPeer` that returns a match gains `protoVersion: 1` (a helper
   `legacyMatch(peerId, writeAllowed)` in a shared test helper is acceptable); `bun run typecheck` is RED until
   Task 7 step 3 adds the required field, so do steps 1 and 3 together.
2. `lan-server.v2.test.ts` first (real `LanServer` on an ephemeral loopback port, a raw `Bun.connect` client that
   speaks v2 through `lan-session.ts`; the vectors cover the cryptography, these cover the server):
   - a known peer completes IK, sends a `federation.*`-shaped request, gets the reply; `onMessage` receives the
     method, params and the `LanPeerMatch` with `protoVersion` as the store gave it;
   - the order of checks: a locked-out IP gets NO bytes back and no DH is performed (spy on a `x25519` counter
     injected through the server's options or measured via the injected `generateEphemeral` not being called);
     a message 1 that does not open: closed, no reply, `recordFailure` once; an unknown initiator: same;
   - FS-A2 server half: replay a recorded message 1, read message 2 (assert the responder ephemeral differs
     from the recording's), replay the recorded request record, assert the socket closes, zero further bytes,
     `onMessage` NOT called, `recordFailure` called once (D-FS-14);
   - `checkLanMethodAllowed` still runs: `vault.list` and a write method without the grant are refused over v2
     with the same `ERR_` codes as `lan-server.test.ts:181,192`, and the denylist call precedes `onMessage`;
   - the first byte `0x7B` still runs the legacy path; a first byte that is neither `0x7B` nor `0x4E 0x4C 0x02`
     closes and counts a failure; version `0x03` and pattern `0x07` close and count;
   - `minProtocol: 2` makes a legacy `hello` and a legacy `pair` close with no reply, counted; a v2 session
     still works;
   - the ratchet: a legacy `hello` from a pubkey whose match has `protoVersion: 2` is refused (correction 6
     adds: so is a legacy `pair` for it) with `minProtocol: 1`; from `protoVersion: 1` it still works;
   - the deadline: a socket that connects and sends nothing, or only half of message 1, is closed at
     `handshakeDeadlineMs` (a short injected value, not a fake clock around `setTimeout`), and counted; a
     completed v2 session is NOT closed by the timer, nor is a completed legacy one;
   - frame caps by mode: a v2 record header declaring more than 65,535 bytes closes without a failure count
     (as `lan-server.test.ts:330` does for legacy); the first-frame cap stays 4,096.
   Run: RED.
3. Implement in `lan-server.ts`: `SessionState.mode`, the first-byte dispatch in `handleChunk` (`:113-132`)
   replacing the `peerPubkey` test at `:126`, `takeFrame` cap by mode (`:153-172`), a `handleV2Handshake` and
   `handleV2Record` written as the numbered ordered steps of the plan's decision order (one function per PHASE,
   each step a visible line, as the I35 notes advise), the deadline timer (armed in `open`, cleared at the end of
   the handshake and on close), `LanPeerMatch.protoVersion: 1 | 2` (required, `:30-33`),
   `LanServerOptions.minProtocol` (default 1) and `handshakeDeadlineMs` (default 10,000), `recordFailure` on a
   failed v2 record. The legacy ratchet check goes in `lan-legacy.ts`'s hello handler as one function,
   `legacyAllowedFor(match, minProtocol)` (the I5x wiring site), called BEFORE `hello_ok` is written.
4. GREEN: `lan-server.v2.test.ts`, then the Task 6 baseline command unchanged except for the fake edits.
5. Red-prove: remove the `recordFailure` on a failed record (D-FS-14 test fails); invert the ratchet comparison
   (the downgrade test fails); let the timer clear itself on `open`, not on handshake completion (deadline test
   fails).

### Task 8 - The client front, the `LanLink`, and every call site

Files: `ipc/lan-client.ts`, `federation/lan-link.ts` (new) + test, `ipc/federation-rpc.ts`,
`federation/peer-fanout.ts`, `engine/delegated-request-remote.ts`, `platform/assemble.ts`,
`share/share-forward.ts`, and the 32 test call sites of correction 5.

1. Tests first:
   - `lan-client.v2.test.ts` (new): against the real `LanServer` with a known peer: `known: 2` completes IK and
     returns the result; `known: 1, minProtocol: 1` against a server running the legacy path only (a
     `LanServer` with a test switch that rejects v2 first frames the way an OLD server does, by closing on
     non-JSON) tries v2, sees the close, retries once in legacy and succeeds, and `onNegotiated` was NOT called;
     the same against a v2 server calls `onNegotiated(2)` once; `known: 1, minProtocol: 2` against the old
     server fails with a fixed message and makes no legacy connection (assert the old-server stub saw exactly
     one connection); `known: 2` against a server that kills the v2 attempt mid-handshake does NOT fall back
     (FS-A3: assert one connection and a rejected promise); a v2 failure that is a bad record never falls back;
     the responder's static key is the pinned one by construction (IK: a wrong pin makes message 1 unreadable
     and the call fails with the "no reply: the peer may have been re-paired or reset" text, spec § 9) and the
     old explicit "does not match pinned peer key" error stays only on the legacy path;
   - `lan-link.test.ts`: `lanLinkFor(row, cfg, index)` returns `known` from `row.proto_version`, `minProtocol`
     from the config, and an `onNegotiated` that calls `index.markLanPeerProto(row.peer_pubkey, v)` (real
     SQLite, real row); `known` never goes down.
   Run: RED.
2. `sendFederatedOverWire(host, port, selfKp, peerPubkey, method, params, timeoutMs, link)` in `lan-client.ts`:
   the REQUIRED trailing `link: LanLink`; the v2 client (connect, send `encodeFirstFrame(msg1)`, read message 2
   under `MAX_HANDSHAKE_FRAME`, `split()`, send the request records, read records until the final one under the
   65,535 cap, close); the policy of "Design decisions". `outboundPairHandshake` is untouched. Remove the
   temporary re-export from Task 6.
3. Call sites, one commit each group, each building the link from the row it already holds:
   `ipc/federation-rpc.ts:320` (`fetchSlice`: take the `row`, not `host, port, pubkey`), `:425`, `:443`, `:457`
   (`requireAskTarget` returns the row); `federation/peer-fanout.ts:96,139,179,220` (`row`);
   `engine/delegated-request-remote.ts:37` (`row` at `:30`); `platform/assemble.ts:1364` (`deliverShareToPeer`
   receives `ForwardPeer`, which gains `protoVersion` at `share/share-forward.ts:6` and is filled at
   `assemble.ts:1374-1381`) -- there the `onNegotiated` writes through `localIndex`. The deps types that carry
   `sendOverWire` (`peer-fanout.ts:15`, `agents/_lib/fanout-deps.ts:13`, the agents, `agents-rpc.ts:80`,
   `federation-rpc.ts:64`, `delegated-request-remote.ts:12`) are `typeof sendFederatedOverWire` and pick the
   new parameter up with no edit; fakes with fewer parameters stay assignable. The LAN config for `minProtocol`
   reaches the client side through one object built where `lanCfg` is loaded (`assemble.ts:1445`) and passed to
   the sites that need it (`ctx.lanMinProtocol` in `FederationRpcContext`, a `deps.minProtocol` in
   `PeerFanoutDeps`, in `DelegatedRequestRemoteDeps`); list them in the PR.
4. Test call sites: the legacy-wire tests (`lan-client.test.ts`, `lan-client.edges.test.ts`) import
   `sendFederatedLegacy` (no behaviour or expectation change); `federation-server.test.ts`, the four integration
   files and the e2e file call `sendFederatedOverWire` with `{ known: 1, minProtocol: 1 }` so they exercise the
   negotiation against real servers (FS-A5).
5. GREEN: the new tests, the Task 6 baseline, then `bun test packages/gateway/src/federation
   packages/gateway/src/ipc packages/gateway/src/engine`.

### Task 9 - Server wiring and the config

Files: `federation/federation-server.ts`, `platform/assemble.ts`, their tests.

1. Tests first (`federation-server.test.ts` additions): `isKnownPeer` returns the row's `proto_version` as
   `protoVersion`; a server built with `lan.minProtocol: 2` refuses a legacy `hello` from a real gateway client
   pair end to end; the `buildFederationLanServer` signature carries `minProtocol` and defaults to 1.
2. `federation-server.ts:105-108`: `return row === undefined ? null : { peerId: row.peer_id, writeAllowed: false,
   protoVersion: row.proto_version === 2 ? 2 : 1 }`. (`writeAllowed: false` is the existing behaviour, spec § 11;
   do not touch it.) `FederationLanConfig` (`:37-43`) gains `minProtocol`; `assemble.ts:1503-1507` passes
   `lanCfg.minProtocol`.
3. `bun test packages/gateway/src/federation packages/gateway/test/integration/federation
   packages/gateway/test/integration/teamvault packages/gateway/test/e2e/share-forward-e2e.test.ts` (FS-A5: query,
   invoke, delegated approval, quorum, team vault and share forward over the new transport).

### Task 10 - The acceptance tests (FS-A1 to FS-A4)

Files: `packages/gateway/src/ipc/lan-forward-secrecy.test.ts` (new), reused by the invariant block of Task 11.

1. `RecordingProxy` (test helper in the same file): a loopback TCP relay that stores every byte of both
   directions per connection.
2. FS-A1: real `LanServer` + the real client through the proxy; one request/response; then `attack(transcript,
   secrets)` is given BOTH static secret keys, the full transcript and nothing else, and tries (a) the legacy
   `openBoxFrame` on every record body in both key orders (4 combinations), (b) a re-derivation of the Noise key
   schedule that computes every DH output EXCEPT `ee` (it has `s_i`, `s_r`, `e_i` public and `e_r` public), then
   AES-GCM-opens every record with each candidate key. None opens. Positive control: the same routine is given the
   test-injected ephemeral secret (the test constructs the session with `generateEphemeral` returning a known key)
   and the first record opens; the test asserts that, so a broken attacker routine fails the test rather than
   passing it (the `tests-that-cannot-fail` rule).
3. FS-A2: client half: a recorded reply replayed to a NEW client session fails to open; server half is in Task 7.
4. FS-A3: end to end: after one v2 session the row is at 2 (real SQLite via `lanLinkFor`); a legacy `hello` for
   that pubkey is then refused; `known: 2` does not fall back; `min_protocol = 2` refuses every legacy first
   frame.
5. FS-A4: an old-style server (legacy path only, built from `lan-legacy.ts`'s handlers) with a new client, and a
   new server with `legacyHelloClient` (the Task 6 legacy client), both directions, `minProtocol = 1`.
6. Each of these goes in the invariant block of Task 11 by import, not by copy.

### Task 11 - Invariant I5x and static rule D4x (the triple)

Files: `packages/gateway/src/security-invariants.test.ts`, `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md` +
`GEMINI.md`, `scripts/structure-audit/check-nimbus-invariants.ts` + its test, the `nimbus-security-invariants`
skill text.

1. Statement (final text in the invariants doc, spec § 7.2): *a LAN session's records are encrypted only under
   keys derived by `ipc/lan-session.ts` from `ipc/lan-noise.ts` after an exchange with an ephemeral DH from each
   side; the static identity key never encrypts a record; the v1 box path is reachable only through
   `ipc/lan-legacy.ts`, never for a peer whose recorded protocol is 2 and never under `min_protocol = 2`.*
   Wiring: `ipc/lan-server.ts` and `ipc/lan-client.ts` call `lan-session.ts` for every non-legacy frame; the
   downgrade check is one function, `lan-legacy.ts` `legacyAllowedFor`.
2. Runtime block `describe("I5x - ...")` in `security-invariants.test.ts`: FS-A1 (with the positive control),
   FS-A2, FS-A3 by import from `lan-forward-secrecy.test.ts`; a by-name test that a legacy `hello` from a
   ratcheted pubkey gets no `hello_ok`; a source pin that `lan-server.ts` and `lan-client.ts` do not import
   `lan-crypto.ts` at all after Task 6, and that `lan-session.ts` passes no `generateEphemeral` argument.
3. Static rule D4x, written as what CANNOT pass (the static-guard notes): in non-test gateway files other than
   `ipc/lan-crypto.ts` and `ipc/lan-legacy.ts`, the identifiers `sealBoxFrame` and `openBoxFrame` and the member
   calls `nacl.box(` and `nacl.box.open(` are violations; matched as words after comments and string literals
   are stripped (the helper D33(c) uses), so an aliased import is caught. Stated bound (the same as D33(c)): a
   dynamically composed call evades a text scan, and a second use inside `lan-legacy.ts` is exempt whole-file.
   Add `check-nimbus-invariants.test.ts` fixture-tree cases (a violating `federation/x.ts`, an aliased import,
   a comment-only mention that passes, the allowed files passing) modelled on the D45 block
   (`check-nimbus-invariants.test.ts:5781`); the rule itself follows the D45 shape at
   `check-nimbus-invariants.ts:2401-2434`. After FS3 the allowance for `lan-legacy.ts` is deleted with the file.
4. Docs: a `## I5x` section and a `## D4x` section in `docs/SECURITY-INVARIANTS.md` (Statement, Why, Stated
   bounds, Enforcement), the "Current ceiling" line (`:3`) moves to the new `I1-I5x` / `D10-D4x`, and CLAUDE.md /
   GEMINI.md gain the one-line entry. `audit:status-drift` and `audit:invariants` pass.
5. Red-prove the rule: add `import { sealBoxFrame } from "../ipc/lan-crypto.ts"` to `federation/federation-server.ts`
   in a scratch edit and watch `bun run audit:invariants` fail; revert.

### Task 12 - Coverage and cleanup

- Per new file, 85% line and 80% branch (`audit:coverage-floor`, Linux-authoritative; the `test:coverage:*`
  scripts are NOT the gate): `lan-noise.ts`, `lan-session.ts`, `lan-legacy.ts` (moved code keeps the coverage
  its tests gave it; `lan-server.ts` and `lan-client.ts` lose lines and keep ratios), `lan-link.ts`. For each,
  before pushing, list every `?:`, `??`, `&&`/`||` and early return and name the test that takes each arm. Do
  NOT write a `??` default no test reaches, and do NOT write `err instanceof Error ? err.message : String(err)`
  (the unreachable arm is the usual floor failure): throw fixed `Error` messages, and where the client must
  show a cause use the existing `fallbackMessage` (`config/layered-config.ts`). The legacy code already contains
  such ternaries (`lan-client.ts:121,133,152`); moving them does not make them reachable, so keep their tests.
- `bun run lint` (Biome), no `any`, no bare `.sort()`, every new function under cognitive complexity 15 (the
  server's v2 handshake is split by PHASE, named steps invoked in sequence), `dbRun` only (I14), no interpolated
  SQL (I9). `crypto.timingSafeEqual`/`constantTimeStringEqual` where two secrets are compared (I10): FS1 compares
  no secret in `lan-noise.ts` (AEAD tag checks are the library's).
- Cross-platform: no paths are built here except the fixture path in tests via `join`; `bun run
  audit:cross-platform`. The recording proxy binds `127.0.0.1` only (I6).
- If Docker is available run `bun run verify:docker --changed` (its one known red exec-e2e is the harness); else
  say so in the PR.

### Task 13 - Docs (the five core docs, every PR) and CHANGELOG

- `CLAUDE.md` and `GEMINI.md` (identical edits): the status paragraph gains one "Phase 10 FS1" sentence (Noise IK
  sessions between upgraded peers: ephemeral DH, counter nonces, rekey every 1,024 records, no replay of a
  recorded request; the old static-box wire kept for peers not yet upgraded under `[lan] min_protocol = 1`; the
  per-peer downgrade ratchet in `lan_peers.proto_version`; invariant I5x, static D4x; pairing still on the old
  frames until FS2; stated bounds in short); `schema V<prev>` becomes the new number in BOTH places it appears;
  the invariant ceiling `I1-I<prev>` and the static `D10-D<prev>` move; the "Static complement" paragraph lists
  D4x. Run `bun run audit:status-drift` and fix every surface it names.
- All ten `CEILING_RANGE_SURFACES` (`scripts/structure-audit/check-status-drift.ts:80-91`): `CLAUDE.md`,
  `GEMINI.md`, `docs/architecture.md`, `docs/README.md`, `docs/SECURITY-INVARIANTS.md`, `.github/SECURITY.md`,
  `.coderabbit.yaml` (its `I1-I<N>` comment, `:15`), `.claude/commands/nimbus-file-map.md`,
  `.claude/commands/nimbus-commands.md` (its `D10-D<N>` rule range, `:185`) and
  `.claude/commands/nimbus-tool-output-envelope.md`. Open each; move the ones whose range reaches the old ceiling.
- `docs/roadmap.md`: the *LAN forward secrecy (S3-F8)* row (`:2032`) stays `[ ]` (FS2 and FS3 remain) with a dated
  sub-note: FS1 delivered, what, and what is left.
- `docs/architecture.md`: the LAN transport subsection (v2 wire, the ordered server steps, the link policy, the
  ratchet, rekey, the 10 s deadline) and the schema pointer; the Table pointer next to V93 (`:994`).
- `docs/README.md`: the Phase 10 status paragraph gains the FS1 sentence.
- `docs/cli-reference.md`: the `[lan]` configuration table gains `min_protocol` (default 1, accepted 1 or 2, what
  2 refuses), and the `nimbus lan` section notes that a peer's `proto_version` is in `lan.listPeers` output
  (FS2 adds the human-facing line).
- `docs/SECURITY.md`: the LAN trust model (`:179`, `:193`): forward secrecy now exists for upgraded peers; the
  residual risks name the compat window and unchanged pairing.
- `docs/schema-reference.md`: the new `ALTER`/column with a dated header (model: the V93 entry, `:1339`).
- `docs/CHANGELOG.md`: a dated entry at the top of "Post-Phase-6 deliveries": what an owner gets (federation
  sessions are forward-secret between upgraded peers; nothing to re-pair; set `[lan] min_protocol = 2` to refuse
  old peers), the schema number, the config key, I5x, D4x, the stated bounds, and the corrections above.
- `.claude/commands/nimbus-federation-identity.md` and `nimbus-security-invariants.md` (the LAN wire description
  and the invariant list), `nimbus-db-migrations.md` ("Newest"), `nimbus-file-map.md` (one row per new file;
  `audit:doc-refs` resolves every path they cite).

### Task 14 - Final verification (sequentially, never beside each other; a failing step hides later ones)

1. `bun run preflight:fast` (types, Biome, static rules incl. `audit:invariants`, `audit:status-drift`,
   `audit:doc-refs`).
2. `bun test packages/gateway/src`
3. `bun test packages/gateway/test packages/cli` (a `src` run does not load `test/`; the federation, teamvault
   and lan integration trees and the share-forward e2e live there).
4. `bun test scripts`
5. `bun run typecheck` and `bun run typecheck:tests` (the baseline must not grow).
6. `bun run audit:invariants` and `bun test scripts/structure-audit/check-nimbus-invariants.test.ts` once more
   after any later edit; `bun run audit:coverage-floor` is CI-authoritative (Linux): run `bun run verify:docker
   --full` if Docker is available, otherwise state that the floor was reasoned per file (Task 12) and not measured.
7. `bun run preflight` if time allows.
8. Known LOCAL baselines (not this branch): six migration e2e tests fail when run beside `packages/cli/src` in one
   process (reproducer in the memory note `migration-e2e-fails-beside-cli-src-in-one-process`); five
   `install.ps1`/gpg tests fail on this machine. On Windows build the sandbox helper first
   (`pwsh -NoProfile -File ./scripts/build-sandbox-helper-win32.ps1`) or the sandbox suites fail for that reason,
   and do not run them beside a background `preflight` (shared ACL ledger). Anything else red is this branch.
9. Before opening the PR re-check `git rev-parse --abbrev-ref HEAD`, then strip `docs/superpowers/**`.

## Spec coverage (spec sections mapped to a task STEP)

| Requirement | Where implemented |
| --- | --- |
| FS-A1 a recorded session cannot be opened with the pairing keys; positive control | Task 10 step 2; Task 11 step 2 |
| FS-A2 replay never executes; replayed reply refused; message 1 replay draws message 2 | Task 7 step 2 (server half), Task 10 step 3 (client half) |
| FS-A3 ratchet and `min_protocol` | Task 7 steps 2-3, Task 8 step 1, Task 10 step 4, Task 4 (`markLanPeerProto`) |
| FS-A4 old and new peers interoperate both ways | Task 8 step 1, Task 10 step 5 |
| FS-A5 every consumer passes unchanged | Task 9 step 3 (query, invoke, delegated, quorum, team vault, share forward) |
| D-FS-1/2/3 Noise IK over AESGCM/SHA-256 from `node:crypto` | Task 2 |
| D-FS-4 no payload in message 1 | Task 2/3 (the drivers send an empty payload; asserted in `lan-session.test.ts`) |
| D-FS-5 records, flag byte, 4 MiB cap | Task 3 step 1-2 |
| D-FS-7 prologue, no labels of our own | Task 3 step 2 |
| D-FS-8 / OR-FS-3 rekey per CipherState, `n` not reset, fail closed | Task 2 step 1, Task 3 step 1 |
| D-FS-9 first-frame magic, version, pattern | Task 3 step 2, Task 7 step 2 |
| D-FS-10 silent close on a message 1 failure | Task 7 step 2 |
| D-FS-11 10 s handshake deadline | Task 7 steps 2-3 (correction 7) |
| D-FS-12 / OR-FS-4 in-repo Noise with vectors | Task 1, Task 2 |
| D-FS-13 downgrade ratchet | Task 4, Task 7, Task 8 |
| D-FS-14 failed record counted | Task 7 steps 2-3 (correction 8) |
| D-FS-15, D-FS-16, D-FS-17, XXpsk0 pairing | NOT FS1: slice FS2 (pairing is unchanged here) |
| § 6 schema `proto_version`; `LanPeerMatch.protoVersion` required | Task 4; Task 7 step 1 and 3 |
| § 6 `[lan] min_protocol` | Task 5, Task 9 |
| § 7.2 invariant I5x and static D4x | Task 11 (rule narrowed, correction 1) |
| OR-FS-1 compat window, default `min_protocol = 1`, status warning | default in Task 5; the status warning is FS2 |
| OR-FS-2 no re-pair | by construction: no key or row changes; `lan_peers` rows are only altered by the new column |
| Docs: five core, CHANGELOG, SECURITY-INVARIANTS, ten ceiling surfaces | Task 13 |

## Risks / open questions

- **Vector availability** (Task 1): not confirmed that the cacophony or snow files include IK + AESGCM +
  SHA-256; the plan has a third source and a stop condition. A hand-generated vector set is weaker evidence than
  an upstream one; say which was used in the PR.
- **The engine is ours** (OR-FS-4). Vectors cover the handshake and plain transport; they do NOT cover rekey for
  AESGCM (upstream vectors do not rekey). The rekey is checked against an independent reference in the test
  (the `ENCRYPT(k, maxnonce, ...)` computation), which proves the code does what the spec says, not that the
  spec's reading is the same as another implementation's. FS1 states this in the PR; interop with other Noise
  stacks is not a goal (spec § 10).
- **Bun differences on CI** (1.4 vs the 1.3.14 used while drafting): re-checked in Task 0 step 4. If
  `diffieHellman` on a JWK-built X25519 key behaves differently, the fallback is `tweetnacl`'s
  `nacl.scalarMult` for the DH only (it is already a dependency and is constant-time), which would need the D4x
  rule to allow `nacl.scalarMult` in `lan-noise.ts`.
- **Correction 6** (a legacy `pair` for a ratcheted key is refused) goes beyond the spec text; the alternative is
  to allow it and rely on the upsert not lowering the version. It is cheap to flip; flagged for review.
- **The timer on legacy sockets** (correction 7) can break an existing test that idles a raw socket for long;
  Task 7 makes the deadline injectable and the legacy tests that need a long idle set it.
- **Merge-order collisions** with the incident engine: `lan-rpc.ts` is not touched here (its
  `FORBIDDEN_OVER_LAN` gets `"incident"` from the other project); the contended files are the number-bearing
  docs, `local-index.ts:290`, `runner.ts`, `check-nimbus-invariants.ts` and `security-invariants.test.ts`. The
  second PR to merge rebases and renumbers; do not pre-resolve it.
- **Call-site churn** (12 production, 32 test sites): mechanical but wide; a missed production site is a type
  error because `link` is required, which is the point.
- **A v1 peer behind a lossy network**: a transient v2 failure on a not-yet-ratcheted peer falls back to legacy
  once (compat window). That is the stated bound of OR-FS-1; `min_protocol = 2` removes it.
- **Live behaviour** is exercised on loopback only; no cross-OS two-machine run is part of FS1. The Windows and
  macOS PR legs run the same test paths as Linux.

## PR

Title (conventional commit, no `!`; nothing here requires a user to act, because the old wire still works under
the default `min_protocol = 1`):

`feat(gateway): LAN federation sessions use a Noise IK key exchange, so a stolen pairing key cannot open recorded sessions`

Description: the data added (column, config key), the corrections above (short), the stated bounds, the
verification output (and which of the steps ran only on Windows), and the follow-ups (FS2 pairing, FS3 removal of
the old wire). End with the attribution lines from the session. No `Release-As:` trailer.

## Review log

(none yet)

## Review log

Round 1 (Antigravity, 2026-11-12): APPROVED, no blocker or major. Minor citation fixes for the implementer: `sendFederatedOverWire` has the production call sites the plan enumerates (re-count with `git grep -n "sendFederatedOverWire(" -- packages/gateway/src ":!*.test.ts"` at Task 0; the "12" in the summary may be 10); `FederationLanConfig` is at `federation/federation-server.ts:14-20`, not `:37-43`; the `lan-client.ts` ternaries are at `:121,138,149,152`.
