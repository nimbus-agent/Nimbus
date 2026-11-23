import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { makeInMemoryVault } from "../../../test/helpers/in-memory-vault.ts";
import type { NimbusFilesystemRootToml } from "../../config/filesystem-toml.ts";
import { Config } from "../../config.ts";
import { writeConnectorSecret } from "../../connectors/connector-vault.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { openMigratedMemoryDb } from "../../index/migrated-db-template.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import type { Syncable } from "../../sync/types.ts";
import { processEnvGet, processEnvSet } from "../env-access.ts";
import { UNKNOWN_HOST_ACTIVITY } from "../host-activity-types.ts";
import type { PlatformPaths } from "../paths.ts";
import {
  createLocalIndexWithEmbeddingRuntime,
  type EmbeddingRuntime,
  ensureGithubCircleCiSchedulerCompanions,
  maybeAttachSessionMemoryStore,
  openGatewaySqlite,
  registerFilesystemRootSyncables,
} from "./index-boot.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nimbus-index-boot-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function pathsFor(demo: boolean): PlatformPaths {
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "logs"),
    socketPath: join(root, "g.sock"),
    extensionsDir: join(root, "extensions"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "sandbox"),
    ...(demo ? { demo: true } : {}),
  };
}

describe("openGatewaySqlite", () => {
  it("opens <dataDir>/nimbus.db migrated, in WAL mode, with a latency-flush stop", () => {
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const stops: Array<() => void> = [];
    const { db, dbPath } = openGatewaySqlite(dataDir, stops);
    try {
      expect(dbPath).toBe(join(dataDir, "nimbus.db"));
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      const uv = db.query<{ user_version: number }, []>("PRAGMA user_version").get();
      expect(uv?.user_version).toBeGreaterThanOrEqual(10);
      expect(
        db.query("SELECT 1 AS one FROM sqlite_master WHERE name = 'item'").get(),
      ).not.toBeNull();
      expect(stops).toHaveLength(1);
      expect(() => stops[0]?.()).not.toThrow();
    } finally {
      db.close();
    }
  });

  it("re-opens an existing database without losing its rows", () => {
    const dataDir = join(root, "data");
    mkdirSync(dataDir, { recursive: true });
    const first = openGatewaySqlite(dataDir, []);
    first.db.run("INSERT INTO _meta (key, value) VALUES ('probe', 'kept')");
    first.db.close();
    const second = openGatewaySqlite(dataDir, []);
    try {
      expect(second.db.query("SELECT value FROM _meta WHERE key = 'probe'").get()).toEqual({
        value: "kept",
      });
    } finally {
      second.db.close();
    }
  });
});

describe("createLocalIndexWithEmbeddingRuntime", () => {
  const ENV_KEYS = ["NIMBUS_SKIP_EMBEDDING_RUNTIME"] as const;
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = Object.fromEntries(ENV_KEYS.map((k) => [k, processEnvGet(k)]));
    for (const k of ENV_KEYS) processEnvSet(k, undefined);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) processEnvSet(k, saved[k]);
  });

  it("has no embedding runtime on a demo-rooted gateway, and says so in what it returns", () => {
    const db = openMigratedMemoryDb();
    const stops: Array<() => void> = [];
    const out = createLocalIndexWithEmbeddingRuntime(
      db,
      pathsFor(true),
      makeInMemoryVault(),
      pino({ level: "silent" }),
      join(root, "config"),
      UNKNOWN_HOST_ACTIVITY,
      stops,
    );
    expect(out.rt).toBeNull();
    expect(out.scheduleItemEmbedding).toBeUndefined();
    expect(out.localIndex).toBeInstanceOf(LocalIndex);
    // The battery backfill gate is built before the runtime decision and always torn down.
    expect(stops).toHaveLength(1);
    expect(() => stops[0]?.()).not.toThrow();
    db.close();
  });

  it.skipIf(!Config.embeddingsEnabled)(
    "returns a deferred runtime and its scheduler hook when embeddings are wanted",
    async () => {
      const configDir = join(root, "config");
      mkdirSync(configDir, { recursive: true });
      // The OpenAI provider with no key settles the runtime as disabled WITHOUT fetching a model.
      writeFileSync(
        join(configDir, "nimbus.toml"),
        ["[embedding]", 'provider = "openai"'].join("\n"),
      );
      const db = openMigratedMemoryDb();
      const stops: Array<() => void> = [];
      const out = createLocalIndexWithEmbeddingRuntime(
        db,
        pathsFor(false),
        makeInMemoryVault(),
        pino({ level: "silent" }),
        configDir,
        UNKNOWN_HOST_ACTIVITY,
        stops,
      );
      try {
        expect(out.rt).not.toBeNull();
        expect(typeof out.scheduleItemEmbedding).toBe("function");
        expect(out.localIndex).toBeInstanceOf(LocalIndex);
        expect(stops).toHaveLength(1);
        const end = Date.now() + 5_000;
        while (out.rt?.getReadiness().state === "warming" && Date.now() < end) await Bun.sleep(10);
        expect(out.rt?.getReadiness().state).toBe("disabled");
        // A disabled runtime degrades a query embed to "no vector", never a throw.
        expect(await out.rt?.embedQuery("hello")).toBeNull();
      } finally {
        out.rt?.terminate();
        for (const s of stops) s();
        db.close();
      }
    },
  );
});

