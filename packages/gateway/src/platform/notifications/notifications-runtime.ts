/**
 * The gateway's notification runtime (pre-S3 item E, T2): picks the OS backend, loads
 * `[notifications]`, and exposes the one `NotificationService` every producer is handed plus the
 * `status`/`test` surface behind the `notifications.*` IPC methods and `nimbus doctor`.
 *
 * ## When the runtime is INACTIVE (the non-delivering fallback is used)
 *
 *   - `allowed: false` — a demo-rooted gateway (I41, `platform/demo-boot.ts`'s `osNotifications`):
 *     a throwaway demo must never raise a toast on the owner's real desktop;
 *   - no backend for this `process.platform`;
 *   - `[notifications]` failed to load (`NotificationsConfigError`, e.g. an unrecognised `content`):
 *     logged LOUDLY at ERROR and notifications run OFF until it is fixed — the fail-closed direction
 *     for a privacy setting (a mistyped `title_only` must not put indexed text on a lock screen). It
 *     never crashes boot.
 *
 * `[notifications] enabled = false` (or `NIMBUS_NOTIFICATIONS=off`) is NOT inactive: the OS service
 * is still built, it simply never probes or delivers, so `status()` reports the real backend.
 *
 * ## `test()` reports, it does not throw
 *
 * `notifications.test` sends ONE fixed-text toast through the real service — rate limit and
 * `title_only` included, since they are part of what is being tested — and returns
 * `{ delivered: true }` or `{ delivered: false, reason }`. A toast that could not be shown is an
 * ANSWER to "do notifications work here?", not a failure of the call, so it is not a JSON-RPC
 * error. `delivered: true` means the platform tool accepted the toast; on macOS that cannot prove
 * it was displayed (see `darwin.ts`).
 */
import {
  loadNimbusNotificationsFromPath,
  type NimbusNotificationsToml,
  type NotificationContentMode,
  type NotificationsEnvGet,
  notificationsDisabledByEnv,
} from "../../config/notifications-toml.ts";
import { processEnvGet } from "../env-access.ts";
import type { NotificationService } from "../types.ts";
import {
  createOsNotifications,
  createPlatformNotificationBackend,
  type NotificationLogger,
  type OsNotificationService,
  type OsNotificationStatus,
} from "./os-notifications.ts";
import type { NotificationBackend, NotificationBackendId } from "./types.ts";

/** Why notifications are off, when they are. Drives `nimbus doctor`'s info-vs-warn choice. */
export type NotificationsDisabledBy = "config" | "env" | "demo" | "config_error";

export type NotificationsStatus = {
  /** `"none"` when no OS backend is in use (demo, unsupported platform, config error). */
  readonly backend: NotificationBackendId | "none";
  readonly enabled: boolean;
  readonly content: NotificationContentMode;
  /** `null` while unknown (probe pending, or never run because notifications are disabled). */
  readonly available: boolean | null;
  readonly reason?: string;
  readonly disabledBy?: NotificationsDisabledBy;
  readonly rateLimitedTotal: number;
  /** The service's live `delivers` at the time of the call. */
  readonly delivers: boolean;
};

export type NotificationsTestResult =
  | { readonly delivered: true; readonly status: NotificationsStatus }
  | { readonly delivered: false; readonly reason: string; readonly status: NotificationsStatus };

export const TEST_NOTIFICATION_TITLE = "Nimbus test notification";
export const TEST_NOTIFICATION_BODY = "OS notifications from Nimbus are working.";

export interface NotificationsRuntime {
  /** Handed to every producer. Its `delivers` is LIVE; read it at use time. */
  readonly service: NotificationService;
  status(): NotificationsStatus;
  /** Resolves once the probe settled (or at once when inactive/disabled). Never rejects. */
  ready(): Promise<NotificationsStatus>;
  /** Send one fixed-text toast. Never rejects. */
  test(): Promise<NotificationsTestResult>;
  /** Cancel pending timers (gateway shutdown). Idempotent. */
  close(): void;
}

export type NotificationsRuntimeLogger = NotificationLogger & {
  error(obj: Record<string, unknown>, msg: string): void;
};

export type CreateNotificationsRuntimeOptions = {
  /** `false` on a demo-rooted gateway (I41). */
  readonly allowed: boolean;
  readonly platform: NodeJS.Platform;
  /** The PROFILE-resolved TOML path (`resolveNimbusTomlForProfile(configDir)`). */
  readonly tomlPath: string;
  readonly logger: NotificationsRuntimeLogger;
  /** The non-delivering service used whenever the runtime is inactive. */
  readonly fallback: NotificationService;
  readonly envGet?: NotificationsEnvGet;
  /** DI for tests: never spawn a real platform tool from a unit test. */
  readonly createBackend?: (platform: NodeJS.Platform) => NotificationBackend | undefined;
};

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function inactiveRuntime(
  fallback: NotificationService,
  st: Omit<NotificationsStatus, "delivers" | "rateLimitedTotal">,
): NotificationsRuntime {
  const status = (): NotificationsStatus => ({
    ...st,
    rateLimitedTotal: 0,
    delivers: fallback.delivers !== false,
  });
  return {
    service: fallback,
    status,
    ready: () => Promise.resolve(status()),
    test: () =>
      Promise.resolve({
        delivered: false,
        reason: st.reason ?? "OS notifications are not available on this gateway",
        status: status(),
      }),
    close: () => {},
  };
}

