/**
 * Gateway-side iCloud Mail + Calendar sync.
 *
 * Mail: iCloud Mail speaks plain IMAP over TLS (imap.mail.me.com:993).
 * Calendar: iCloud Calendar speaks CalDAV (caldav.icloud.com).
 *
 * Authentication for both uses the account's app-specific password (NOT the
 * Apple ID password), stored in the Vault under `apple.icloud_email` +
 * `apple.icloud_app_password`.
 *
 * The sync body runs in two sequential passes:
 *  1. Mail pass — via `runImapLikeSync` (reuses the shared IMAP-like engine).
 *  2. Calendar pass — ensure running → load config → rate-limit → fetch →
 *     parse (SDK) → map → upsert. A calendar-fetch failure degrades gracefully
 *     (warning log, mail cursor preserved) rather than crashing the cycle.
 */
import { parseICalendar } from "@nimbus-dev/sdk";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import type { Syncable, SyncContext, SyncResult } from "../sync/types.ts";
import {
  type AppleCalConfig,
  type AppleEventFetcher,
  computeCalWindow,
  loadCalConfig,
} from "./_lib/apple-caldav-fetch.ts";
import { runImapLikeSync } from "./_lib/imap-sync-core.ts";
import { mapAppleEventToItem } from "./apple-event-mapping.ts";
import { mapImapLikeMessageToItem } from "./imap-email-mapping.ts";
import type { ImapConnectionConfig, ImapMessageFetcher } from "./imap-sync.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "apple" as const;
const CURSOR_PREFIX = "nimbus-apple1:";
const DEFAULT_MAILBOX = "INBOX";
/** Fixed iCloud IMAP endpoint — always port 993 over implicit TLS. */
const ICLOUD_IMAP_HOST = "imap.mail.me.com";
const ICLOUD_IMAP_PORT = 993;
/** Single forward pass per cycle: index the most-recent N messages. */
const MAX_MESSAGES = 200;

type AppleCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies AppleCursorV1);
}

/**
 * Resolve the iCloud Mail connection config from the Vault.
 *
 * Reads `apple.icloud_email` (the full iCloud e-mail address) and
 * `apple.icloud_app_password` (the app-specific password generated under
 * Apple ID → Sign-In & Security → App-Specific Passwords). Both must be
 * non-empty; returns `null` if either is absent so the scheduler skips
 * the cycle gracefully.
 *
 * The mailbox is read from `apple.mailbox` (optional, defaults to "INBOX").
 * Host, port, and TLS mode are fixed constants — iCloud Mail does not
 * allow user-configurable endpoints.
 */
export async function loadMailConfig(ctx: SyncContext): Promise<ImapConnectionConfig | null> {
  const email = (await ctx.getSecret("icloud_email"))?.trim() ?? "";
  const appPw = (await ctx.getSecret("icloud_app_password"))?.trim() ?? "";
  if (email === "" || appPw === "") {
    return null;
  }
  const mailbox = (await ctx.getSecret("mailbox"))?.trim() || DEFAULT_MAILBOX;
  return {
    host: ICLOUD_IMAP_HOST,
    port: ICLOUD_IMAP_PORT,
    secure: true,
    username: email,
    password: appPw,
    mailbox,
  };
}

/**
 * Options for the Apple syncable. Both `fetchMessages` (IMAP) and
 * `fetchEvents` (CalDAV) seams are injected so tests can exercise either path
 * without opening real network sockets.
 */
export type AppleSyncableOptions = {
  /** Ensure the apple MCP connector process is running before fetching. */
  ensureAppleMcpRunning: () => Promise<void>;
  /** Injected IMAP fetcher (real over imapflow in prod; fake in tests). */
  fetchMessages: ImapMessageFetcher;
  /** Injected CalDAV fetcher (real over tsdav in prod; fake in tests). */
  fetchEvents: AppleEventFetcher;
};

/**
 * Run the CalDAV calendar pass after the mail pass.
 *
 * Returns the number of event rows upserted. On any failure (config absent,
 * fetch error), logs a warning and returns 0 — the overall sync result is
 * still a success (mail cursor is preserved).
 */
async function runCalendarPass(
  ctx: SyncContext,
  ensureRunning: () => Promise<void>,
  fetchEvents: AppleEventFetcher,
): Promise<number> {
  await ensureRunning();

  const config: AppleCalConfig | null = await loadCalConfig(ctx);
  if (config === null) {
    // Calendar not configured (or creds absent) — skip silently.
    return 0;
  }

  await ctx.rateLimiter.acquire(SERVICE_ID);

  const window = computeCalWindow(config, Date.now());
  const outcome = await fetchEvents(config, window);

  if (!outcome.ok) {
    ctx.logger.warn(
      { serviceId: SERVICE_ID, error: outcome.error },
      "apple sync: calendar fetch failed; skipping calendar pass",
    );
    return 0;
  }

  const syncedAt = Date.now();
  let upserted = 0;

  // The same calendar can span multiple ICS entries (one per expanded object),
  // so the per-calendar cap must accumulate across entries — not reset per entry.
  const perCalendarCounts = new Map<string, number>();
  for (const { calendar, ics } of outcome.events) {
    const events = parseICalendar(ics);
    let calCount = perCalendarCounts.get(calendar) ?? 0;
    for (const ev of events) {
      if (calCount >= config.maxInstancesPerCalendar) {
        break;
      }
      const row = mapAppleEventToItem(ev, { calendar, syncedAt });
      if (row !== null) {
        upsertIndexedItemForSync(ctx, row);
        upserted += 1;
        calCount += 1;
      }
    }
    perCalendarCounts.set(calendar, calCount);
  }

  return upserted;
}

/**
 * Apple (iCloud Mail + Calendar) syncable — registers under `serviceId:
 * "apple"` with the scheduler.
 *
 * The sync body runs two sequential passes:
 *  1. Mail pass via `runImapLikeSync`.
 *  2. Calendar pass: ensure-running → load config → rate-limit → fetch →
 *     parse (SDK `parseICalendar`) → map → upsert. Failures degrade
 *     gracefully; the mail cursor and upsert count are preserved.
 */
export function createAppleSyncable(options: AppleSyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 5 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      // Pass 1: mail
      const mailResult = await runImapLikeSync(ctx, cursor, {
        serviceId: SERVICE_ID,
        ensureRunning: options.ensureAppleMcpRunning,
        loadConfig: loadMailConfig,
        fetchMessages: options.fetchMessages,
        maxMessages: MAX_MESSAGES,
        pass1Cursor,
        mapMessage: (msg, syncedAt) => mapImapLikeMessageToItem(SERVICE_ID, msg, { syncedAt }),
      });

      // Pass 2: calendar (additive — failures do not invalidate the mail result)
      let calUpserted = 0;
      try {
        calUpserted = await runCalendarPass(
          ctx,
          options.ensureAppleMcpRunning,
          options.fetchEvents,
        );
      } catch (err) {
        ctx.logger.warn(
          { serviceId: SERVICE_ID, err: err instanceof Error ? err.message : String(err) },
          "apple sync: calendar pass threw; treating as non-fatal",
        );
      }

      // Merge: preserve the mail cursor; sum upsert counts.
      return {
        ...mailResult,
        itemsUpserted: mailResult.itemsUpserted + calUpserted,
      };
    },
  };
}
