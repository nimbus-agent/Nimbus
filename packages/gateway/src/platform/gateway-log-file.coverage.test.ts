/**
 * Every per-OS arm of the daily-log resolution, asserted from ANY host through the `os` parameter.
 *
 * `gateway-log-file.test.ts` drives these through the host's own platform, so on a given runner
 * only that runner's arm ever executes — and the authoritative coverage run is Linux-only. Each
 * case here redirects the env vars the path constructors read into a fresh temp dir, so nothing is
 * written to a real profile. The one exception to the redirect is darwin, whose root is
 * `homedir()` with no env input: that arm's path is only COMPUTED and compared, never written —
 * which is also why the listener case below skips its write on a macOS host.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { homedir, platform, tmpdir } from "node:os";
import { join } from "node:path";

import { processEnvGet, processEnvSet } from "./env-access.ts";
import {
  emergencyGatewayLog,
  emergencyGatewayLogForPlatform,
  gatewayLogBasename,
  platformDailyLogPath,
} from "./gateway-log-file.ts";

const REDIRECTED = ["APPDATA", "LOCALAPPDATA", "XDG_DATA_HOME", "NIMBUS_DEMO"] as const;

/** `true` only when `F` takes EXACTLY one parameter: no optional or rest parameter after it. */
type TakesExactlyOneParameter<F extends (...args: never[]) => unknown> =
  Parameters<F> extends [unknown] ? ([unknown] extends Parameters<F> ? true : false) : false;

let tmp: string;
let saved: Map<string, string | undefined>;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-daily-log-"));
  saved = new Map(REDIRECTED.map((k) => [k, processEnvGet(k)]));
  processEnvSet("APPDATA", join(tmp, "roaming"));
  processEnvSet("LOCALAPPDATA", join(tmp, "local"));
  processEnvSet("XDG_DATA_HOME", join(tmp, "xdg-data"));
  // A demo-rooted environment re-roots every path (I41); these assertions are about the real one.
  processEnvSet("NIMBUS_DEMO", undefined);
});

afterEach(() => {
  for (const [k, v] of saved) processEnvSet(k, v);
  rmSync(tmp, { recursive: true, force: true });
});

describe("platformDailyLogPath — one arm per OS", () => {
  test("win32 resolves under LOCALAPPDATA\\Nimbus\\data\\logs", () => {
    expect(platformDailyLogPath("win32")).toBe(
      join(tmp, "local", "Nimbus", "data", "logs", gatewayLogBasename()),
    );
  });

  test("darwin resolves under ~/Library/Application Support/Nimbus/logs", () => {
    expect(platformDailyLogPath("darwin")).toBe(
      join(homedir(), "Library", "Application Support", "Nimbus", "logs", gatewayLogBasename()),
    );
  });

  test("linux resolves under $XDG_DATA_HOME/nimbus/logs", () => {
    expect(platformDailyLogPath("linux")).toBe(
      join(tmp, "xdg-data", "nimbus", "logs", gatewayLogBasename()),
    );
  });

  test("an unsupported platform has no daily log at all", () => {
    expect(platformDailyLogPath("aix")).toBeNull();
    expect(platformDailyLogPath("freebsd")).toBeNull();
  });

  test("omitting the platform resolves for the HOST, exactly as before the parameter existed", () => {
    expect(platformDailyLogPath()).toBe(platformDailyLogPath(platform()));
  });
});

describe("emergencyGatewayLogForPlatform — the platform arm decides whether anything is written", () => {
  const linuxLogsDir = (): string => join(tmp, "xdg-data", "nimbus", "logs");

  test("on a supported platform the fatal line is appended to that platform's daily log", () => {
    emergencyGatewayLogForPlatform(new Error("emergency-linux-arm"), "linux");
    const files = readdirSync(linuxLogsDir());
    expect(files).toEqual([gatewayLogBasename()]);
    const content = readFileSync(join(linuxLogsDir(), gatewayLogBasename()), "utf8");
    expect(content).toContain("[gateway] fatal: Error: emergency-linux-arm");
  });

  test("on an unsupported platform it returns before touching the filesystem", () => {
    emergencyGatewayLogForPlatform(new Error("emergency-aix-arm"), "aix");
    // Nothing was created anywhere under the redirected roots — not even the directories.
    expect(readdirSync(tmp)).toEqual([]);
    expect(existsSync(linuxLogsDir())).toBe(false);
  });

  test("the HOST logger ignores a listener's extra arguments — `(err, origin)` still logs", () => {
    // Runtime half: a `process.on("uncaughtException", …)` listener is called with
    // `(err, "uncaughtException")`. Had the platform been a defaulted SECOND parameter, that origin
    // string would be taken as the platform, resolve no log path, and record nothing. Run only
    // where the host's daily log is redirected into this test's temp dir (win32 via LOCALAPPDATA,
    // linux via XDG_DATA_HOME): darwin's lives under the real home, which a test must never write.
    const hostLog = platformDailyLogPath();
    if (hostLog?.startsWith(tmp) === true) {
      const asListener = emergencyGatewayLog as (err: unknown, origin: string) => void;
      asListener(new Error("listener-shaped"), "uncaughtException");
      expect(readFileSync(hostLog, "utf8")).toContain("[gateway] fatal: Error: listener-shaped");
    }
    // Compile-time half, checked by `tsc` on every host (macOS included, where the runtime half
    // cannot run): the host logger takes EXACTLY one parameter. An `@ts-expect-error` on a
    // two-argument call is NOT enough: re-adding `os: NodeJS.Platform = platform()` keeps that call
    // a type error ("uncaughtException" is not a platform), so the directive would stay satisfied
    // over exactly the regression it is meant to catch. This assignment fails for ANY added
    // parameter, optional or rest.
    const exactlyOneParameter: TakesExactlyOneParameter<typeof emergencyGatewayLog> = true;
    expect(exactlyOneParameter).toBe(true);
  });
});
