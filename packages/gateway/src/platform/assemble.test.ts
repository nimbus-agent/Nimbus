import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInMemoryVault } from "../../test/helpers/in-memory-vault.ts";
import { writeConnectorSecret } from "../connectors/connector-vault.ts";
import { THIS_BINARY_COVERAGE } from "../egress/egress-coverage.ts";
import { appendEgressEntry } from "../egress/egress-ledger.ts";
import { coverageForWindow } from "../egress/egress-verify.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { Syncable } from "../sync/types.ts";
import { appendBootMarkerOrWarn, assemblePlatformServices, httpOriginFor } from "./assemble.ts";
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

// I29 fix: a corrupted/locked ledger must degrade egress proofs to `indeterminate`, not take the
// whole gateway down. `appendBootMarkerOrWarn` is the narrowest testable unit around the
// unguarded `appendBootMarker` call in `assemblePlatformServices` — exercised directly here
// against a real (in-memory) egress_ledger rather than via a full ~30s gateway boot.
describe("appendBootMarkerOrWarn", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });
  afterEach(() => db.close());

  it("does not throw when the ledger head row_hash is malformed, and warns naming the failure", () => {
    // Seed one row, then corrupt its row_hash the same way egress-ledger.test.ts does — this is
    // exactly the condition `readHeadHash` fails closed on.
    appendEgressEntry(db, {
      timestamp: 1,
      sourceType: "task",
      sourceId: "s",
      destination: "email",
      method: "email.send",
      payloadSummary: "{}",
      hitlStatus: "approved",
      resultStatus: "authorized",
    });
    db.run(
      `UPDATE egress_ledger SET row_hash = 'deadbeef' WHERE id = (SELECT MAX(id) FROM egress_ledger)`,
    );

    const warnCalls: unknown[][] = [];
    const logger = { warn: (...args: unknown[]) => void warnCalls.push(args) };

    expect(() => appendBootMarkerOrWarn(db, THIS_BINARY_COVERAGE, 2_000, logger)).not.toThrow();

    expect(warnCalls).toHaveLength(1);
    const [meta, message] = warnCalls[0] as [{ err: unknown }, string];
    expect(meta.err).toBeDefined();
    expect(message).toMatch(/boot marker/i);
    expect(message).toMatch(/indeterminate/i);

    // No marker was appended (the append itself failed) — the window this process should have
    // covered stays indeterminate rather than reporting a falsely clean/covered state.
    expect(coverageForWindow(db, { since: 2_000, until: 3_000 })).toEqual({
      task: "none",
      mcp: "none",
      http: "none",
      session: "none",
      sync: "none",
      model: "none",
      peer: "none",
    });
  });

  it("appends normally and warns nothing when the ledger is healthy", () => {
    const warnCalls: unknown[][] = [];
    const logger = { warn: (...args: unknown[]) => void warnCalls.push(args) };

    appendBootMarkerOrWarn(db, THIS_BINARY_COVERAGE, 1_000, logger);

    expect(warnCalls).toHaveLength(0);
    expect(coverageForWindow(db, {})).toEqual(THIS_BINARY_COVERAGE);
  });
});

