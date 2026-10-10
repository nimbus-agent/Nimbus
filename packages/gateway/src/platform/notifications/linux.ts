/**
 * Linux backend: the freedesktop Notifications D-Bus service, via `notify-send` or `gdbus`.
 *
 * ## Two tools, two encodings
 *
 * `notify-send` (libnotify) is preferred: title and body are plain argv elements after `--`, so
 * nothing parses them as anything but text, and a leading `-` is not read as a flag.
 *
 * `gdbus call` is the fallback for desktops without libnotify's CLI. Its method arguments are NOT
 * plain text: each is parsed as GVariant TEXT FORMAT. So title and body are encoded with
 * `gvariantStringLiteral` — a single-quoted literal in which `\` and `'` are backslash-escaped and
 * every remaining control character becomes a `\uXXXX` escape — so no input can end the literal
 * and become a second value (an array, a different type, an extra argument).
 *
 * ## The body is markup on most servers
 *
 * The spec lets a server interpret the BODY as a small HTML-like markup; most do. A ticket title
 * containing `<b>` or `&` would be rendered or mangled, so the body is escaped (`&`, `<`, `>`)
 * before EITHER tool sees it. The summary (title) is plain text per the spec and is not escaped.
 *
 * ## Probe (no spawn)
 *
 * Available when a session bus is reachable — `DBUS_SESSION_BUS_ADDRESS` is set, or
 * `$XDG_RUNTIME_DIR/bus` exists (then passed to the child explicitly) — AND one of the two tools is
 * on PATH. It does not confirm a notification SERVER is running on that bus; a missing server shows
 * up as a send failure. Verified by tests and CI only, not on a real desktop by this change.
 */
import { existsSync } from "node:fs";
import { posix } from "node:path";

import { spawnCapture } from "../spawn-capture.ts";
import {
  describeSpawnFailure,
  NOTIFICATION_BODY_MAX_CHARS,
  NOTIFICATION_SPAWN_TIMEOUT_MS,
  NOTIFICATION_TITLE_MAX_CHARS,
  type NotificationBackend,
  type NotificationEnvSource,
  type NotificationProbeResult,
  NotificationSendError,
  type NotificationSpawner,
  pickEnv,
  prepareNotificationText,
} from "./types.ts";

export const LINUX_APP_NAME = "Nimbus";
/** How long the server should show the toast (ms), for the `gdbus` path. */
export const LINUX_EXPIRE_TIMEOUT_MS = 5000;

export const LINUX_NOTIFY_ENV_KEYS = [
  "PATH",
  "HOME",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
] as const;

/** Escape the three characters freedesktop body markup gives meaning to. `&` first. */
export function escapeNotificationMarkup(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/**
 * A GVariant text-format string literal that parses back to exactly `text`. `\` and `'` are
 * backslash-escaped; every control character (and DEL) becomes `\uXXXX`, so the literal is a
 * single line with no unescaped quote anywhere inside it.
 */
export function gvariantStringLiteral(text: string): string {
  let out = "'";
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (ch === "\\") out += String.raw`\\`;
    else if (ch === "'") out += String.raw`\'`;
    else if (cp < 0x20 || cp === 0x7f) out += `\\u${cp.toString(16).padStart(4, "0")}`;
    else out += ch;
  }
  return `${out}'`;
}

function preparedTitle(title: string): string {
  return prepareNotificationText(title, NOTIFICATION_TITLE_MAX_CHARS);
}

function preparedBody(body: string): string {
  return escapeNotificationMarkup(prepareNotificationText(body, NOTIFICATION_BODY_MAX_CHARS));
}

export function buildNotifySendArgv(tool: string, title: string, body: string): string[] {
  return [tool, `--app-name=${LINUX_APP_NAME}`, "--", preparedTitle(title), preparedBody(body)];
}

export function buildGdbusArgv(tool: string, title: string, body: string): string[] {
  return [
    tool,
    "call",
    "--session",
    "--dest",
    "org.freedesktop.Notifications",
    "--object-path",
    "/org/freedesktop/Notifications",
    "--method",
    "org.freedesktop.Notifications.Notify",
    gvariantStringLiteral(LINUX_APP_NAME), // app_name
    "0", // replaces_id
    "''", // app_icon
    gvariantStringLiteral(preparedTitle(title)), // summary
    gvariantStringLiteral(preparedBody(body)), // body
    "[]", // actions
    "{}", // hints
    String(LINUX_EXPIRE_TIMEOUT_MS), // expire_timeout
  ];
}

