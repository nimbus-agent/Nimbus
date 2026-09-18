// The CLI and the gateway each carry a demo-root module because neither may import the other.
// If they drift, `nimbus --demo …` dials a socket the demo gateway never bound, or reads a
// gateway.json it never wrote. This is the only place allowed to import both.
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import * as cli from "../../packages/cli/src/lib/demo-root.ts";
import * as gw from "../../packages/gateway/src/platform/demo-root.ts";

const REALS = [
  {
    name: "windows-shaped",
    real: {
      configDir: join("C:", "Users", "u", "AppData", "Roaming", "Nimbus"),
      dataDir: join("C:", "Users", "u", "AppData", "Local", "Nimbus", "data"),
      logDir: join("C:", "Users", "u", "AppData", "Local", "Nimbus", "data", "logs"),
      socketPath: "\\\\.\\pipe\\nimbus-gateway",
      extensionsDir: join("C:", "Users", "u", "AppData", "Local", "Nimbus", "extensions"),
      tempDir: join("T", "nimbus"),
    },
  },
  {
    // Upper-case prefix: the gateway detects pipes via dirs.ts's case-insensitive
    // isWindowsNamedPipe, the CLI inline — this row is what keeps those two equal.
    name: "windows-shaped, upper-case PIPE prefix",
    real: {
      configDir: join("C:", "Users", "u", "AppData", "Roaming", "Nimbus"),
      dataDir: join("C:", "Users", "u", "AppData", "Local", "Nimbus", "data"),
      logDir: join("C:", "Users", "u", "AppData", "Local", "Nimbus", "data", "logs"),
      socketPath: "\\\\.\\PIPE\\nimbus-gateway",
      extensionsDir: join("C:", "Users", "u", "AppData", "Local", "Nimbus", "extensions"),
      tempDir: join("T", "nimbus"),
    },
  },
  {
    name: "darwin-shaped (configDir === dataDir)",
    real: {
      configDir: join("Users", "u", "Library", "Application Support", "Nimbus"),
      dataDir: join("Users", "u", "Library", "Application Support", "Nimbus"),
      logDir: join("Users", "u", "Library", "Application Support", "Nimbus", "logs"),
      socketPath: join("var", "folders", "x", "T", "nimbus-gateway.sock"),
      extensionsDir: join("Users", "u", "Library", "Application Support", "Nimbus", "extensions"),
      tempDir: join("T", "nimbus"),
    },
  },
  {
    name: "linux-shaped",
    real: {
      configDir: join("home", "u", ".config", "nimbus"),
      dataDir: join("home", "u", ".local", "share", "nimbus"),
      logDir: join("home", "u", ".local", "share", "nimbus", "logs"),
      socketPath: join("run", "user", "1000", "nimbus-gateway.sock"),
      extensionsDir: join("home", "u", ".local", "share", "nimbus", "extensions"),
      tempDir: join("T", "nimbus"),
    },
  },
] as const;

const ENVS: ReadonlyArray<Record<string, string>> = [
  {},
  { NIMBUS_DEMO: "" },
  { NIMBUS_DEMO: "0" },
  { NIMBUS_DEMO: "1" },
  { NIMBUS_DEMO: "true" },
  { NIMBUS_DEMO: "1", NIMBUS_CONFIG_DIR: "/x" },
  { NIMBUS_DEMO: "1", NIMBUS_GATEWAY_SOCKET: "/x" },
  { NIMBUS_DEMO: "1", NIMBUS_CONFIG_DIR: "" },
  { NIMBUS_CONFIG_DIR: "/x" },
];

function verdict(
  fn: (get: (n: string) => string | undefined) => boolean,
  map: Record<string, string>,
) {
  try {
    return { ok: true as const, value: fn((n) => map[n]) };
  } catch (e) {
    return { ok: false as const, message: e instanceof Error ? e.message : String(e) };
  }
}

describe("demo-root parity: CLI mirror ≡ gateway", () => {
  for (const { name, real } of REALS) {
    test(`deriveDemoPaths agrees for ${name}`, () => {
      expect(cli.deriveDemoPaths({ ...real })).toEqual(gw.deriveDemoPaths({ ...real }));
    });
  }

  test("demoModeRequested gives the same verdict and message for every env shape", () => {
    for (const map of ENVS) {
      expect(verdict(cli.demoModeRequested, map)).toEqual(verdict(gw.demoModeRequested, map));
    }
  });

  test("the exported constants agree", () => {
    expect(cli.DEMO_ENV).toBe(gw.DEMO_ENV);
    expect(cli.DEMO_DIRNAME).toBe(gw.DEMO_DIRNAME);
    expect(cli.DEMO_TEMP_DIRNAME).toBe(gw.DEMO_TEMP_DIRNAME);
  });
});
