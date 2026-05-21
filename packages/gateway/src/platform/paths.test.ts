import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

// Stubbable env access. Each test sets `envStub[key]` to control what
// `processEnvGet(key)` returns inside paths.ts.
let envStub: Record<string, string | undefined> = {};
mock.module("./env-access.ts", () => ({
  processEnvGet: (k: string): string | undefined => envStub[k],
  processEnvDelete: (_k: string): void => {},
  processEnvSet: (_k: string, _v: string | undefined): void => {},
}));

// Import AFTER the mock is installed.
const { createWindowsPaths, createDarwinPaths, createLinuxPaths } = await import("./paths.ts");
const { PlatformInitError } = await import("./errors.ts");

describe("createWindowsPaths", () => {
  beforeEach(() => {
    envStub = {};
  });
  afterEach(() => {
    envStub = {};
  });

  it("derives configDir from APPDATA and dataDir from LOCALAPPDATA", () => {
    envStub["APPDATA"] = "C:\\Users\\Test\\AppData\\Roaming";
    envStub["LOCALAPPDATA"] = "C:\\Users\\Test\\AppData\\Local";
    const paths = createWindowsPaths();
    expect(paths.configDir).toBe("C:\\Users\\Test\\AppData\\Roaming\\Nimbus");
    expect(paths.dataDir).toBe("C:\\Users\\Test\\AppData\\Local\\Nimbus\\data");
    expect(paths.logDir).toBe("C:\\Users\\Test\\AppData\\Local\\Nimbus\\data\\logs");
    expect(paths.socketPath).toBe(String.raw`\\.\pipe\nimbus-gateway`);
    expect(paths.extensionsDir).toBe("C:\\Users\\Test\\AppData\\Local\\Nimbus\\extensions");
    expect(paths.tempDir).toBe(join(tmpdir(), "nimbus"));
  });

  it("throws PlatformInitError when APPDATA is missing", () => {
    envStub["LOCALAPPDATA"] = "C:\\Users\\Test\\AppData\\Local";
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });

  it("throws PlatformInitError when LOCALAPPDATA is missing", () => {
    envStub["APPDATA"] = "C:\\Users\\Test\\AppData\\Roaming";
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });

  it("throws PlatformInitError when APPDATA is empty string", () => {
    envStub["APPDATA"] = "";
    envStub["LOCALAPPDATA"] = "C:\\Users\\Test\\AppData\\Local";
    expect(() => createWindowsPaths()).toThrow(PlatformInitError);
  });
});

describe("createDarwinPaths", () => {
  beforeEach(() => {
    envStub = {};
  });
  afterEach(() => {
    envStub = {};
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
    envStub["TMPDIR"] = "/private/var/tmp/custom";
    const paths = createDarwinPaths();
    // Use join so the assertion is cross-platform (Windows path.join converts separators)
    expect(paths.socketPath).toBe(join("/private/var/tmp/custom", "nimbus-gateway.sock"));
  });

  it("falls back to /tmp for the socketPath base when TMPDIR is unset", () => {
    // envStub has no TMPDIR key — processEnvGet returns undefined → source uses "/tmp"
    const paths = createDarwinPaths();
    expect(paths.socketPath).toBe(join("/tmp", "nimbus-gateway.sock"));
  });
});

describe("createLinuxPaths", () => {
  beforeEach(() => {
    envStub = {};
  });
  afterEach(() => {
    envStub = {};
  });

  it("uses XDG_CONFIG_HOME + XDG_DATA_HOME + XDG_RUNTIME_DIR when set", () => {
    envStub["XDG_CONFIG_HOME"] = "/var/test/config";
    envStub["XDG_DATA_HOME"] = "/var/test/data";
    envStub["XDG_RUNTIME_DIR"] = "/run/user/1000";
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
