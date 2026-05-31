import type { SyncResult } from "./types.ts";

function elapsedMs(t0: number): number {
  return Math.round(performance.now() - t0);
}

export function syncPassCursorHttpEmpty(
  t0: number,
  bytesTransferred: number,
  incomingCursor: string | null,
  defaultCursor: string,
): SyncResult {
  return {
    cursor: incomingCursor ?? defaultCursor,
    itemsUpserted: 0,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: elapsedMs(t0),
    bytesTransferred,
  };
}

export function syncPassCursorParseEmpty(
  t0: number,
  bytesTransferred: number,
  defaultCursor: string,
): SyncResult {
  return {
    cursor: defaultCursor,
    itemsUpserted: 0,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: elapsedMs(t0),
    bytesTransferred,
  };
}

export function syncPassCursorSuccess(
  t0: number,
  bytesTransferred: number,
  defaultCursor: string,
  itemsUpserted: number,
): SyncResult {
  return {
    cursor: defaultCursor,
    itemsUpserted,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: elapsedMs(t0),
    bytesTransferred,
  };
}

export function clampSyncTitle(title: string, maxLen = 512): string {
  return title.length > maxLen ? title.slice(0, maxLen) : title;
}
