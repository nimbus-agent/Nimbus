/**
 * Gateway-side CalDAV fetch layer for iCloud Calendar.
 *
 * fetchAppleCalendarEvents is the injectable-seam entry point used by the
 * sync engine. It delegates to a transport parameter (default:
 * defaultCalDavTransport, the real tsdav network call). Tests inject a fake
 * transport; the real transport is kept thin and coverage-excluded so it never
 * imposes a network dependency on the test suite.
 *
 * Architecture notes:
 *  - The gateway must NOT import from packages/mcp-connectors.
 *  - parseICalendar / ParsedEvent come from @nimbus-dev/sdk.
 *  - The fetch ORCHESTRATION (login → discover → select → expand) lives in
 *    `collectCalDavEvents`, which runs against an injected `CalDavBootstrap` so it
 *    is unit-tested with a fake (no sockets). The real `defaultCalDavTransport` is
 *    a thin shell that constructs the tsdav `DAVClient` — the only genuinely
 *    untestable network bit — and delegates; it is excluded from coverage.
 */
import type { SyncContext } from "../../sync/types.ts";

// ─── Config ───────────────────────────────────────────────────────────────────

/** Resolved configuration for a single CalDAV sync cycle. */
export interface AppleCalConfig {
  /** iCloud email address (also the CalDAV principal username). */
  readonly email: string;
  /** App-specific password for CalDAV authentication. */
  readonly appPw: string;
  /**
   * When non-empty, only calendars whose displayName is in this list are synced.
   * Takes precedence over excludeCalendars.
   */
  readonly includeCalendars?: readonly string[];
  /** Calendar displayNames to skip (ignored when includeCalendars is set). */
  readonly excludeCalendars?: readonly string[];
  /** How many days in the past to include in the time window. Default: 90. */
  readonly windowPastDays: number;
  /** How many days in the future to include. Default: 365. */
  readonly windowFutureDays: number;
  /** Per-calendar cap on returned raw ICS objects. Default: 1000. */
  readonly maxInstancesPerCalendar: number;
}

// ─── Transport seam ───────────────────────────────────────────────────────────

/** One calendar's raw (expanded) ICS blob as returned by the transport. */
export interface CalendarIcsEntry {
  readonly calendar: string;
  readonly ics: string;
}

/**
 * Injectable network transport. Tests pass a fake; the real implementation
 * uses tsdav and is coverage-excluded.
 */
export type CalDavTransport = (
  config: AppleCalConfig,
  window: { startUtc: string; endUtc: string },
) => Promise<CalendarIcsEntry[]>;

// ─── Public types ─────────────────────────────────────────────────────────────

/** Outcome of a CalDAV fetch cycle (mirrors the {ok} shape used elsewhere). */
export type AppleEventFetchOutcome =
  | { readonly ok: true; readonly events: CalendarIcsEntry[] }
  | { readonly ok: false; readonly error: string };

/**
 * Injectable fetcher type consumed by createAppleSyncable.
 * Matches the signature of fetchAppleCalendarEvents without the optional
 * transport parameter.
 */
export type AppleEventFetcher = (
  config: AppleCalConfig,
  window: { startUtc: string; endUtc: string },
) => Promise<AppleEventFetchOutcome>;

// ─── Real transport (coverage-excluded) ──────────────────────────────────────

/** A single raw calendar object as returned by the CalDAV `calendar-query` REPORT. */
export interface CalDavObject {
  readonly url?: string;
  readonly data?: unknown;
}

/**
 * The minimal subset of tsdav's `DAVClient` the fetch orchestration depends on.
 * Injecting this (rather than reaching for `tsdav` directly) keeps the discover →
 * select → expand loop unit-testable with a fake — no sockets in the test path.
 */
export interface CalDavBootstrap {
  login(): Promise<unknown>;
  fetchCalendars(): Promise<{ url: string; displayName?: string }[]>;
  fetchCalendarObjects(params: {
    calendar: { url: string; displayName?: string };
    timeRange: { start: string; end: string };
    expand: boolean;
  }): Promise<CalDavObject[]>;
}

/**
 * Run the CalDAV fetch cycle against an injected bootstrap client: log in,
 * discover calendars, filter to the configured selection, then fetch the
 * server-expanded ICS objects per calendar (capped at maxInstancesPerCalendar).
 * No socket construction here — the real `DAVClient` is built by
 * `defaultCalDavTransport` and passed in — so this is the unit-tested core.
 */
export async function collectCalDavEvents(
  bootstrap: CalDavBootstrap,
  config: AppleCalConfig,
  window: { startUtc: string; endUtc: string },
): Promise<CalendarIcsEntry[]> {
  await bootstrap.login();
  const allCalendars = await bootstrap.fetchCalendars();
  const selected = selectCalendars(allCalendars, {
    include: config.includeCalendars,
    exclude: config.excludeCalendars,
  });
  const results: CalendarIcsEntry[] = [];
  for (const cal of selected) {
    const objects = await bootstrap.fetchCalendarObjects({
      calendar: cal,
      timeRange: { start: window.startUtc, end: window.endUtc },
      expand: true,
    });
    let pushed = 0;
    for (const obj of objects) {
      if (pushed >= config.maxInstancesPerCalendar) break;
      if (typeof obj.data === "string" && obj.data.trim() !== "") {
        results.push({ calendar: cal.displayName ?? cal.url, ics: obj.data });
        pushed++;
      }
    }
  }
  return results;
}

// ─── Real transport (thin network shell, coverage-excluded) ───────────────────

/* c8 ignore start -- constructs the real tsdav DAVClient (sockets); the
   testable orchestration lives in collectCalDavEvents above. */
