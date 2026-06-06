import { afterEach, beforeEach, describe, expect, it } from "bun:test";
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
