import { describe, expect, test } from "bun:test";

import type { SpawnCaptureOptions, SpawnCaptureResult } from "../spawn-capture.ts";
import {
  buildOsascriptArgv,
  createDarwinNotificationBackend,
  OSASCRIPT_PATH,
  OSASCRIPT_STATEMENTS,
} from "./darwin.ts";
import {
  NOTIFICATION_BODY_MAX_CHARS,
  NOTIFICATION_SPAWN_TIMEOUT_MS,
  NOTIFICATION_TITLE_MAX_CHARS,
  NotificationSendError,
  prepareNotificationText,
} from "./types.ts";

const HOSTILE: readonly string[] = [
  "plain title",
  `it's "quoted" " & (do shell script "rm -rf ~") & "`,
  "back\\slash\\\\double",
  "<b>&amp;</text><x>",
  "line one\nline two",
  "$(touch /tmp/pwned) `id`",
  '-e display dialog "x"',
  "--",
  "unicode: café, 日本語, emoji 😀",
  "nul\u0000byte",
];

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

const FIXED_PREFIX = [
  OSASCRIPT_PATH,
  "-e",
  "on run argv",
  "-e",
  "display notification (item 2 of argv) with title (item 1 of argv)",
  "-e",
  "end run",
  "--",
];

describe("macOS osascript — argv", () => {
  test("the AppleScript is constant and reads text only from argv", () => {
    expect(OSASCRIPT_STATEMENTS.join("\n")).not.toMatch(/"/);
    expect(buildOsascriptArgv("T", "B")).toEqual([...FIXED_PREFIX, "T", "B"]);
  });

  test.each(HOSTILE.map((s) => [s]))(
    "hostile text %j is passed as the last two argv elements, after --, verbatim",
    (s) => {
      const argv = buildOsascriptArgv(s, `${s} body`);
      expect(argv.slice(0, FIXED_PREFIX.length)).toEqual(FIXED_PREFIX);
      expect(argv).toHaveLength(FIXED_PREFIX.length + 2);
      expect(argv[FIXED_PREFIX.length]).toBe(
        prepareNotificationText(s, NOTIFICATION_TITLE_MAX_CHARS),
      );
      expect(argv[FIXED_PREFIX.length + 1]).toBe(
        prepareNotificationText(`${s} body`, NOTIFICATION_BODY_MAX_CHARS),
      );
      // Nothing from the text enters an `-e` statement.
      for (let i = 0; i < FIXED_PREFIX.length; i += 1) expect(argv[i]).toBe(FIXED_PREFIX[i]);
      for (const a of argv) expect(a).not.toContain("\u0000");
    },
  );

  test("a very long title/body is capped", () => {
    const argv = buildOsascriptArgv("x".repeat(10_000), "😀".repeat(10_000));
    expect(Array.from(argv.at(-2) ?? "")).toHaveLength(NOTIFICATION_TITLE_MAX_CHARS);
    expect(Array.from(argv.at(-1) ?? "")).toHaveLength(NOTIFICATION_BODY_MAX_CHARS);
  });
});

describe("macOS osascript — backend", () => {
  test("probe checks that osascript exists, without spawning", async () => {
    const { calls, spawn } = recordingSpawn();
    const seen: string[] = [];
    const present = createDarwinNotificationBackend({
      spawn,
      env: {},
      fileExists: (p) => {
        seen.push(p);
        return true;
      },
    });
    expect(present.id).toBe("macos-osascript");
    expect(await present.probe()).toEqual({ available: true });
    expect(seen).toEqual([OSASCRIPT_PATH]);

    const absent = createDarwinNotificationBackend({ spawn, env: {}, fileExists: () => false });
    const r = await absent.probe();
    expect(r.available).toBe(false);
    expect(r.reason).toContain("osascript");

    const throwing = createDarwinNotificationBackend({
      spawn,
      env: {},
      fileExists: () => {
        throw new Error("EACCES");
      },
    });
    expect((await throwing.probe()).available).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("send spawns the argv with a minimal env and a timeout", async () => {
    const { calls, spawn } = recordingSpawn();
    const backend = createDarwinNotificationBackend({
      spawn,
      env: { HOME: "/Users/a", PATH: "/usr/bin", AWS_SECRET_ACCESS_KEY: "s3cr3t" },
      fileExists: () => true,
    });
    await backend.send("Nimbus", "body");
    expect(calls).toEqual([
      {
        argv: buildOsascriptArgv("Nimbus", "body"),
        options: {
          env: { HOME: "/Users/a", PATH: "/usr/bin" },
          timeoutMs: NOTIFICATION_SPAWN_TIMEOUT_MS,
        },
      },
    ]);
  });

  test("a failed send rejects with a text-free reason", async () => {
    const body = "SECRET-BODY-SENTINEL";
    const backend = createDarwinNotificationBackend({
      spawn: recordingSpawn({ ok: false, code: 1, stderr: body }).spawn,
      env: {},
    });
    const err = await backend.send("t", body).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NotificationSendError);
    expect((err as Error).message).toBe("osascript exited with code 1");
  });
});
