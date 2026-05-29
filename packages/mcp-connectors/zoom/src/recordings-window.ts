/**
 * Zoom's /v2/users/me/recordings requires (to - from) <= 1 month. We use 31
 * days as the safe upper bound (Zoom's docs say "1 month" loosely; 31 covers
 * any month). Returns nothing on success; throws a clear Error when the
 * window is wrong so the LLM agent doesn't burn a round-trip on a 400.
 * Review point 3.1.
 *
 * Lives in its own module (not server.ts) so it can be unit-tested without
 * importing server.ts — which runs `runReadOnlyMcpConnector` at top level and
 * would start a stdio transport on import. Mirrors the existing
 * encode-meeting-path.ts / search-filter.ts extraction pattern.
 */
const MAX_RECORDINGS_WINDOW_MS = 31 * 86_400_000;

export function validateZoomRecordingsWindow(from: string, to: string): void {
  const fromMs = Date.parse(from);
  const toMs = Date.parse(to);
  if (!Number.isFinite(fromMs)) {
    throw new Error(`Invalid 'from': ${from} is not an ISO-8601 date.`);
  }
  if (!Number.isFinite(toMs)) {
    throw new Error(`Invalid 'to': ${to} is not an ISO-8601 date.`);
  }
  if (toMs < fromMs) {
    throw new Error(`'to' (${to}) must be >= 'from' (${from}).`);
  }
  const widthMs = toMs - fromMs;
  if (widthMs > MAX_RECORDINGS_WINDOW_MS) {
    const days = Math.round(widthMs / 86_400_000);
    throw new Error(
      `Zoom requires (to - from) <= 1 month; got ${String(days)} days. Split the request into multiple <= 31-day windows.`,
    );
  }
}
