import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../../sync/pass-cursor-sync-result.ts";
import { type SyncContext, type SyncResult, syncNoopResult } from "../../sync/types.ts";
import type { FetchOutcome } from "./fetch-outcome.ts";

/** The row shape accepted by {@link upsertIndexedItemForSync}. */
export type SyncUpsertRow = Parameters<SyncContext["upsertItem"]>[0];

/**
 * Map each raw item and upsert the non-null results, returning the count
 * upserted. Mirrors the per-connector `upsert*` loop verbatim.
 */
export function upsertMapped(
  ctx: SyncContext,
  items: readonly unknown[],
  map: (raw: unknown) => SyncUpsertRow | null,
): number {
  let upserted = 0;
  for (const raw of items) {
    const mapped = map(raw);
    if (mapped === null) {
      continue;
    }
    ctx.upsertItem(mapped);
    upserted += 1;
  }
  return upserted;
}

/** A page's parsed items, whether to fetch the next page, and (for cursor/token
 * pagination) the opaque token threaded into the NEXT `fetchPage` call. */
export interface ParsedPage {
  readonly items: readonly unknown[];
  readonly hasMore: boolean;
  /** Token/path for the next page (continuation-token connectors). Omit/"" for page-number connectors. */
  readonly nextPageCursor?: string;
}

/** Bare-array page parser: items are the JSON array; another page exists iff the page was full. */
export function bareArrayPage(
  parsed: unknown,
  pageSize: number,
): { items: unknown[]; hasMore: boolean } {
  const items = Array.isArray(parsed) ? parsed : [];
  return { items, hasMore: items.length >= pageSize };
}

export interface PaginatedSyncSpec<C> {
  /** Start the connector's MCP process if needed (called before credential load). */
  readonly ensureRunning: () => Promise<void>;
  /** Load credentials, or null when unconfigured (→ noop). */
  readonly loadCreds: () => Promise<C | null>;
  /** The pass-1 cursor string persisted on every terminal result. */
  readonly pass1Cursor: () => string;
  /** Maximum number of page fetches. */
  readonly maxPages: number;
  /** First page number (default 1). */
  readonly startPage?: number;
  /**
   * Fetch one page. `pageCursor` is "" on the first page, then the previous
   * page's `nextPageCursor`. Page-number connectors ignore it and use `page`;
   * continuation-token connectors use it (as the token or the next path).
   */
  readonly fetchPage: (creds: C, page: number, pageCursor: string) => Promise<FetchOutcome>;
  /** Parse a successful page into items + whether more pages follow (+ optional next cursor). */
  readonly parsePage: (parsed: unknown, page: number) => ParsedPage;
  /** Map one raw item to an upsert row, or null to skip. Receives `creds` (some mappers need creds-derived context, e.g. a base URL) and `now`. */
  readonly map: (raw: unknown, creds: C, now: number) => SyncUpsertRow | null;
}

/**
 * Run a single-pass paginated sync: ensure-running → load creds (noop if
 * unconfigured) → walk pages (first-page error degrades to an empty pass-cursor
 * result; later-page error breaks) → upsert mapped items → pass-1 success. The
 * loop threads `pageCursor` (""→prev `nextPageCursor`) so both page-number and
 * continuation-token connectors are covered. Behaviour-identical to the
 * hand-written single-pass connector `sync()` bodies.
 */
export async function runSinglePassPaginatedSync<C>(
  ctx: SyncContext,
  cursor: string | null,
  spec: PaginatedSyncSpec<C>,
): Promise<SyncResult> {
  const t0 = performance.now();
  await spec.ensureRunning();
  const creds = await spec.loadCreds();
  if (creds === null) {
    return syncNoopResult(cursor, t0);
  }

  const now = Date.now();
  const startPage = spec.startPage ?? 1;
  let totalBytes = 0;
  let totalUpserted = 0;
  let pageCursor = "";

  for (let i = 0; i < spec.maxPages; i += 1) {
    const page = startPage + i;
    const outcome = await spec.fetchPage(creds, page, pageCursor);
    totalBytes += outcome.bytes;
    if (outcome.kind !== "ok") {
      if (i === 0) {
        return outcome.kind === "http_error"
          ? syncPassCursorHttpEmpty(t0, totalBytes, cursor, spec.pass1Cursor())
          : syncPassCursorParseEmpty(t0, totalBytes, spec.pass1Cursor());
      }
      break;
    }

    const parsed = spec.parsePage(outcome.parsed, page);
    totalUpserted += upsertMapped(ctx, parsed.items, (raw) => spec.map(raw, creds, now));
    if (!parsed.hasMore) {
      break;
    }
    pageCursor = parsed.nextPageCursor ?? "";
  }

  return syncPassCursorSuccess(t0, totalBytes, spec.pass1Cursor(), totalUpserted);
}
