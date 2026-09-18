import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  DEMO_TEMP_DIRNAME,
  demoModeRequested,
  demoRootFor,
  demoSocketPathFor,
  deriveDemoPaths,
} from "./demo-root.ts";
import { PlatformInitError } from "./errors.ts";
import type { PlatformPaths } from "./paths.ts";

function env(map: Record<string, string>): (name: string) => string | undefined {
  return (name) => map[name];
}

describe("demoModeRequested", () => {
  test.each([
    ["unset", {}],
    ["empty", { NIMBUS_DEMO: "" }],
    ["zero", { NIMBUS_DEMO: "0" }],
  ])("%s means off", (_label, map) => {
    expect(demoModeRequested(env(map))).toBe(false);
  });

  test('"1" means on', () => {
    expect(demoModeRequested(env({ NIMBUS_DEMO: "1" }))).toBe(true);
  });

  test.each(["true", "yes", "2", " 1"])('refuses the ambiguous value "%s"', (v) => {
    expect(() => demoModeRequested(env({ NIMBUS_DEMO: v }))).toThrow(PlatformInitError);
    expect(() => demoModeRequested(env({ NIMBUS_DEMO: v }))).toThrow(
      "NIMBUS_DEMO must be 1 or unset",
    );
  });

  test.each(["NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET"])(
    "refuses NIMBUS_DEMO=1 combined with a non-empty %s",
    (name) => {
      expect(() => demoModeRequested(env({ NIMBUS_DEMO: "1", [name]: "/somewhere" }))).toThrow(
        name,
      );
    },
  );

  test("an EMPTY override is ignored, matching the existing override semantics", () => {
    expect(demoModeRequested(env({ NIMBUS_DEMO: "1", NIMBUS_CONFIG_DIR: "" }))).toBe(true);
  });

  test("an override WITHOUT demo mode is not this function's concern", () => {
    expect(demoModeRequested(env({ NIMBUS_CONFIG_DIR: "/x" }))).toBe(false);
  });
});

describe("demoSocketPathFor", () => {
  const pipe = "\\\\.\\pipe\\nimbus-gateway";

  test("a Windows pipe gets a -demo-<12 hex> suffix derived from the demo root", () => {
    const s = demoSocketPathFor(pipe, join("A", "demo"));
    expect(s.startsWith(`${pipe}-demo-`)).toBe(true);
    expect(s.slice(`${pipe}-demo-`.length)).toMatch(/^[0-9a-f]{12}$/);
  });

  test("pipe detection is case-insensitive, like dirs.ts isWindowsNamedPipe", () => {
    const upper = "\\\\.\\PIPE\\nimbus-gateway";
    expect(demoSocketPathFor(upper, join("A", "demo"))).toMatch(/-demo-[0-9a-f]{12}$/);
  });

  test("the pipe suffix is deterministic per root and distinct across roots", () => {
    const a1 = demoSocketPathFor(pipe, join("A", "demo"));
    const a2 = demoSocketPathFor(pipe, join("A", "demo"));
    const b = demoSocketPathFor(pipe, join("B", "demo"));
    expect(a1).toBe(a2);
    expect(a1).not.toBe(b);
  });

  test("a unix socket moves to nimbus-gateway-demo.sock in the SAME directory", () => {
    const real = join("run", "user", "nimbus-gateway.sock");
    expect(demoSocketPathFor(real, "ignored")).toBe(
      join(dirname(real), "nimbus-gateway-demo.sock"),
    );
  });
});

describe("deriveDemoPaths", () => {
  const real: PlatformPaths = {
    configDir: join("R", "config"),
    dataDir: join("R", "data"),
    logDir: join("R", "data", "logs"),
    socketPath: join("R", "run", "nimbus-gateway.sock"),
    extensionsDir: join("R", "extensions"),
    tempDir: join(tmpdir(), "nimbus"),
  };

  test("every path moves under <realDataDir>/demo and the result is marked demo", () => {
    const root = demoRootFor(real.dataDir);
    expect(root).toBe(join("R", "data", "demo"));
    expect(deriveDemoPaths(real)).toEqual({
      configDir: join(root, "config"),
      dataDir: join(root, "data"),
      logDir: join(root, "data", "logs"),
      socketPath: join("R", "run", "nimbus-gateway-demo.sock"),
      extensionsDir: join(root, "data", "extensions"),
      tempDir: join(tmpdir(), DEMO_TEMP_DIRNAME),
      demo: true,
    });
  });
});
