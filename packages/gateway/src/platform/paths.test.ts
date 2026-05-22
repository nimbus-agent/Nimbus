import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PlatformInitError } from "./errors.ts";
import { createDarwinPaths, createLinuxPaths, createWindowsPaths } from "./paths.ts";

// paths.ts reads env vars through `processEnvGet` (a 1-line wrapper around
// `process.env[k]`). Instead of mocking that module via `mock.module(...)`
// — which is process-global in bun and leaks to every later test that
// imports `processEnvGet`, breaking ~40 unrelated cases on macOS CI when the
// load order surfaces this file first — we mutate `process.env` directly
// and restore the originals in `afterEach`. This is the same pattern Phase 4
// auth tests use (e.g. `auth/notion-access-token.test.ts`).
//
// We touch the union of every env var read across the three `create<OS>Paths`
// functions: Windows (APPDATA, LOCALAPPDATA), macOS (TMPDIR), Linux
// (XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_RUNTIME_DIR).
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
    const appData = "C:\\Users\\Test\\AppData\\Roaming";
    const localAppData = "C:\\Users\\Test\\AppData\\Local";
    process.env["APPDATA"] = appData;
    process.env["LOCALAPPDATA"] = localAppData;
    const paths = createWindowsPaths();
    // `node:path.join` is platform-dependent — on macOS/Linux CI it uses `/`
    // as the separator even when the operand strings contain backslashes.
    // Compute expected values the same way the source does so the assertions
    // match regardless of host OS.
    expect(paths.configDir).toBe(join(appData, "Nimbus"));
    expect(paths.dataDir).toBe(join(localAppData, "Nimbus", "data"));
    expect(paths.logDir).toBe(join(localAppData, "Nimbus", "data", "logs"));
    // The source builds the socketPath as a Windows named-pipe literal regardless
    // of host OS — no `join` is involved, so the raw-string assertion is correct.
    expect(paths.socketPath).toBe(String.raw`\\.\pipe\nimbus-gateway`);
    expect(paths.extensionsDir).toBe(join(localAppData, "Nimbus", "extensions"));
    expect(paths.tempDir).toBe(join(tmpdir(), "nimbus"));
  });

  it("throws PlatformInitError when APPDATA is missing", () => {
    process.env["LOCALAPPDATA"] = "C:\\Users\\Test\\AppData\\Local";
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });

  it("throws PlatformInitError when LOCALAPPDATA is missing", () => {
    process.env["APPDATA"] = "C:\\Users\\Test\\AppData\\Roaming";
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });

  it("throws PlatformInitError when APPDATA is empty string", () => {
    process.env["APPDATA"] = "";
    process.env["LOCALAPPDATA"] = "C:\\Users\\Test\\AppData\\Local";
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
    // On Darwin configDir and dataDir share the same root
    expect(paths.dataDir).toBe(expectedRoot);
    expect(paths.logDir).toBe(join(expectedRoot, "logs"));
    expect(paths.extensionsDir).toBe(join(expectedRoot, "extensions"));
    expect(paths.tempDir).toBe(join(tmpdir(), "nimbus"));
  });

  it("uses TMPDIR for the socketPath base when set", () => {
    process.env["TMPDIR"] = "/private/var/tmp/custom";
    const paths = createDarwinPaths();
    // Use join so the assertion is cross-platform (Windows path.join converts separators)
    expect(paths.socketPath).toBe(join("/private/var/tmp/custom", "nimbus-gateway.sock"));
  });

  it("falls back to /tmp for the socketPath base when TMPDIR is unset", () => {
    // env has no TMPDIR — processEnvGet returns undefined → source uses "/tmp"
    const paths = createDarwinPaths();
    expect(paths.socketPath).toBe(join("/tmp", "nimbus-gateway.sock"));
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
    // Use join so the assertion is cross-platform (Windows path.join converts separators)
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
