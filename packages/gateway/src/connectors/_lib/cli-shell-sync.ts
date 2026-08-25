import {
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../../sync/pass-cursor-sync-result.ts";
import { type SyncContext, type SyncResult, syncNoopResult } from "../../sync/types.ts";
import type { SyncUpsertRow } from "./paginated-sync.ts";

export type { SyncUpsertRow };

/**
 * Guard a value before it is passed as a positional/flag-value to a spawned CLI
 * process. Spawns use an argv array (no shell), but a value beginning with `-`
 * would be parsed by the CLI as a FLAG (argv flag smuggling). Values that are
 * empty, exceed 1024 chars, start with `-`, or carry a control character are
 * rejected so they never appear in an argv.
 */
export function isSafeCliArg(value: string): boolean {
  if (value.length === 0 || value.length > 1024 || value.startsWith("-")) {
    return false;
  }
  for (let i = 0; i < value.length; i += 1) {
    const cp = value.codePointAt(i);
    if (cp !== undefined && cp < 0x20) {
      return false;
    }
  }
  return true;
}

/** Outcome from a single CLI page invocation. */
export interface CliShellOutcome {
  readonly ok: boolean;
  readonly text: string;
  readonly bytes?: number;
}

/** Items parsed from a single CLI page response. */
export interface ParsedCliPage {
  readonly items: readonly unknown[];
  readonly hasMore: boolean;
  /** Continuation token for the next page (omit/undefined for single-result connectors). */
  readonly nextPageCursor?: string;
}

/**
 * Spec for a single-pass CLI-shell sync. Mirrors {@link PaginatedSyncSpec} from
 * `paginated-sync.ts` but invokes a CLI runner instead of an HTTP `fetchPage`.
 */
export interface CliShellSyncSpec<C> {
  /** Start the connector's MCP process if needed (called before credential load). */
  readonly ensureRunning: () => Promise<void>;
  /** Load credentials, or null when unconfigured (→ noop). */
  readonly loadCreds: () => Promise<C | null>;
  /** The pass-1 cursor string persisted on every terminal result. */
  readonly pass1Cursor: () => string;
  /** Maximum number of CLI page invocations. */
  readonly maxPages: number;
  /**
   * Run one CLI page. `pageCursor` is "" on the first page, then the previous
   * page's `nextPageCursor`. Token-paginated connectors use it; single-result
   * connectors ignore it.
   */
  readonly runCliPage: (creds: C, page: number, pageCursor: string) => Promise<CliShellOutcome>;
  /** Parse a successful CLI response into items + whether more pages follow (+ optional next cursor). */
  readonly parsePage: (text: string, page: number) => ParsedCliPage;
  /** Map one raw item to an upsert row, or null to skip. Receives `creds` and `now` for context. */
  readonly map: (raw: unknown, creds: C, now: number) => SyncUpsertRow | null;
}

/**
 * Run a single-pass CLI-shell sync: ensure-running → load creds (noop if
 * unconfigured) → walk pages (first-page error degrades to a parse-empty
 * pass-cursor result; later-page error breaks) → upsert mapped items → pass-1
 * success. The loop threads `pageCursor` (""→prev `nextPageCursor`) so both
 * single-result and token-paginated connectors are covered. Behaviour-identical
 * to the hand-written single-pass connector `sync()` bodies it replaces.
 */
export async function runSinglePassCliShellSync<C>(
  ctx: SyncContext,
  cursor: string | null,
  spec: CliShellSyncSpec<C>,
): Promise<SyncResult> {
  const t0 = performance.now();
  await spec.ensureRunning();
  const creds = await spec.loadCreds();
  if (creds === null) {
    return syncNoopResult(cursor, t0);
  }

  const now = Date.now();
  let totalBytes = 0;
  let totalUpserted = 0;
  let pageCursor = "";

  for (let i = 0; i < spec.maxPages; i += 1) {
    const outcome = await spec.runCliPage(creds, i, pageCursor);
    const bytes = outcome.bytes ?? outcome.text.length;
    totalBytes += bytes;
    if (!outcome.ok) {
      if (i === 0) {
        return syncPassCursorParseEmpty(t0, totalBytes, spec.pass1Cursor());
      }
      break;
    }

    const parsed = spec.parsePage(outcome.text, i);
    for (const raw of parsed.items) {
      const mapped = spec.map(raw, creds, now);
      if (mapped === null) {
        continue;
      }
      ctx.upsertItem(mapped);
      totalUpserted += 1;
    }
    if (!parsed.hasMore) {
      break;
    }
    pageCursor = parsed.nextPageCursor ?? "";
  }

  return syncPassCursorSuccess(t0, totalBytes, spec.pass1Cursor(), totalUpserted);
}
