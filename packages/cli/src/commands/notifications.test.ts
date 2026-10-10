// DI tests for `nimbus notifications` and the doctor notifications line — a duck-typed
// `IPCClient`, never `mock.module` (process-global; leaks across the combined CLI run).
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import { doctorPrintNotifications } from "./doctor-core.ts";
import { runNotifications, runNotificationsCmd } from "./notifications.ts";
import {
  doctorNotificationsLine,
  formatNotificationsStatus,
  formatNotificationsTest,
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
    // An unrecognised flag is refused, not ignored (a script expecting JSON must not get text).
    await expect(runNotificationsCmd(["status", "--jso"])).rejects.toThrow(
      /Unknown argument: --jso/,
    );
    await expect(runNotificationsCmd(["test", "--json", "extra"])).rejects.toThrow(/usage/);
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
    const notFound = Object.assign(new Error("Method not found"), { code: -32601 });
    const old = fakeClient(() => Promise.reject(notFound));
    expect(await doctorPrintNotifications(old.client)).toBe(0);
    expect(logs).toBe("");
    const bad = fakeClient(() => Promise.resolve({ backend: 1 }));
    expect(await doctorPrintNotifications(bad.client)).toBe(1);
    expect(logs).toContain("[warn] Notifications: malformed");
  });

  test("any OTHER RPC failure warns rather than reading as healthy", async () => {
    const internal = Object.assign(new Error("Internal error"), { code: -32603 });
    const failing = fakeClient(() => Promise.reject(internal));
    expect(await doctorPrintNotifications(failing.client)).toBe(1);
    expect(logs).toContain("[warn] Notifications: status check failed (Internal error).");
    // An error with no code at all is not "method not found" either.
    const bare = fakeClient(() => Promise.reject(new Error("socket closed")));
    expect(await doctorPrintNotifications(bare.client)).toBe(1);
  });
});

describe("parse: every malformed field is named", () => {
  const cases: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["backend", { ...ON, backend: 7 }],
    ["content", { ...ON, content: null }],
    ["available", { ...ON, available: "yes" }],
    ["reason", { ...ON, reason: 42 }],
    ["disabledBy", { ...ON, disabledBy: 3 }],
    ["rateLimitedTotal", { ...ON, rateLimitedTotal: "2" }],
    ["delivers", { ...ON, delivers: undefined }],
  ];
  for (const [field, raw] of cases) {
    test(`rejects a bad ${field}`, () => {
      expect(() => parseNotificationsStatus(raw)).toThrow(
        `malformed notifications response from the gateway: ${field}`,
      );
    });
  }

  test("non-object status shapes are refused", () => {
    expect(() => parseNotificationsStatus([ON])).toThrow("status is not an object");
    expect(() => parseNotificationsStatus("ON")).toThrow("status is not an object");
  });

  test("every disabledBy value the gateway can send is accepted", () => {
    for (const d of ["config", "env", "demo", "config_error"] as const) {
      expect(parseNotificationsStatus({ ...ENV_OFF, disabledBy: d }).disabledBy).toBe(d);
    }
  });

  test("an absent reason/disabledBy is omitted, not set to undefined", () => {
    const parsed = parseNotificationsStatus(ON);
    expect("reason" in parsed).toBe(false);
    expect("disabledBy" in parsed).toBe(false);
  });

  test("test result: non-object, bad status, and bad delivered/reason are refused", () => {
    expect(() => parseNotificationsTest(null)).toThrow("test result is not an object");
    expect(() => parseNotificationsTest([])).toThrow("test result is not an object");
    expect(() => parseNotificationsTest({ delivered: true })).toThrow("status is not an object");
    expect(() => parseNotificationsTest({ delivered: "yes", status: ON })).toThrow(
      "delivered/reason",
    );
    expect(() => parseNotificationsTest({ delivered: false, reason: 1, status: ON })).toThrow(
      "delivered/reason",
    );
    expect(
      parseNotificationsTest({ delivered: false, reason: "rate limited", status: ON }),
    ).toEqual({ delivered: false, reason: "rate limited", status: ON });
  });
});

describe("format: availability and enabled lines", () => {
  test("unavailable with and without a reason", () => {
    expect(formatNotificationsStatus({ ...ON, available: false, reason: "no bus" })).toContain(
      "  Available:   no — no bus\n",
    );
    expect(formatNotificationsStatus({ ...ON, available: false })).toContain("  Available:   no\n");
  });

  test("unknown availability with and without a reason", () => {
    expect(formatNotificationsStatus({ ...ON, available: null, reason: "probing" })).toContain(
      "  Available:   unknown — probing\n",
    );
    expect(formatNotificationsStatus({ ...ON, available: null })).toContain(
      "  Available:   unknown\n",
    );
  });

  test("disabled with and without a reason", () => {
    expect(formatNotificationsStatus(ENV_OFF)).toContain(
      "  Enabled:     no — disabled by NIMBUS_NOTIFICATIONS=off\n",
    );
    const { reason: _r, ...noReason } = ENV_OFF;
    expect(formatNotificationsStatus(noReason)).toContain("  Enabled:     no\n");
  });

  test("the full rendered status for a working backend", () => {
    expect(formatNotificationsStatus(ON)).toBe(
      [
        "OS notifications",
        "  Backend:     windows-toast",
        "  Enabled:     yes",
        "  Content:     full",
        "  Available:   yes",
        "  Rate-limited since the gateway started: 2",
        "",
      ].join("\n"),
    );
  });

  test("a delivered test on macOS adds the Script Editor hint; other backends do not", () => {
    const mac = { ...ON, backend: "macos-osascript" };
    expect(formatNotificationsTest({ delivered: true, status: mac })).toContain(
      "allow notifications for Script Editor",
    );
    expect(formatNotificationsTest({ delivered: true, status: ON })).toBe(
      "Test notification sent — check your notification centre.\n",
    );
  });
});

describe("doctor line fallbacks when the gateway sends no reason", () => {
  const { reason: _r, ...offNoReason } = ENV_OFF;
  test("each state has its own fallback text", () => {
    expect(doctorNotificationsLine({ ...offNoReason, disabledBy: "config_error" })).toEqual({
      line: "[warn] Notifications: off — invalid config",
      exit: 1,
    });
    expect(doctorNotificationsLine(offNoReason)).toEqual({
      line: "[info] Notifications: off — disabled",
      exit: 0,
    });
    expect(doctorNotificationsLine({ ...ON, available: false })).toEqual({
      line: "[warn] Notifications: unavailable — unknown reason",
      exit: 1,
    });
    expect(doctorNotificationsLine({ ...ON, available: null })).toEqual({
      line: "[info] Notifications: availability not yet known (probe pending)",
      exit: 0,
    });
    expect(doctorNotificationsLine(ON).line).toBe(
      "[ok] Notifications: windows-toast (content: full). Try `nimbus notifications test`.",
    );
  });
});
