import { describe, expect, test } from "bun:test";

import type { SpawnCaptureOptions, SpawnCaptureResult } from "../spawn-capture.ts";
import {
  buildGdbusArgv,
  buildNotifySendArgv,
  createLinuxNotificationBackend,
  escapeDbusAddressValue,
  escapeNotificationMarkup,
  gvariantStringLiteral,
  resolveLinuxNotifier,
} from "./linux.ts";
import {
  NOTIFICATION_BODY_MAX_CHARS,
  NOTIFICATION_SPAWN_TIMEOUT_MS,
  NOTIFICATION_TITLE_MAX_CHARS,
  NotificationSendError,
  prepareNotificationText,
} from "./types.ts";

const HOSTILE: readonly string[] = [
  "plain title",
  `it's "quoted"`,
  "back\\slash\\\\double and trailing \\",
  "'] , ['injected'] , {'x': <1>} , '",
  "<b>&amp;</text><x>",
  "line one\nline two\ttab",
  "$(touch /tmp/pwned) `id`",
  "--urgency=critical",
  "unicode: café, 日本語, emoji 😀, ‮evil",
  "nul\u0000byte and esc\u001B[31m",
];

/**
 * A strict parser for ONE GVariant single-quoted string literal, mirroring the escapes
 * `g_variant_parse` accepts that `gvariantStringLiteral` emits. Throws if the input is anything
 * but exactly one literal — i.e. if text could have ended it early.
 */
function parseGVariantLiteral(lit: string): string {
  if (!lit.startsWith("'")) throw new Error("not a literal");
  let out = "";
  let i = 1;
  while (i < lit.length) {
    const ch = lit[i] ?? "";
    if (ch === "'") {
      if (i !== lit.length - 1) throw new Error(`literal ends early at ${i}`);
      return out;
    }
    if (ch === "\\") {
      const next = lit[i + 1] ?? "";
      if (next === "\\" || next === "'") {
        out += next;
        i += 2;
      } else if (next === "u") {
        out += String.fromCodePoint(Number.parseInt(lit.slice(i + 2, i + 6), 16));
        i += 6;
      } else {
        throw new Error(`unexpected escape \\${next}`);
      }
      continue;
    }
    out += ch;
    i += ch.length;
  }
  throw new Error("unterminated literal");
}

type Call = { argv: readonly string[]; options: SpawnCaptureOptions };

function recordingSpawn(result: Partial<SpawnCaptureResult> = {}) {
  const calls: Call[] = [];
  const spawn = (argv: readonly string[], options: SpawnCaptureOptions) => {
    calls.push({ argv, options });
    return Promise.resolve<SpawnCaptureResult>({
      ok: true,
      stdout: "",
      stderr: "",
      code: 0,
      ...result,
    });
  };
  return { calls, spawn };
}

describe("linux — text encoding", () => {
  test("markup escaping covers &, <, > with & first", () => {
    expect(escapeNotificationMarkup("a & <b> &amp;")).toBe("a &amp; &lt;b&gt; &amp;amp;");
  });

  test.each(HOSTILE.map((s) => [s]))("GVariant literal of %j parses back to exactly it", (s) => {
    const lit = gvariantStringLiteral(s);
    expect(parseGVariantLiteral(lit)).toBe(s);
    // Single line: no raw control characters reach gdbus.
    for (const ch of lit) {
      const cp = ch.codePointAt(0) ?? 0;
      expect(cp >= 0x20 && cp !== 0x7f).toBe(true);
    }
  });

  test("GVariant escapes are exact", () => {
    expect(gvariantStringLiteral("a'b\\c\nd")).toBe("'a\\'b\\\\c\\u000ad'");
    expect(gvariantStringLiteral("")).toBe("''");
  });

  test("D-Bus address escaping leaves the safe set alone and %-encodes the rest", () => {
    expect(escapeDbusAddressValue("/run/user/1000/bus")).toBe("/run/user/1000/bus");
    expect(escapeDbusAddressValue("/tmp/a b;c=d,é")).toBe("/tmp/a%20b%3Bc%3Dd%2C%C3%A9");
  });
});

describe("linux — argv builders", () => {
  test.each(HOSTILE.map((s) => [s]))("notify-send gets %j as plain argv after --", (s) => {
    const argv = buildNotifySendArgv("/usr/bin/notify-send", s, s);
    expect(argv).toEqual([
      "/usr/bin/notify-send",
      "--app-name=Nimbus",
      "--",
      prepareNotificationText(s, NOTIFICATION_TITLE_MAX_CHARS),
      escapeNotificationMarkup(prepareNotificationText(s, NOTIFICATION_BODY_MAX_CHARS)),
    ]);
    const body = argv[4] ?? "";
    expect(body).not.toMatch(/[<>]/);
  });

  test.each(HOSTILE.map((s) => [s]))(
    "gdbus gets %j as exactly one GVariant literal per field",
    (s) => {
      const argv = buildGdbusArgv("/usr/bin/gdbus", s, s);
      expect(argv.slice(0, 9)).toEqual([
        "/usr/bin/gdbus",
        "call",
        "--session",
        "--dest",
        "org.freedesktop.Notifications",
        "--object-path",
        "/org/freedesktop/Notifications",
        "--method",
        "org.freedesktop.Notifications.Notify",
      ]);
      expect(argv).toHaveLength(17);
      expect(argv[9]).toBe("'Nimbus'");
      expect(argv.slice(10, 12)).toEqual(["0", "''"]);
      expect(parseGVariantLiteral(argv[12] ?? "")).toBe(
        prepareNotificationText(s, NOTIFICATION_TITLE_MAX_CHARS),
      );
      expect(parseGVariantLiteral(argv[13] ?? "")).toBe(
        escapeNotificationMarkup(prepareNotificationText(s, NOTIFICATION_BODY_MAX_CHARS)),
      );
      expect(argv.slice(14)).toEqual(["[]", "{}", "5000"]);
    },
  );

  test("a very long title/body is capped", () => {
    const argv = buildNotifySendArgv("ns", "x".repeat(10_000), "y".repeat(10_000));
    expect(Array.from(argv[3] ?? "")).toHaveLength(NOTIFICATION_TITLE_MAX_CHARS);
    expect(Array.from(argv[4] ?? "")).toHaveLength(NOTIFICATION_BODY_MAX_CHARS);
  });
});

