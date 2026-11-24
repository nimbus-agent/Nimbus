/**
 * The primitives under `lan-noise.ts` (Noise revision 34, https://noiseprotocol.org/noise.html), from
 * `node:crypto` only (owner ruling OR-FS-4): X25519, HMAC/HKDF over SHA-256, AES-256-GCM with the
 * counter nonce of Noise § 12.4, and the `CipherState` (§ 5.1) with its one-way `Rekey()`. Split from
 * `lan-noise.ts` so neither file passes 500 lines; import the public names from `lan-noise.ts`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  randomBytes,
} from "node:crypto";
import type { BoxKeypair } from "./lan-crypto.ts";

export const DHLEN = 32;
export const HASHLEN = 32;
export const TAG_LEN = 16;
/** Noise § 3: a Noise message, handshake or transport, is at most 65,535 bytes. */
export const MAX_NOISE_MESSAGE = 65_535;
/** Noise § 5.1: the nonce 2^64-1 is reserved for `Rekey()` and never used for a message. */
const MAX_NONCE = 2n ** 64n - 1n;

export const NOISE_OPEN_FAILED = "lan-noise: message failed to open";

const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

export function requireKeyLength(key: Uint8Array): void {
  if (key.length !== DHLEN) throw new Error("lan-noise: invalid key length");
}

/** The X25519 public key for a 32-byte secret (any 32 bytes are a valid X25519 scalar). */
export function x25519PublicKey(secretKey: Uint8Array): Uint8Array {
  requireKeyLength(secretKey);
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_X25519_PREFIX, secretKey]),
    format: "der",
    type: "pkcs8",
  });
  const der = createPublicKey(privateKey).export({ format: "der", type: "spki" });
  return new Uint8Array(der.subarray(der.length - DHLEN));
}

/** X25519 `DH(secret, public)`. An all-zero output (a low-order point) is refused (RFC 7748 § 6.1). */
export function x25519(secretKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  requireKeyLength(secretKey);
  requireKeyLength(publicKey);
  let shared: Uint8Array;
  try {
    shared = new Uint8Array(
      diffieHellman({
        privateKey: createPrivateKey({
          key: Buffer.concat([PKCS8_X25519_PREFIX, secretKey]),
          format: "der",
          type: "pkcs8",
        }),
        publicKey: createPublicKey({
          key: Buffer.concat([SPKI_X25519_PREFIX, publicKey]),
          format: "der",
          type: "spki",
        }),
      }),
    );
  } catch {
    throw new Error("lan-noise: invalid public key");
  }
  return requireContributory(shared);
}

/**
 * RFC 7748 § 6.1: an all-zero shared secret means the peer sent a low-order point. Some runtimes
 * throw for it, some return zeros, so the check is made here as well (and tested directly).
 */
export function requireContributory(shared: Uint8Array): Uint8Array {
  if (shared.every((b) => b === 0)) throw new Error("lan-noise: invalid public key");
  return shared;
}

export function defaultEphemeral(): BoxKeypair {
  const secretKey = new Uint8Array(randomBytes(DHLEN));
  return { publicKey: x25519PublicKey(secretKey), secretKey };
}

export function sha256(...parts: Uint8Array[]): Uint8Array {
  const h = createHash("sha256");
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

function hmac(key: Uint8Array, ...parts: Uint8Array[]): Uint8Array {
  const h = createHmac("sha256", key);
  for (const p of parts) h.update(p);
  return new Uint8Array(h.digest());
}

/** Noise § 4.3 HKDF with two outputs: HMAC with the chaining key as salt, empty info. */
export function hkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(chainingKey, ikm);
  const out1 = hmac(tempKey, new Uint8Array([0x01]));
  const out2 = hmac(tempKey, out1, new Uint8Array([0x02]));
  tempKey.fill(0);
  return [out1, out2];
}