// Task 11: the one `http:` exception source for `POST /v1/items/fetch`. Unit-tested directly
// against a fake Vault — the property under test (return the parsed `.origin`, never the raw
// secret; fail closed on anything but `http:`) is orthogonal to the full gateway boot above.
describe("httpOriginFor", () => {
  it("returns the LOWERCASED, no-trailing-slash origin for a self-hosted http: secret", async () => {
    const vault = makeInMemoryVault();
    // Uppercase host + trailing slash: the raw secret targeted-fetch.ts must NEVER see, because
    // its comparison is against `parsed.origin` (always lowercase host, no trailing slash).
    await writeConnectorSecret(vault, "gitlab", "api_base", "http://Internal.Example:8080/");
    expect(await httpOriginFor(vault, "gitlab")).toBe("http://internal.example:8080");
  });

  it("returns null for an https: self-hosted secret — no exception to grant", async () => {
    const vault = makeInMemoryVault();
    await writeConnectorSecret(vault, "jenkins", "base_url", "https://ci.internal.example");
    expect(await httpOriginFor(vault, "jenkins")).toBeNull();
  });

  it("returns null for an unparseable secret rather than throwing", async () => {
    const vault = makeInMemoryVault();
    await writeConnectorSecret(vault, "jira", "base_url", "not a url");
    expect(await httpOriginFor(vault, "jira")).toBeNull();
  });

  it("returns null for a missing or blank secret", async () => {
    const vault = makeInMemoryVault();
    expect(await httpOriginFor(vault, "gitlab")).toBeNull();
    await writeConnectorSecret(vault, "gitlab", "api_base", "   ");
    expect(await httpOriginFor(vault, "gitlab")).toBeNull();
  });

  it("returns null immediately for github/bitbucket — no self-hosted variant", async () => {
    const vault = makeInMemoryVault();
    expect(await httpOriginFor(vault, "github")).toBeNull();
    expect(await httpOriginFor(vault, "bitbucket")).toBeNull();
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

  // Task 11 / I29: `platform/assemble.ts` is the ONLY production `new SyncScheduler(...)`, and it
  // must pass a real (non-undefined) `appendSyncEgress` — otherwise `sync`'s coverage claim in
  // `egress/egress-coverage.ts` (raised to `"per-run"`) is a false claim the moment a real sync
  // runs. This is exactly the regression that happened once already (Task 10 had to revert the
  // claim because assemble.ts omitted the option) — so it is proven against the REAL assembly
  // path, not a fake scheduler construction, and a future refactor that drops the option again
  // fails this test instead of silently reverting the claim to a lie.
  it("wires a real appendSyncEgress into the production SyncScheduler — a forced sync ledgers ONE `sync` row", async () => {
    const paths = makePaths();
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    services = await assemblePlatformServices(paths);

    const probeServiceId = "assemble-egress-probe";
    const fakeSyncable: Syncable = {
      serviceId: probeServiceId,
      defaultIntervalMs: 3_600_000,
      initialSyncDepthDays: 1,
      sync: async (_ctx, cursor) => ({
        cursor,
        itemsUpserted: 0,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: 1,
      }),
    };
    services.syncScheduler.register(fakeSyncable);
    await services.syncScheduler.forceSync(probeServiceId);

    // Filtered by `destination = probeServiceId` rather than just `source_type = 'sync'`: this
    // test is about proving the wiring exists for THIS probe, not about being the only sync in
    // the process — a background scheduled sync for another registered connector would add an
    // unrelated row with a different `destination` and must not be mistaken for this one's.
    // (It does NOT rely on other real cloud connectors staying silent because they are
    // unconfigured on this test machine — I29 Critical 1 makes that true regardless, proven
    // directly by the empty-Vault multi-connector test below, not merely assumed here.)
    const db = services.localIndex.getDatabase();
    const rows = db
      .query(
        `SELECT destination, method, hitl_status, result_status FROM egress_ledger
         WHERE source_type = 'sync' AND destination = ? ORDER BY id DESC`,
      )
      .all(probeServiceId) as Array<{
      destination: string;
      method: string;
      hitl_status: string;
      result_status: string;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      destination: probeServiceId,
      method: "sync.run",
      hitl_status: "not_required",
      result_status: "authorized",
    });
  }, 30000);

  // I29 CRITICAL 1: an EMPTY Vault (a fresh install, or a machine with zero connectors
  // configured) must ledger ZERO `sync` egress rows when several real cloud connectors are
  // force-synced — before this fix, each one's `sync()` short-circuited to a network-free noop
  // while the scheduler still appended an unconditional "authorized" row per run, fabricating
  // outbound-egress events for a machine that made zero outbound requests. Proven against a REAL
  // assembly (real `registerConnectorMeshSyncables` registrations, real Vault-backed
  // `isConnectorConfigured` check), not a fake scheduler.
  it("force-syncing several cloud connectors against an EMPTY Vault ledgers ZERO sync egress rows", async () => {
    const paths = makePaths();
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    services = await assemblePlatformServices(paths);

    const probeServiceIds = ["github", "slack", "notion"] as const;
    await Promise.all(probeServiceIds.map((id) => services?.syncScheduler.forceSync(id)));

    const db = services.localIndex.getDatabase();
    const rows = db
      .query(
        `SELECT destination FROM egress_ledger WHERE source_type = 'sync' AND destination IN (?, ?, ?)`,
      )
      .all(...probeServiceIds) as Array<{ destination: string }>;
    expect(rows).toHaveLength(0);
  }, 30000);

  // I29 CRITICAL fix: `filesystem`/`blame`/`openapi`/`obsidian` are registered on the SAME
  // scheduler as every cloud connector but make NO outbound network request — a syncable that
  // performs a LOCAL mutation, not egress, must not be ledgered as egress (the `NULL_EGRESS_SINK`
  // precedent, applied to this class). Proven against a REAL assembly with a REAL
  // `[[filesystem.roots]]` block (the exact config shape that registers `filesystem` + `blame` on
  // the scheduler, per `registerFilesystemRootSyncables`), not a fake scheduler: a forced sync of
  // `filesystem` must append ZERO `sync` egress rows, never an `authorized` row for a request that
  // provably never left the machine.
  it("appends ZERO sync egress rows for a local-only indexer (filesystem) even on a forced sync", async () => {
    const paths = makePaths();
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    const rootDir = join(tmpDir, "fs-root");
    mkdirSync(rootDir, { recursive: true });
    writeFileSync(
      join(paths.configDir, "nimbus.toml"),
      `[[filesystem.roots]]\npath = "${rootDir.replace(/\\/g, "/")}"\n`,
    );

    services = await assemblePlatformServices(paths);
    // `registerFilesystemRootSyncables` (called synchronously inside assembly) registers both
    // `filesystem` and `blame` for any non-empty root set — forcing either proves the exclusion;
    // `filesystem` is forced here, `blame` is covered by the unit-level
    // `LOCAL_ONLY_SYNC_SERVICES` tests in `egress/sync-egress.test.ts`.
    await services.syncScheduler.forceSync("filesystem");

    const db = services.localIndex.getDatabase();
    const count = db
      .query(
        `SELECT COUNT(*) AS n FROM egress_ledger WHERE source_type = 'sync' AND destination = 'filesystem'`,
      )
      .get() as { n: number };
    expect(count.n).toBe(0);
  }, 30000);
});
