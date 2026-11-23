import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";
import { makeInMemoryVault } from "../../../test/helpers/in-memory-vault.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import { openMigratedMemoryDb } from "../../index/migrated-db-template.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import { processEnvGet, processEnvSet } from "../env-access.ts";
import type { PlatformPaths } from "../paths.ts";
import {
  autoUpdateIpcOpts,
  maybeStartAutoUpdateRuntime,
  wireUpdaterIntoIpc,
} from "./updater-boot.ts";

const ENV_KEYS = [
  "NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE",
  "NIMBUS_UPDATER_URL",
  "NIMBUS_UPDATER_DISABLE",
  "NIMBUS_DISTRIBUTION_CHANNEL",
  "NIMBUS_DEV_UPDATER_PUBLIC_KEY",
] as const;

let saved: Record<string, string | undefined>;
let db: Database;
let root: string;
let logger: Logger;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, processEnvGet(k)]));
  for (const k of ENV_KEYS) processEnvSet(k, undefined);
  db = openMigratedMemoryDb();
  root = mkdtempSync(join(tmpdir(), "nimbus-updater-boot-"));
  logger = pino({ level: "silent" });
});

afterEach(() => {
  for (const k of ENV_KEYS) processEnvSet(k, saved[k]);
  db.close();
  rmSync(root, { recursive: true, force: true });
});

function pathsFor(demo: boolean): PlatformPaths {
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  return {
    configDir,
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    socketPath: join(root, "g.sock"),
    extensionsDir: join(root, "extensions"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "sandbox"),
    ...(demo ? { demo: true } : {}),
  };
}

function writeToml(configDir: string, text: string): void {
  writeFileSync(join(configDir, "nimbus.toml"), text);
}

const FAKE_MESH = { stopExtensionClient: () => Promise.resolve() } as unknown as LazyConnectorMesh;

function registryFetchDeps(): Parameters<typeof maybeStartAutoUpdateRuntime>[0]["registryFetch"] {
  return {
    fetchFn: () => Promise.reject(new Error("no network in this test")),
    enforceAirGap: () => true,
    now: () => 0,
    production: false,
  };
}

function startRuntime(paths: PlatformPaths, stops: Array<() => void>) {
  return maybeStartAutoUpdateRuntime({
    db,
    vault: makeInMemoryVault(),
    paths,
    connectorMesh: FAKE_MESH,
    sidecarStops: stops,
    registryFetch: registryFetchDeps(),
    onUpdateApplied: () => {},
    freshenTrust: () => Promise.resolve(),
  });
}

describe("maybeStartAutoUpdateRuntime", () => {
  it("starts the daemon and registers a stop that aborts it", async () => {
    const stops: Array<() => void> = [];
    const runtime = startRuntime(pathsFor(false), stops);
    expect(runtime).toBeDefined();
    expect(stops).toHaveLength(1);
    await Bun.sleep(0);
    expect(runtime?.daemon.isRunning()).toBe(true);
    expect(runtime?.abortController.signal.aborted).toBe(false);
    stops[0]?.();
    expect(runtime?.abortController.signal.aborted).toBe(true);
    await Bun.sleep(0);
    expect(runtime?.daemon.isRunning()).toBe(false);
  });

  it("is not started when NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE=1", () => {
    processEnvSet("NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE", "1");
    const stops: Array<() => void> = [];
    expect(startRuntime(pathsFor(false), stops)).toBeUndefined();
    expect(stops).toHaveLength(0);
  });

  it("only a literal 1 vetoes the daemon", () => {
    processEnvSet("NIMBUS_EXTENSIONS_DISABLE_AUTO_UPDATE", "0");
    const stops: Array<() => void> = [];
    const runtime = startRuntime(pathsFor(false), stops);
    expect(runtime).toBeDefined();
    stops[0]?.();
  });

  it("is never started on a demo-rooted gateway (I41)", () => {
    const stops: Array<() => void> = [];
    expect(startRuntime(pathsFor(true), stops)).toBeUndefined();
    expect(stops).toHaveLength(0);
  });
});

describe("autoUpdateIpcOpts", () => {
  it("contributes nothing when the daemon is not running", () => {
    expect(autoUpdateIpcOpts(undefined, root, false)).toEqual({});
  });

  it("exposes the runtime bag and a diagnostic that reads config and the cache", () => {
    const paths = pathsFor(false);
    writeToml(paths.configDir, ["[extensions]", "update_check_interval_hours = 7"].join("\n"));
    const stops: Array<() => void> = [];
    const runtime = startRuntime(paths, stops);
    const opts = autoUpdateIpcOpts(runtime, paths.configDir, true);
    expect(opts.extensionsAutoUpdate).toBe(runtime?.deps);
    expect(opts.extensionsAutoUpdateDiag?.intervalHours).toBe(7);
    expect(opts.extensionsAutoUpdateDiag?.airGapBlocked).toBe(true);
    expect(opts.extensionsAutoUpdateDiag?.cachedUpdatesCount()).toBe(0);
    stops[0]?.();
  });

  it("reports the air-gap flag as given, not as a constant", () => {
    const paths = pathsFor(false);
    const stops: Array<() => void> = [];
    const runtime = startRuntime(paths, stops);
    expect(
      autoUpdateIpcOpts(runtime, paths.configDir, false).extensionsAutoUpdateDiag,
    ).toMatchObject({ airGapBlocked: false, intervalHours: 24 });
    stops[0]?.();
  });
});

