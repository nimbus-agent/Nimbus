/**
 * The OS-delivering `NotificationService` (pre-S3 item E): config, probe state, `title_only`,
 * a rate limit and text-free logging, around one platform `NotificationBackend`.
 *
 * ## `delivers` is LIVE
 *
 * `delivers` is a getter, not a snapshot. It is `false` when `[notifications] enabled = false`, or
 * once the probe has RESOLVED unavailable; `true` otherwise — including before and during the probe,
 * since `show()` awaits the probe and rejects if it comes back unavailable. A consumer that records
 * an outcome (the on-call push sinks) must read it at use time, not copy it at construction.
 *
 * An unavailable probe is retried — at most once per `PROBE_RETRY_MS`, on the next `show()`/`ready()`
 * — because the common cause is a gateway autostarted before the desktop session's bus/notifier.
 *
 * ## `show()` outcomes
 *
 *   - disabled by config → resolves, nothing shown (the `delivers: false` no-op contract);
 *   - backend unavailable → rejects (`NotificationUnavailableError`);
 *   - over the rate limit → rejects (`NotificationRateLimitedError`), counted for the summary toast;
 *   - backend send failed → rejects (`NotificationSendError`), logged with title + reason;
 *   - otherwise resolves once the backend accepted the toast.
 *
 * It never throws SYNCHRONOUSLY: producers fire it as `void notify(...)` mid-loop. But a REJECTION
 * from a `void`ed call is an unhandled rejection, which `exit-diagnostics.ts` turns into a gateway
 * exit — so every fire-and-forget call site must attach its own `.catch`. The rejections are typed
 * so a caller that records outcomes can tell a policy drop from a failure.
 *
 * ## Rate limit
 *
 * At most `RATE_LIMIT_MAX` toasts per rolling `RATE_LIMIT_WINDOW_MS`. Excess toasts are dropped and
 * counted; when the window next has room, ONE fixed-text summary toast reports how many were
 * dropped. The summary is sent either by a timer armed for that moment or, if a `show()` arrives
 * first, ahead of that toast. It counts against the window like any other toast.
 *
 * ## Logging
 *
 * Bodies are NEVER logged: watcher bodies carry indexed item titles, and `gateway-log-redact.ts`
 * scrubs secrets, not indexed content. Failures log the title (producers use fixed titles) and a
 * text-free reason.
 */
import type {
  NimbusNotificationsToml,
  NotificationContentMode,
} from "../../config/notifications-toml.ts";
import type { NotificationService, NotificationShowOptions } from "../types.ts";
import { createDarwinNotificationBackend } from "./darwin.ts";
import { createLinuxNotificationBackend } from "./linux.ts";
import {
  NOTIFICATION_TITLE_MAX_CHARS,
  type NotificationBackend,
  type NotificationBackendId,
  type NotificationEnvSource,
  type NotificationProbeResult,
  NotificationSendError,
  type NotificationSpawner,
  prepareNotificationText,
} from "./types.ts";
import { createWin32NotificationBackend } from "./win32.ts";

export const RATE_LIMIT_MAX = 5;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const PROBE_RETRY_MS = 5 * 60_000;

/** The body every toast carries under `content = "title_only"`. */
export const TITLE_ONLY_BODY = "Open Nimbus for details";

/** Title of the rate-limit summary toast. Fixed text apart from the count. */
export function rateLimitSummaryTitle(dropped: number): string {
  return `Nimbus: ${dropped} more notification${dropped === 1 ? "" : "s"}`;
}
export const RATE_LIMIT_SUMMARY_BODY = "Some notifications were not shown. Open Nimbus for details";

/** The service's `show()` rejects with this when the backend probe says it cannot deliver. */
export class NotificationUnavailableError extends Error {
  override readonly name = "NotificationUnavailableError";
}

/** The service's `show()` rejects with this when the toast was dropped by the rate limit. */
export class NotificationRateLimitedError extends Error {
  override readonly name = "NotificationRateLimitedError";
}

/** Structural so the pino logger fits without a cast. */
export type NotificationLogger = {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
};

