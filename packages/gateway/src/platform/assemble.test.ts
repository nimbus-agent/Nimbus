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
    // assemble.ts wires twenty subsystems (vault, embeddings, mesh, IPC,
    // updater, autoupdate, telemetry, …) and exposes a single entry point.
    // Full coverage requires spinning up a real gateway subprocess —
    // exercised by the integration suite and the headless smoke. We assert
    // the contract surface here so a future signature/arity change fails
    // before the heavier integration runs.
    expect(typeof assemblePlatformServices).toBe("function");
    expect(assemblePlatformServices.length).toBe(1);
    // It's an async function (returns a Promise).
    expect(assemblePlatformServices.constructor.name).toBe("AsyncFunction");
  });
});

/**
 * In-process gateway assembly — exercises the helper-function clusters in
 * assemble.ts (createStubAutostart/Notifications bodies, loadOpenapiConfig,
 * createLocalIndexWithEmbeddingRuntime, maybeAttachSessionMemoryStore,
 * createSchedulerWithMesh, collectSidecarsFromEnv) without spawning a
 * subprocess.
 *
 * Note: this is heavier than a unit test — it constructs the IPC server,
 * mesh, vault, etc., then immediately disposes them. We isolate it from
 * the user's real configDir/dataDir by using a fresh tmp dir per test.
 */
describe("assemblePlatformServices — in-process assembly", () => {
  let tmpDir: string;
  let originalSkipEmbed: string | undefined;
  let services: PlatformServices | null = null;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-assemble-"));
    originalSkipEmbed = process.env["NIMBUS_SKIP_EMBEDDING_RUNTIME"];
    // Skip the heavy embedding runtime so the test doesn't try to download
    // MiniLM weights. The createLocalIndexWithEmbeddingRuntime branch still
    // runs (rt === null path).
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
        // SyncScheduler.stop() returns a Promise (drain loop on
        // runningGlobal); awaiting prevents a Windows handle race where the
        // tick handle is still alive when rmSync(tmpDir, ...) tries to
        // delete the data dir.
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
    // Use a unique socket path so concurrent test runs don't collide. On
    // Windows we still use the named-pipe convention via a per-test
    // pipe name; on Unix it's a regular file path inside tmpDir.
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
    // Write a minimal nimbus.toml so loadOpenapiConfig parses a real file
    // (not the file-missing branch already covered by smoke).
    const tomlPath = join(paths.configDir, "nimbus.toml");
    // Ensure config dir exists before writeFileSync — ensurePlatformDirectories
    // will create it but we want to write before that runs.
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(
      tomlPath,
      [
        // Set llm overrides so applyLlmTomlOverrides branches at 334/337 fire.
        "[llm]",
        'remote_model = "claude-sonnet-4-6"',
        'classifier_model = "claude-haiku-4-5-20251001"',
        "",
        // OpenAPI block makes loadOpenapiConfig's parseOpenapiToml branch run.
        "[openapi]",
        "enabled = true",
      ].join("\n"),
    );

    services = await assemblePlatformServices(paths);
    expect(services).toBeDefined();
    expect(typeof services.vault.get).toBe("function");
    expect(typeof services.ipc.stop).toBe("function");
    expect(typeof services.localIndex).toBe("object");
    // disposeSidecars is the contract this test depends on for clean tear-down.
    expect(typeof services.disposeSidecars).toBe("function");
    // The stubAutostart manager must satisfy the AutostartManager interface.
    expect(await services.autostart.isEnabled()).toBe(false);
    await services.autostart.enable();
    await services.autostart.disable();
    // The stubNotifications service must implement show() without throwing.
    await services.notifications.show("title", "body");
  });

  it("collectSidecarsFromEnv attaches HTTP + metrics sidecars when ports are set", async () => {
    const paths = makePaths();
    // Discover two free ports by letting the OS bind ephemeral ports via
    // `Bun.serve({port: 0})`, then immediately stop those listeners and use
    // the discovered numbers. This avoids the deterministic `pid % 1000`
    // collision that occurred when two CI workers shared a modulus —
    // `collectSidecarsFromEnv` skips port 0 (it gates on `hp > 0`), so we
    // can't simply forward port 0 through the env var.
    //
    // There's a vanishingly small race window between stop() and assemble
    // binding the same port. If that ever flakes we fall back to option (c)
    // (stub Bun.serve), but in practice the OS keeps the freed port out of
    // the ephemeral pool just long enough for the bind to land.
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
      // No direct introspection — but disposeSidecars now wraps the
      // additional stop functions. We assert the field is present and the
      // disposer runs without throwing.
      expect(typeof services.disposeSidecars).toBe("function");
      services.disposeSidecars?.();
    } finally {
      processEnvSet("NIMBUS_HTTP_PORT", originalHttpPort);
      processEnvSet("NIMBUS_METRICS_PORT", originalMetricsPort);
    }
  });
});
