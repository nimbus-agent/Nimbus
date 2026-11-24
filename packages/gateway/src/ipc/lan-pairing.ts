import { createHmac, randomBytes } from "node:crypto";
import bs58 from "bs58";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";

export const PAIRING_CODE_LENGTH = 20;
/** The Bitcoin base58 alphabet, which is what `bs58` encodes with. */
const PAIRING_CODE_FORMAT = /^[1-9A-HJ-NP-Za-km-z]{20}$/;

/**
 * 15 random bytes, base58-encoded, cut to 20 characters: about 114 bits (the last digit is cut off a
 * 21-digit encoding, so the space is `floor(N / 58)` over about 2^117 values). Below Noise § 14's
 * 256-bit PSK guideline, accepted by owner ruling OR-FS-6. `lan-pairing.test.ts` pins both facts.
 */
export function generatePairingCode(): string {
  const raw = new Uint8Array(randomBytes(15));
  const encoded = bs58.encode(raw);
  if (encoded.length >= PAIRING_CODE_LENGTH) return encoded.slice(0, PAIRING_CODE_LENGTH);
  return encoded.padStart(PAIRING_CODE_LENGTH, "1");
}

/**
 * D-FS-16: the code is exactly 20 base58 characters, where it enters (`PairingWindow.open`) and where
 * it is typed (`outboundPairHandshake`), so a caller cannot pass a short code into a mode that
 * assumes a high-entropy secret. This checks FORMAT, not entropy: a string cannot prove its own.
 */
export function assertPairingCodeFormat(code: string): void {
  if (!PAIRING_CODE_FORMAT.test(code)) {
    throw new Error(
      "lan-pairing: the pairing code must be exactly 20 base58 characters (the code `nimbus lan open` prints on the host)",
    );
  }
}

const PSK_SALT = new TextEncoder().encode("nimbus-lan/2 pair psk");
const PSK_INFO = new TextEncoder().encode("psk0");

/**
 * D-FS-6: the Noise PSK for `XXpsk0` is `HKDF-SHA256(salt = "nimbus-lan/2 pair psk", ikm = the 20
 * ASCII bytes of the code, info = "psk0", L = 32)` (RFC 5869): no normalisation, no base58 decoding.
 * Both ends derive it from the code they hold; the code itself never travels.
 */
export function derivePairingPsk(code: string): Uint8Array {
  assertPairingCodeFormat(code);
  // RFC 5869 with one output block (L = 32 = HashLen): PRK = HMAC(salt, ikm), OKM = HMAC(PRK, info || 0x01).
  const prk = createHmac("sha256", PSK_SALT).update(new TextEncoder().encode(code)).digest();
  const okm = createHmac("sha256", prk)
    .update(PSK_INFO)
    .update(new Uint8Array([0x01]))
    .digest();
  return new Uint8Array(okm);
}

export class PairingWindow {
  private code: string | null = null;
  /** D-FS-15: derived once at `open`, zeroed at `close` and at expiry. */
  private psk: Uint8Array | null = null;
  private openedAt: number | null = null;
  private readonly now: () => number;
  constructor(
    private readonly windowMs: number,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }

  open(code: string): void {
    const psk = derivePairingPsk(code); // validates the format before anything is stored
    this.wipePsk();
    this.code = code;
    this.psk = psk;
    this.openedAt = this.now();
  }

  close(): void {
    this.wipePsk();
    this.code = null;
    this.openedAt = null;
  }

  private wipePsk(): void {
    this.psk?.fill(0);
    this.psk = null;
  }

  isOpen(): boolean {
    if (!this.code || this.openedAt === null) return false;
    return this.now() - this.openedAt <= this.windowMs;
  }

  getExpiresAt(): number | null {
    if (this.openedAt === null) return null;
    return this.openedAt + this.windowMs;
  }

  /**
   * A copy of the open window's PSK for an `XXpsk0` responder, or `undefined` when no window is open
   * or it has expired (an expired window is closed, and its PSK zeroed, here).
   */
  currentPsk(): Uint8Array | undefined {
    if (!this.isOpen()) {
      if (this.code !== null) this.close();
      return undefined;
    }
    return this.psk === null ? undefined : this.psk.slice();
  }

  /**
   * Closes the window after an `XXpsk0` initiator proved the code (message 3 opened). `false` when it
   * was already closed or expired: of two initiators that raced with the right code, only the first
   * pairs. A failed message 1 never calls this, so a wrong guess does not burn the owner's window.
   */
  consumeOpen(): boolean {
    if (!this.isOpen()) {
      this.close();
      return false;
    }
    this.close();
    return true;
  }

  consume(code: string): boolean {
    return this.consumeAt(code, this.now());
  }

  consumeAt(code: string, nowMs: number): boolean {
    if (!this.code || this.openedAt === null) return false;
    if (nowMs - this.openedAt > this.windowMs) {
      this.close();
      return false;
    }
    if (!constantTimeStringEqual(code, this.code)) return false;
    this.close();
    return true;
  }
}