/** Noise § 4.3 HKDF with three outputs (used by `MixKeyAndHash`). */
export function hkdf3(
  chainingKey: Uint8Array,
  ikm: Uint8Array,
): [Uint8Array, Uint8Array, Uint8Array] {
  const tempKey = hmac(chainingKey, ikm);
  const out1 = hmac(tempKey, new Uint8Array([0x01]));
  const out2 = hmac(tempKey, out1, new Uint8Array([0x02]));
  const out3 = hmac(tempKey, out2, new Uint8Array([0x03]));
  tempKey.fill(0);
  return [out1, out2, out3];
}

/** Noise § 12.4: the AESGCM nonce is 4 zero bytes then the 64-bit counter, big-endian. */
function nonceBytes(n: bigint): Uint8Array {
  const nonce = new Uint8Array(12);
  new DataView(nonce.buffer).setBigUint64(4, n, false);
  return nonce;
}

function aeadSeal(key: Uint8Array, n: bigint, ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  const cipher = createCipheriv("aes-256-gcm", key, nonceBytes(n), { authTagLength: TAG_LEN });
  cipher.setAAD(ad);
  const body = cipher.update(plaintext);
  const rest = cipher.final();
  return new Uint8Array(Buffer.concat([body, rest, cipher.getAuthTag()]));
}

function aeadOpen(key: Uint8Array, n: bigint, ad: Uint8Array, sealed: Uint8Array): Uint8Array {
  if (sealed.length < TAG_LEN) throw new Error(NOISE_OPEN_FAILED);
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, nonceBytes(n), {
      authTagLength: TAG_LEN,
    });
    decipher.setAAD(ad);
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LEN));
    const body = decipher.update(sealed.subarray(0, sealed.length - TAG_LEN));
    const rest = decipher.final();
    return new Uint8Array(Buffer.concat([body, rest]));
  } catch {
    throw new Error(NOISE_OPEN_FAILED);
  }
}

/** Noise § 5.1. A CipherState without a key passes data through (used before the first `ee`/`es`). */
export class CipherState {
  private key: Uint8Array | undefined;
  private n: bigint;

  constructor(key: Uint8Array | undefined, n = 0n) {
    if (key !== undefined) requireKeyLength(key);
    this.key = key === undefined ? undefined : key.slice();
    this.n = n;
  }

  hasKey(): boolean {
    return this.key !== undefined;
  }

  /** The next nonce to be used (the number of messages already sealed or opened). */
  nonce(): bigint {
    return this.n;
  }

  /** SHA-256 of the key, hex: lets a test see that a key changed without exposing the key. */
  keyFingerprint(): string {
    if (this.key === undefined) throw new Error("lan-noise: no key");
    return createHash("sha256").update(this.key).digest("hex");
  }

  encryptWithAd(ad: Uint8Array, plaintext: Uint8Array): Uint8Array {
    if (this.key === undefined) return plaintext;
    if (this.n === MAX_NONCE) throw new Error("lan-noise: nonce space exhausted");
    if (plaintext.length + TAG_LEN > MAX_NOISE_MESSAGE) {
      throw new Error("lan-noise: message too large");
    }
    const sealed = aeadSeal(this.key, this.n, ad, plaintext);
    this.n += 1n;
    return sealed;
  }

  decryptWithAd(ad: Uint8Array, ciphertext: Uint8Array): Uint8Array {
    if (this.key === undefined) return ciphertext;
    if (this.n === MAX_NONCE) throw new Error("lan-noise: nonce space exhausted");
    const plain = aeadOpen(this.key, this.n, ad, ciphertext);
    this.n += 1n;
    return plain;
  }

  /**
   * Noise § 4.2 default REKEY, which § 12.4 leaves in force for AESGCM: the first 32 bytes of
   * `ENCRYPT(k, maxnonce, zerolen, zeros)`. It does NOT reset `n` (§ 11.3), so a nonce is never
   * reused under one key and never across keys. One-way: the old key cannot be recovered.
   */
  rekey(): void {
    if (this.key === undefined) throw new Error("lan-noise: no key");
    const next = aeadSeal(this.key, MAX_NONCE, new Uint8Array(0), new Uint8Array(DHLEN)).slice(
      0,
      DHLEN,
    );
    this.key.fill(0);
    this.key = next;
  }
}