describe("ensureGithubCircleCiSchedulerCompanions", () => {
  function indexWithGithub(): { index: LocalIndex; close: () => void } {
    const db = openMigratedMemoryDb();
    const index = new LocalIndex(db);
    index.ensureConnectorSchedulerRegistration("github", 60_000, Date.now());
    return { index, close: () => db.close() };
  }

  it("registers both companions when their credentials are in the vault", async () => {
    const { index, close } = indexWithGithub();
    const vault = makeInMemoryVault();
    await writeConnectorSecret(vault, "github", "pat", "ghp_x");
    await writeConnectorSecret(vault, "circleci", "api_token", "cci_x");
    await ensureGithubCircleCiSchedulerCompanions(index, vault);
    expect(index.persistedConnectorStatuses("github_actions")).toHaveLength(1);
    expect(index.persistedConnectorStatuses("circleci")).toHaveLength(1);
    close();
  });

  it("registers only the companion whose credential exists", async () => {
    const { index, close } = indexWithGithub();
    const vault = makeInMemoryVault();
    await writeConnectorSecret(vault, "circleci", "api_token", "cci_x");
    await ensureGithubCircleCiSchedulerCompanions(index, vault);
    expect(index.persistedConnectorStatuses("github_actions")).toHaveLength(0);
    expect(index.persistedConnectorStatuses("circleci")).toHaveLength(1);
    close();
  });

  it("treats an empty secret as absent", async () => {
    const { index, close } = indexWithGithub();
    const vault = makeInMemoryVault();
    await writeConnectorSecret(vault, "github", "pat", "");
    await writeConnectorSecret(vault, "circleci", "api_token", "");
    await ensureGithubCircleCiSchedulerCompanions(index, vault);
    expect(index.persistedConnectorStatuses("github_actions")).toHaveLength(0);
    expect(index.persistedConnectorStatuses("circleci")).toHaveLength(0);
    close();
  });

  it("registers nothing with no credentials at all", async () => {
    const { index, close } = indexWithGithub();
    await ensureGithubCircleCiSchedulerCompanions(index, makeInMemoryVault());
    expect(index.persistedConnectorStatuses("github_actions")).toHaveLength(0);
    expect(index.persistedConnectorStatuses("circleci")).toHaveLength(0);
    close();
  });
});

