import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NotificationService } from "../types.ts";
import {
  createNotificationsRuntime,
  type NotificationsRuntimeLogger,
  TEST_NOTIFICATION_BODY,
  TEST_NOTIFICATION_TITLE,
} from "./notifications-runtime.ts";
import { type NotificationBackend, NotificationSendError } from "./types.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function toml(content: string | undefined): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-notif-rt-"));
  dirs.push(dir);
  const p = join(dir, "nimbus.toml");
  if (content !== undefined) writeFileSync(p, content);
  return p;
}

type Logged = { level: string; obj: Record<string, unknown>; msg: string };
function logger(): { log: NotificationsRuntimeLogger; lines: Logged[] } {
  const lines: Logged[] = [];
  const at =
    (level: string) =>
    (obj: Record<string, unknown>, msg: string): void => {
      lines.push({ level, obj, msg });
    };
  return { log: { info: at("info"), warn: at("warn"), error: at("error") }, lines };
}

const fallbackShows: string[] = [];
const fallback: NotificationService = {
  delivers: false,
  show: (title) => {
    fallbackShows.push(title);
    return Promise.resolve();
  },
};

function fakeBackend(
  over: Partial<{ available: boolean; reason: string; sendFails: boolean }> = {},
): { backend: NotificationBackend; sent: Array<[string, string]>; probes: () => number } {
  const sent: Array<[string, string]> = [];
  let probes = 0;
  return {
    sent,
    probes: () => probes,
    backend: {
      id: "windows-toast",
      probe: () => {
        probes += 1;
        return Promise.resolve(
          over.available === false
            ? { available: false, reason: over.reason ?? "nope" }
            : { available: true },
        );
      },
      send: (t, b) => {
        if (over.sendFails === true) return Promise.reject(new NotificationSendError("exit 1"));
        sent.push([t, b]);
        return Promise.resolve();
      },
    },
  };
}

const noEnv = (): string | undefined => undefined;

describe("createNotificationsRuntime — inactive", () => {
  test("demo-rooted (allowed: false): the fallback service, no backend is even constructed", async () => {
    let constructed = 0;
    const rt = createNotificationsRuntime({
      allowed: false,
      platform: "win32",
      tomlPath: toml(undefined),
      logger: logger().log,
      fallback,
      envGet: noEnv,
      createBackend: () => {
        constructed += 1;
        return fakeBackend().backend;
      },
    });
    expect(rt.service).toBe(fallback);
    expect(constructed).toBe(0);
    expect(await rt.ready()).toMatchObject({
      backend: "none",
      enabled: false,
      available: false,
      disabledBy: "demo",
      delivers: false,
    });
    const r = await rt.test();
    expect(r.delivered).toBe(false);
    expect(r.delivered ? "" : r.reason).toContain("demo-rooted");
  });

  test("invalid [notifications] content: logged at ERROR, runs OFF with the fallback, never throws", async () => {
    const { log, lines } = logger();
    const rt = createNotificationsRuntime({
      allowed: true,
      platform: "win32",
      tomlPath: toml('[notifications]\ncontent = "titel_only"\n'),
      logger: log,
      fallback,
      envGet: noEnv,
      createBackend: () => fakeBackend().backend,
    });
    expect(rt.service).toBe(fallback);
    expect(lines.filter((l) => l.level === "error")).toHaveLength(1);
    expect(String(lines[0]?.obj["err"])).toContain("titel_only");
    const st = rt.status();
    expect(st).toMatchObject({ enabled: false, disabledBy: "config_error", backend: "none" });
    expect(st.reason).toContain("invalid [notifications] config");
  });

  test("a platform with no backend: fallback, available false with the platform named", async () => {
    const rt = createNotificationsRuntime({
      allowed: true,
      platform: "aix",
      tomlPath: toml(undefined),
      logger: logger().log,
      fallback,
      envGet: noEnv,
      createBackend: () => undefined,
    });
    expect(rt.service).toBe(fallback);
    const st = await rt.ready();
    expect(st).toMatchObject({ enabled: true, available: false, backend: "none" });
    expect(st.reason).toContain('"aix"');
    expect(st.disabledBy).toBeUndefined();
  });
});

