import { afterEach, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformInitError } from "./errors.ts";
import { createDarwinPaths, createLinuxPaths, createWindowsPaths } from "./paths.ts";

// Real, unique temp root used as an arbitrary TMPDIR override value (S5443).
const FAKE_TMPDIR = mkdtempSync(join(tmpdir(), "nimbus-paths-test-"));

const TRACKED_ENV_KEYS = [
  "APPDATA",
  "LOCALAPPDATA",
  "NIMBUS_CONFIG_DIR",
  "NIMBUS_DEMO",
  "NIMBUS_GATEWAY_SOCKET",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_RUNTIME_DIR",
] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const k of TRACKED_ENV_KEYS) {
    out[k] = process.env[k];
  }
  return out;
}

function restoreEnv(snapshot: Record<string, string | undefined>): void {
  for (const k of TRACKED_ENV_KEYS) {
    const v = snapshot[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}

function clearEnv(): void {
  for (const k of TRACKED_ENV_KEYS) {
    delete process.env[k];
  }
}

describe("createWindowsPaths", () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
  });
  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("derives configDir from APPDATA and dataDir from LOCALAPPDATA", () => {
    const appData = String.raw`C:\Users\Test\AppData\Roaming`;
    const localAppData = String.raw`C:\Users\Test\AppData\Local`;
    process.env["APPDATA"] = appData;
    process.env["LOCALAPPDATA"] = localAppData;
    const paths = createWindowsPaths();
    expect(paths.configDir).toBe(join(appData, "Nimbus"));
    expect(paths.dataDir).toBe(join(localAppData, "Nimbus", "data"));
    expect(paths.logDir).toBe(join(localAppData, "Nimbus", "data", "logs"));
    expect(paths.socketPath).toBe(String.raw`\\.\pipe\nimbus-gateway`);
    expect(paths.extensionsDir).toBe(join(localAppData, "Nimbus", "extensions"));
    expect(paths.tempDir).toBe(join(tmpdir(), "nimbus"));
  });

  it("throws PlatformInitError when APPDATA is missing", () => {
    process.env["LOCALAPPDATA"] = String.raw`C:\Users\Test\AppData\Local`;
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });

  it("throws PlatformInitError when LOCALAPPDATA is missing", () => {
    process.env["APPDATA"] = String.raw`C:\Users\Test\AppData\Roaming`;
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });

  it("throws PlatformInitError when APPDATA is empty string", () => {
    process.env["APPDATA"] = "";
    process.env["LOCALAPPDATA"] = String.raw`C:\Users\Test\AppData\Local`;
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });
});

describe("createDarwinPaths", () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
  });
  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("places configDir + dataDir + logDir under Library/Application Support/Nimbus", () => {
    const paths = createDarwinPaths();
    const expectedRoot = join(homedir(), "Library", "Application Support", "Nimbus");
    expect(paths.configDir).toBe(expectedRoot);
    expect(paths.dataDir).toBe(expectedRoot);
    expect(paths.logDir).toBe(join(expectedRoot, "logs"));
    expect(paths.extensionsDir).toBe(join(expectedRoot, "extensions"));
    expect(paths.tempDir).toBe(join(tmpdir(), "nimbus"));
  });

  it("uses TMPDIR for the socketPath base when set", () => {
    process.env["TMPDIR"] = FAKE_TMPDIR;
    const paths = createDarwinPaths();
    expect(paths.socketPath).toBe(join(FAKE_TMPDIR, "nimbus-gateway.sock"));
  });

  it("falls back to /tmp for the socketPath base when TMPDIR is unset", () => {
    const paths = createDarwinPaths();
    // Asserts production's hardcoded /tmp socket fallback (darwin, TMPDIR unset).
    expect(paths.socketPath).toBe(join("/tmp", "nimbus-gateway.sock")); // NOSONAR S5443: production fallback assertion
  });
});

