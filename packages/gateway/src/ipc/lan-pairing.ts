import { randomBytes } from "node:crypto";
import bs58 from "bs58";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";

export function generatePairingCode(): string {
  const raw = new Uint8Array(randomBytes(15));
  const encoded = bs58.encode(raw);
  if (encoded.length >= 20) return encoded.slice(0, 20);
  return encoded.padStart(20, "1");
}

export class PairingWindow {
  private code: string | null = null;
  private openedAt: number | null = null;
  private readonly now: () => number;
  constructor(
    private readonly windowMs: number,
    now?: () => number,
  ) {
    this.now = now ?? (() => Date.now());
  }

  open(code: string): void {
    this.code = code;
    this.openedAt = this.now();
  }

  close(): void {
    this.code = null;
    this.openedAt = null;
  }

  isOpen(): boolean {
    if (!this.code || this.openedAt === null) return false;
    return this.now() - this.openedAt <= this.windowMs;
  }

  getExpiresAt(): number | null {
    if (this.openedAt === null) return null;
    return this.openedAt + this.windowMs;
  }

  consume(code: string): boolean {
    return this.consumeAt(code, this.now());
  }

  /**
   * Consume the open code when `matches(code)` says the caller proved knowledge of it, and return
   * the code so the caller can prove knowledge back. The LAN v2 pairing handshake never sends the
   * code itself, only an HMAC over it, so the window cannot be asked "is this the code?". Expiry
   * and single use work exactly as in {@link consume}.
   */
  consumeMatching(matches: (code: string) => boolean): string | null {
    if (!this.code || this.openedAt === null) return null;
    if (this.now() - this.openedAt > this.windowMs) {
      this.close();
      return null;
    }
    const code = this.code;
    if (!matches(code)) return null;
    this.close();
    return code;
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
