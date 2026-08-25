import { syncPassCursorSuccess } from "../../sync/pass-cursor-sync-result.ts";
import type { Provider } from "../../sync/rate-limiter.ts";
import { type SyncContext, type SyncResult, syncNoopResult } from "../../sync/types.ts";
import type { SyncUpsertRow } from "./paginated-sync.ts";

/**
 * Parse a numeric secret (e.g. an IMAP port) in the range [1, 65535]. Returns
 * `fallback` when the value is absent, empty, non-numeric, or out of range.
 * Byte-identical to the `intFromSecret` helpers it replaces in the imap +
 * protonmail sync bodies.
 */
export function parsePortSecret(raw: string | null | undefined, fallback: number): number {
  const t = raw?.trim() ?? "";
  if (t === "") {
    return fallback;
  }
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n <= 65535 ? Math.trunc(n) : fallback;
}

/** A single fetch of message views, or a transient/connection failure (no throw). */
export type ImapLikeFetchOutcome<Msg> =
  | { readonly ok: true; readonly messages: readonly Msg[] }
  | { readonly ok: false; readonly error: string };

/**
 * Run one single-pass IMAP-style sync cycle: ensure-running → load config (noop
 * if unconfigured) → rate-limit → fetch (a throw OR `{ok:false}` degrades to a
 * transient result that preserves the cursor, never crashing the scheduler) →
 * map + upsert each message → pass-1 success. Generic over the connection-config
 * and message-view types so it imports nothing from the connector modules (no
 * dependency cycle). Behaviour-identical to the hand-written imap/protonmail
 * `sync()` bodies it replaces; the `serviceId` is interpolated into the warn
 * messages exactly as before (`<serviceId> sync: …`).
 */
export async function runImapLikeSync<Cfg, Msg>(
  ctx: SyncContext,
  cursor: string | null,
  opts: {
    readonly serviceId: Provider;
    readonly ensureRunning: () => Promise<void>;
    readonly loadConfig: (ctx: SyncContext) => Promise<Cfg | null>;
    readonly fetchMessages: (config: Cfg, limit: number) => Promise<ImapLikeFetchOutcome<Msg>>;
    readonly maxMessages: number;
    readonly pass1Cursor: () => string;
    readonly mapMessage: (msg: Msg, syncedAt: number) => SyncUpsertRow | null;
  },
): Promise<SyncResult> {
  const t0 = performance.now();
  await opts.ensureRunning();

  const config = await opts.loadConfig(ctx);
  if (config === null) {
    return syncNoopResult(cursor, t0);
  }

  await ctx.rateLimiter.acquire(opts.serviceId);

  const transient = (): SyncResult => ({
    cursor: cursor ?? opts.pass1Cursor(),
    itemsUpserted: 0,
    itemsDeleted: 0,
    hasMore: false,
    durationMs: Math.round(performance.now() - t0),
  });

  let outcome: ImapLikeFetchOutcome<Msg>;
  try {
    outcome = await opts.fetchMessages(config, opts.maxMessages);
  } catch (err) {
    // Defence-in-depth: even if a fetcher throws, the scheduler must not crash.
    // Treat as a transient failure and preserve the cursor.
    ctx.logger.warn(
      { serviceId: opts.serviceId, err: err instanceof Error ? err.message : String(err) },
      `${opts.serviceId} sync: fetch threw; treating as transient failure`,
    );
    return transient();
  }

  if (!outcome.ok) {
    ctx.logger.warn(
      { serviceId: opts.serviceId, error: outcome.error },
      `${opts.serviceId} sync: connection/fetch failed; preserving cursor`,
    );
    return transient();
  }

  const now = Date.now();
  let upserted = 0;
  for (const msg of outcome.messages) {
    const mapped = opts.mapMessage(msg, now);
    if (mapped !== null) {
      ctx.upsertItem(mapped);
      upserted += 1;
    }
  }

  return syncPassCursorSuccess(t0, 0, opts.pass1Cursor(), upserted);
}
