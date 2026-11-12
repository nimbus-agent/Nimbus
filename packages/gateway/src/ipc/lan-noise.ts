/**
 * The Noise Protocol Framework (revision 34, https://noiseprotocol.org/noise.html), implemented from
 * the specification and `node:crypto` only (owner ruling OR-FS-4: no new dependency): X25519 for DH,
 * AES-256-GCM for the cipher and SHA-256 / HMAC-SHA256 for the hash, so the suite is
 * `Noise_<pattern>_25519_AESGCM_SHA256`.
 *
 * Scope: exactly what the `IK` pattern needs (the pre-message `s`, the tokens `e s ee es se ss`,
 * `Split()`, `Rekey()`, the handshake hash). There is no `psk` token yet: the pairing slice adds it
 * as one more token and one more row of the pattern table, without changing the engine's shape.
 * The pattern table is data (`HandshakePattern`), so a pattern is a row, never new code.
 *
 * Checked against the published test vectors (`test/fixtures/noise/`) by `lan-noise.test.ts`.
 *
 * Every read-side failure (a message that does not open, a truncated message, a low-order point) is
 * the SAME fixed error, `NOISE_OPEN_FAILED`: nothing here is an oracle for which check failed.
 * Interop with other Noise stacks is not a goal; the prologue and the framing around this are
 * Nimbus-specific (`lan-session.ts`).
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
const TAG_LEN = 16;
/** Noise § 3: a Noise message, handshake or transport, is at most 65,535 bytes. */
export const MAX_NOISE_MESSAGE = 65_535;
/** Noise § 5.1: the nonce 2^64-1 is reserved for `Rekey()` and never used for a message. */
const MAX_NONCE = 2n ** 64n - 1n;

export const NOISE_OPEN_FAILED = "lan-noise: message failed to open";

const PKCS8_X25519_PREFIX = Buffer.from("302e020100300506032b656e04220420", "hex");
const SPKI_X25519_PREFIX = Buffer.from("302a300506032b656e032100", "hex");

