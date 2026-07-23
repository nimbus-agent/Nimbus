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
    expect(assemblePlatformServices).toHaveLength(1);
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

  it("boots the federation block and exposes executorDelegation for owner-side HITL (I20)", async () => {
    const paths = makePaths();
    // Bind the LAN server to an ephemeral free port on loopback; mDNS off so no multicast traffic.
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
    const lanPort = probe.port;
    probe.stop();
    if (typeof lanPort !== "number") throw new Error("could not reserve a free LAN port");

    const tomlPath = join(paths.configDir, "nimbus.toml");
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(
      tomlPath,
      [
        "[federation]",
        "enabled = true",
        "consent_timeout_seconds = 15",
        "mdns_enabled = false",
        'mdns_bind = "127.0.0.1"',
        "",
        "[lan]",
        `port = ${String(lanPort)}`,
        'bind = "127.0.0.1"',
      ].join("\n"),
    );

    services = await assemblePlatformServices(paths);

    // The owner-side delegation dep is built only when federation is enabled (I20). The executor
    // gate uses it to route a HITL action to an active delegate before the local owner prompt.
    expect(services.executorDelegation).toBeDefined();
    expect(typeof services.executorDelegation?.requestRemote).toBe("function");
    expect(services.executorDelegation?.isOperatorValid()).toBe(true);
    // No delegate configured → requestRemote falls back to a timeout (owner-prompt fallback).
    const outcome = await services.executorDelegation?.requestRemote("email.send");
    expect(outcome).toEqual({ kind: "timeout" });
    // Booting the full federation block (LAN server + delegation deps) runs ~6s
    // on slow Windows CI runners, over the 5s default — raise this test's timeout
    // so it doesn't flake (it's a known intermittent failure in pr-quality-cross-platform).
  }, 30000);

  it("boots the ChatOps graph when [chatops].enabled and exposes the chatops.* IPC ctx", async () => {
    const paths = makePaths();
    const tomlPath = join(paths.configDir, "nimbus.toml");
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(
      tomlPath,
      ["[chatops]", "enabled = true", "slack_enabled = true", 'bot_vault_entry = "test-bot"'].join(
        "\n",
      ),
    );

    services = await assemblePlatformServices(paths);

    expect(services.chatops).toBeDefined();
    const status = services.chatops?.rpcCtx.status();
    expect(status?.enabled).toBe(true);
    expect(status?.platforms.map((p) => p.name)).toEqual(["slack"]);
    // No Bot Framework JWT validator without teams_enabled + teams_bot_app_id (fail-closed I13 route).
    expect(services.chatops?.teamsSurface).toBeUndefined();
    // The known-write grammar is live (HITL_REQUIRED-backed).
    const parsed = services.chatops?.rpcCtx.testParse("run deployment.rollback service=x") as {
      kind: string;
    };
    expect(parsed.kind).toBe("write");
  }, 30000);

  it("does not boot ChatOps when [chatops] is absent", async () => {
    const paths = makePaths();
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    services = await assemblePlatformServices(paths);
    expect(services.chatops).toBeUndefined();
  }, 30000);

  // M-1: `loadNimbusServiceConfigsFromConfigDir` throws on a malformed
  // [metrics.dora.*]/[ci.service.*] block. Before the fix, this call was
  // unguarded at boot — a config typo aborted gateway startup entirely
  // instead of degrading the one feature (timeline correlation) that reads it.
  it("M-1: boots successfully despite a malformed [metrics.dora.*] block (missing required 'repos')", async () => {
    const paths = makePaths();
    const tomlPath = join(paths.configDir, "nimbus.toml");
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(
      tomlPath,
      [
        "[metrics.dora.checkout]",
        // 'repos' deliberately omitted — materializeOneServiceConfig throws
        // "missing required 'repos'" (config/service-config-toml.ts).
        'pagerduty_services = ["PSVC1"]',
      ].join("\n"),
    );

    services = await assemblePlatformServices(paths);
    expect(services).toBeDefined();
    expect(typeof services.ipc.stop).toBe("function");
  }, 30000);
});
