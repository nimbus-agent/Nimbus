import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_NOTIFICATIONS_CONFIG,
  loadNimbusNotificationsFromPath,
  NOTIFICATIONS_ENV_VAR,
  NotificationsConfigError,
  notificationsDisabledByEnv,
  parseNimbusTomlNotifications,
} from "./notifications-toml.ts";

const noEnv = (): string | undefined => undefined;
const envWith =
  (value: string) =>
  (name: string): string | undefined =>
    name === NOTIFICATIONS_ENV_VAR ? value : undefined;

describe("[notifications] config", () => {
  test("defaults: ON, full content", () => {
    expect(DEFAULT_NOTIFICATIONS_CONFIG).toEqual({ enabled: true, content: "full" });
    expect(parseNimbusTomlNotifications("", noEnv)).toEqual(DEFAULT_NOTIFICATIONS_CONFIG);
    expect(parseNimbusTomlNotifications("[fleet]\nenabled = false\n", noEnv)).toEqual(
      DEFAULT_NOTIFICATIONS_CONFIG,
    );
  });

  test("parses enabled and content", () => {
    expect(
      parseNimbusTomlNotifications(
        '[notifications]\nenabled = false\ncontent = "title_only"\n',
        noEnv,
      ),
    ).toEqual({ enabled: false, content: "title_only" });
    expect(
      parseNimbusTomlNotifications('[notifications]\ncontent = "full" # comment\n', noEnv).content,
    ).toBe("full");
  });

  test("only the exact header counts", () => {
    expect(
      parseNimbusTomlNotifications("[notifications.x]\nenabled = false\n", noEnv).enabled,
    ).toBe(true);
  });

  test("a malformed enabled value keeps the default", () => {
    expect(parseNimbusTomlNotifications("[notifications]\nenabled = nope\n", noEnv).enabled).toBe(
      true,
    );
  });

  test("an unknown content value is refused LOUDLY, naming the value", () => {
    const parse = () =>
      parseNimbusTomlNotifications('[notifications]\ncontent = "title-only"\n', noEnv);
    expect(parse).toThrow(NotificationsConfigError);
    expect(parse).toThrow('"title-only"');
    expect(parse).toThrow('"full", "title_only"');
    expect(() => parseNimbusTomlNotifications('[notifications]\ncontent = ""\n', noEnv)).toThrow(
      NotificationsConfigError,
    );
  });

  test("NIMBUS_NOTIFICATIONS=off/0/false disables; anything else leaves the config alone", () => {
    for (const v of ["off", "OFF", " off ", "0", "false", "False"]) {
      expect(notificationsDisabledByEnv(envWith(v))).toBe(true);
      expect(parseNimbusTomlNotifications("", envWith(v)).enabled).toBe(false);
    }
    for (const v of ["on", "1", "true", "", "yes"]) {
      expect(notificationsDisabledByEnv(envWith(v))).toBe(false);
      expect(parseNimbusTomlNotifications("", envWith(v)).enabled).toBe(true);
    }
    // The env var can only DISABLE: it never re-enables a config that turned toasts off.
    expect(
      parseNimbusTomlNotifications("[notifications]\nenabled = false\n", envWith("on")).enabled,
    ).toBe(false);
    expect(notificationsDisabledByEnv(noEnv)).toBe(false);
  });

  test("the parsed config is frozen", () => {
    expect(Object.isFrozen(parseNimbusTomlNotifications("", noEnv))).toBe(true);
  });
});

describe("loadNimbusNotificationsFromPath", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  test("missing file → defaults, and the env override still applies", () => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-notif-toml-"));
    const missing = join(dir, "nimbus.toml");
    expect(loadNimbusNotificationsFromPath(missing, noEnv)).toEqual(DEFAULT_NOTIFICATIONS_CONFIG);
    expect(loadNimbusNotificationsFromPath(missing, envWith("off")).enabled).toBe(false);
  });

  test("reads the file; an invalid content value throws to the caller", () => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-notif-toml-"));
    const p = join(dir, "nimbus.toml");
    writeFileSync(p, '[notifications]\ncontent = "title_only"\n');
    expect(loadNimbusNotificationsFromPath(p, noEnv)).toEqual({
      enabled: true,
      content: "title_only",
    });
    writeFileSync(p, '[notifications]\ncontent = "summary"\n');
    expect(() => loadNimbusNotificationsFromPath(p, noEnv)).toThrow(NotificationsConfigError);
  });
});
