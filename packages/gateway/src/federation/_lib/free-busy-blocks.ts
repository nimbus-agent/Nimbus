/**
 * Free/busy blocks for federated scheduling (Phase 10, OR-S4-SCHED). PURE: no clock, no I/O, no
 * database. Everything a peer ever learns about an owner's calendar is one `FreeBusyReply`: a start
 * instant, the block length and one `0`/`1` character per 30-minute block. The reply has no other
 * field, so its shape cannot depend on what a busy block came from.
 */

export const BLOCK_MS = 30 * 60 * 1000;
/** The widest window one request may cover (14 days: 672 blocks). */
export const MAX_WINDOW_MS = 14 * 86_400_000;
/**
 * How far ahead of now a window may end. The calendar sync keeps now-1d to now+30d and re-anchors
 * weekly, so the horizon is never shorter than +23 days; 21 leaves a margin. A block past the sync
 * window would read as free only because nothing was fetched for it.
 */
export const MAX_HORIZON_MS = 21 * 86_400_000;

export type FreeBusyWindow = { readonly fromMs: number; readonly toMs: number };

/** The ONLY thing that crosses the wire in a successful answer. */
export type FreeBusyReply = {
  readonly fromMs: number;
  readonly blockMs: typeof BLOCK_MS;
  /** One character per block, `1` busy, `0` free; its length is exactly (toMs - fromMs) / BLOCK_MS. */
  readonly blocks: string;
};

export function floorToBlock(ms: number): number {
  return Math.floor(ms / BLOCK_MS) * BLOCK_MS;
}

export function ceilToBlock(ms: number): number {
  return Math.ceil(ms / BLOCK_MS) * BLOCK_MS;
}

export function blockCount(w: FreeBusyWindow): number {
  return (w.toMs - w.fromMs) / BLOCK_MS;
}

/**
 * Validates a requested window against `nowMs`. Both ends must be safe integers on a 30-minute
 * boundary of the epoch (so the two sides' blocks line up), the window 30 minutes to 14 days long,
 * starting no more than one block in the past and ending inside the sync horizon.
 */
export function validateWindow(
  fromMs: unknown,
  toMs: unknown,
  nowMs: number,
): FreeBusyWindow | undefined {
  if (!Number.isSafeInteger(fromMs) || !Number.isSafeInteger(toMs)) return undefined;
  const from = fromMs as number;
  const to = toMs as number;
  if (from % BLOCK_MS !== 0 || to % BLOCK_MS !== 0) return undefined;
  if (to <= from || to - from > MAX_WINDOW_MS) return undefined;
  if (from < floorToBlock(nowMs) - BLOCK_MS) return undefined;
  if (to > nowMs + MAX_HORIZON_MS) return undefined;
  return { fromMs: from, toMs: to };
}

export function emptyBlocks(w: FreeBusyWindow): Uint8Array {
  return new Uint8Array(blockCount(w));
}

/** Marks every block the half-open span [startMs, endMs) overlaps. A span with no length marks none. */
export function markBusy(blocks: Uint8Array, w: FreeBusyWindow, startMs: number, endMs: number) {
  if (!(endMs > startMs)) return;
  const first = Math.max(0, Math.floor((startMs - w.fromMs) / BLOCK_MS));
  const last = Math.min(blocks.length - 1, Math.ceil((endMs - w.fromMs) / BLOCK_MS) - 1);
  for (let i = first; i <= last; i++) blocks[i] = 1;
}

export function encodeBlocks(blocks: Uint8Array): string {
  let out = "";
  for (const b of blocks) out += b === 1 ? "1" : "0";
  return out;
}

/** Builds the wire reply for a window from its busy blocks. */
export function buildReply(w: FreeBusyWindow, blocks: Uint8Array): FreeBusyReply {
  return { fromMs: w.fromMs, blockMs: BLOCK_MS, blocks: encodeBlocks(blocks) };
}

/**
 * Strictly reads a peer's reply for the window we asked about: exactly the three fields, the
 * agreed start and block length, and a `0`/`1` string of exactly the right length. Anything else is
 * `undefined` (the caller reports a malformed answer); extra fields are never carried over.
 */
export function parseReply(raw: unknown, w: FreeBusyWindow): Uint8Array | undefined {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  if (r["fromMs"] !== w.fromMs || r["blockMs"] !== BLOCK_MS) return undefined;
  const s = r["blocks"];
  const n = blockCount(w);
  if (typeof s !== "string" || s.length !== n || !/^[01]*$/.test(s)) return undefined;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = s.charCodeAt(i) === 49 ? 1 : 0;
  return out;
}

export type Slot = { readonly startMs: number; readonly endMs: number };

/**
 * The maximal runs of blocks free on BOTH sides that are at least `durationMs` long, earliest
 * first. A run is reported whole (start to end); the person picks a start inside it.
 */
export function commonFreeSlots(
  w: FreeBusyWindow,
  mine: Uint8Array,
  theirs: Uint8Array,
  durationMs: number,
): Slot[] {
  const out: Slot[] = [];
  let runStart = -1;
  const close = (endIndex: number): void => {
    if (runStart < 0) return;
    const startMs = w.fromMs + runStart * BLOCK_MS;
    const endMs = w.fromMs + endIndex * BLOCK_MS;
    if (endMs - startMs >= durationMs) out.push({ startMs, endMs });
    runStart = -1;
  };
  for (let i = 0; i < mine.length; i++) {
    const free = mine[i] !== 1 && theirs[i] !== 1;
    if (free && runStart < 0) runStart = i;
    if (!free) close(i);
  }
  close(mine.length);
  return out;
}
