import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { getCliPlatformPaths, resolveSocketPath } from "./paths.ts";

// Real temp root for fake socket-path / TMPDIR override strings (never written to disk).
let tmpRoot: string;
beforeAll(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "nimbus-cli-paths-test-"));
});
afterAll(() => {
  if (tmpRoot) rmSync(tmpRoot, { recursive: true, force: true });
});

const ENV_KEYS = [
  "NIMBUS_GATEWAY_SOCKET",
  "TMPDIR",
  "XDG_RUNTIME_DIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "APPDATA",
  "LOCALAPPDATA",
] as const;

const originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};

function snapshotEnv(): void {
  for (const k of ENV_KEYS) originalEnv[k] = process.env[k];
}

function restoreEnv(): void {
  for (const k of ENV_KEYS) {
    const orig = originalEnv[k];
    if (orig === undefined) delete process.env[k];
    else process.env[k] = orig;
  }
}

function clearControlledEnv(): void {
  for (const k of ENV_KEYS) delete process.env[k];
}

snapshotEnv();

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
    clearControlledEnv();
  });
  afterEach(() => {
    restoreEnv();
    restorePlatform();
  });

  it("returns NIMBUS_GATEWAY_SOCKET override when set", () => {
    const customSock = join(tmpRoot, "custom.sock");
    process.env["NIMBUS_GATEWAY_SOCKET"] = customSock;
    expect(resolveSocketPath()).toBe(customSock);
  });

  it("treats empty NIMBUS_GATEWAY_SOCKET as unset (falls through to platform default)", () => {
    process.env["NIMBUS_GATEWAY_SOCKET"] = "";
    setPlatform("linux");
    process.env["XDG_RUNTIME_DIR"] = "/run/user/1000";
    expect(resolveSocketPath()).toBe(join("/run/user/1000", "nimbus-gateway.sock"));
  });

  it("returns the Windows named-pipe path on win32", () => {
    setPlatform("win32");
    expect(resolveSocketPath()).toBe(String.raw`\\.\pipe\nimbus-gateway`);
  });

  it("returns a TMPDIR-based path on darwin", () => {
    setPlatform("darwin");
    process.env["TMPDIR"] = "/private/var/tmp";
    expect(resolveSocketPath()).toBe(join("/private/var/tmp", "nimbus-gateway.sock"));
  });

  it("falls back to /tmp on darwin when TMPDIR is unset", () => {
    setPlatform("darwin");
    expect(resolveSocketPath()).toBe(join("/tmp", "nimbus-gateway.sock"));
  });

  it("uses XDG_RUNTIME_DIR on linux when set", () => {
    setPlatform("linux");
    process.env["XDG_RUNTIME_DIR"] = "/run/user/1000";
    expect(resolveSocketPath()).toBe(join("/run/user/1000", "nimbus-gateway.sock"));
  });

  it("falls back to tmpdir() on linux when XDG_RUNTIME_DIR is unset", () => {
    setPlatform("linux");
    expect(resolveSocketPath()).toBe(join(tmpdir(), "nimbus-gateway.sock"));
  });
});

describe("getCliPlatformPaths — win32 branch", () => {
  beforeEach(() => {
    clearControlledEnv();
    setPlatform("win32");
  });
  afterEach(() => {
    restoreEnv();
    restorePlatform();
  });

  it("derives configDir from APPDATA + dataDir from LOCALAPPDATA", () => {
    process.env["APPDATA"] = String.raw`C:\Users\Test\AppData\Roaming`;
    process.env["LOCALAPPDATA"] = String.raw`C:\Users\Test\AppData\Local`;
    const paths = getCliPlatformPaths();
    expect(paths.configDir).toBe(join(String.raw`C:\Users\Test\AppData\Roaming`, "Nimbus"));
    expect(paths.dataDir).toBe(join(String.raw`C:\Users\Test\AppData\Local`, "Nimbus", "data"));
    expect(paths.logDir).toBe(join(paths.dataDir, "logs"));
    expect(paths.extensionsDir).toBe(
      join(String.raw`C:\Users\Test\AppData\Local`, "Nimbus", "extensions"),
    );
    expect(paths.tempDir).toBe(join(tmpdir(), "nimbus"));
    expect(paths.socketPath).toBe(String.raw`\\.\pipe\nimbus-gateway`);
  });

  it("throws when APPDATA is missing", () => {
    process.env["LOCALAPPDATA"] = String.raw`C:\x`;
    expect(() => getCliPlatformPaths()).toThrow(/APPDATA/);
  });

  it("throws when APPDATA is empty", () => {
    process.env["APPDATA"] = "";
    process.env["LOCALAPPDATA"] = String.raw`C:\x`;
    expect(() => getCliPlatformPaths()).toThrow(/APPDATA/);
  });

  it("throws when LOCALAPPDATA is missing", () => {
    process.env["APPDATA"] = String.raw`C:\x`;
    expect(() => getCliPlatformPaths()).toThrow(/LOCALAPPDATA/);
  });

  it("throws when LOCALAPPDATA is empty", () => {
    process.env["APPDATA"] = String.raw`C:\x`;
    process.env["LOCALAPPDATA"] = "";
    expect(() => getCliPlatformPaths()).toThrow(/LOCALAPPDATA/);
  });
});

describe("getCliPlatformPaths — darwin branch", () => {
  beforeEach(() => {
    clearControlledEnv();
    setPlatform("darwin");
  });
  afterEach(() => {
    restoreEnv();
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
    clearControlledEnv();
    setPlatform("linux");
  });
  afterEach(() => {
    restoreEnv();
    restorePlatform();
  });

  it("uses XDG_CONFIG_HOME + XDG_DATA_HOME when set", () => {
    process.env["XDG_CONFIG_HOME"] = "/var/test/config";
    process.env["XDG_DATA_HOME"] = "/var/test/data";
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

describe("NIMBUS_CONFIG_DIR override", () => {
  const saved = process.env["NIMBUS_CONFIG_DIR"];
  afterEach(() => {
    if (saved === undefined) {
      delete process.env["NIMBUS_CONFIG_DIR"];
    } else {
      process.env["NIMBUS_CONFIG_DIR"] = saved;
    }
  });

  test("overrides configDir on the current platform", () => {
    // The gateway honours this in platform/paths.ts; the CLI MUST agree or
    // `nimbus init` writes nimbus.toml somewhere the gateway never reads.
    const target = join(tmpdir(), "nimbus-cli-config-override");
    process.env["NIMBUS_CONFIG_DIR"] = target;
    expect(getCliPlatformPaths().configDir).toBe(target);
  });

  test("leaves dataDir alone — only configDir moves", () => {
    // Deliberate: this must never be able to silently repoint a live gateway's
    // database or socket.
    delete process.env["NIMBUS_CONFIG_DIR"];
    const before = getCliPlatformPaths();
    process.env["NIMBUS_CONFIG_DIR"] = join(tmpdir(), "nimbus-cli-config-override");
    const after = getCliPlatformPaths();
    expect(after.dataDir).toBe(before.dataDir);
    expect(after.socketPath).toBe(before.socketPath);
    expect(after.extensionsDir).toBe(before.extensionsDir);
  });

  test("an empty value is ignored, not treated as a relocation", () => {
    delete process.env["NIMBUS_CONFIG_DIR"];
    const before = getCliPlatformPaths().configDir;
    process.env["NIMBUS_CONFIG_DIR"] = "";
    expect(getCliPlatformPaths().configDir).toBe(before);
  });
});