export type OsNotificationStatus = {
  readonly backend: NotificationBackendId;
  readonly enabled: boolean;
  readonly content: NotificationContentMode;
  /**
   * `null` when not known: the probe has not resolved yet, or never runs because notifications
   * are disabled by config (nothing is spawned for a disabled service).
   */
  readonly available: boolean | null;
  readonly reason?: string;
  /** Toasts dropped by the rate limit since this service was created. */
  readonly rateLimitedTotal: number;
};

export interface OsNotificationService extends NotificationService {
  readonly delivers: boolean;
  status(): OsNotificationStatus;
  /** Start (or reuse) the probe and resolve the resulting status. Never rejects. */
  ready(): Promise<OsNotificationStatus>;
  /** Cancel a pending summary timer (gateway shutdown). Idempotent. */
  close(): void;
}

export type TimerHandle = { cancel(): void };

export type CreateOsNotificationsOptions = {
  readonly backend: NotificationBackend;
  readonly config: NimbusNotificationsToml;
  readonly logger: NotificationLogger;
  /** Clock (ms). Default `Date.now`. */
  readonly now?: () => number;
  /** Arm a one-shot timer. Default an UNREF'd `setTimeout`, so a pending summary never holds the
   * process open. */
  readonly setTimer?: (fn: () => void, delayMs: number) => TimerHandle;
};

function defaultSetTimer(fn: () => void, delayMs: number): TimerHandle {
  const t = setTimeout(fn, delayMs);
  t.unref?.();
  return { cancel: () => clearTimeout(t) };
}

type ProbeState =
  | { readonly kind: "idle" }
  | { readonly kind: "pending"; readonly promise: Promise<void> }
  | { readonly kind: "done"; readonly result: NotificationProbeResult; readonly at: number };

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : "notification failed";
}

