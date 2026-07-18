import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { processEnvDelete, processEnvGet, processEnvSet } from "./env-access.ts";
import { PlatformInitError } from "./errors.ts";
import { createDarwinPaths, createLinuxPaths, createWindowsPaths } from "./paths.ts";

const gatewayRoot = join(import.meta.dirname, "..", "..");

describe("Platform Abstraction Layer", () => {
  let tmpDir: string;
  let originalEnv: Record<string, string | undefined>;

  beforeEach(() => {
    processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", "1");
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-pal-test-"));
    originalEnv = {
      APPDATA: processEnvGet("APPDATA"),
      LOCALAPPDATA: processEnvGet("LOCALAPPDATA"),
      XDG_CONFIG_HOME: processEnvGet("XDG_CONFIG_HOME"),
      XDG_DATA_HOME: processEnvGet("XDG_DATA_HOME"),
      XDG_RUNTIME_DIR: processEnvGet("XDG_RUNTIME_DIR"),
    };
    processEnvSet("APPDATA", tmpDir);
    processEnvSet("LOCALAPPDATA", tmpDir);
    processEnvSet("XDG_CONFIG_HOME", join(tmpDir, ".config"));
    processEnvSet("XDG_DATA_HOME", join(tmpDir, ".local/share"));
    processEnvSet("XDG_RUNTIME_DIR", tmpDir);
  });

  afterEach(async () => {
    processEnvDelete("NIMBUS_SKIP_EMBEDDING_RUNTIME");
    for (const [key, val] of Object.entries(originalEnv)) {
      processEnvSet(key, val);
    }
    try {
      await rm(tmpDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM") {
        throw err;
      }
      console.warn(`[platform.test] tmpDir cleanup deferred to OS (${code}): ${tmpDir}`);
    }
  });

  it("createPlatformServices is exported", async () => {
    const { createPlatformServices } = await import("./index.ts");
    expect(typeof createPlatformServices).toBe("function");
  });

  it("returns a full PlatformServices shape for the current OS", async (): Promise<void> => {
    const { createPlatformServices } = await import("./index.ts");
    const services = await createPlatformServices();

    try {
      expect(services.vault).toBeDefined();
      expect(typeof services.vault.get).toBe("function");
      expect(services.ipc).toBeDefined();
      expect(typeof services.ipc.start).toBe("function");
      expect(services.paths).toBeDefined();
      expect(services.localIndex).toBeDefined();
      expect(typeof services.localIndex.listAudit).toBe("function");
      expect(services.connectorMesh).toBeDefined();
      expect(typeof services.connectorMesh.listTools).toBe("function");
      expect(services.syncScheduler).toBeDefined();
      expect(typeof services.syncScheduler.start).toBe("function");
      expect(services.autostart).toBeDefined();
      expect(services.notifications).toBeDefined();
      expect(typeof services.openUrl).toBe("function");

      const { paths } = services;
      for (const key of [
        "configDir",
        "dataDir",
        "logDir",
        "socketPath",
        "extensionsDir",
        "tempDir",
      ] as const) {
        expect(typeof paths[key]).toBe("string");
        expect(paths[key].length).toBeGreaterThan(0);
      }
    } finally {
      await services.syncScheduler?.stop().catch(() => {});
      await services.connectorMesh?.disconnect().catch(() => {});
      services.disposeSidecars?.();
      services.localIndex?.close();
      await new Promise((r) => setTimeout(r, 100));
    }
  }, 30000);
  it("uses the documented IPC path pattern per OS", () => {
    const os = platform();
    let paths: ReturnType<typeof createWindowsPaths>;
    if (os === "win32") {
      paths = createWindowsPaths();
    } else if (os === "darwin") {
      paths = createDarwinPaths();
    } else {
      paths = createLinuxPaths();
    }
    if (os === "win32") {
      expect(paths.socketPath.toLowerCase()).toBe(
        String.raw`\\.\pipe\nimbus-gateway`.toLowerCase(),
      );
    } else {
      expect(paths.socketPath).toContain("nimbus-gateway.sock");
    }
  });

  it.skipIf(platform() !== "linux")(
    "throws PlatformInitError for missing Linux secret-tool (subprocess)",
    () => {
      const result = Bun.spawnSync({
        cmd: ["bun", "run", join(gatewayRoot, "test/fixtures/linux-secret-tool-probe.ts")],
        cwd: gatewayRoot,
        env: {
          ...process.env,
          PATH: dirname(process.execPath),
          NIMBUS_LINUX_VAULT_PROBE_STRICT_PATH: "1",
        },
        stderr: "pipe",
        stdout: "pipe",
      });
      expect(result.exitCode).not.toBe(0);
      const errText = new TextDecoder().decode(result.stderr);
      expect(errText).toContain("secret-tool not found");
      expect(errText).toContain("PlatformInitError");
    },
  );

  it.skipIf(platform() !== "win32")(
    "createWindowsPaths throws PlatformInitError without APPDATA",
    () => {
      const prev = processEnvGet("APPDATA");
      processEnvDelete("APPDATA");
      try {
        expect(() => createWindowsPaths()).toThrow(PlatformInitError);
      } finally {
        processEnvSet("APPDATA", prev);
      }
    },
  );
});

describe("PlatformPaths factories", () => {
  it.skipIf(platform() !== "darwin")("darwin paths share config and data roots per Q1 plan", () => {
    const paths = createDarwinPaths();
    expect(paths.configDir).toBe(paths.dataDir);
  });

  it.skipIf(platform() !== "linux")("linux paths are under XDG-style directories", () => {
    const paths = createLinuxPaths();
    expect(paths.configDir).toContain("nimbus");
    expect(paths.dataDir).toContain("nimbus");
  });
});
