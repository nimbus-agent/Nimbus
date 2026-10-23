/**
 * The ONE rule for the `lastError` a connector status reports. A paused service's stated pause
 * reason (kept on the health row) wins over a stale sync error left in the scheduler row; a pause
 * with no stated reason, and every non-paused service, report the scheduler row's error.
 */
export function statusLastError(
  paused: boolean,
  schedulerError: string | null,
  healthError: string | undefined,
): string | null {
  if (paused) return healthError ?? schedulerError ?? null;
  return schedulerError ?? null;
}
