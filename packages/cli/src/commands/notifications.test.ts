// DI tests for `nimbus notifications` and the doctor notifications line — a duck-typed
// `IPCClient`, never `mock.module` (process-global; leaks across the combined CLI run).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import { doctorPrintNotifications } from "./doctor-core.ts";
import { runNotifications, runNotificationsCmd } from "./notifications.ts";
import {
  doctorNotificationsLine,
  formatNotificationsStatus,
  type NotificationsStatusView,
  parseNotificationsStatus,
  parseNotificationsTest,
} from "./notifications-format.ts";

function fakeClient(impl: (method: string) => Promise<unknown>): {
  client: IPCClient;
  calls: string[];
} {
  const calls: string[] = [];
  const fake = {
    call: async (method: string): Promise<unknown> => {
      calls.push(method);
      return impl(method);
    },
  };
  return { client: fake as unknown as IPCClient, calls };
}

const ON: NotificationsStatusView = {
  backend: "windows-toast",
  enabled: true,
  content: "full",
  available: true,
  rateLimitedTotal: 2,
  delivers: true,
};
const ENV_OFF: NotificationsStatusView = {
  backend: "linux-libnotify",
  enabled: false,
  content: "full",
  available: null,
  reason: "disabled by NIMBUS_NOTIFICATIONS=off",
  disabledBy: "env",
  rateLimitedTotal: 0,
  delivers: false,
};

let stdout = "";
let logs = "";
let origWrite: typeof process.stdout.write;
let origLog: typeof console.log;
let origExit: typeof process.exitCode;

beforeEach(() => {
  stdout = "";
  logs = "";
  origWrite = process.stdout.write.bind(process.stdout);
  origLog = console.log.bind(console);
  origExit = process.exitCode;
  process.stdout.write = ((chunk: string): boolean => {
    stdout += chunk;
    return true;
  }) as typeof process.stdout.write;
  console.log = ((...args: unknown[]): void => {
    logs += `${args.map(String).join(" ")}\n`;
  }) as typeof console.log;
});
afterEach(() => {
  process.stdout.write = origWrite;
  console.log = origLog;
  process.exitCode = origExit;
});

describe("parse (the wire is external data)", () => {
  test("accepts the gateway shape; rejects a malformed one loudly", () => {
    expect(parseNotificationsStatus(ON)).toEqual(ON);
    expect(parseNotificationsStatus(ENV_OFF)).toEqual(ENV_OFF);
    expect(() => parseNotificationsStatus({ ...ON, enabled: "yes" })).toThrow(/malformed.*enabled/);
    expect(() => parseNotificationsStatus({ ...ON, disabledBy: "whim" })).toThrow(/disabledBy/);
    expect(() => parseNotificationsStatus(null)).toThrow(/malformed/);
    expect(parseNotificationsTest({ delivered: true, status: ON })).toEqual({
      delivered: true,
      status: ON,
    });
    expect(() => parseNotificationsTest({ delivered: false, status: ON })).toThrow(/reason/);
  });
});

describe("nimbus notifications", () => {
  test("a bad subcommand is a usage error before any gateway contact", async () => {
    await expect(runNotificationsCmd(["bogus"])).rejects.toThrow(/usage: nimbus notifications/);
    await expect(runNotificationsCmd([])).rejects.toThrow(/usage/);
    const { client, calls } = fakeClient(() => Promise.reject(new Error("must not be called")));
    await expect(runNotifications(client, ["nope"])).rejects.toThrow(/usage/);
    expect(calls).toEqual([]);
  });

  test("status renders the backend, config and availability", async () => {
    const { client, calls } = fakeClient(() => Promise.resolve(ON));
    await runNotifications(client, ["status"]);
    expect(calls).toEqual(["notifications.status"]);
    expect(stdout).toContain("Backend:     windows-toast");
    expect(stdout).toContain("Available:   yes");
    expect(stdout).toContain("Rate-limited since the gateway started: 2");
  });

  test("status --json prints the validated shape", async () => {
    const { client } = fakeClient(() => Promise.resolve(ENV_OFF));
    await runNotifications(client, ["status", "--json"]);
    expect(JSON.parse(stdout)).toEqual(ENV_OFF);
  });

  test("test: delivered prints success and leaves the exit code alone", async () => {
    process.exitCode = 0;
    const { client, calls } = fakeClient(() => Promise.resolve({ delivered: true, status: ON }));
    await runNotifications(client, ["test"]);
    expect(calls).toEqual(["notifications.test"]);
    expect(stdout).toContain("Test notification sent");
    expect(process.exitCode).toBe(0);
  });

  test("test: not delivered prints the reason and exits 1", async () => {
    process.exitCode = 0;
    const { client } = fakeClient(() =>
      Promise.resolve({ delivered: false, reason: ENV_OFF.reason, status: ENV_OFF }),
    );
    await runNotifications(client, ["test"]);
    expect(stdout).toBe("Test notification NOT delivered: disabled by NIMBUS_NOTIFICATIONS=off\n");
    expect(process.exitCode).toBe(1);
  });

  test("the disabled status hides the availability line (nothing was probed)", () => {
    expect(formatNotificationsStatus(ENV_OFF)).not.toContain("Available:");
  });
});

describe("doctor notifications line", () => {
  test("info when off by choice, warn when broken, ok when working", () => {
    expect(doctorNotificationsLine(ON)).toMatchObject({ exit: 0 });
    expect(doctorNotificationsLine(ON).line).toStartWith("[ok]");
    expect(doctorNotificationsLine(ENV_OFF)).toEqual({
      line: "[info] Notifications: off — disabled by NIMBUS_NOTIFICATIONS=off",
      exit: 0,
    });
    expect(doctorNotificationsLine({ ...ENV_OFF, disabledBy: "demo", reason: "demo" }).exit).toBe(
      0,
    );
    expect(
      doctorNotificationsLine({
        ...ENV_OFF,
        disabledBy: "config_error",
        reason: "invalid [notifications] config",
      }),
    ).toEqual({ line: "[warn] Notifications: off — invalid [notifications] config", exit: 1 });
    expect(doctorNotificationsLine({ ...ON, available: false, reason: "no session bus" })).toEqual({
      line: "[warn] Notifications: unavailable — no session bus",
      exit: 1,
    });
    expect(
      doctorNotificationsLine({ ...ON, available: null, reason: "probe pending" }).line,
    ).toStartWith("[info]");
  });

  test("an older gateway (-32601) keeps doctor quiet; a malformed reply warns", async () => {
    const old = fakeClient(() => Promise.reject(new Error("Method not found")));
    expect(await doctorPrintNotifications(old.client)).toBe(0);
    expect(logs).toBe("");
    const bad = fakeClient(() => Promise.resolve({ backend: 1 }));
    expect(await doctorPrintNotifications(bad.client)).toBe(1);
    expect(logs).toContain("[warn] Notifications: malformed");
  });
});
