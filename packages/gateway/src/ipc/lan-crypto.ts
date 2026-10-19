import { createHmac } from "node:crypto";
import nacl from "tweetnacl";

import { timingSafeEqualBytes } from "../util/timing-safe-compare.ts";

export interface BoxKeypair {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
}

export function generateBoxKeypair(): BoxKeypair {
  const kp = nacl.box.keyPair();
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

export function boxKeypairFromSecretKey(secretKey: Uint8Array): BoxKeypair {
  if (secretKey.length !== 32) {
    throw new Error(`box secret key must be 32 bytes, got ${secretKey.length}`);
  }
  const kp = nacl.box.keyPair.fromSecretKey(secretKey);
  return { publicKey: kp.publicKey, secretKey: kp.secretKey };
}

/**
 * LAN wire protocol version 2 (code audit 2026-10-19, S2 + S3).
 *
 * Version 1 sealed every frame with `nacl.box` under the two STATIC keys and a random nonce, so a
 * frame recorded from one connection decrypted just as well on the next: a captured
 * `connector.remove` from a write-allowed peer could be replayed at will. It also sent the pairing
 * code in cleartext beside the client key, so anyone on the path could read the code, or swap
 * either public key and pair a key of their own.
 *
 * Version 2:
 * - **Per-connection session key.** Each side contributes a fresh X25519 key in the handshake. The
 *   key is SHA-512 over both the static shared secret (which only the two pinned keys can compute,
 *   so it authenticates both ends) and the ephemeral one (forward secrecy: a static key stolen later
 *   does not open recorded traffic), bound to all four public keys.
 * - **Counter nonces.** Frames are `nacl.secretbox` under that key with a nonce made of a direction
 *   byte and a per-direction sequence number, so the nonce is never sent: a replayed, reordered or
 *   reflected frame simply fails to open.
 * - **Pairing by proof.** The code never travels. The client proves it knows the code with
 *   `HMAC(code, client key)`, and the host answers with `HMAC(code, host key ‖ client key)`, which
 *   the client checks before pinning the host's key. The code is ~110 bits of base58, so a recorded
 *   proof cannot be brute-forced back into the code.
 */
export const LAN_PROTOCOL_VERSION = 2;

const SESSION_LABEL = new TextEncoder().encode("nimbus-lan-session-v2");

/** Which way a frame travels; part of its nonce, so a frame cannot be reflected back at its sender. */
export type LanDirection = "client_to_host" | "host_to_client";

export interface LanSessionKeyInput {
  /** This side's long-term key. */
  ownStatic: BoxKeypair;
  /** This side's per-connection key. */
  ownEphemeral: BoxKeypair;
  peerStaticPublic: Uint8Array;
  peerEphemeralPublic: Uint8Array;
  /** Fixes the order the four public keys are hashed in, so both ends derive the same key. */
  role: "client" | "host";
}

/** The 32-byte `secretbox` key for one connection. Both ends compute the same value. */
export function deriveLanSessionKey(input: LanSessionKeyInput): Uint8Array {
  for (const k of [input.peerStaticPublic, input.peerEphemeralPublic]) {
    if (k.length !== 32) throw new Error("lan: peer public key must be 32 bytes");
  }
  const staticShared = nacl.box.before(input.peerStaticPublic, input.ownStatic.secretKey);
  const ephemeralShared = nacl.box.before(input.peerEphemeralPublic, input.ownEphemeral.secretKey);
  const clientStatic = input.role === "client" ? input.ownStatic.publicKey : input.peerStaticPublic;
  const hostStatic = input.role === "client" ? input.peerStaticPublic : input.ownStatic.publicKey;
  const clientEph =
    input.role === "client" ? input.ownEphemeral.publicKey : input.peerEphemeralPublic;
  const hostEph =
    input.role === "client" ? input.peerEphemeralPublic : input.ownEphemeral.publicKey;
  return nacl
    .hash(
      concat(
        SESSION_LABEL,
        staticShared,
        ephemeralShared,
        clientStatic,
        hostStatic,
        clientEph,
        hostEph,
      ),
    )
    .slice(0, nacl.secretbox.keyLength);
}

function frameNonce(direction: LanDirection, seq: number): Uint8Array {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new Error("lan: bad frame sequence number");
  const nonce = new Uint8Array(nacl.secretbox.nonceLength);
  nonce[0] = direction === "client_to_host" ? 1 : 2;
  new DataView(nonce.buffer).setBigUint64(16, BigInt(seq), false);
  return nonce;
}

export function sealSessionFrame(
  key: Uint8Array,
  direction: LanDirection,
  seq: number,
  plaintext: Uint8Array,
): Uint8Array {
  return nacl.secretbox(plaintext, frameNonce(direction, seq), key);
}

/** Throws when the frame was not sealed under `key` for exactly this direction and sequence. */
export function openSessionFrame(
  key: Uint8Array,
  direction: LanDirection,
  seq: number,
  frame: Uint8Array,
): Uint8Array {
  if (frame.length < nacl.secretbox.overheadLength) throw new Error("frame too short");
  const plain = nacl.secretbox.open(frame, frameNonce(direction, seq), key);
  if (!plain) throw new Error("lan: frame did not open (tampered, replayed or wrong key)");
  return plain;
}

/** One side's HMAC-SHA256 proof that it knows the pairing code, bound to the keys being paired. */
export function pairingProof(
  code: string,
  role: "client" | "host",
  clientStaticPublic: Uint8Array,
  hostStaticPublic?: Uint8Array,
): Uint8Array {
  const mac = createHmac("sha256", code);
  mac.update(`nimbus-lan-pair-v2|${role}|`);
  mac.update(clientStaticPublic);
  if (role === "host") {
    if (hostStaticPublic === undefined) throw new Error("lan: host proof needs the host key");
    mac.update(hostStaticPublic);
  }
  return new Uint8Array(mac.digest());
}

/** Constant-time check of a received proof (I10). */
export function pairingProofMatches(expected: Uint8Array, received: Uint8Array): boolean {
  return timingSafeEqualBytes(expected, received);
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
