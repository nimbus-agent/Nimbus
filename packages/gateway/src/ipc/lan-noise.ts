/**
 * The Noise Protocol Framework (revision 34, https://noiseprotocol.org/noise.html), implemented from
 * the specification and `node:crypto` only (owner ruling OR-FS-4: no new dependency): X25519 for DH,
 * AES-256-GCM for the cipher and SHA-256 / HMAC-SHA256 for the hash, so the suite is
 * `Noise_<pattern>_25519_AESGCM_SHA256`.
 *
 * Scope: what the `IK` and `XXpsk0` patterns need (the pre-message `s`, the tokens
 * `e s ee es se ss psk`, `MixKeyAndHash`, `Split()`, `Rekey()`, the handshake hash). The pattern
 * table is data (`HandshakePattern`), so a pattern is a row, never new code.
 *
 * Checked against the published test vectors (`test/fixtures/noise/`) by `lan-noise.test.ts`.
 *
 * Every read-side failure (a message that does not open, a truncated message, a low-order point) is
 * the SAME fixed error, `NOISE_OPEN_FAILED`: nothing here is an oracle for which check failed.
 * Interop with other Noise stacks is not a goal; the prologue and the framing around this are
 * Nimbus-specific (`lan-session.ts`). The primitives (X25519, HKDF, AES-GCM, `CipherState`) are in
 * `lan-noise-cipher.ts`; this file is the symmetric state, the handshake state and the pattern table.
 */
import type { BoxKeypair } from "./lan-crypto.ts";
import {
  CipherState,
  DHLEN,
  defaultEphemeral,
  HASHLEN,
  hkdf2,
  hkdf3,
  MAX_NOISE_MESSAGE,
  NOISE_OPEN_FAILED,
  requireKeyLength,
  sha256,
  TAG_LEN,
  x25519,
} from "./lan-noise-cipher.ts";

export {
  CipherState,
  DHLEN,
  HASHLEN,
  MAX_NOISE_MESSAGE,
  NOISE_OPEN_FAILED,
  requireContributory,
  x25519,
  x25519PublicKey,
} from "./lan-noise-cipher.ts";

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

  /** Noise § 5.2 `MixKeyAndHash`: the `psk` token (§ 9.2). */
  mixKeyAndHash(inputKeyMaterial: Uint8Array): void {
    const [ck, tempH, tempK] = hkdf3(this.ck, inputKeyMaterial);
    this.ck.fill(0);
    this.ck = ck;
    this.mixHash(tempH);
    this.cipher = new CipherState(tempK);
    tempH.fill(0);
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

export type Token = "e" | "s" | "ee" | "es" | "se" | "ss" | "psk";

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

/**
 * `XXpsk0` (Noise § 7.5, § 9.4): neither side knows the other's static key; a pre-shared symmetric
 * key is mixed in BEFORE the first DH, so a wrong key fails message 1 and a man in the middle
 * without it can finish neither direction.
 */
export const PATTERN_XXPSK0: HandshakePattern = {
  name: "XXpsk0",
  preMessages: { initiator: [], responder: [] },
  messages: [
    ["psk", "e"],
    ["e", "ee", "s", "es"],
    ["s", "se"],
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
  /** The pre-shared keys, consumed in order by the pattern's `psk` tokens (32 bytes each). */
  psks?: Uint8Array[];
  /** Injected so test vectors can pin the ephemeral; production code never passes it. */
  generateEphemeral?: (() => BoxKeypair) | undefined;
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
  private readonly psks: Uint8Array[];
  private pskIndex = 0;
  private readonly pskMode: boolean;
  private messageIndex = 0;
  private failed = false;
  private finished = false;

  constructor(opts: HandshakeOptions) {
    this.pattern = opts.pattern;
    this.initiator = opts.initiator;
    this.s = opts.s;
    this.generateEphemeral = opts.generateEphemeral ?? defaultEphemeral;
    this.psks = (opts.psks ?? []).map((k) => {
      requireKeyLength(k);
      return k.slice();
    });
    const pskTokens = opts.pattern.messages.flat().filter((t) => t === "psk").length;
    if (pskTokens !== this.psks.length) throw new Error("lan-noise: wrong number of psks");
    this.pskMode = pskTokens > 0;
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

  /** A failed handshake is dead; its pre-shared keys are overwritten (best effort). */
  private fail(): void {
    this.failed = true;
    for (const psk of this.psks) psk.fill(0);
  }

  private nextPsk(): Uint8Array {
    const psk = this.psks[this.pskIndex];
    if (psk === undefined) throw new Error("lan-noise: missing key");
    this.pskIndex += 1;
    return psk;
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
          if (this.pskMode) this.symmetric.mixKey(this.e.publicKey);
        } else if (token === "s") {
          out.push(this.symmetric.encryptAndHash(this.s.publicKey));
        } else if (token === "psk") {
          this.symmetric.mixKeyAndHash(this.nextPsk());
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
      this.fail();
      throw err;
    }
  }

  readMessage(message: Uint8Array): Uint8Array {
    if (this.failed || message.length > MAX_NOISE_MESSAGE) {
      this.fail();
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
          if (this.pskMode) this.symmetric.mixKey(this.re);
        } else if (token === "psk") {
          this.symmetric.mixKeyAndHash(this.nextPsk());
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
      this.fail();
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
    for (const psk of this.psks) psk.fill(0);
    return this.initiator ? { send: c1, receive: c2 } : { send: c2, receive: c1 };
  }
}
