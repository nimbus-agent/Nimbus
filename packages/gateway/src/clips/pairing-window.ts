import { randomInt } from "node:crypto";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";
import type { ApiScope } from "./api-scopes.ts";

export const PAIRING_TTL_MS = 120_000;
export const PAIRING_MAX_ATTEMPTS = 5;

export interface PairingWindowDeps {
  readonly nowMs: () => number;
  readonly genCode?: () => string;
}

interface OpenWindow {
  readonly label: string;
  readonly code: string;
  readonly scopes: readonly ApiScope[];
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

  /**
   * `scopes` is what the minted token will carry. It is recorded HERE, at the moment the OWNER
   * opens the window from the CLI — never taken from the confirming request. A requester that
   * could name its own scopes would simply grant itself the set, which is the same
   * server-derived-not-caller-supplied rule I23 relies on for reply targets.
   */
  open(label: string, scopes: readonly ApiScope[]): { code: string; expiresAtMs: number } {
    const code = this.genCode();
    const expiresAtMs = this.nowMs() + PAIRING_TTL_MS;
    this.window = { label, code, scopes, expiresAtMs, attempts: 0 };
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

  confirm(code: string): { label: string; scopes: readonly ApiScope[] } | null {
    const w = this.window;
    if (w === null) return null;
    if (this.nowMs() > w.expiresAtMs) {
      this.window = null;
      return null;
    }
    w.attempts += 1;
    if (constantTimeStringEqual(code, w.code)) {
      this.window = null; // single-use
      return { label: w.label, scopes: w.scopes };
    }
    if (w.attempts >= PAIRING_MAX_ATTEMPTS) {
      this.window = null; // attempt cap reached → close
    }
    return null;
  }
}