describe("createLinuxPaths", () => {
  let snapshot: Record<string, string | undefined>;

  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
  });
  afterEach(() => {
    restoreEnv(snapshot);
  });

  it("uses XDG_CONFIG_HOME + XDG_DATA_HOME + XDG_RUNTIME_DIR when set", () => {
    process.env["XDG_CONFIG_HOME"] = "/var/test/config";
    process.env["XDG_DATA_HOME"] = "/var/test/data";
    process.env["XDG_RUNTIME_DIR"] = "/run/user/1000";
    const paths = createLinuxPaths();
    expect(paths.configDir).toBe(join("/var/test/config", "nimbus"));
    expect(paths.dataDir).toBe(join("/var/test/data", "nimbus"));
    expect(paths.socketPath).toBe(join("/run/user/1000", "nimbus-gateway.sock"));
    expect(paths.logDir).toBe(join("/var/test/data", "nimbus", "logs"));
    expect(paths.extensionsDir).toBe(join("/var/test/data", "nimbus", "extensions"));
    expect(paths.tempDir).toBe(join(tmpdir(), "nimbus"));
  });

  it("falls back to ~/.config and ~/.local/share when XDG vars are unset", () => {
    const paths = createLinuxPaths();
    const home = homedir();
    expect(paths.configDir).toBe(join(home, ".config", "nimbus"));
    expect(paths.dataDir).toBe(join(home, ".local", "share", "nimbus"));
  });

  it("falls back to tmpdir() for the socket runtime dir when XDG_RUNTIME_DIR is unset", () => {
    const paths = createLinuxPaths();
    expect(paths.socketPath).toBe(join(tmpdir(), "nimbus-gateway.sock"));
  });
});

describe("NIMBUS_CONFIG_DIR override", () => {
  const OVERRIDE = join(FAKE_TMPDIR, "override-config");

  it("relocates configDir on every platform creator", () => {
    // createDarwinPaths() reads homedir() with no env input at all, so without
    // this seam an isolated test on macOS would read and write the developer's
    // real config directory.
    process.env["NIMBUS_CONFIG_DIR"] = OVERRIDE;
    process.env["APPDATA"] = join(FAKE_TMPDIR, "roaming");
    process.env["LOCALAPPDATA"] = join(FAKE_TMPDIR, "local");

    expect(createWindowsPaths().configDir).toBe(OVERRIDE);
    expect(createDarwinPaths().configDir).toBe(OVERRIDE);
    expect(createLinuxPaths().configDir).toBe(OVERRIDE);
  });

  it("moves ONLY configDir — dataDir and socketPath are untouched", () => {
    // Scoped deliberately: a wider override could silently repoint a live
    // gateway's database or socket.
    const before = createLinuxPaths();
    process.env["NIMBUS_CONFIG_DIR"] = OVERRIDE;
    const after = createLinuxPaths();

    expect(after.configDir).toBe(OVERRIDE);
    expect(after.dataDir).toBe(before.dataDir);
    expect(after.socketPath).toBe(before.socketPath);
  });

  it("an empty value is ignored, not treated as a valid path", () => {
    process.env["NIMBUS_CONFIG_DIR"] = "";
    expect(createLinuxPaths().configDir).toBe(join(homedir(), ".config", "nimbus"));
  });

  it("absent override leaves the platform default intact", () => {
    delete process.env["NIMBUS_CONFIG_DIR"];
    expect(createLinuxPaths().configDir).toBe(join(homedir(), ".config", "nimbus"));
  });
});

describe("NIMBUS_GATEWAY_SOCKET override", () => {
  const saved = process.env["NIMBUS_GATEWAY_SOCKET"];
  afterEach(() => {
    if (saved === undefined) {
      delete process.env["NIMBUS_GATEWAY_SOCKET"];
    } else {
      process.env["NIMBUS_GATEWAY_SOCKET"] = saved;
    }
  });

  test("overrides socketPath on every platform creator", () => {
    // The CLI has honoured this since before the gateway did
    // (cli/src/paths.ts resolveSocketPath). While only one side read it, a user
    // who set it got a CLI waiting on a pipe the gateway would never bind —
    // `nimbus start` hung for 60s and then failed. Both sides must agree.
    const target = join(tmpdir(), "nimbus-socket-override.sock");
    process.env["NIMBUS_GATEWAY_SOCKET"] = target;
    process.env["APPDATA"] ??= join(tmpdir(), "appdata");
    process.env["LOCALAPPDATA"] ??= join(tmpdir(), "localappdata");

    expect(createWindowsPaths().socketPath).toBe(target);
    expect(createDarwinPaths().socketPath).toBe(target);
    expect(createLinuxPaths().socketPath).toBe(target);
  });

  test("leaves configDir and dataDir alone — only the socket moves", () => {
    delete process.env["NIMBUS_GATEWAY_SOCKET"];
    const before = createLinuxPaths();
    process.env["NIMBUS_GATEWAY_SOCKET"] = join(tmpdir(), "nimbus-socket-override.sock");
    const after = createLinuxPaths();
    expect(after.configDir).toBe(before.configDir);
    expect(after.dataDir).toBe(before.dataDir);
    expect(after.logDir).toBe(before.logDir);
  });

  test("an empty value is ignored, not treated as a socket path", () => {
    delete process.env["NIMBUS_GATEWAY_SOCKET"];
    const before = createLinuxPaths().socketPath;
    process.env["NIMBUS_GATEWAY_SOCKET"] = "";
    expect(createLinuxPaths().socketPath).toBe(before);
  });
});

