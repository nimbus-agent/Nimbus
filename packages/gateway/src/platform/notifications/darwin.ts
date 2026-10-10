/**
 * macOS backend: `osascript` running `display notification`.
 *
 * ## How the text reaches AppleScript — and why it cannot break out
 *
 * The AppleScript is three CONSTANT `-e` statements forming an `on run argv` handler that reads the
 * title and body as `item 1` / `item 2` of `argv`. Title and body travel ONLY as argv elements
 * after `--`; they are never part of the script source, so a quote, backslash or `" & (do shell
 * script …) & "` in a ticket title is just text. `--` ends option parsing, so a title that begins
 * with `-` is not read as an `osascript` flag. `execve` passes argv verbatim — there is no shell.
 *
 * ## Stated limits (verified by tests and CI only, not on a real Mac by this change)
 *
 * - Notifications from `osascript` are attributed to "Script Editor", and macOS may require the
 *   owner to allow Script Editor's notifications once (System Settings → Notifications) before any
 *   appear. `display notification` exits 0 either way, so this backend cannot detect that state.
 * - The probe only checks that `/usr/bin/osascript` exists.
 */
import { existsSync } from "node:fs";

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

export const OSASCRIPT_PATH = "/usr/bin/osascript";

/** The constant AppleScript statements; data never appears in them. */
export const OSASCRIPT_STATEMENTS = [
  "on run argv",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "end run",
] as const;

export const DARWIN_NOTIFY_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "__CF_USER_TEXT_ENCODING",
] as const;

export function buildOsascriptArgv(title: string, body: string): string[] {
  return [
    OSASCRIPT_PATH,
    ...OSASCRIPT_STATEMENTS.flatMap((s) => ["-e", s]),
    "--",
    prepareNotificationText(title, NOTIFICATION_TITLE_MAX_CHARS),
    prepareNotificationText(body, NOTIFICATION_BODY_MAX_CHARS),
  ];
}

export type DarwinNotificationBackendDeps = {
  readonly spawn?: NotificationSpawner;
  readonly env?: NotificationEnvSource;
  readonly fileExists?: (path: string) => boolean;
};

export function createDarwinNotificationBackend(
  deps: DarwinNotificationBackendDeps = {},
): NotificationBackend {
  const spawn = deps.spawn ?? spawnCapture;
  const env = deps.env ?? process.env;
  const fileExists = deps.fileExists ?? existsSync;
  const childEnv = pickEnv(env, DARWIN_NOTIFY_ENV_KEYS);

  return {
    id: "macos-osascript",
    probe(): Promise<NotificationProbeResult> {
      try {
        return Promise.resolve(
          fileExists(OSASCRIPT_PATH)
            ? { available: true }
            : { available: false, reason: `${OSASCRIPT_PATH} not found` },
        );
      } catch {
        return Promise.resolve({ available: false, reason: "osascript probe failed" });
      }
    },
    async send(title: string, body: string): Promise<void> {
      const r = await spawn(buildOsascriptArgv(title, body), {
        env: childEnv,
        timeoutMs: NOTIFICATION_SPAWN_TIMEOUT_MS,
      });
      if (!r.ok) throw new NotificationSendError(describeSpawnFailure("osascript", r));
    },
  };
}
