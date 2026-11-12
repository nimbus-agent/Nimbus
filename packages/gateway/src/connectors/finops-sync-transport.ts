import {
  DAY_MS,
  FIRST_WINDOW_DAYS,
  RESTATE_WINDOW_DAYS,
  startOfUtcDay,
} from "../finops/cost-item-contract.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  type ConnectorSessionRequest,
  type ConnectorToolSession,
  withConnectorSession,
} from "../teamvault/connector-session.ts";
import { parseMcpListPage } from "./connector-list-page.ts";
import { decodeNimbusJsonCursorObject, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

/** Hard backstop against a cursor that never ends. */
const MAX_PAGES = 200;

/** The window one sync asks the vendor for. */
export interface FinopsWindow {
  readonly sinceMs: number;
  readonly untilMs: number;
}

/** One paged read of the connector: its tool, the arguments it takes besides `cursor`, and a key. */
export interface FinopsDrainCall<K extends string = string> {
  readonly key: K;
  readonly toolId: string;
  readonly args: Readonly<Record<string, unknown>>;
}

export interface FinopsSyncSpec<P, K extends string> {
  readonly serviceId: string;
  readonly defaultIntervalMs: number;
  readonly initialSyncDepthDays: number;
  /** Cursor prefix, e.g. `nimbus-vantage1:`; the payload is `{ lastOkMs }`. */
  readonly cursorPrefix: string;
  /**
   * The item type whose presence makes the cursor trustworthy. The scheduler keeps the cursor in
   * `scheduler_state`, which neither `nimbus data delete` nor `connector remove` clears, so a cursor
   * can outlive the rows it describes: with no row of this type indexed the cursor is ignored and
   * the first window (45 days) is read again.
   */
  readonly cursorRowType: string;
  /** Read the owner's options and refuse a configuration that cannot sync, before any spawn. */
  readonly configure: (ctx: SyncContext) => Promise<P>;
  /** The paged reads for this window, run in order inside ONE connector session. */
  readonly drains: (window: FinopsWindow, prepared: P) => readonly FinopsDrainCall<K>[];
  /** Map and write everything drained, in one batch; returns the number of rows written. */
  readonly index: (
    ctx: SyncContext,
    drained: Readonly<Record<K, readonly unknown[]>>,
    syncedAt: number,
    prepared: P,
  ) => number;
}

type SessionRunner = <T>(
  req: ConnectorSessionRequest,
  body: (session: ConnectorToolSession) => Promise<T>,
) => Promise<T>;

let sessionRunnerOverride: SessionRunner | undefined;

/** TEST-ONLY DI seam (avoids spawning a real subprocess). Pass `undefined` to restore. */
export function __setFinopsSessionRunnerForTest(fn: SessionRunner | undefined): void {
  sessionRunnerOverride = fn;
}

/**
 * Drain one paged tool to its end, sending `args` plus `cursor` on every call and following
 * `nextCursor`. The arguments are exactly the caller's: a tool whose schema caps `limit` lower must
 * be given that limit, never the transport's own. A cursor that does not advance, or more than
 * {@link MAX_PAGES} pages, is an error: a partial drain must never be indexed.
 */
export async function drainWithArgs(
  session: ConnectorToolSession,
  toolId: string,
  args: Readonly<Record<string, unknown>>,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await session.call(toolId, { ...args, cursor });
    const { items: pageItems, nextCursor } = parseMcpListPage(res);
    items.push(...pageItems);
    if (nextCursor === null) {
      return items;
    }
    if (nextCursor === cursor) {
      throw new Error(`${toolId}: the cursor did not advance`);
    }
    cursor = nextCursor;
  }
  throw new Error(`${toolId}: more than ${String(MAX_PAGES)} pages; refusing a partial read`);
}

/** `lastOkMs` from a cursor of this prefix, or null when there is none to read. */
export function lastOkMsFromCursor(cursor: string | null, prefix: string): number | null {
  const payload = decodeNimbusJsonCursorObject(cursor, prefix);
  const v = payload?.["lastOkMs"];
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/** The first sync reads 45 days; a later one re-reads from three UTC days before the last success. */
export function windowFor(lastOkMs: number | null, now: number): FinopsWindow {
  const sinceMs =
    lastOkMs === null
      ? now - FIRST_WINDOW_DAYS * DAY_MS
      : Math.min(startOfUtcDay(lastOkMs) - RESTATE_WINDOW_DAYS * DAY_MS, now);
  return { sinceMs, untilMs: now };
}

/**
 * A FinOps syncable on a transport that passes `sinceMs`/`untilMs` (the warehouse transport drains
 * with fixed arguments and is tied to the team-credential connectors). Personal credentials only
 * (D-FO-7): a `team` pin for the service throws before any spawn. ALL drains finish before anything
 * is written, so a failed or rate-limited drain indexes nothing and the cursor stays where it was
 * (the scheduler persists a cursor only for a sync that returns).
 */
export function createFinopsSyncable<P, K extends string>(spec: FinopsSyncSpec<P, K>): Syncable {
  return {
    serviceId: spec.serviceId,
    defaultIntervalMs: spec.defaultIntervalMs,
    initialSyncDepthDays: spec.initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      if (ctx.credentialFor(spec.serviceId).credential === "team") {
        throw new Error(
          `connectors.${spec.serviceId}: credential = "team" is not supported for cost data; ` +
            "a cost connector reads with the owner's own token",
        );
      }
      const prepared = await spec.configure(ctx);
      const lastOkMs =
        ctx.countItems(spec.serviceId, spec.cursorRowType) === 0
          ? null
          : lastOkMsFromCursor(cursor, spec.cursorPrefix);
      const window = windowFor(lastOkMs, Date.now());
      const run = sessionRunnerOverride ?? withConnectorSession;
      const drained = await run(
        {
          service: spec.serviceId,
          vaultView: ctx.scopedVaultView(spec.serviceId),
          sandboxCwd: ctx.sandboxCwd,
        },
        async (session) => {
          const out = {} as Record<K, unknown[]>;
          for (const call of spec.drains(window, prepared)) {
            out[call.key] = await drainWithArgs(session, call.toolId, call.args); // NOSONAR S9382: one connector session, one drain after another - the vendor paces its own requests
          }
          return out;
        },
      );
      const syncedAt = Date.now();
      const upserted = spec.index(ctx, drained, syncedAt, prepared);
      return {
        cursor: encodeNimbusJsonCursor(spec.cursorPrefix, { lastOkMs: syncedAt }),
        itemsUpserted: upserted,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}