const defaultCalDavTransport: CalDavTransport = async (config, window) => {
  const { DAVClient } = await import("tsdav");
  const bootstrap = new DAVClient({
    serverUrl: "https://caldav.icloud.com",
    credentials: { username: config.email, password: config.appPw },
    authMethod: "Basic",
    defaultAccountType: "caldav",
  });
  return collectCalDavEvents(bootstrap as unknown as CalDavBootstrap, config, window);
};
/* c8 ignore stop */

// ─── Calendar selection (pure, tested) ───────────────────────────────────────

/**
 * Filter a list of raw calendar objects returned by tsdav to only the ones the
 * config wants. Pure function — no I/O.
 *
 * - If include is non-empty, return only calendars whose displayName is in
 *   the include list (exact match). Takes precedence over exclude.
 * - If only exclude is non-empty, return all calendars whose displayName is
 *   NOT in the exclude list.
 * - If both are empty/absent, return all calendars.
 */
export function selectCalendars(
  calendars: readonly { url: string; displayName?: string }[],
  cfg: { include?: readonly string[] | undefined; exclude?: readonly string[] | undefined },
): { url: string; displayName?: string }[] {
  const include = cfg.include;
  const exclude = cfg.exclude;

  if (include !== undefined && include.length > 0) {
    const set = new Set(include);
    return calendars.filter((c) => c.displayName !== undefined && set.has(c.displayName));
  }
  if (exclude !== undefined && exclude.length > 0) {
    const set = new Set(exclude);
    return calendars.filter((c) => c.displayName === undefined || !set.has(c.displayName));
  }
  return [...calendars];
}

// ─── Window computation ───────────────────────────────────────────────────────

/**
 * Compute the UTC ISO-8601 time window for a CalDAV expand query.
 *
 * nowMs is injectable so callers / tests can pin the clock.
 */
export function computeCalWindow(
  cfg: Pick<AppleCalConfig, "windowPastDays" | "windowFutureDays">,
  nowMs: number,
): { startUtc: string; endUtc: string } {
  const startMs = nowMs - cfg.windowPastDays * 86_400_000;
  const endMs = nowMs + cfg.windowFutureDays * 86_400_000;
  return {
    startUtc: new Date(startMs).toISOString(),
    endUtc: new Date(endMs).toISOString(),
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Fetch all CalDAV events for the configured calendars within the given time
 * window. Never throws — connection/protocol failures are caught and returned
 * as {ok: false, error}.
 *
 * The transport parameter is the injectable seam: tests pass a fake that
 * returns fixture ICS data; production uses defaultCalDavTransport (tsdav).
 */
export async function fetchAppleCalendarEvents(
  config: AppleCalConfig,
  window: { startUtc: string; endUtc: string },
  transport: CalDavTransport = defaultCalDavTransport,
): Promise<AppleEventFetchOutcome> {
  try {
    const events = await transport(config, window);
    return { ok: true, events };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ─── Config loader ────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_PAST_DAYS = 90;
const DEFAULT_WINDOW_FUTURE_DAYS = 365;
const DEFAULT_MAX_INSTANCES = 1000;

function parsePositiveInt(raw: string, fallback: number): number {
  if (raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : fallback;
}

/**
 * Resolve the CalDAV sync configuration from the Vault.
 *
 * Returns null when either apple.icloud_email or apple.icloud_app_password
 * is absent (the connector is unconfigured); the scheduler will skip the
 * calendar pass gracefully.
 *
 * Window and selection parameters are read from optional vault keys
 * with safe defaults:
 *  - apple.cal_window_past_days   (default 90)
 *  - apple.cal_window_future_days (default 365)
 *  - apple.cal_max_instances      (default 1000)
 *  - apple.cal_include_calendars  (comma-separated displayNames; default: all)
 *  - apple.cal_exclude_calendars  (comma-separated displayNames; default: none)
 */
export async function loadCalConfig(ctx: SyncContext): Promise<AppleCalConfig | null> {
  const email = (await ctx.getSecret("icloud_email"))?.trim() ?? "";
  const appPw = (await ctx.getSecret("icloud_app_password"))?.trim() ?? "";
  if (email === "" || appPw === "") {
    return null;
  }

  // Optional calendar config keys. Read via readConnectorSecret (the approved
  // allow-list path) — they are listed in CONNECTOR_VAULT_SECRET_KEYS["apple"] so
  // they are cleared on connector removal and pass the D11 vault-key audit.
  const pastRaw = (await ctx.getSecret("cal_window_past_days"))?.trim() ?? "";
  const futureRaw = (await ctx.getSecret("cal_window_future_days"))?.trim() ?? "";
  const maxRaw = (await ctx.getSecret("cal_max_instances"))?.trim() ?? "";
  const includeRaw = (await ctx.getSecret("cal_include_calendars"))?.trim() ?? "";
  const excludeRaw = (await ctx.getSecret("cal_exclude_calendars"))?.trim() ?? "";

  function parseCommaSeparated(raw: string): readonly string[] | undefined {
    if (raw === "") return undefined;
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
  }

  const windowPastDays = parsePositiveInt(pastRaw, DEFAULT_WINDOW_PAST_DAYS);
  const windowFutureDays = parsePositiveInt(futureRaw, DEFAULT_WINDOW_FUTURE_DAYS);
  const maxInstancesPerCalendar = parsePositiveInt(maxRaw, DEFAULT_MAX_INSTANCES);
  const includeCalendars = parseCommaSeparated(includeRaw);
  const excludeCalendars = parseCommaSeparated(excludeRaw);

  const config: AppleCalConfig = {
    email,
    appPw,
    windowPastDays,
    windowFutureDays,
    maxInstancesPerCalendar,
    ...(includeCalendars === undefined ? {} : { includeCalendars }),
    ...(excludeCalendars === undefined ? {} : { excludeCalendars }),
  };

  return config;
}
