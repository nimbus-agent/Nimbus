import type { CaptureErrorCode } from "./capture-types.ts";

const HOUR_MS = 3_600_000;

/**
 * ONE gateway-wide sliding window over every capture ATTEMPT (spec § 5.1 step 3). Deliberately
 * keyed on nothing: a per-connection key would reset whenever a client restarts `nimbus
 * mcp-server`, since `clientId` is a fresh UUID per socket. In-memory; a gateway restart resets
 * it — the durable hourly cap (step 7) is the bound that survives.
 */
export class CaptureAttemptLimiter {
  private readonly stamps: number[] = [];

  constructor(private readonly windowMs: number = HOUR_MS) {}

  tryAcquire(nowMs: number, capPerWindow: number): boolean {
    while (this.stamps.length > 0 && (this.stamps[0] ?? 0) <= nowMs - this.windowMs) {
      this.stamps.shift();
    }
    if (this.stamps.length >= capPerWindow) return false;
    this.stamps.push(nowMs);
    return true;
  }
}

/** Refusals at gate steps 1–3 are counted here instead of audited (spec § 5.1). */
export class CaptureRefusalCounter {
  private readonly counts = new Map<CaptureErrorCode, number>();

  bump(code: CaptureErrorCode): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.counts);
  }
}
