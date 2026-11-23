import type { IPCClient } from "../../ipc-client/index.ts";
import type { ConsentChoice } from "../../lib/interactive-ipc-handlers.ts";
import { withGatewayIpc } from "../../lib/with-gateway-ipc.ts";

export type SyncStatus = {
  serviceId: string;
  status: string;
  lastSyncAt: number | null;
  nextSyncAt: number | null;
  intervalMs: number;
  itemCount: number;
  lastError: string | null;
  consecutiveFailures: number;
  healthState?: string;
  healthRetryAfterMs?: number | null;
};

export type SyncTelemetryEntry = {
  startedAt: number;
  durationMs: number;
  itemsUpserted: number;
  itemsDeleted: number;
  bytesTransferred: number | null;
  hadMore: boolean;
  errorMsg: string | null;
  /** Items the run returned but did not write (extension sync); 0 otherwise. */
  itemsDropped: number;
};

export type SyncStatusWithTelemetry = SyncStatus & { telemetry?: SyncTelemetryEntry[] };

/**
 * Connect, run, disconnect — delegating to the shared `withGatewayIpc`.
 *
 * Kept as a thin local wrapper only because this file has eleven call sites using the
 * positional `(fn, consent, timeout)` shape; the lifecycle itself lives in one place now.
 *
 * The middle parameter used to be a free `onConnect` callback that a HITL-gated call site
 * had to remember to pass. It is now a {@link ConsentChoice}, and omitting it selects the
 * interactive prompt rather than nothing — so `connector add --mcp`, which called a gated
 * method with no handler and hung for 30s every time, is correct by default.
 */
export async function withIpc<T>(
  fn: (c: IPCClient) => Promise<T>,
  consent?: ConsentChoice,
  requestTimeoutMs?: number,
): Promise<T> {
  return withGatewayIpc(fn, undefined, {
    ...(consent === undefined ? {} : { consent }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
  });
}

export function relTime(ms: number | null): string {
  if (ms === null) {
    return "—";
  }
  const sec = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (sec < 60) {
    return `${String(sec)}s ago`;
  }
  if (sec < 3600) {
    return `${String(Math.floor(sec / 60))}m ago`;
  }
  if (sec < 86400) {
    return `${String(Math.floor(sec / 3600))}h ago`;
  }
  return `${String(Math.floor(sec / 86400))}d ago`;
}

export function fmtNextSync(ms: number | null): string {
  if (ms === null) {
    return "—";
  }
  const delta = ms - Date.now();
  if (delta <= 0) {
    return "due";
  }
  const sec = Math.floor(delta / 1000);
  if (sec < 60) {
    return `in ${String(sec)}s`;
  }
  if (sec < 3600) {
    return `in ${String(Math.floor(sec / 60))}m`;
  }
  if (sec < 86400) {
    return `in ${String(Math.floor(sec / 3600))}h`;
  }
  return `in ${String(Math.floor(sec / 86400))}d`;
}

export function truncateText(s: string, maxLen: number): string {
  if (s.length <= maxLen) {
    return s;
  }
  if (maxLen <= 1) {
    return "…";
  }
  return `${s.slice(0, maxLen - 1)}…`;
}

export function padField(s: string, w: number): string {
  return s.length >= w ? s : s + " ".repeat(w - s.length);
}

export function repeatChar(ch: string, n: number): string {
  return ch.repeat(Math.max(0, n));
}
