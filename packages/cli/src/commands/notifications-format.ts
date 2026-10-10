/**
 * Wire parsing + rendering for `notifications.status` / `notifications.test` (pre-S3 item E),
 * shared by `nimbus notifications` and the `nimbus doctor` notifications line.
 *
 * The CLI reaches the gateway over IPC only, so these shapes are an independent, strict mirror of
 * the gateway's `NotificationsStatus` / `NotificationsTestResult`
 * (`packages/gateway/src/platform/notifications/notifications-runtime.ts`). A malformed or
 * version-skewed response fails loudly here rather than printing a misleading status.
 */

export type NotificationsDisabledBy = "config" | "env" | "demo" | "config_error";

export type NotificationsStatusView = {
  readonly backend: string;
  readonly enabled: boolean;
  readonly content: string;
  readonly available: boolean | null;
  readonly reason?: string;
  readonly disabledBy?: NotificationsDisabledBy;
  readonly rateLimitedTotal: number;
  readonly delivers: boolean;
};

export type NotificationsTestView =
  | { readonly delivered: true; readonly status: NotificationsStatusView }
  | {
      readonly delivered: false;
      readonly reason: string;
      readonly status: NotificationsStatusView;
    };

const DISABLED_BY = new Set<string>(["config", "env", "demo", "config_error"]);

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function malformed(what: string): Error {
  return new Error(`malformed notifications response from the gateway: ${what}`);
}

export function parseNotificationsStatus(raw: unknown): NotificationsStatusView {
  const r = asRecord(raw);
  if (r === undefined) throw malformed("status is not an object");
  const { backend, enabled, content, available, reason, disabledBy, rateLimitedTotal, delivers } =
    r;
  if (typeof backend !== "string") throw malformed("backend");
  if (typeof enabled !== "boolean") throw malformed("enabled");
  if (typeof content !== "string") throw malformed("content");
  if (available !== null && typeof available !== "boolean") throw malformed("available");
  if (reason !== undefined && typeof reason !== "string") throw malformed("reason");
  if (
    disabledBy !== undefined &&
    (typeof disabledBy !== "string" || !DISABLED_BY.has(disabledBy))
  ) {
    throw malformed("disabledBy");
  }
  if (typeof rateLimitedTotal !== "number") throw malformed("rateLimitedTotal");
  if (typeof delivers !== "boolean") throw malformed("delivers");
  return {
    backend,
    enabled,
    content,
    available,
    rateLimitedTotal,
    delivers,
    ...(reason === undefined ? {} : { reason }),
    ...(disabledBy === undefined ? {} : { disabledBy: disabledBy as NotificationsDisabledBy }),
  };
}

export function parseNotificationsTest(raw: unknown): NotificationsTestView {
  const r = asRecord(raw);
  if (r === undefined) throw malformed("test result is not an object");
  const status = parseNotificationsStatus(r["status"]);
  if (r["delivered"] === true) return { delivered: true, status };
  if (r["delivered"] === false && typeof r["reason"] === "string") {
    return { delivered: false, reason: r["reason"], status };
  }
  throw malformed("delivered/reason");
}

function availabilityText(s: NotificationsStatusView): string {
  if (s.available === true) return "yes";
  const why = s.reason === undefined ? "" : ` — ${s.reason}`;
  return s.available === false ? `no${why}` : `unknown${why}`;
}

export function formatNotificationsStatus(s: NotificationsStatusView): string {
  const reasonSuffix = s.reason === undefined ? "" : ` — ${s.reason}`;
  const enabled = s.enabled ? "yes" : `no${reasonSuffix}`;
  const lines = [
    "OS notifications",
    `  Backend:     ${s.backend}`,
    `  Enabled:     ${enabled}`,
    `  Content:     ${s.content}`,
  ];
  if (s.enabled) lines.push(`  Available:   ${availabilityText(s)}`);
  lines.push(`  Rate-limited since the gateway started: ${String(s.rateLimitedTotal)}`);
  return `${lines.join("\n")}\n`;
}

export function formatNotificationsTest(t: NotificationsTestView): string {
  if (t.delivered) {
    const mac =
      t.status.backend === "macos-osascript"
        ? " On macOS, allow notifications for Script Editor once if none appeared."
        : "";
    return `Test notification sent — check your notification centre.${mac}\n`;
  }
  return `Test notification NOT delivered: ${t.reason}\n`;
}

/**
 * One `nimbus doctor` line. `[info]` (exit 0) when notifications are off by the owner's own choice
 * (config, env, or a demo root); `[warn]` (exit 1) when they should work and do not — an invalid
 * `[notifications]` section, an unavailable backend, or a platform with none.
 */
export function doctorNotificationsLine(s: NotificationsStatusView): {
  line: string;
  exit: number;
} {
  if (s.disabledBy === "config_error") {
    return { line: `[warn] Notifications: off — ${s.reason ?? "invalid config"}`, exit: 1 };
  }
  if (!s.enabled) {
    return { line: `[info] Notifications: off — ${s.reason ?? "disabled"}`, exit: 0 };
  }
  if (s.available === false) {
    return {
      line: `[warn] Notifications: unavailable — ${s.reason ?? "unknown reason"}`,
      exit: 1,
    };
  }
  if (s.available === null) {
    return {
      line: `[info] Notifications: availability not yet known (${s.reason ?? "probe pending"})`,
      exit: 0,
    };
  }
  return {
    line: `[ok] Notifications: ${s.backend} (content: ${s.content}). Try \`nimbus notifications test\`.`,
    exit: 0,
  };
}