describe("linux — probe/resolution", () => {
  const which =
    (have: Record<string, string>) =>
    (cmd: string): string | null =>
      have[cmd] ?? null;

  test("needs a session bus", async () => {
    const r = resolveLinuxNotifier(
      { PATH: "/usr/bin" },
      () => false,
      which({ "notify-send": "/usr/bin/notify-send" }),
    );
    expect(r.ok).toBe(false);
    const backend = createLinuxNotificationBackend({
      env: { PATH: "/usr/bin" },
      fileExists: () => false,
      which: which({ "notify-send": "/usr/bin/notify-send" }),
    });
    const p = await backend.probe();
    expect(p.available).toBe(false);
    expect(p.reason).toContain("D-Bus");
  });

  test("derives the bus address from $XDG_RUNTIME_DIR/bus when it exists", () => {
    const seen: string[] = [];
    const r = resolveLinuxNotifier(
      { PATH: "/usr/bin", XDG_RUNTIME_DIR: "/run/user/1000", SECRET_TOKEN: "x" },
      (p) => {
        seen.push(p);
        return true;
      },
      which({ gdbus: "/usr/bin/gdbus" }),
    );
    expect(seen).toEqual(["/run/user/1000/bus"]);
    expect(r).toEqual({
      ok: true,
      tool: { kind: "gdbus", path: "/usr/bin/gdbus" },
      env: {
        PATH: "/usr/bin",
        XDG_RUNTIME_DIR: "/run/user/1000",
        DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
      },
    });
  });

  test("prefers notify-send over gdbus; neither → unavailable", () => {
    const env = { PATH: "/usr/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" };
    const both = resolveLinuxNotifier(
      env,
      () => false,
      which({ "notify-send": "/a/notify-send", gdbus: "/a/gdbus" }),
    );
    expect(both.ok && both.tool).toEqual({ kind: "notify-send", path: "/a/notify-send" });
    const none = resolveLinuxNotifier(env, () => false, which({}));
    expect(none).toEqual({ ok: false, reason: "neither notify-send nor gdbus is on PATH" });
  });

  test("which is called with the child's PATH", () => {
    const paths: string[] = [];
    resolveLinuxNotifier(
      { PATH: "/custom/bin", DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" },
      () => false,
      (_c, p) => {
        paths.push(p);
        return null;
      },
    );
    expect(paths).toEqual(["/custom/bin", "/custom/bin"]);
  });

  test("a throwing lookup resolves unavailable, never rejects", async () => {
    const backend = createLinuxNotificationBackend({
      env: { DBUS_SESSION_BUS_ADDRESS: "unix:path=/x" },
      which: () => {
        throw new Error("boom");
      },
    });
    expect((await backend.probe()).available).toBe(false);
  });
});

describe("linux — send", () => {
  const env = {
    PATH: "/usr/bin",
    HOME: "/home/a",
    DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
    GITHUB_TOKEN: "ghp_secret",
  };

  test("notify-send path: argv + minimal env + timeout", async () => {
    const { calls, spawn } = recordingSpawn();
    const backend = createLinuxNotificationBackend({
      spawn,
      env,
      which: (c) => (c === "notify-send" ? "/usr/bin/notify-send" : null),
    });
    expect(backend.id).toBe("linux-libnotify");
    await backend.send("Nimbus", "a <b> & c");
    expect(calls).toEqual([
      {
        argv: ["/usr/bin/notify-send", "--app-name=Nimbus", "--", "Nimbus", "a &lt;b&gt; &amp; c"],
        options: {
          env: {
            PATH: "/usr/bin",
            HOME: "/home/a",
            DBUS_SESSION_BUS_ADDRESS: "unix:path=/run/user/1000/bus",
          },
          timeoutMs: NOTIFICATION_SPAWN_TIMEOUT_MS,
        },
      },
    ]);
  });

  test("gdbus fallback path", async () => {
    const { calls, spawn } = recordingSpawn();
    const backend = createLinuxNotificationBackend({
      spawn,
      env,
      which: (c) => (c === "gdbus" ? "/usr/bin/gdbus" : null),
    });
    await backend.send("T", "B");
    expect(calls[0]?.argv).toEqual(buildGdbusArgv("/usr/bin/gdbus", "T", "B"));
  });

  test("failures reject with a text-free reason", async () => {
    const body = "SECRET-BODY-SENTINEL";
    const failing = createLinuxNotificationBackend({
      spawn: recordingSpawn({ ok: false, code: 1, stderr: body }).spawn,
      env,
      which: (c) => (c === "notify-send" ? "/usr/bin/notify-send" : null),
    });
    const e1 = await failing.send("t", body).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(NotificationSendError);
    expect((e1 as Error).message).toBe("notify-send exited with code 1");

    const noTool = createLinuxNotificationBackend({ env, which: () => null });
    const e2 = await noTool.send("t", body).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(NotificationSendError);
    expect((e2 as Error).message).not.toContain(body);
  });
});