export function createOsNotifications(opts: CreateOsNotificationsOptions): OsNotificationService {
  const { backend, config, logger } = opts;
  const now = opts.now ?? Date.now;
  const setTimer = opts.setTimer ?? defaultSetTimer;

  let probe: ProbeState = { kind: "idle" };
  const sentAt: number[] = [];
  let droppedPending = 0;
  let rateLimitedTotal = 0;
  let summaryTimer: TimerHandle | undefined;

  const status = (): OsNotificationStatus => {
    const base = {
      backend: backend.id,
      enabled: config.enabled,
      content: config.content,
      rateLimitedTotal,
    };
    if (!config.enabled) {
      return { ...base, available: null, reason: "disabled by [notifications] enabled = false" };
    }
    if (probe.kind !== "done") return { ...base, available: null, reason: "probe pending" };
    return probe.result.available
      ? { ...base, available: true }
      : {
          ...base,
          available: false,
          reason: probe.result.reason ?? "notification backend unavailable",
        };
  };

  const runProbe = (): Promise<void> => {
    // The body runs on a later microtask, so `probe = pending` below is assigned BEFORE the body's
    // `probe = done` — even when `backend.probe()` throws synchronously. Run inline, a synchronous
    // throw would set `done` first and then be overwritten with `pending`, forever.
    const promise = Promise.resolve().then(async () => {
      let result: NotificationProbeResult;
      try {
        result = await backend.probe();
      } catch {
        result = { available: false, reason: "notification probe failed" };
      }
      probe = { kind: "done", result, at: now() };
      if (!result.available) {
        safeLog("info", {
          event: "notification.unavailable",
          backend: backend.id,
          reason: result.reason ?? "unknown",
        });
      }
    });
    probe = { kind: "pending", promise };
    return promise;
  };

  const ready = async (): Promise<OsNotificationStatus> => {
    if (!config.enabled) return status();
    if (probe.kind === "idle") await runProbe();
    else if (probe.kind === "pending") await probe.promise;
    else if (!probe.result.available && now() - probe.at >= PROBE_RETRY_MS) await runProbe();
    return status();
  };

  function safeLog(level: "info" | "warn", obj: Record<string, unknown>): void {
    try {
      logger[level](
        obj,
        level === "warn" ? "OS notification not delivered" : "OS notifications unavailable",
      );
    } catch {
      // A throwing logger must not turn a notification into a crash.
    }
  }

  const pruneWindow = (): void => {
    const cutoff = now() - RATE_LIMIT_WINDOW_MS;
    while (sentAt.length > 0 && (sentAt[0] ?? 0) <= cutoff) sentAt.shift();
  };

  /** Claim a slot in the window. Synchronous, so concurrent `show()`s cannot both take the last one. */
  const reserve = (): boolean => {
    pruneWindow();
    if (sentAt.length >= RATE_LIMIT_MAX) return false;
    sentAt.push(now());
    return true;
  };

  const deliver = async (title: string, body: string): Promise<void> => {
    try {
      await backend.send(title, body);
    } catch (err) {
      const reason = reasonOf(err);
      safeLog("warn", {
        event: "notification.failed",
        backend: backend.id,
        title: prepareNotificationText(title, NOTIFICATION_TITLE_MAX_CHARS),
        reason,
      });
      throw err instanceof NotificationSendError ? err : new NotificationSendError(reason);
    }
  };

  /** Send the summary if drops are pending and the window has room. */
  const flushSummary = (): void => {
    if (droppedPending === 0 || !reserve()) return;
    const n = droppedPending;
    droppedPending = 0;
    summaryTimer?.cancel();
    summaryTimer = undefined;
    // Fire-and-forget, with its own catch: `deliver` already logged a failure.
    deliver(rateLimitSummaryTitle(n), RATE_LIMIT_SUMMARY_BODY).catch(() => {});
  };

  const armSummaryTimer = (): void => {
    if (summaryTimer !== undefined) return;
    const oldest = sentAt[0] ?? now();
    const delay = Math.max(0, oldest + RATE_LIMIT_WINDOW_MS - now() + 1);
    // Fires just after the oldest toast leaves the window, so a slot is free by construction: any
    // `show()` that could have taken it first sends the summary itself (and cancels this timer).
    summaryTimer = setTimer(() => {
      summaryTimer = undefined;
      flushSummary();
    }, delay);
  };

  const showImpl = async (title: string, body: string, urgent: boolean): Promise<void> => {
    if (!config.enabled) return;
    const st = await ready();
    if (st.available !== true) {
      throw new NotificationUnavailableError(st.reason ?? "notification backend unavailable");
    }
    const shownBody = config.content === "title_only" ? TITLE_ONLY_BODY : body;
    flushSummary();
    if (urgent) {
      pruneWindow();
      sentAt.push(now());
    } else if (!reserve()) {
      droppedPending += 1;
      rateLimitedTotal += 1;
      armSummaryTimer();
      throw new NotificationRateLimitedError("notification dropped by the rate limit");
    }
    await deliver(title, shownBody);
  };

  return {
    get delivers(): boolean {
      if (!config.enabled) return false;
      if (probe.kind !== "done" || probe.result.available) return true;
      // An unavailable probe is retried by the next `show()` once PROBE_RETRY_MS has passed. A
      // consumer that gates on `delivers` (the on-call push records `skipped` and never calls
      // `show()`) would otherwise never trigger that retry: a gateway autostarted before the desktop
      // session would skip every toast until something else called `show()`. So once the interval
      // has passed, report true — `show()` re-probes, and rejects if the backend is still unavailable.
      return now() - probe.at >= PROBE_RETRY_MS;
    },
    // An `async` function cannot throw synchronously; every failure becomes a rejection.
    show: (title: string, body: string, options?: NotificationShowOptions): Promise<void> =>
      showImpl(title, body, options?.urgent === true),
    status,
    ready: () => ready().catch(() => status()),
    close(): void {
      summaryTimer?.cancel();
      summaryTimer = undefined;
    },
  };
}

export type PlatformNotificationBackendDeps = {
  readonly spawn?: NotificationSpawner;
  readonly env?: NotificationEnvSource;
};

/**
 * The backend for `platform`, or `undefined` where Nimbus has none (the caller keeps the
 * non-delivering service there).
 */
export function createPlatformNotificationBackend(
  platform: NodeJS.Platform,
  deps: PlatformNotificationBackendDeps = {},
): NotificationBackend | undefined {
  switch (platform) {
    case "win32":
      return createWin32NotificationBackend(deps);
    case "darwin":
      return createDarwinNotificationBackend(deps);
    case "linux":
      return createLinuxNotificationBackend(deps);
    default:
      return undefined;
  }
}
