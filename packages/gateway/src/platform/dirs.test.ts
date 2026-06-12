import { afterEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensurePlatformDirectories, isWindowsNamedPipe } from "./dirs.ts";
import type { PlatformPaths } from "./paths.ts";

// Real unique temp root for all dirs tests (S5443).
const TEST_TMPDIR = mkdtempSync(join(tmpdir(), "nimbus-dirs-test-"));

afterEach(() => {
  // Nothing to restore — tests use isolated sub-dirs within TEST_TMPDIR.
});

// ─── isWindowsNamedPipe ────────────────────────────────────────────────────

describe("isWindowsNamedPipe", () => {
  it("returns true for a canonical Windows named-pipe path", () => {
    expect(isWindowsNamedPipe(String.raw`\\.\pipe\nimbus-gateway`)).toBe(true);
  });

  it("returns true for an upper-case variant (case-insensitive check)", () => {
    expect(isWindowsNamedPipe(String.raw`\\.\PIPE\nimbus-gateway`)).toBe(true);
  });

  it("returns true for a mixed-case variant", () => {
    expect(isWindowsNamedPipe(String.raw`\\.\Pipe\some-pipe`)).toBe(true);
  });

  it("returns false for a Unix socket path", () => {
    expect(isWindowsNamedPipe("/run/user/1000/nimbus-gateway.sock")).toBe(false);
  });

  it("returns false for a Windows path that is not a named pipe", () => {
    expect(isWindowsNamedPipe(String.raw`C:\Temp\nimbus.sock`)).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isWindowsNamedPipe("")).toBe(false);
  });
});

// ─── ensurePlatformDirectories ─────────────────────────────────────────────

describe("ensurePlatformDirectories — non-pipe socketPath", () => {
  it("creates configDir, vault sub-dir, dataDir, logDir, extensionsDir, tempDir, and socket parent dir", async () => {
    const base = mkdtempSync(join(TEST_TMPDIR, "dirs-non-pipe-"));
    const configDir = join(base, "config");
    const dataDir = join(base, "data");
    const logDir = join(base, "data", "logs");
    const extensionsDir = join(base, "data", "extensions");
    const tempDir = join(base, "temp", "nimbus");
    const socketPath = join(base, "run", "nimbus-gateway.sock");

    const paths: PlatformPaths = {
      configDir,
      dataDir,
      logDir,
      socketPath,
      extensionsDir,
      tempDir,
    };

    await ensurePlatformDirectories(paths);

    expect(existsSync(configDir)).toBe(true);
    expect(existsSync(join(configDir, "vault"))).toBe(true);
    expect(existsSync(dataDir)).toBe(true);
    expect(existsSync(logDir)).toBe(true);
    expect(existsSync(extensionsDir)).toBe(true);
    expect(existsSync(tempDir)).toBe(true);
    // The parent directory of the socket path must be created.
    expect(existsSync(dirname(socketPath))).toBe(true);
  });

  it("is idempotent — calling twice does not throw", async () => {
    const base = mkdtempSync(join(TEST_TMPDIR, "dirs-idempotent-"));
    const paths: PlatformPaths = {
      configDir: join(base, "config"),
      dataDir: join(base, "data"),
      logDir: join(base, "data", "logs"),
      socketPath: join(base, "run", "nimbus-gateway.sock"),
      extensionsDir: join(base, "data", "extensions"),
      tempDir: join(base, "temp", "nimbus"),
    };
    await ensurePlatformDirectories(paths);
    // Second call must not throw (mkdir recursive is idempotent).
    await expect(ensurePlatformDirectories(paths)).resolves.toBeUndefined();
  });
});

describe("ensurePlatformDirectories — Windows named-pipe socketPath", () => {
  it("does NOT attempt to create a parent dir for a Windows named-pipe socket", async () => {
    const base = mkdtempSync(join(TEST_TMPDIR, "dirs-pipe-"));
    const paths: PlatformPaths = {
      configDir: join(base, "config"),
      dataDir: join(base, "data"),
      logDir: join(base, "data", "logs"),
      // Canonical Windows named-pipe path — dirname would be \\.\pipe which
      // does not exist as a real directory on any OS.
      socketPath: String.raw`\\.\pipe\nimbus-gateway`,
      extensionsDir: join(base, "data", "extensions"),
      tempDir: join(base, "temp", "nimbus"),
    };

    // Must not throw even though \\.\pipe\ is not a real mkdir-able directory.
    await expect(ensurePlatformDirectories(paths)).resolves.toBeUndefined();

    // All the real dirs must still be created.
    expect(existsSync(paths.configDir)).toBe(true);
    expect(existsSync(join(paths.configDir, "vault"))).toBe(true);
    expect(existsSync(paths.dataDir)).toBe(true);
    expect(existsSync(paths.logDir)).toBe(true);
    expect(existsSync(paths.extensionsDir)).toBe(true);
    expect(existsSync(paths.tempDir)).toBe(true);
  });
});

// Cleanup the shared temp root after all tests in this file.
import { afterAll } from "bun:test";

afterAll(() => {
  rmSync(TEST_TMPDIR, { recursive: true, force: true });
});
