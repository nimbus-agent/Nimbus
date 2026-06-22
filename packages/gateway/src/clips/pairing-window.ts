import { randomInt } from "node:crypto";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";

export const PAIRING_TTL_MS = 120_000;
export const PAIRING_MAX_ATTEMPTS = 5;

export interface PairingWindowDeps {
  readonly nowMs: () => number;
  readonly genCode?: () => string;
}

interface OpenWindow {
  readonly label: string;
  readonly code: string;
  readonly expiresAtMs: number;
  attempts: number;
}

function defaultCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * A single, in-memory pairing window. Strictly ephemeral — a gateway restart drops it (I30:
 * a token is minted only behind a live, owner-opened, unexpired, attempts-remaining window).
 */
export class PairingWindowController {
  private window: OpenWindow | null = null;
  private readonly nowMs: () => number;
  private readonly genCode: () => string;

  constructor(deps: PairingWindowDeps) {
    this.nowMs = deps.nowMs;
    this.genCode = deps.genCode ?? defaultCode;
  }

  open(label: string): { code: string; expiresAtMs: number } {
    const code = this.genCode();
    const expiresAtMs = this.nowMs() + PAIRING_TTL_MS;
    this.window = { label, code, expiresAtMs, attempts: 0 };
    return { code, expiresAtMs };
  }

  isOpen(): boolean {
    const w = this.window;
    if (w === null) return false;
    if (this.nowMs() > w.expiresAtMs) {
      this.window = null;
      return false;
    }
    return true;
  }

  confirm(code: string): { label: string } | null {
    const w = this.window;
    if (w === null) return null;
    if (this.nowMs() > w.expiresAtMs) {
      this.window = null;
      return null;
    }
    w.attempts += 1;
    if (constantTimeStringEqual(code, w.code)) {
      this.window = null; // single-use
      return { label: w.label };
    }
    if (w.attempts >= PAIRING_MAX_ATTEMPTS) {
      this.window = null; // attempt cap reached → close
    }
    return null;
  }
}
