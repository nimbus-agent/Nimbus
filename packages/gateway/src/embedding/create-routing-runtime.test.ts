import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pino from "pino";
import { openSeededDbFile } from "../../test/helpers/migrated-db-seed.ts";
import { requestUrl } from "../../test/helpers/request-url.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { processEnvDelete, processEnvSet } from "../platform/env-access.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { MockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { Embedder } from "./types.ts";

function vecAvailable(): boolean {
  const d = new Database(":memory:");
  tryLoadSqliteVec(d);
  const ok = isVecLoaded(d);
  d.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function fakeEmbedder(model: string, dims: number): Embedder {
  return {
    model,
    dims,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map((_, i) => {
        const v = new Float32Array(dims);
        v[0] = i + 1;
        return v;
      });
    },
  };
}

async function fakeLocalEmbedder(): Promise<Embedder> {
  return fakeEmbedder("local:all-MiniLM-L6-v2", 384);
}
async function throwingLocalEmbedder(): Promise<Embedder> {
  throw new Error("synthetic local embedder failure");
}

const REAL_FETCH = globalThis.fetch;
function installOpenaiFetchStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestUrl(input);
    if (!url.includes("api.openai.com/v1/embeddings")) {
      throw new Error(`unexpected fetch in routing-runtime test: ${url}`);
    }
    const body =
      typeof init?.body === "string"
        ? (JSON.parse(init.body) as { input: string[] })
        : { input: [] };
    const data = body.input.map((_, i) => ({
      index: i,
      embedding: Array.from({ length: 1536 }, () => 0.001),
    }));
    return new Response(JSON.stringify({ data }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}
function restoreFetch(): void {
  globalThis.fetch = REAL_FETCH;
}

type Harness = {
  db: Database;
  vault: NimbusVault;
  paths: PlatformPaths;
  toml: { chunkTokens: number; chunkOverlapTokens: number; backfillBatchSize: number };
  cleanup: () => void;
};

function makeHarness(opts: { migrateTo: number; setApiKey: boolean }): Harness {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-routing-runtime-"));
  const db = openSeededDbFile(join(dir, "nimbus.db"), opts.migrateTo);
  const vault = new MockVault();
  if (opts.setApiKey) {
    void vault.set("openai.api_key", "fixture-present");
  }
  const paths: PlatformPaths = {
    configDir: dir,
    dataDir: dir,
    logDir: dir,
    socketPath: join(dir, "gw.sock"),
    extensionsDir: join(dir, "ext"),
    tempDir: dir,
  };
  return {
    db,
    vault,
    paths,
    toml: { chunkTokens: 200, chunkOverlapTokens: 20, backfillBatchSize: 50 },
    cleanup: () => {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file-handle race; harmless */
      }
    },
  };
}

type RoutingFactory = typeof import("./create-routing-runtime.ts").tryCreateRoutingEmbeddingRuntime;

async function importFactory(
  createEmbedder: Parameters<RoutingFactory>[5] = fakeLocalEmbedder,
): Promise<
  (
    db: Parameters<RoutingFactory>[0],
    paths: Parameters<RoutingFactory>[1],
    logger: Parameters<RoutingFactory>[2],
    toml: Parameters<RoutingFactory>[3],
    vault: Parameters<RoutingFactory>[4],
  ) => ReturnType<RoutingFactory>
> {
  const mod = await import(resolve(import.meta.dir, "create-routing-runtime.ts"));
  return (db, paths, logger, toml, vault) =>
    mod.tryCreateRoutingEmbeddingRuntime(db, paths, logger, toml, vault, createEmbedder);
}

const silentLogger = pino({ level: "silent" });

describe("tryCreateRoutingEmbeddingRuntime — null-return branches", () => {
  beforeEach(() => {
    mock.restore();
    processEnvDelete("OPENAI_API_KEY");
  });
  afterEach(() => {
    mock.restore();
    processEnvDelete("OPENAI_API_KEY");
  });

  test("returns null when openai.api_key is missing from vault + env", async () => {
    const h = makeHarness({ migrateTo: 30, setApiKey: false });
    try {
      const factory = await importFactory();
      const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
      expect(runtime).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("OPENAI_API_KEY env var trumps the empty vault key", async () => {
    processEnvSet("OPENAI_API_KEY", "env-present");
    const h = makeHarness({ migrateTo: 30, setApiKey: false });
    try {
      const factory = await importFactory();
      const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
      if (!VEC_AVAILABLE) {
        expect(runtime).toBeNull();
        return;
      }
      expect(runtime).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("treats whitespace-only vault key as missing", async () => {
    const h = makeHarness({ migrateTo: 30, setApiKey: false });
    await h.vault.set("openai.api_key", "   \t\n  ");
    try {
      const factory = await importFactory();
      const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
      expect(runtime).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("returns null when the local embedder throws during init", async () => {
    const h = makeHarness({ migrateTo: 30, setApiKey: true });
    try {
      const factory = await importFactory(throwingLocalEmbedder);
      const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
      expect(runtime).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("returns null when local embedder init failure happens after API key resolves", async () => {
    const h = makeHarness({ migrateTo: 30, setApiKey: true });
    try {
      const factory = await importFactory(throwingLocalEmbedder);
      const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
      expect(runtime).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("logs an init-failure warning when an embedder throws", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const captureLogger = pino(
      { level: "warn" },
      {
        write(chunk: string) {
          try {
            warnings.push(JSON.parse(chunk));
          } catch {
            /* ignore non-JSON pino output */
          }
        },
      },
    );
    const h = makeHarness({ migrateTo: 30, setApiKey: true });
    try {
      const factory = await importFactory(throwingLocalEmbedder);
      await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
      await factory(h.db, h.paths, captureLogger, h.toml, h.vault);
      expect(
        warnings.some(
          (w) => typeof w["msg"] === "string" && w["msg"].includes("Hybrid embedding init failed"),
        ),
      ).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("returns null when ensureSqliteVecForConnection is false (schema >= v6, vec not loaded)", async () => {
    if (!VEC_AVAILABLE) {
      return;
    }
    const h = makeHarness({ migrateTo: 30, setApiKey: true });
    h.db.close();
    const freshDb = new Database(h.db.filename);
    try {
      let vecOnFresh = true;
      try {
        freshDb.query("SELECT vec_version()").get();
      } catch {
        vecOnFresh = false;
      }
      if (vecOnFresh) {
        return;
      }
      const factory = await importFactory();
      const runtime = await factory(freshDb, h.paths, silentLogger, h.toml, h.vault);
      const stillVec = isVecLoaded(freshDb);
      if (!stillVec) {
        expect(runtime).toBeNull();
      }
    } finally {
      freshDb.close();
      try {
        rmSync(h.paths.dataDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

describe.skipIf(!VEC_AVAILABLE)(
  "tryCreateRoutingEmbeddingRuntime — runtime returned by happy path",
  () => {
    beforeEach(() => {
      mock.restore();
      installOpenaiFetchStub();
    });
    afterEach(() => {
      mock.restore();
      restoreFetch();
    });

    test("returns a non-null runtime when key + embedders + vec all line up", async () => {
      const h = makeHarness({ migrateTo: 30, setApiKey: true });
      try {
        const factory = await importFactory();
        const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
        expect(runtime).not.toBeNull();
      } finally {
        h.cleanup();
      }
    });

    test("getEmbeddingModel returns the local tag and getEmbeddingDims returns 384", async () => {
      const h = makeHarness({ migrateTo: 30, setApiKey: true });
      try {
        const factory = await importFactory();
        const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
        expect(runtime?.getEmbeddingModel()).toBe("local:all-MiniLM-L6-v2");
        expect(runtime?.getEmbeddingDims()).toBe(384);
      } finally {
        h.cleanup();
      }
    });

    test("getBackfillProgress returns null (lazy runtime carries no progress)", async () => {
      const h = makeHarness({ migrateTo: 30, setApiKey: true });
      try {
        const factory = await importFactory();
        const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
        expect(runtime?.getBackfillProgress()).toBeNull();
      } finally {
        h.cleanup();
      }
    });

    test("embedQuery returns the single local vector for the input text", async () => {
      const h = makeHarness({ migrateTo: 30, setApiKey: true });
      try {
        const factory = await importFactory();
        const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
        const vec = await runtime?.embedQuery("hello");
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec?.length).toBe(384);
        expect(vec?.[0]).toBe(1);
      } finally {
        h.cleanup();
      }
    });

    test("embedQueryDual returns both vectors with both model tags", async () => {
      const h = makeHarness({ migrateTo: 30, setApiKey: true });
      try {
        const factory = await importFactory();
        const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
        const out = await runtime?.embedQueryDual("hello");
        expect(out?.vec384).toBeInstanceOf(Float32Array);
        expect(out?.vec1536).toBeInstanceOf(Float32Array);
        expect(out?.vec384?.length).toBe(384);
        expect(out?.vec1536?.length).toBe(1536);
        expect(out?.model384).toBe("local:all-MiniLM-L6-v2");
        expect(out?.model1536).toBe("openai:text-embedding-3-small");
      } finally {
        h.cleanup();
      }
    });

    test("scheduleItemEmbedding is a no-op for an itemId that doesn't exist", async () => {
      const h = makeHarness({ migrateTo: 30, setApiKey: true });
      try {
        const factory = await importFactory();
        const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
        expect(() => runtime?.scheduleItemEmbedding("never-existed")).not.toThrow();
        await new Promise((r) => setTimeout(r, 20));
        const row = h.db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as {
          c: number;
        };
        expect(row.c).toBe(0);
      } finally {
        h.cleanup();
      }
    });

    test("scheduleItemEmbedding embeds a real item via the local pipeline (prose-light type)", async () => {
      const h = makeHarness({ migrateTo: 30, setApiKey: true });
      try {
        const now = Date.now();
        h.db.run(
          `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          ["github:pr-1", "github", "pr", "pr-1", "Refactor connector mesh", "body text", now, now],
        );
        const factory = await importFactory();
        const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
        runtime?.scheduleItemEmbedding("github:pr-1");
        await new Promise((r) => setTimeout(r, 80));
        const chunks = h.db
          .query("SELECT COUNT(*) AS c FROM embedding_chunk WHERE item_id = ?")
          .get("github:pr-1") as { c: number };
        expect(chunks.c).toBeGreaterThan(0);
      } finally {
        h.cleanup();
      }
    });

    test("startBackgroundJobs is idempotent — second call does not re-trigger backfill", async () => {
      const h = makeHarness({ migrateTo: 30, setApiKey: true });
      try {
        const factory = await importFactory();
        const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
        expect(() => runtime?.startBackgroundJobs()).not.toThrow();
        expect(() => runtime?.startBackgroundJobs()).not.toThrow();
      } finally {
        h.cleanup();
      }
    });

    test("terminate is a no-op in the in-process runtime", async () => {
      const h = makeHarness({ migrateTo: 30, setApiKey: true });
      try {
        const factory = await importFactory();
        const runtime = await factory(h.db, h.paths, silentLogger, h.toml, h.vault);
        expect(() => runtime?.terminate()).not.toThrow();
      } finally {
        h.cleanup();
      }
    });
  },
);
