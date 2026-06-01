import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assemblePlatformServices } from "./assemble.ts";
import { processEnvSet } from "./env-access.ts";
import type { PlatformPaths } from "./paths.ts";
import type { PlatformServices } from "./types.ts";

describe("assemblePlatformServices (smoke)", () => {
  it("is an async function with arity 1 (paths)", () => {
    expect(typeof assemblePlatformServices).toBe("function");
    expect(assemblePlatformServices.length).toBe(1);
    expect(assemblePlatformServices.constructor.name).toBe("AsyncFunction");
  });
});

describe("assemblePlatformServices — in-process assembly", () => {
  let tmpDir: string;
  let originalSkipEmbed: string | undefined;
  let services: PlatformServices | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-assemble-"));
    originalSkipEmbed = process.env["NIMBUS_SKIP_EMBEDDING_RUNTIME"];
    processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", "1");
  });

  afterEach(async () => {
    if (services !== null) {
      try {
        services.disposeSidecars?.();
      } catch {
        /* ignore */
      }
      try {
        await services.ipc.stop();
      } catch {
        /* ignore */
      }
      try {
        await services.syncScheduler.stop();
      } catch {
        /* ignore */
      }
      services = null;
    }
    processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", originalSkipEmbed);
    try {
      rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      /* Windows handle race; harmless */
    }
  });

  function makePaths(): PlatformPaths {
    const socketBaseName = `nimbus-assemble-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const winPipePrefix = "\\\\.\\pipe\\";
    const socketPath =
      process.platform === "win32" ? winPipePrefix + socketBaseName : join(tmpDir, "g.sock");
    return {
      configDir: join(tmpDir, "config"),
      dataDir: join(tmpDir, "data"),
      logDir: join(tmpDir, "logs"),
      socketPath,
      extensionsDir: join(tmpDir, "extensions"),
      tempDir: join(tmpDir, "tmp"),
    };
  }

  it("constructs a PlatformServices and routes the configured nimbus.toml", async () => {
    const paths = makePaths();
    const tomlPath = join(paths.configDir, "nimbus.toml");
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(
      tomlPath,
      [
        "[llm]",
        'remote_model = "claude-sonnet-4-6"',
        'classifier_model = "claude-haiku-4-5-20251001"',
        'local_model = "local-test-model:latest"',
        "",
        "[openapi]",
        "enabled = true",
      ].join("\n"),
    );

    services = await assemblePlatformServices(paths);
    expect(services).toBeDefined();
    expect(typeof services.vault.get).toBe("function");
    expect(typeof services.ipc.stop).toBe("function");
    expect(typeof services.localIndex).toBe("object");
    expect(typeof services.llmRegistry.getRouterStatus).toBe("function");
    expect(typeof services.disposeSidecars).toBe("function");
    expect(await services.autostart.isEnabled()).toBe(false);
    await services.autostart.enable();
    await services.autostart.disable();
    await services.notifications.show("title", "body");
  });

  it("collectSidecarsFromEnv attaches HTTP + metrics sidecars when ports are set", async () => {
    const paths = makePaths();
    const discoverFreePort = (): number => {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
      const p = probe.port;
      probe.stop();
      if (typeof p !== "number") {
        throw new Error("discoverFreePort: probe did not bind a TCP port");
      }
      return p;
    };
    const httpPort = String(discoverFreePort());
    const metricsPort = String(discoverFreePort());
    const originalHttpPort = process.env["NIMBUS_HTTP_PORT"];
    const originalMetricsPort = process.env["NIMBUS_METRICS_PORT"];
    processEnvSet("NIMBUS_HTTP_PORT", httpPort);
    processEnvSet("NIMBUS_METRICS_PORT", metricsPort);
    try {
      services = await assemblePlatformServices(paths);
      expect(typeof services.disposeSidecars).toBe("function");
      services.disposeSidecars?.();
    } finally {
      processEnvSet("NIMBUS_HTTP_PORT", originalHttpPort);
      processEnvSet("NIMBUS_METRICS_PORT", originalMetricsPort);
    }
  });
});