function safeLog(
  logger: NotificationsRuntimeLogger,
  level: "info" | "warn" | "error",
  obj: Record<string, unknown>,
  msg: string,
): void {
  try {
    logger[level](obj, msg);
  } catch {
    // A throwing logger must not stop the gateway booting.
  }
}

export function createNotificationsRuntime(
  opts: CreateNotificationsRuntimeOptions,
): NotificationsRuntime {
  const { logger, fallback } = opts;
  const envGet = opts.envGet ?? processEnvGet;

  if (!opts.allowed) {
    return inactiveRuntime(fallback, {
      backend: "none",
      enabled: false,
      content: "full",
      available: false,
      reason: "demo-rooted gateway: OS notifications are never raised (I41)",
      disabledBy: "demo",
    });
  }

  let config: NimbusNotificationsToml;
  try {
    config = loadNimbusNotificationsFromPath(opts.tomlPath, envGet);
  } catch (e) {
    const message = errMessage(e);
    safeLog(
      logger,
      "error",
      { event: "notification.config_invalid", err: message },
      "[notifications] config is INVALID — OS notifications are OFF until it is fixed",
    );
    return inactiveRuntime(fallback, {
      backend: "none",
      enabled: false,
      content: "full",
      available: false,
      reason: `invalid [notifications] config (${message}); notifications are off until it is fixed`,
      disabledBy: "config_error",
    });
  }

  const backend = (opts.createBackend ?? createPlatformNotificationBackend)(opts.platform);
  if (backend === undefined) {
    safeLog(
      logger,
      "info",
      { event: "notification.unsupported_platform", platform: opts.platform },
      "OS notifications are not implemented on this platform",
    );
    return inactiveRuntime(fallback, {
      backend: "none",
      enabled: config.enabled,
      content: config.content,
      available: false,
      reason: `no OS notification backend for platform "${opts.platform}"`,
    });
  }

  const disabledBy: NotificationsDisabledBy | undefined = config.enabled
    ? undefined
    : notificationsDisabledByEnv(envGet)
      ? "env"
      : "config";
  if (disabledBy !== undefined) {
    safeLog(
      logger,
      "info",
      { event: "notification.disabled", by: disabledBy },
      "OS notifications are disabled",
    );
  }

  const svc: OsNotificationService = createOsNotifications({ backend, config, logger });

  const project = (s: OsNotificationStatus): NotificationsStatus => {
    const base = {
      backend: s.backend,
      enabled: s.enabled,
      content: s.content,
      available: s.available,
      rateLimitedTotal: s.rateLimitedTotal,
      delivers: svc.delivers,
    };
    if (disabledBy === "env") {
      return { ...base, reason: "disabled by NIMBUS_NOTIFICATIONS=off", disabledBy };
    }
    return {
      ...base,
      ...(s.reason === undefined ? {} : { reason: s.reason }),
      ...(disabledBy === undefined ? {} : { disabledBy }),
    };
  };

  const ready = async (): Promise<NotificationsStatus> => project(await svc.ready());

  return {
    service: svc,
    status: () => project(svc.status()),
    ready,
    async test(): Promise<NotificationsTestResult> {
      const st = await ready();
      if (!st.enabled) {
        return {
          delivered: false,
          reason: st.reason ?? "OS notifications are disabled",
          status: st,
        };
      }
      if (st.available !== true) {
        return {
          delivered: false,
          reason: st.reason ?? "the OS notification backend is unavailable",
          status: st,
        };
      }
      try {
        await svc.show(TEST_NOTIFICATION_TITLE, TEST_NOTIFICATION_BODY);
        return { delivered: true, status: project(svc.status()) };
      } catch (e) {
        return { delivered: false, reason: errMessage(e), status: project(svc.status()) };
      }
    },
    close: () => svc.close(),
  };
}

/**
 * The fire-and-forget adapter every producer callback goes through. `show()` REJECTS (unavailable,
 * rate-limited, send failure) and a `void`ed rejection is an unhandled rejection, which
 * `platform/exit-diagnostics.ts` turns into a gateway exit. The returned promise never rejects; the
 * service already logged any failure (title + reason, never the body).
 */
export function showIgnoringFailure(
  service: Pick<NotificationService, "show">,
  title: string,
  body: string,
): Promise<void> {
  try {
    return service.show(title, body).catch(() => {});
  } catch {
    return Promise.resolve();
  }
}