describe("createNotificationsRuntime — active", () => {
  test("available: test() sends the fixed-text toast through the real service", async () => {
    const fb = fakeBackend();
    const rt = createNotificationsRuntime({
      allowed: true,
      platform: "win32",
      tomlPath: toml(undefined),
      logger: logger().log,
      fallback,
      envGet: noEnv,
      createBackend: () => fb.backend,
    });
    expect(rt.service).not.toBe(fallback);
    expect(await rt.ready()).toMatchObject({
      backend: "windows-toast",
      enabled: true,
      available: true,
      delivers: true,
    });
    const r = await rt.test();
    expect(r.delivered).toBe(true);
    expect(fb.sent).toEqual([[TEST_NOTIFICATION_TITLE, TEST_NOTIFICATION_BODY]]);
    rt.close();
  });

  test("title_only applies to the test toast too", async () => {
    const fb = fakeBackend();
    const rt = createNotificationsRuntime({
      allowed: true,
      platform: "win32",
      tomlPath: toml('[notifications]\ncontent = "title_only"\n'),
      logger: logger().log,
      fallback,
      envGet: noEnv,
      createBackend: () => fb.backend,
    });
    expect((await rt.test()).delivered).toBe(true);
    expect(fb.sent[0]?.[0]).toBe(TEST_NOTIFICATION_TITLE);
    expect(fb.sent[0]?.[1]).not.toBe(TEST_NOTIFICATION_BODY);
  });

  test("probe unavailable: test() reports delivered:false with the probe reason, nothing sent", async () => {
    const fb = fakeBackend({ available: false, reason: "no session bus" });
    const rt = createNotificationsRuntime({
      allowed: true,
      platform: "linux",
      tomlPath: toml(undefined),
      logger: logger().log,
      fallback,
      envGet: noEnv,
      createBackend: () => fb.backend,
    });
    const r = await rt.test();
    expect(r).toMatchObject({ delivered: false, reason: "no session bus" });
    expect(r.status).toMatchObject({ available: false, delivers: false });
    expect(fb.sent).toEqual([]);
  });

  test("send failure: delivered:false with the text-free reason", async () => {
    const fb = fakeBackend({ sendFails: true });
    const rt = createNotificationsRuntime({
      allowed: true,
      platform: "win32",
      tomlPath: toml(undefined),
      logger: logger().log,
      fallback,
      envGet: noEnv,
      createBackend: () => fb.backend,
    });
    expect(await rt.test()).toMatchObject({ delivered: false, reason: "exit 1" });
  });

  test("[notifications] enabled = false: real backend reported, never probed, disabledBy config", async () => {
    const fb = fakeBackend();
    const { log, lines } = logger();
    const rt = createNotificationsRuntime({
      allowed: true,
      platform: "win32",
      tomlPath: toml("[notifications]\nenabled = false\n"),
      logger: log,
      fallback,
      envGet: noEnv,
      createBackend: () => fb.backend,
    });
    const st = await rt.ready();
    expect(st).toMatchObject({
      backend: "windows-toast",
      enabled: false,
      disabledBy: "config",
      delivers: false,
    });
    expect(fb.probes()).toBe(0);
    expect(lines.some((l) => l.obj["event"] === "notification.disabled")).toBe(true);
    const r = await rt.test();
    expect(r.delivered).toBe(false);
    expect(fb.sent).toEqual([]);
  });

  test("NIMBUS_NOTIFICATIONS=off: disabledBy env, reason names the env var, nothing spawned", async () => {
    const fb = fakeBackend();
    const rt = createNotificationsRuntime({
      allowed: true,
      platform: "win32",
      tomlPath: toml("[notifications]\nenabled = true\n"),
      logger: logger().log,
      fallback,
      envGet: (n) => (n === "NIMBUS_NOTIFICATIONS" ? "off" : undefined),
      createBackend: () => fb.backend,
    });
    const r = await rt.test();
    expect(r).toMatchObject({
      delivered: false,
      reason: "disabled by NIMBUS_NOTIFICATIONS=off",
      status: { disabledBy: "env", enabled: false },
    });
    expect(fb.probes()).toBe(0);
  });

  test("a throwing logger never stops construction", () => {
    const boom = (): void => {
      throw new Error("log");
    };
    expect(() =>
      createNotificationsRuntime({
        allowed: true,
        platform: "win32",
        tomlPath: toml('[notifications]\ncontent = "x"\n'),
        logger: { info: boom, warn: boom, error: boom },
        fallback,
        envGet: noEnv,
        createBackend: () => fakeBackend().backend,
      }),
    ).not.toThrow();
  });
});