/**
 * D-Bus address values allow `[-0-9A-Za-z_/.\*]` unescaped; every other byte is `%XX`. Needed when
 * the bus address is derived from `$XDG_RUNTIME_DIR`, which is a path we did not choose.
 */
export function escapeDbusAddressValue(value: string): string {
  let out = "";
  for (const byte of Buffer.from(value, "utf8")) {
    const ch = String.fromCodePoint(byte);
    out += /[-0-9A-Za-z_/.\\*]/.test(ch)
      ? ch
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`;
  }
  return out;
}

export type LinuxNotificationTool = {
  readonly kind: "notify-send" | "gdbus";
  readonly path: string;
};

type LinuxResolution =
  | {
      readonly ok: true;
      readonly tool: LinuxNotificationTool;
      readonly env: Record<string, string>;
    }
  | { readonly ok: false; readonly reason: string };

export type LinuxNotificationBackendDeps = {
  readonly spawn?: NotificationSpawner;
  readonly env?: NotificationEnvSource;
  readonly fileExists?: (path: string) => boolean;
  /** Resolve a command on the given PATH (default `Bun.which`). */
  readonly which?: (command: string, path: string) => string | null;
};

function defaultWhich(command: string, path: string): string | null {
  return Bun.which(command, { PATH: path });
}

/** Resolve the session bus and the tool. Pure apart from the injected `fileExists`/`which`. */
export function resolveLinuxNotifier(
  env: NotificationEnvSource,
  fileExists: (path: string) => boolean,
  which: (command: string, path: string) => string | null,
): LinuxResolution {
  const childEnv = pickEnv(env, LINUX_NOTIFY_ENV_KEYS);
  if (childEnv["DBUS_SESSION_BUS_ADDRESS"] === undefined) {
    const runtimeDir = childEnv["XDG_RUNTIME_DIR"];
    const socket = runtimeDir === undefined ? undefined : posix.join(runtimeDir, "bus");
    if (socket === undefined || !fileExists(socket)) {
      return {
        ok: false,
        reason:
          "no D-Bus session bus (DBUS_SESSION_BUS_ADDRESS unset and $XDG_RUNTIME_DIR/bus absent)",
      };
    }
    childEnv["DBUS_SESSION_BUS_ADDRESS"] = `unix:path=${escapeDbusAddressValue(socket)}`;
  }
  const path = childEnv["PATH"] ?? "/usr/local/bin:/usr/bin:/bin";
  const notifySend = which("notify-send", path);
  if (notifySend !== null) {
    return { ok: true, tool: { kind: "notify-send", path: notifySend }, env: childEnv };
  }
  const gdbus = which("gdbus", path);
  if (gdbus !== null) return { ok: true, tool: { kind: "gdbus", path: gdbus }, env: childEnv };
  return { ok: false, reason: "neither notify-send nor gdbus is on PATH" };
}

export function createLinuxNotificationBackend(
  deps: LinuxNotificationBackendDeps = {},
): NotificationBackend {
  const spawn = deps.spawn ?? spawnCapture;
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? existsSync;
  const which = deps.which ?? defaultWhich;

  const resolve = (): LinuxResolution => {
    try {
      return resolveLinuxNotifier(env, fileExists, which);
    } catch {
      return { ok: false, reason: "notification tool lookup failed" };
    }
  };

  return {
    id: "linux-libnotify",
    probe(): Promise<NotificationProbeResult> {
      const r = resolve();
      return Promise.resolve(r.ok ? { available: true } : { available: false, reason: r.reason });
    },
    async send(title: string, body: string): Promise<void> {
      // Resolved per send, not cached from the probe: a session bus that appears after boot (an
      // autostarted gateway racing the desktop session) is picked up without a restart.
      const r = resolve();
      if (!r.ok) throw new NotificationSendError(r.reason);
      const argv =
        r.tool.kind === "notify-send"
          ? buildNotifySendArgv(r.tool.path, title, body)
          : buildGdbusArgv(r.tool.path, title, body);
      const result = await spawn(argv, { env: r.env, timeoutMs: NOTIFICATION_SPAWN_TIMEOUT_MS });
      if (!result.ok) throw new NotificationSendError(describeSpawnFailure(r.tool.kind, result));
    },
  };
}
