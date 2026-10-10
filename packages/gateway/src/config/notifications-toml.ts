/**
 * `[notifications]` — OS notifications (toasts) raised by the gateway (pre-S3 item E).
 *
 * DEFAULT ON. Unlike most optional sections this one is on by default: a toast leaves the gateway
 * only for the local OS notification centre, never the network, and every producer (sync failure,
 * lost authentication, a fired watcher, an on-call pushed brief) is something the owner already
 * asked Nimbus to tell them about. `enabled = false` turns every toast off.
 *
 * `content` decides how much reaches the notification centre — which is visible on a lock screen
 * and, on some desktops, persisted in a history the OS keeps:
 *   - `"full"` (default) shows the producer's body, which can carry indexed item titles;
 *   - `"title_only"` replaces EVERY body with one fixed string, so nothing from the index is shown.
 *
 * An unrecognised `content` value is refused LOUDLY (`NotificationsConfigError`, naming the value)
 * rather than defaulted: a typo of `title_only` silently falling back to `full` would put indexed
 * text on a lock screen the owner believed they had kept it off. The caller (`platform/assemble.ts`)
 * catches it, logs it, and runs with notifications OFF — the fail-closed direction for a privacy
 * setting. A malformed `enabled` value is ignored like other boolean keys, keeping the default.
 *
 * Env override: `NIMBUS_NOTIFICATIONS=off` (also `0`/`false`, case-insensitive) forces
 * `enabled = false` whatever the file says. It can only DISABLE — no env value enables toasts a
 * config turned off. It exists so test harnesses that boot a real gateway never raise real toasts
 * on a developer's desktop. It is read at LOAD time, not at module import, so a harness that sets it
 * before booting the gateway is honoured.
 *
 * Takes a PATH, not a config dir: callers pass `resolveNimbusTomlForProfile(configDir)` so a
 * profile TOML is honoured (see `fleet-toml.ts`'s `loadNimbusFleetFromPath` for why there is no
 * `…FromConfigDir` variant).
 */
import { existsSync, readFileSync } from "node:fs";

import { processEnvGet } from "../platform/env-access.ts";
import {
  isTableHeader,
  parseBool,
  parseString,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

export const NOTIFICATION_CONTENT_MODES = ["full", "title_only"] as const;
export type NotificationContentMode = (typeof NOTIFICATION_CONTENT_MODES)[number];

export type NimbusNotificationsToml = {
  readonly enabled: boolean;
  readonly content: NotificationContentMode;
};

export const DEFAULT_NOTIFICATIONS_CONFIG: NimbusNotificationsToml = Object.freeze({
  enabled: true,
  content: "full",
});

/** The env var that can force notifications off (see the file header). */
export const NOTIFICATIONS_ENV_VAR = "NIMBUS_NOTIFICATIONS";

const ENV_OFF_VALUES = new Set(["off", "0", "false"]);

export class NotificationsConfigError extends Error {}

/** Reads one env var; injectable so tests never touch `process.env`. */
export type NotificationsEnvGet = (name: string) => string | undefined;

function isContentMode(v: string): v is NotificationContentMode {
  return (NOTIFICATION_CONTENT_MODES as readonly string[]).includes(v);
}

type NotificationsDraft = {
  -readonly [K in keyof NimbusNotificationsToml]: NimbusNotificationsToml[K];
};

function applyNotificationsKey(out: NotificationsDraft, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "content": {
      const v = parseString(valRaw).trim();
      if (!isContentMode(v)) {
        const allowed = NOTIFICATION_CONTENT_MODES.map((m) => JSON.stringify(m)).join(", ");
        throw new NotificationsConfigError(
          `[notifications].content must be one of ${allowed} (got: ${JSON.stringify(v)})`,
        );
      }
      out.content = v;
      break;
    }
    default:
      break;
  }
}

/** True when the env override asks for notifications to be off. */
export function notificationsDisabledByEnv(envGet: NotificationsEnvGet = processEnvGet): boolean {
  const raw = envGet(NOTIFICATIONS_ENV_VAR);
  return raw !== undefined && ENV_OFF_VALUES.has(raw.trim().toLowerCase());
}

/**
 * Parse the `[notifications]` section of a TOML source and apply the env override.
 * Throws `NotificationsConfigError` on an unrecognised `content` value.
 */
export function parseNimbusTomlNotifications(
  source: string,
  envGet: NotificationsEnvGet = processEnvGet,
): NimbusNotificationsToml {
  const out: NotificationsDraft = { ...DEFAULT_NOTIFICATIONS_CONFIG };
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[notifications]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) applyNotificationsKey(out, kv.key, kv.valRaw);
  }
  if (notificationsDisabledByEnv(envGet)) out.enabled = false;
  return Object.freeze(out);
}

/**
 * A missing file still goes through the parser so the env override applies on a first boot with
 * no `nimbus.toml` (the same trap `loadNimbusUpdaterFromPath` documents).
 */
export function loadNimbusNotificationsFromPath(
  tomlPath: string,
  envGet: NotificationsEnvGet = processEnvGet,
): NimbusNotificationsToml {
  const raw = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  return parseNimbusTomlNotifications(raw, envGet);
}