describe("NIMBUS_DEMO=1 relocates every resolver into <realDataDir>/demo", () => {
  let snapshot: Record<string, string | undefined>;
  // HOME/USERPROFILE are saved and restored HERE rather than added to TRACKED_ENV_KEYS: `clearEnv()`
  // deletes every tracked key in the OTHER describes' beforeEach, and those tests compute their
  // expectations from the real `homedir()`.
  let savedHome: string | undefined;
  let savedUserProfile: string | undefined;
  beforeEach(() => {
    snapshot = snapshotEnv();
    clearEnv();
    savedHome = process.env["HOME"];
    savedUserProfile = process.env["USERPROFILE"];
    process.env["HOME"] = join(FAKE_TMPDIR, "home");
    process.env["USERPROFILE"] = join(FAKE_TMPDIR, "home");
    process.env["APPDATA"] = join(FAKE_TMPDIR, "roaming");
    process.env["LOCALAPPDATA"] = join(FAKE_TMPDIR, "local");
    process.env["XDG_CONFIG_HOME"] = join(FAKE_TMPDIR, "xdg-config");
    process.env["XDG_DATA_HOME"] = join(FAKE_TMPDIR, "xdg-data");
    process.env["XDG_RUNTIME_DIR"] = join(FAKE_TMPDIR, "run");
    process.env["TMPDIR"] = FAKE_TMPDIR;
  });
  afterEach(() => {
    restoreEnv(snapshot);
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    if (savedUserProfile === undefined) delete process.env["USERPROFILE"];
    else process.env["USERPROFILE"] = savedUserProfile;
  });

  const RESOLVERS = [
    ["win32", createWindowsPaths],
    ["darwin", createDarwinPaths],
    ["linux", createLinuxPaths],
  ] as const;

  for (const [os, resolve] of RESOLVERS) {
    test(`${os}: demo paths are the derivation of the real ones`, () => {
      const real = resolve();
      process.env["NIMBUS_DEMO"] = "1";
      const demo = resolve();
      expect(demo.demo).toBe(true);
      expect(demo.configDir).toBe(join(real.dataDir, "demo", "config"));
      expect(demo.dataDir).toBe(join(real.dataDir, "demo", "data"));
      expect(real.demo).toBeUndefined();
    });

    test(`${os}: refuses NIMBUS_DEMO=1 with NIMBUS_CONFIG_DIR`, () => {
      process.env["NIMBUS_DEMO"] = "1";
      process.env["NIMBUS_CONFIG_DIR"] = join(FAKE_TMPDIR, "elsewhere");
      expect(() => resolve()).toThrow("NIMBUS_CONFIG_DIR");
    });
  }

  // The reviewer's requested regression: on Linux, socketPath is derived from XDG_RUNTIME_DIR while
  // dataDir (and so the demo root) is derived from XDG_DATA_HOME. Two demo roots that share a socket
  // directory but differ in data directory must still resolve to two DIFFERENT sockets, or the
  // second gateway cannot bind and a CLI can reach the OTHER demo's gateway.
  test("linux: two demo roots sharing XDG_RUNTIME_DIR but differing in XDG_DATA_HOME resolve to different socketPaths", () => {
    process.env["NIMBUS_DEMO"] = "1";
    process.env["XDG_DATA_HOME"] = join(FAKE_TMPDIR, "xdg-data-one");
    const one = createLinuxPaths();
    process.env["XDG_DATA_HOME"] = join(FAKE_TMPDIR, "xdg-data-two");
    const two = createLinuxPaths();
    expect(one.socketPath).not.toBe(two.socketPath);
  });
});
