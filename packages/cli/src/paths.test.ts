// packages/cli/src/paths.test.ts
//
// Covers `resolveSocketPath` + `getCliPlatformPaths` across all three OS
// branches on a single CI runner by stubbing both `./env.ts` (for env-var
// reads) and `process.platform` (restored from a captured PropertyDescriptor
// in afterEach).
//
// Caveat: `node:os.homedir()` and `node:os.tmpdir()` read the underlying OS
// at call time and do NOT change when `process.platform` is stubbed. On
// Linux CI, `homedir()` returns `/home/user` even when `platform` is stubbed
// to `"win32"`. Assertions therefore use `join(homedir(), ...)` against the
// same operands the source uses, never hardcoded paths.

import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

let envStub: Record<string, string | undefined> = {};

mock.module("./env.ts", () => ({
  envGet: (k: string): string | undefined => envStub[k],
}));

const { getCliPlatformPaths, resolveSocketPath } = await import("./paths.ts");

let origPlatform: PropertyDescriptor | undefined;

function setPlatform(value: NodeJS.Platform): void {
  origPlatform ??= Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value, configurable: true });
}

function restorePlatform(): void {
  if (origPlatform) {
    Object.defineProperty(process, "platform", origPlatform);
    origPlatform = undefined;
  }
}

describe("resolveSocketPath", () => {
  beforeEach(() => {
    envStub = {};
  });
  afterEach(() => {
    envStub = {};
    restorePlatform();
  });

  it("returns NIMBUS_GATEWAY_SOCKET override when set", () => {
    envStub["NIMBUS_GATEWAY_SOCKET"] = "/tmp/custom.sock";
    expect(resolveSocketPath()).toBe("/tmp/custom.sock");
  });

  it("treats empty NIMBUS_GATEWAY_SOCKET as unset (falls through to platform default)", () => {
    envStub["NIMBUS_GATEWAY_SOCKET"] = "";
    setPlatform("linux");
    envStub["XDG_RUNTIME_DIR"] = "/run/user/1000";
    expect(resolveSocketPath()).toBe(join("/run/user/1000", "nimbus-gateway.sock"));
  });

  it("returns the Windows named-pipe path on win32", () => {
    setPlatform("win32");
    expect(resolveSocketPath()).toBe(String.raw`\\.\pipe\nimbus-gateway`);
  });

  it("returns a TMPDIR-based path on darwin", () => {
    setPlatform("darwin");
    envStub["TMPDIR"] = "/private/var/tmp";
    expect(resolveSocketPath()).toBe(join("/private/var/tmp", "nimbus-gateway.sock"));
  });

  it("falls back to /tmp on darwin when TMPDIR is unset", () => {
    setPlatform("darwin");
    expect(resolveSocketPath()).toBe(join("/tmp", "nimbus-gateway.sock"));
  });

  it("uses XDG_RUNTIME_DIR on linux when set", () => {
    setPlatform("linux");
    envStub["XDG_RUNTIME_DIR"] = "/run/user/1000";
    expect(resolveSocketPath()).toBe(join("/run/user/1000", "nimbus-gateway.sock"));
  });

  it("falls back to tmpdir() on linux when XDG_RUNTIME_DIR is unset", () => {
    setPlatform("linux");
    expect(resolveSocketPath()).toBe(join(tmpdir(), "nimbus-gateway.sock"));
  });
});

describe("getCliPlatformPaths — win32 branch", () => {
  beforeEach(() => {
    envStub = {};
    setPlatform("win32");
  });
  afterEach(() => {
    envStub = {};
    restorePlatform();
  });

  it("derives configDir from APPDATA + dataDir from LOCALAPPDATA", () => {
    envStub["APPDATA"] = "C:\\Users\\Test\\AppData\\Roaming";
    envStub["LOCALAPPDATA"] = "C:\\Users\\Test\\AppData\\Local";
    const paths = getCliPlatformPaths();
    expect(paths.configDir).toBe(join("C:\\Users\\Test\\AppData\\Roaming", "Nimbus"));
    expect(paths.dataDir).toBe(join("C:\\Users\\Test\\AppData\\Local", "Nimbus", "data"));
    expect(paths.logDir).toBe(join(paths.dataDir, "logs"));
    expect(paths.extensionsDir).toBe(
      join("C:\\Users\\Test\\AppData\\Local", "Nimbus", "extensions"),
    );
    expect(paths.tempDir).toBe(join(tmpdir(), "nimbus"));
    expect(paths.socketPath).toBe(String.raw`\\.\pipe\nimbus-gateway`);
  });

  it("throws when APPDATA is missing", () => {
    envStub["LOCALAPPDATA"] = "C:\\x";
    expect(() => getCliPlatformPaths()).toThrow(/APPDATA/);
  });

  it("throws when APPDATA is empty", () => {
    envStub["APPDATA"] = "";
    envStub["LOCALAPPDATA"] = "C:\\x";
    expect(() => getCliPlatformPaths()).toThrow(/APPDATA/);
  });

  it("throws when LOCALAPPDATA is missing", () => {
    envStub["APPDATA"] = "C:\\x";
    expect(() => getCliPlatformPaths()).toThrow(/LOCALAPPDATA/);
  });

  it("throws when LOCALAPPDATA is empty", () => {
    envStub["APPDATA"] = "C:\\x";
    envStub["LOCALAPPDATA"] = "";
    expect(() => getCliPlatformPaths()).toThrow(/LOCALAPPDATA/);
  });
});

describe("getCliPlatformPaths — darwin branch", () => {
  beforeEach(() => {
    envStub = {};
    setPlatform("darwin");
  });
  afterEach(() => {
    envStub = {};
    restorePlatform();
  });

  it("places configDir, dataDir, and logDir under Library/Application Support/Nimbus", () => {
    const paths = getCliPlatformPaths();
    const root = join(homedir(), "Library", "Application Support", "Nimbus");
    expect(paths.configDir).toBe(root);
    expect(paths.dataDir).toBe(root);
    expect(paths.logDir).toBe(join(root, "logs"));
    expect(paths.extensionsDir).toBe(join(root, "extensions"));
    expect(paths.tempDir).toBe(join(tmpdir(), "nimbus"));
  });
});

describe("getCliPlatformPaths — linux branch", () => {
  beforeEach(() => {
    envStub = {};
    setPlatform("linux");
  });
  afterEach(() => {
    envStub = {};
    restorePlatform();
  });

  it("uses XDG_CONFIG_HOME + XDG_DATA_HOME when set", () => {
    envStub["XDG_CONFIG_HOME"] = "/var/test/config";
    envStub["XDG_DATA_HOME"] = "/var/test/data";
    const paths = getCliPlatformPaths();
    expect(paths.configDir).toBe(join("/var/test/config", "nimbus"));
    expect(paths.dataDir).toBe(join("/var/test/data", "nimbus"));
    expect(paths.logDir).toBe(join("/var/test/data", "nimbus", "logs"));
    expect(paths.extensionsDir).toBe(join("/var/test/data", "nimbus", "extensions"));
    expect(paths.tempDir).toBe(join(tmpdir(), "nimbus"));
  });

  it("falls back to ~/.config and ~/.local/share when XDG vars are unset", () => {
    const paths = getCliPlatformPaths();
    expect(paths.configDir).toBe(join(homedir(), ".config", "nimbus"));
    expect(paths.dataDir).toBe(join(homedir(), ".local", "share", "nimbus"));
  });
});