function requireKeyLength(key: Uint8Array): void {
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

function defaultEphemeral(): BoxKeypair {
  const secretKey = new Uint8Array(randomBytes(DHLEN));
  return { publicKey: x25519PublicKey(secretKey), secretKey };
}

function sha256(...parts: Uint8Array[]): Uint8Array {
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
function hkdf2(chainingKey: Uint8Array, ikm: Uint8Array): [Uint8Array, Uint8Array] {
  const tempKey = hmac(chainingKey, ikm);
  const out1 = hmac(tempKey, new Uint8Array([0x01]));
  const out2 = hmac(tempKey, out1, new Uint8Array([0x02]));
  tempKey.fill(0);
  return [out1, out2];
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

/** Noise § 5.2. */
class SymmetricState {
  private ck: Uint8Array;
  private h: Uint8Array;
  private cipher = new CipherState(undefined);

  constructor(protocolName: string) {
    const name = new TextEncoder().encode(protocolName);
    if (name.length <= HASHLEN) {
      this.h = new Uint8Array(HASHLEN);
      this.h.set(name, 0);
    } else {
      this.h = sha256(name);
    }
    this.ck = this.h.slice();
  }

  handshakeHash(): Uint8Array {
    return this.h.slice();
  }

  mixHash(data: Uint8Array): void {
    this.h = sha256(this.h, data);
  }

  mixKey(inputKeyMaterial: Uint8Array): void {
    const [ck, tempK] = hkdf2(this.ck, inputKeyMaterial);
    this.ck.fill(0);
    this.ck = ck;
    this.cipher = new CipherState(tempK);
    tempK.fill(0);
  }

  encryptAndHash(plaintext: Uint8Array): Uint8Array {
    const ciphertext = this.cipher.encryptWithAd(this.h, plaintext);
    this.mixHash(ciphertext);
    return ciphertext;
  }

  decryptAndHash(ciphertext: Uint8Array): Uint8Array {
    const plaintext = this.cipher.decryptWithAd(this.h, ciphertext);
    this.mixHash(ciphertext);
    return plaintext;
  }

  hasKey(): boolean {
    return this.cipher.hasKey();
  }

  /** Noise § 5.2 `Split()`: two CipherStates, the first for the initiator's sends. */
  split(): [CipherState, CipherState] {
    const [k1, k2] = hkdf2(this.ck, new Uint8Array(0));
    const c1 = new CipherState(k1);
    const c2 = new CipherState(k2);
    k1.fill(0);
    k2.fill(0);
    this.ck.fill(0);
    return [c1, c2];
  }
}

export type Token = "e" | "s" | "ee" | "es" | "se" | "ss";

/** A handshake pattern as data: pre-messages by role and message token lists (initiator first). */
export interface HandshakePattern {
  name: string;
  preMessages: { initiator: Token[]; responder: Token[] };
  messages: Token[][];
}

/** `IK`: the initiator knows the responder's static key and sends its own encrypted in message 1. */
export const PATTERN_IK: HandshakePattern = {
  name: "IK",
  preMessages: { initiator: [], responder: ["s"] },
  messages: [
    ["e", "es", "s", "ss"],
    ["e", "ee", "se"],
  ],
};

export interface HandshakeOptions {
  pattern: HandshakePattern;
  initiator: boolean;
  prologue: Uint8Array;
  /** This side's static key pair (never wiped here: the caller owns it). */
  s: BoxKeypair;
  /** The peer's static public key when the pattern pre-shares it (the IK initiator). */
  rs?: Uint8Array;
  /** Injected so test vectors can pin the ephemeral; production code never passes it. */
  generateEphemeral?: () => BoxKeypair;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((sum, c) => sum + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/** Noise § 5.3. */
export class HandshakeState {
  private readonly symmetric: SymmetricState;
  private readonly pattern: HandshakePattern;
  private readonly initiator: boolean;
  private readonly s: BoxKeypair;
  private readonly generateEphemeral: () => BoxKeypair;
  private e: BoxKeypair | undefined;
  private rs: Uint8Array | undefined;
  private re: Uint8Array | undefined;
  private messageIndex = 0;
  private failed = false;
  private finished = false;

  constructor(opts: HandshakeOptions) {
    this.pattern = opts.pattern;
    this.initiator = opts.initiator;
    this.s = opts.s;
    this.generateEphemeral = opts.generateEphemeral ?? defaultEphemeral;
    requireKeyLength(opts.s.secretKey);
    requireKeyLength(opts.s.publicKey);
    const theirPre = opts.initiator
      ? opts.pattern.preMessages.responder
      : opts.pattern.preMessages.initiator;
    if (theirPre.length > 0) {
      if (opts.rs === undefined) throw new Error("lan-noise: remote static required");
      requireKeyLength(opts.rs);
      this.rs = opts.rs.slice();
    }
    this.symmetric = new SymmetricState(`Noise_${opts.pattern.name}_25519_AESGCM_SHA256`);
    this.symmetric.mixHash(opts.prologue);
    this.mixPreMessage(opts.pattern.preMessages.initiator, opts.initiator);
    this.mixPreMessage(opts.pattern.preMessages.responder, !opts.initiator);
  }

  /** Hashes the pre-message keys: the initiator's first, then the responder's (Noise § 5.3). */
  private mixPreMessage(tokens: Token[], ownRole: boolean): void {
    for (const token of tokens) {
      if (token !== "s") throw new Error("lan-noise: unsupported pre-message");
      const key = ownRole ? this.s.publicKey : this.rs;
      this.symmetric.mixHash(this.requireKey(key));
    }
  }

  private requireKey(key: Uint8Array | undefined): Uint8Array {
    if (key === undefined) throw new Error("lan-noise: missing key");
    return key;
  }

  private ephemeral(): BoxKeypair {
    if (this.e === undefined) throw new Error("lan-noise: missing key");
    return this.e;
  }

  /** The DH for a two-letter token, from this side's point of view (Noise § 7.3). */
  private dhFor(token: "ee" | "es" | "se" | "ss"): Uint8Array {
    const ours = this.initiator;
    switch (token) {
      case "ee":
        return x25519(this.ephemeral().secretKey, this.requireKey(this.re));
      case "ss":
        return x25519(this.s.secretKey, this.requireKey(this.rs));
      case "es":
        return ours
          ? x25519(this.ephemeral().secretKey, this.requireKey(this.rs))
          : x25519(this.s.secretKey, this.requireKey(this.re));
      case "se":
        return ours
          ? x25519(this.s.secretKey, this.requireKey(this.re))
          : x25519(this.ephemeral().secretKey, this.requireKey(this.rs));
    }
  }

  private isMyTurnToWrite(): boolean {
    return this.messageIndex % 2 === (this.initiator ? 0 : 1);
  }

  private currentTokens(): Token[] | undefined {
    return this.pattern.messages[this.messageIndex];
  }

  writeMessage(payload: Uint8Array): Uint8Array {
    const tokens = this.currentTokens();
    if (this.failed || tokens === undefined || !this.isMyTurnToWrite()) {
      throw new Error("lan-noise: out of turn");
    }
    try {
      const out: Uint8Array[] = [];
      for (const token of tokens) {
        if (token === "e") {
          this.e = this.generateEphemeral();
          out.push(this.e.publicKey);
          this.symmetric.mixHash(this.e.publicKey);
        } else if (token === "s") {
          out.push(this.symmetric.encryptAndHash(this.s.publicKey));
        } else {
          this.symmetric.mixKey(this.dhFor(token));
        }
      }
      out.push(this.symmetric.encryptAndHash(payload));
      const message = concat(out);
      if (message.length > MAX_NOISE_MESSAGE) throw new Error("lan-noise: message too large");
      this.messageIndex += 1;
      return message;
    } catch (err) {
      this.failed = true;
      throw err;
    }
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.failed || message.length > MAX_NOISE_MESSAGE) {
      this.failed = true;
      throw new Error(NOISE_OPEN_FAILED);
    }
    const tokens = this.currentTokens();
    if (tokens === undefined || this.isMyTurnToWrite()) throw new Error("lan-noise: out of turn");
    try {
      let rest = message;
      for (const token of tokens) {
        if (token === "e") {
          if (rest.length < DHLEN) throw new Error(NOISE_OPEN_FAILED);
          this.re = rest.slice(0, DHLEN);
          rest = rest.subarray(DHLEN);
          this.symmetric.mixHash(this.re);
        } else if (token === "s") {
          const length = DHLEN + (this.symmetric.hasKey() ? TAG_LEN : 0);
          if (rest.length < length) throw new Error(NOISE_OPEN_FAILED);
          this.rs = this.symmetric.decryptAndHash(rest.subarray(0, length));
          rest = rest.subarray(length);
        } else {
          this.symmetric.mixKey(this.dhFor(token));
        }
      }
      const payload = this.symmetric.decryptAndHash(rest);
      this.messageIndex += 1;
      return payload;
    } catch {
      this.failed = true;
      throw new Error(NOISE_OPEN_FAILED);
    }
  }

  private isComplete(): boolean {
    return !this.failed && this.messageIndex === this.pattern.messages.length;
  }

  /** The transcript hash `h` (Noise § 11.2 channel binding). */
  handshakeHash(): Uint8Array {
    return this.symmetric.handshakeHash();
  }

  /** The peer's static public key: known to the IK responder once message 1 was read. */
  remoteStatic(): Uint8Array {
    if (this.rs === undefined) throw new Error("lan-noise: remote static not known");
    return this.rs.slice();
  }

  /**
   * Ends the handshake: the two transport CipherStates (`send`, `receive`) for this side, and the
   * ephemeral secret and the handshake's chaining key are overwritten (best effort; JavaScript
   * gives no guarantee about copies, see the spec's stated bounds).
   */
  split(): { send: CipherState; receive: CipherState } {
    if (!this.isComplete() || this.finished) throw new Error("lan-noise: handshake not complete");
    this.finished = true;
    const [c1, c2] = this.symmetric.split();
    if (this.e !== undefined) this.e.secretKey.fill(0);
    return this.initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 };
  }
}
