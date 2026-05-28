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
