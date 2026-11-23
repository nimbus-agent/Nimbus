import type { Logger } from "pino";
import type { AutostartManager, NotificationService } from "../types.ts";

export function createStubAutostart(): AutostartManager {
  return {
    isEnabled(): Promise<boolean> {
      return Promise.resolve(false);
    },
    async enable(): Promise<void> {},
    async disable(): Promise<void> {},
  };
}

/**
 * The NON-delivering `NotificationService` (`delivers: false`). Since pre-S3 item E it is no
 * longer the only implementation: `platform/notifications/` raises real OS toasts on Windows,
 * macOS and Linux, and `createNotificationsRuntime` falls back to THIS service only where it
 * cannot or must not deliver — a demo-rooted gateway (I41), a platform with no backend, or a
 * `[notifications]` section that failed to load (notifications then run OFF until it is fixed).
 *
 * What a fallback does NOT mean: no alert is lost. All three producers — repeated sync
 * failure, connector auth loss, and a watcher fire — write durable state BEFORE they
 * call `show()`. A fire is persisted by `insertWatcherEvent` + `updateWatcherLastFired`
 * one statement ahead of the notify; auth loss is persisted by `transitionHealth` to
 * `sync_state.health_state`, `last_error` and a `connector_health_history` row. Both
 * then surface through `nimbus connector list`/`status`/`history`, `nimbus doctor`, the
 * TUI, the Tauri tray, and agent `connectorHealthCaveat` strings. What is missing is
 * the unattended PUSH channel, not the data.
 *
 * The log line makes the gap observable instead of silent. It logs the TITLE ONLY, and
 * deliberately not the body: watcher bodies interpolate `fired.summary`
 * (`${service}: ${item title}`) straight from the index, so logging them would write
 * indexed item titles into `logDir`. `gateway-log-redact.ts` scrubs secrets, not
 * arbitrary indexed content, so it is not a backstop here. The three titles are fixed
 * strings and carry the full signal.
 */
export function createUnimplementedNotifications(logger: Logger): NotificationService {
  return {
    delivers: false,
    show(title: string, _body: string): Promise<void> {
      // `Promise.try` runs the body synchronously, as the `async` method did, and turns a throwing
      // logger into a REJECTION rather than a synchronous throw — producers fire this as
      // `void notify(...)` mid-loop, so a throw would escape into their loop instead.
      return Promise.try(() => {
        logger.info(
          { event: "notification.dropped", title },
          "OS notification not delivered (no OS notification backend in use); the underlying event is still persisted and readable",
        );
      });
    },
  };
}