describe("maybeAttachSessionMemoryStore", () => {
  type Interval = { cb: () => void; ms: number; handle: ReturnType<typeof setInterval> };
  let captured: Interval | undefined;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let cleared: unknown[];

  beforeEach(() => {
    captured = undefined;
    cleared = [];
    globalThis.setInterval = ((cb: () => void, ms: number) => {
      const handle = realSetInterval(() => {}, 3_600_000);
      captured = { cb, ms, handle };
      return handle;
    }) as typeof setInterval;
    globalThis.clearInterval = ((h: Parameters<typeof clearInterval>[0]) => {
      cleared.push(h);
      realClearInterval(h);
    }) as typeof clearInterval;
  });
  afterEach(() => {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    if (captured !== undefined) realClearInterval(captured.handle);
  });

  function fakeRuntime(vec: Float32Array | null): EmbeddingRuntime {
    return {
      getEmbeddingDims: () => 384,
      embedQuery: () => Promise.resolve(vec),
    } as unknown as EmbeddingRuntime;
  }

  function vecCount(db: Database): number {
    const row = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM vec_items_384").get();
    return row?.n ?? 0;
  }

  it("returns no store for a schema older than session memory", () => {
    const db = new Database(":memory:");
    db.run("PRAGMA user_version = 5");
    const stops: Array<() => void> = [];
    expect(maybeAttachSessionMemoryStore(db, null, { memoryTtlHours: 24 }, stops)).toBeUndefined();
    expect(stops).toHaveLength(0);
    expect(captured).toBeUndefined();
    db.close();
  });

  it("without a runtime stores text with no vector", async () => {
    const db = openMigratedMemoryDb();
    const store = maybeAttachSessionMemoryStore(db, null, { memoryTtlHours: 24 }, []);
    expect(store).toBeDefined();
    await store?.append({ sessionId: "s", text: "hello", role: "user", createdAt: Date.now() });
    expect(store?.listSessions()).toHaveLength(1);
    expect(vecCount(db)).toBe(0);
    db.close();
  });

  it("with a runtime embeds through it at the runtime's dimensions", async () => {
    const db = openMigratedMemoryDb();
    const store = maybeAttachSessionMemoryStore(
      db,
      fakeRuntime(new Float32Array(384).fill(0.5)),
      { memoryTtlHours: 24 },
      [],
    );
    await store?.append({ sessionId: "s", text: "hello", role: "user", createdAt: Date.now() });
    expect(vecCount(db)).toBe(1);
    db.close();
  });

  it("prunes expired chunks hourly by the configured TTL, and keeps fresh ones", async () => {
    const db = openMigratedMemoryDb();
    const stops: Array<() => void> = [];
    const store = maybeAttachSessionMemoryStore(db, null, { memoryTtlHours: 2 }, stops);
    const now = Date.now();
    await store?.append({
      sessionId: "old",
      text: "a",
      role: "user",
      createdAt: now - 3 * 3_600_000,
    });
    await store?.append({ sessionId: "new", text: "b", role: "user", createdAt: now - 3_600_000 });
    expect(captured?.ms).toBe(3_600_000);
    captured?.cb();
    expect(store?.listSessions().map((s) => s.sessionId)).toEqual(["new"]);
    expect(stops).toHaveLength(1);
    stops[0]?.();
    expect(cleared).toContain(captured?.handle);
    db.close();
  });

  it("clamps a zero TTL to one hour rather than pruning everything", async () => {
    const db = openMigratedMemoryDb();
    const store = maybeAttachSessionMemoryStore(db, null, { memoryTtlHours: 0 }, []);
    await store?.append({ sessionId: "s", text: "a", role: "user", createdAt: Date.now() - 1_000 });
    captured?.cb();
    expect(store?.listSessions()).toHaveLength(1);
    db.close();
  });

  it("swallows a prune failure instead of crashing the timer", () => {
    const db = openMigratedMemoryDb();
    maybeAttachSessionMemoryStore(db, null, { memoryTtlHours: 1 }, []);
    db.close();
    expect(() => captured?.cb()).not.toThrow();
  });
});

describe("registerFilesystemRootSyncables", () => {
  function fakeScheduler(): { scheduler: SyncScheduler; ids: string[] } {
    const ids: string[] = [];
    const scheduler = {
      register: (s: Syncable) => {
        ids.push(s.serviceId);
      },
    } as unknown as SyncScheduler;
    return { scheduler, ids };
  }

  function rootAt(name: string): NimbusFilesystemRootToml {
    const path = join(root, name);
    mkdirSync(path, { recursive: true });
    return {
      path,
      gitAware: false,
      codeIndex: false,
      dependencyGraph: false,
      mediaIndex: false,
      exclude: [],
    };
  }

  function registered(index: LocalIndex): string[] {
    return ["filesystem", "blame", "openapi", "obsidian"].filter(
      (id) => index.persistedConnectorStatuses(id).length > 0,
    );
  }

  it("registers nothing when there are no roots", () => {
    const db = openMigratedMemoryDb();
    const index = new LocalIndex(db);
    const { scheduler, ids } = fakeScheduler();
    registerFilesystemRootSyncables(scheduler, index, join(root, "config"), [], []);
    expect(ids).toEqual([]);
    expect(registered(index)).toEqual([]);
    db.close();
  });

  it("a CLI-registered root gets filesystem and blame only, never openapi or obsidian", () => {
    const db = openMigratedMemoryDb();
    const index = new LocalIndex(db);
    const { scheduler, ids } = fakeScheduler();
    registerFilesystemRootSyncables(scheduler, index, join(root, "config"), [], [rootAt("reg")]);
    expect(ids).toHaveLength(2);
    expect(registered(index)).toEqual(["filesystem", "blame"]);
    db.close();
  });

  it("a [[filesystem.roots]] root also opts into openapi and obsidian", () => {
    const db = openMigratedMemoryDb();
    const index = new LocalIndex(db);
    const { scheduler, ids } = fakeScheduler();
    registerFilesystemRootSyncables(scheduler, index, join(root, "config"), [rootAt("toml")], []);
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    expect(registered(index)).toEqual(["filesystem", "blame", "openapi", "obsidian"]);
    db.close();
  });

  it("a root whose folder no longer exists is dropped before registering", () => {
    const db = openMigratedMemoryDb();
    const index = new LocalIndex(db);
    const { scheduler, ids } = fakeScheduler();
    const gone: NimbusFilesystemRootToml = {
      ...rootAt("gone"),
      path: join(root, "does-not-exist"),
    };
    registerFilesystemRootSyncables(scheduler, index, join(root, "config"), [], [gone]);
    expect(ids).toEqual([]);
    expect(registered(index)).toEqual([]);
    db.close();
  });
});
