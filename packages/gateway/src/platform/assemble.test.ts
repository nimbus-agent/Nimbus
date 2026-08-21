import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import net from "node:net";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { makeInMemoryVault } from "../../test/helpers/in-memory-vault.ts";
import { resetPersonaWarningsForTest } from "../config/persona.ts";
import { writeConnectorSecret } from "../connectors/connector-vault.ts";
import { THIS_BINARY_COVERAGE } from "../egress/egress-coverage.ts";
import { appendEgressEntry } from "../egress/egress-ledger.ts";
import { coverageForWindow } from "../egress/egress-verify.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import type { Syncable } from "../sync/types.ts";
import {
  appendBootMarkerOrWarn,
  assemblePlatformServices,
  createUnimplementedNotifications,
  httpOriginFor,
} from "./assemble.ts";
import { processEnvSet } from "./env-access.ts";
import { gatewayDailyLogPath } from "./gateway-log-file.ts";
import type { PlatformPaths } from "./paths.ts";
import type { PlatformServices } from "./types.ts";

describe("assemblePlatformServices (smoke)", () => {
  it("is an async function with arity 2 (paths, customVault?)", () => {
    expect(typeof assemblePlatformServices).toBe("function");
    expect(assemblePlatformServices).toHaveLength(2);
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
    // Rehydrates a template migrated once per process instead of replaying every migration for
    // each of this block's tests — see `migrated-db-template.ts`. Still a private in-memory
    // database per test; `deserialize` builds a new one from the image, it does not share it.
    db = openMigratedMemoryDb();
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
describe("createUnimplementedNotifications", () => {
  function capture(): {
    infoCalls: unknown[][];
    logger: Parameters<typeof createUnimplementedNotifications>[0];
  } {
    const infoCalls: unknown[][] = [];
    const logger = {
      info: (...args: unknown[]) => void infoCalls.push(args),
    } as unknown as Parameters<typeof createUnimplementedNotifications>[0];
    return { infoCalls, logger };
  }

  it("logs the dropped notification instead of silently discarding it", async () => {
    const { infoCalls, logger } = capture();
    await createUnimplementedNotifications(logger).show("Nimbus watcher", "pagerduty: db down");
    expect(infoCalls).toHaveLength(1);
    expect(infoCalls[0]?.[0]).toMatchObject({
      event: "notification.dropped",
      title: "Nimbus watcher",
    });
  });

  it("never logs the BODY — watcher bodies carry indexed item titles", async () => {
    // `fired.summary` interpolates `${service}: ${item title}` straight from the index,
    // so logging the body would write indexed content into logDir. `gateway-log-redact`
    // scrubs secrets, not arbitrary indexed text, and is no backstop here.
    const { infoCalls, logger } = capture();
    const body = "pagerduty: Customer PII export failed for acme-corp";
    await createUnimplementedNotifications(logger).show("Nimbus watcher", body);
    expect(JSON.stringify(infoCalls)).not.toContain("acme-corp");
    expect(JSON.stringify(infoCalls)).not.toContain(body);
  });

  it("resolves rather than throwing, so a producer's `void notify(...)` cannot reject", async () => {
    const { logger } = capture();
    await expect(
      createUnimplementedNotifications(logger).show("Nimbus sync failed", "github"),
    ).resolves.toBeUndefined();
  });
});

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
    tmpDir = realpathSync(mkdtempSync(join(tmpdir(), "nimbus-assemble-")));
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

    services = await assemblePlatformServices(paths, makeInMemoryVault());
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
      services = await assemblePlatformServices(paths, makeInMemoryVault());
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

    services = await assemblePlatformServices(paths, makeInMemoryVault());

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

    services = await assemblePlatformServices(paths, makeInMemoryVault());

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
    services = await assemblePlatformServices(paths, makeInMemoryVault());
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

    services = await assemblePlatformServices(paths, makeInMemoryVault());
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
    services = await assemblePlatformServices(paths, makeInMemoryVault());

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
    // (This test's own correctness does not depend on other real cloud connectors staying silent
    // on this machine — filtering by `destination = probeServiceId` excludes any row a different
    // connector's own run would append regardless. It is a SEPARATE claim, proven directly by the
    // empty-Vault tests below rather than assumed here, that those other connectors actually DO
    // stay silent: before Fix 1 in `sync/connector-configured.ts`, 13 registered syncables with an
    // empty manifest key list were NOT silent — each made zero network calls but still ledgered an
    // "authorized" row on every run. That gap is closed now, and the tests below assert it against
    // both the 3 manifest-keyed probes AND all 13 previously-ungated syncables.)
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
    services = await assemblePlatformServices(paths, makeInMemoryVault());

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

  // I29 Critical follow-up (Fix 1): the 13 registered, non-local-only syncables whose OWN
  // `CONNECTOR_VAULT_SECRET_KEYS` entry is an EMPTY array (`sync/connector-configured.ts`'s
  // `DERIVED_CONFIGURED_CHECKS`) used to fall through the manifest check's "no signal, no gate"
  // branch and were ledgered as `authorized` on EVERY run against an EMPTY Vault — proven by a
  // real boot + instrumented `globalThis.fetch`: 0 network attempts, 15 fabricated `sync` rows
  // before this fix. Forcing all 13 against a real, empty-Vault assembly must now ledger ZERO
  // rows AND make ZERO `fetch` calls (the four of the 13 that go over HTTP rather than an
  // AWS/GCP CLI spawn — `gmail`/`google_drive`/`google_photos`/`google_meet` also apply, but
  // `github_actions`/`onedrive`/`outlook` are the ones this process can reach without native
  // repos/mailboxes already indexed).
  it("force-syncing all 13 empty-manifest syncables against an EMPTY Vault ledgers ZERO sync egress rows and makes ZERO fetch calls", async () => {
    const paths = makePaths();
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    services = await assemblePlatformServices(paths, makeInMemoryVault());

    const emptyManifestServiceIds = [
      "google_drive",
      "gmail",
      "google_photos",
      "google_meet",
      "onedrive",
      "outlook",
      "github_actions",
      "bigquery",
      "athena",
      "cloudwatch",
      "sagemaker",
      "cloud_logging",
      "vertex_ai",
    ] as const;

    const originalFetch = globalThis.fetch;
    let fetchCalls = 0;
    globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
      fetchCalls += 1;
      return originalFetch(...args);
    }) as typeof fetch;
    try {
      // Six of these thirteen (`google_drive`/`gmail`/`google_photos`/`google_meet`/`onedrive`/
      // `outlook`) throw a "not configured" Error straight out of their own `sync()` when
      // unconfigured — pre-existing, unmodified connector behavior this fix does not touch — so a
      // forced run on any of them REJECTS the `forceSync` promise. Each rejection is swallowed
      // individually: what this test asserts is the egress ROW COUNT, not that every one of these
      // connectors resolves cleanly against an empty Vault.
      await Promise.all(
        emptyManifestServiceIds.map((id) =>
          services?.syncScheduler.forceSync(id).catch(() => undefined),
        ),
      );
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(fetchCalls).toBe(0);

    const db = services.localIndex.getDatabase();
    const rows = db
      .query(
        `SELECT destination FROM egress_ledger WHERE source_type = 'sync' AND destination IN (${emptyManifestServiceIds
          .map(() => "?")
          .join(",")})`,
      )
      .all(...emptyManifestServiceIds) as Array<{ destination: string }>;
    expect(rows).toEqual([]);
  }, 60000);

  // Fix 1, other half: gating must not silence the LEGITIMATE case — once one of these 13
  // actually has its real signal set, the run must still ledger exactly ONE `sync` row, the same
  // as any other configured connector. `github_actions` is picked because its own `sync()`
  // short-circuits to a network-free noop as soon as the local index has no github repos (which
  // this fresh DB does not), so this proves the egress-append wiring without depending on a real
  // network call succeeding.
  it("a newly-gated empty-manifest syncable still ledgers exactly ONE row once its real signal is set", async () => {
    const paths = makePaths();
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    services = await assemblePlatformServices(paths, makeInMemoryVault());
    // `github_actions` has a 60s scheduled interval and the scheduler is already ticking at this
    // point — pausing it (a paused connector's own tick is skipped, but "forceSync on a paused
    // connector still runs" per `scheduler.test.ts`) rules out a natural scheduled tick racing
    // the explicit `forceSync` below and appending a SECOND row, which would make this assertion
    // flaky for a reason that has nothing to do with what it is testing.
    services.syncScheduler.pause("github_actions");

    await writeConnectorSecret(services.vault, "github", "pat", "ghp_test_token");
    await services.syncScheduler.forceSync("github_actions");

    const db = services.localIndex.getDatabase();
    const rows = db
      .query(
        `SELECT destination, method, hitl_status, result_status FROM egress_ledger
         WHERE source_type = 'sync' AND destination = 'github_actions'`,
      )
      .all() as Array<{
      destination: string;
      method: string;
      hitl_status: string;
      result_status: string;
    }>;
    expect(rows).toEqual([
      {
        destination: "github_actions",
        method: "sync.run",
        hitl_status: "not_required",
        result_status: "authorized",
      },
    ]);
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

    services = await assemblePlatformServices(paths, makeInMemoryVault());
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

  // ---------------------------------------------------------------------------
  // C2 + C3 (whole-branch review). Both are single lines in `assemblePlatformServices`
  // whose only observable effect is at the boundary of a REAL assembly, which is why they
  // are asserted here rather than against an injected fake: every other `profile.*` test
  // injects its own ProfileManager, and every other persona test passes its own logger, so
  // both lines could be deleted with the rest of the suite still green.
  // ---------------------------------------------------------------------------

  /** One NDJSON JSON-RPC request line. Mirrors `ipc/ipc.test.ts`'s helper of the same shape. */
  function jsonRpcNdjsonLine(method: string, id: number, params?: unknown): string {
    const body: Record<string, unknown> = { jsonrpc: "2.0", id, method };
    if (params !== undefined) body["params"] = params;
    return `${JSON.stringify(body)}\n`;
  }

  /**
   * Send one request over the assembled gateway's real IPC socket and resolve its first
   * response line. Win32 takes the named-pipe path through `node:net`, POSIX takes the unix
   * socket through `Bun.connect` — the same split `ipc/ipc.test.ts` already uses.
   */
  async function rpcOverSocket(listenPath: string, method: string): Promise<string> {
    const lineToWrite = jsonRpcNdjsonLine(method, 1, {});
    const takeFirst = (buffer: string, chunk: string): { next: string; line?: string } => {
      const combined = buffer + chunk;
      const nl = combined.indexOf("\n");
      if (nl < 0) return { next: combined };
      return { next: combined.slice(nl + 1), line: combined.slice(0, nl) };
    };
    if (platform() === "win32") {
      return await new Promise<string>((resolve, reject) => {
        let buf = "";
        const sock = net.createConnection(listenPath);
        sock.on("connect", () => sock.write(lineToWrite));
        sock.on("data", (b: Buffer) => {
          const { next, line } = takeFirst(buf, b.toString("utf8"));
          buf = next;
          if (line !== undefined) {
            resolve(line);
            sock.end();
          }
        });
        sock.on("error", reject);
      });
    }
    return await new Promise<string>((resolve, reject) => {
      let buf = "";
      Bun.connect({
        unix: listenPath,
        socket: {
          open(socket) {
            socket.write(lineToWrite);
          },
          data(socket, chunk: Uint8Array) {
            const { next, line } = takeFirst(buf, new TextDecoder().decode(chunk));
            buf = next;
            if (line !== undefined) {
              resolve(line);
              socket.end();
            }
          },
          error() {
            reject(new Error("socket error"));
          },
        },
      }).catch(reject);
    });
  }

  // C2: `ipcOpts.profileManager = new ProfileManager(...)` is the ONE production construction.
  // Before A2 it did not exist and every `profile.*` call threw "Profile manager is not
  // available on this gateway" — the exact "declared, dispatched, never constructed" defect
  // this branch set out to fix. Asserted end-to-end over the assembled gateway's real socket,
  // and on the RETURNED CONTENT (a profile file this test wrote into this gateway's configDir),
  // not merely on "did not throw": a manager pointed at some other directory would satisfy the
  // weaker assertion.
  it("C2: profile.list succeeds over the assembled gateway's IPC and reads ITS config dir", async () => {
    const paths = makePaths();
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(join(paths.configDir, "nimbus.work.toml"), "schema_version = 1\n");

    services = await assemblePlatformServices(paths, makeInMemoryVault());
    await services.ipc.start();

    const raw = await rpcOverSocket(services.ipc.listenPath, "profile.list");
    const res = JSON.parse(raw) as { result?: unknown; error?: { message?: string } };
    expect(res.error).toBeUndefined();
    expect(res.result).toEqual({ profiles: [{ name: "work", active: false }], active: null });
  }, 30000);

  // C3: `resolvePersona(paths.configDir, syncLogger)` is the SOLE site that passes a logger.
  // Deleting it makes `config/persona.ts`'s warn path dead code and a user with `tone = "tree"`
  // silently gets neutral behaviour. The boot logger writes to `logDir`'s daily file, so that
  // file is where the warning is observable without changing production to accept an injected
  // logger.
  it("C3: an unrecognised [persona] value warns through the boot logger's daily log", async () => {
    resetPersonaWarningsForTest();
    const paths = makePaths();
    rmSync(paths.configDir, { recursive: true, force: true });
    mkdirSync(paths.configDir, { recursive: true });
    writeFileSync(join(paths.configDir, "nimbus.toml"), '[persona]\ntone = "tree"\n');

    // `createGatewayPinoLogger` resolves its level from NIMBUS_LOG_LEVEL at construction and
    // defaults to "warn"; pin it so a machine or CI job running with `error`/`silent` does not
    // turn this into a false failure (nor, worse, a vacuous pass in the red-prove direction).
    const originalLevel = process.env["NIMBUS_LOG_LEVEL"];
    processEnvSet("NIMBUS_LOG_LEVEL", "warn");
    try {
      services = await assemblePlatformServices(paths, makeInMemoryVault());
    } finally {
      processEnvSet("NIMBUS_LOG_LEVEL", originalLevel);
    }

    // pino's file destination is async (`sync: false`), so poll briefly rather than assuming
    // the flush has already landed by the time assembly returns.
    const logPath = gatewayDailyLogPath(paths.logDir);
    const personaWarning = async (): Promise<{ msg?: unknown; key?: unknown; value?: unknown }> => {
      for (let i = 0; i < 60; i += 1) {
        const raw = existsSync(logPath) ? readFileSync(logPath, "utf8") : "";
        for (const line of raw.split("\n")) {
          if (line.trim() === "") continue;
          let parsed: { msg?: unknown; key?: unknown; value?: unknown };
          try {
            parsed = JSON.parse(line) as { msg?: unknown; key?: unknown; value?: unknown };
          } catch {
            continue;
          }
          if (typeof parsed.msg === "string" && parsed.msg.startsWith("[persona]")) return parsed;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      return {};
    };

    // Parsed as NDJSON rather than substring-matched over the raw file: pino JSON-escapes the
    // message, so the on-disk bytes are `tone = \\"tree\\"`, and a naive `toContain` of the
    // human-readable sentence would fail for a reason unrelated to the wiring under test.
    const warning = await personaWarning();
    expect(warning.msg).toBe(
      '[persona] tone = "tree" is not a recognised value — falling back to "neutral"',
    );
    expect(warning.key).toBe("tone");
    expect(warning.value).toBe("tree");
  }, 30000);
});