type FakeIpc = {
  ipc: ReturnType<typeof createIpcServer>;
  broadcasts: Array<{ name: string; payload: unknown }>;
  updaters: unknown[];
};

function fakeIpc(): FakeIpc {
  const broadcasts: FakeIpc["broadcasts"] = [];
  const updaters: unknown[] = [];
  const ipc = {
    broadcast: (name: string, payload: unknown) => {
      broadcasts.push({ name, payload });
    },
    setUpdater: (u: unknown) => {
      updaters.push(u);
    },
  } as unknown as ReturnType<typeof createIpcServer>;
  return { ipc, broadcasts, updaters };
}

async function until(cond: () => boolean, ms = 5_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
}

describe("wireUpdaterIntoIpc", () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  afterEach(() => {
    server?.stop(true);
    server = undefined;
  });

  function serve(status: number, body: unknown): string {
    server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch: () => new Response(JSON.stringify(body), { status }),
    });
    return `http://127.0.0.1:${server.port}/latest.json`;
  }

  it("builds no updater when [updater] is disabled", () => {
    const paths = pathsFor(false);
    writeToml(paths.configDir, ["[updater]", "enabled = false"].join("\n"));
    const f = fakeIpc();
    wireUpdaterIntoIpc(paths.configDir, f.ipc, logger, db);
    expect(f.updaters).toHaveLength(0);
  });

  it("builds no updater when NIMBUS_UPDATER_DISABLE=1, whatever the file says", () => {
    const paths = pathsFor(false);
    writeToml(paths.configDir, ["[updater]", "enabled = true"].join("\n"));
    processEnvSet("NIMBUS_UPDATER_DISABLE", "1");
    const f = fakeIpc();
    wireUpdaterIntoIpc(paths.configDir, f.ipc, logger, db);
    expect(f.updaters).toHaveLength(0);
  });

  it("builds no updater for a package-manager install (self-update is the manager's job)", () => {
    const paths = pathsFor(false);
    writeToml(paths.configDir, ["[updater]", "enabled = true"].join("\n"));
    processEnvSet("NIMBUS_DISTRIBUTION_CHANNEL", "msi");
    const f = fakeIpc();
    wireUpdaterIntoIpc(paths.configDir, f.ipc, logger, db);
    expect(f.updaters).toHaveLength(0);
  });

  it("hands the updater to the server and makes no request when check_on_startup is off", async () => {
    const url = serve(200, {});
    const paths = pathsFor(false);
    writeToml(
      paths.configDir,
      ["[updater]", "enabled = true", `url = "${url}"`, "check_on_startup = false"].join("\n"),
    );
    const f = fakeIpc();
    wireUpdaterIntoIpc(paths.configDir, f.ipc, logger, db);
    expect(f.updaters).toHaveLength(1);
    await Bun.sleep(50);
    expect(f.broadcasts).toHaveLength(0);
  });

  it("checks at startup and broadcasts an available update through the server", async () => {
    const platforms = Object.fromEntries(
      ["darwin-x86_64", "darwin-aarch64", "linux-x86_64", "windows-x86_64"].map((t) => [
        t,
        { url: "https://example.invalid/x", sha256: "00", signature: "00" },
      ]),
    );
    const url = serve(200, { version: "999.0.0", pub_date: "2030-01-01", platforms, notes: "n" });
    const paths = pathsFor(false);
    writeToml(paths.configDir, ["[updater]", "enabled = true", `url = "${url}"`].join("\n"));
    const f = fakeIpc();
    wireUpdaterIntoIpc(paths.configDir, f.ipc, logger, db);
    expect(f.updaters).toHaveLength(1);
    await until(() => f.broadcasts.length > 0);
    expect(f.broadcasts[0]).toEqual({
      name: "updater.updateAvailable",
      payload: { version: "999.0.0", notes: "n" },
    });
  });

  it("logs a failed startup check without throwing, with URL credentials redacted", async () => {
    const real = serve(500, {});
    const url = real.replace("http://", "http://owner:hunter2@");
    const paths = pathsFor(false);
    writeToml(paths.configDir, ["[updater]", "enabled = true", `url = "${url}"`].join("\n"));
    const warn = spyOn(logger, "warn");
    const f = fakeIpc();
    wireUpdaterIntoIpc(paths.configDir, f.ipc, logger, db);
    await until(() => warn.mock.calls.length > 0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toBe("updater startup check failed");
    const logged = JSON.stringify(warn.mock.calls[0]?.[0]);
    expect(logged).not.toContain("hunter2");
    expect(f.broadcasts).toHaveLength(0);
  });
});
