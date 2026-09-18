import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";
import {
  DEMO_TEMP_DIRNAME,
  DemoModeError,
  demoModeRequested,
  demoRootFor,
  demoSocketPathFor,
  deriveDemoPaths,
} from "./demo-root.ts";

function env(map: Record<string, string>): (name: string) => string | undefined {
  return (name) => map[name];
}

describe("demoModeRequested (cli mirror)", () => {
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
    expect(() => demoModeRequested(env({ NIMBUS_DEMO: v }))).toThrow(DemoModeError);
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

  test("an EMPTY override is ignored", () => {
    expect(demoModeRequested(env({ NIMBUS_DEMO: "1", NIMBUS_CONFIG_DIR: "" }))).toBe(true);
  });
});

describe("demoSocketPathFor (cli mirror)", () => {
  const pipe = "\\\\.\\pipe\\nimbus-gateway";
  test("Windows pipe: case-insensitive detection", () => {
    expect(demoSocketPathFor("\\\\.\\PIPE\\nimbus-gateway", join("A", "demo"))).toMatch(
      /-demo-[0-9a-f]{12}$/,
    );
  });

  test("Windows pipe: deterministic -demo-<12 hex> suffix", () => {
    const s = demoSocketPathFor(pipe, join("A", "demo"));
    expect(s.slice(`${pipe}-demo-`.length)).toMatch(/^[0-9a-f]{12}$/);
    expect(demoSocketPathFor(pipe, join("A", "demo"))).toBe(s);
    expect(demoSocketPathFor(pipe, join("B", "demo"))).not.toBe(s);
  });
  test("unix socket: same directory, demo basename", () => {
    const real = join("run", "nimbus-gateway.sock");
    expect(demoSocketPathFor(real, "x")).toBe(join(dirname(real), "nimbus-gateway-demo.sock"));
  });
});

describe("deriveDemoPaths (cli mirror)", () => {
  test("relocates under <realDataDir>/demo and marks demo", () => {
    const real: CliPlatformPaths = {
      configDir: join("R", "config"),
      dataDir: join("R", "data"),
      logDir: join("R", "data", "logs"),
      socketPath: join("R", "run", "nimbus-gateway.sock"),
      extensionsDir: join("R", "extensions"),
      tempDir: join(tmpdir(), "nimbus"),
    };
    const root = demoRootFor(real.dataDir);
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
