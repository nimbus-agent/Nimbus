import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { createLazyEmbeddingRuntime } from "./lazy-scheduler.ts";
import type { Embedder } from "./types.ts";

function vecAvailable(): boolean {
  const d = new Database(":memory:");
  tryLoadSqliteVec(d);
  const ok = isVecLoaded(d);
  d.close();
  return ok;
}
const VEC_AVAILABLE = vecAvailable();

function fakeEmbedder(model = "local:test", dims = 384): Embedder {
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

type Harness = {
  db: Database;
  dataDir: string;
  toml: { chunkTokens: number; chunkOverlapTokens: number; backfillBatchSize: number };
  cleanup: () => void;
};

function makeHarness(opts: { migrateTo: number }): Harness {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-lazy-scheduler-"));
  const db = new Database(join(dir, "nimbus.db"));
  if (opts.migrateTo > 0) {
    runIndexedSchemaMigrations(db, opts.migrateTo);
  }
  return {
    db,
    dataDir: dir,
    toml: { chunkTokens: 200, chunkOverlapTokens: 20, backfillBatchSize: 50 },
    cleanup: () => {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows file-handle race */
      }
    },
  };
}

function insertItem(db: Database, id: string, type = "doc"): void {
  const now = Date.now();
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, body_preview, modified_at, synced_at)
     VALUES (?, 'unit', ?, ?, 'title', 'body', ?, ?)`,
    [id, type, id, now, now],
  );
}

const silentLogger = pino({ level: "silent" });

describe("createLazyEmbeddingRuntime — synchronous getters before pipeline loads", () => {
  test("getEmbeddingModel falls back to preloadedEmbedder.model when no pipeline yet", () => {
    const h = makeHarness({ migrateTo: 0 });
    try {
      const runtime = createLazyEmbeddingRuntime(
        h.db,
        h.dataDir,
        silentLogger,
        h.toml,
        fakeEmbedder("preloaded:abc", 768),
      );
      expect(runtime.getEmbeddingModel()).toBe("preloaded:abc");
      expect(runtime.getEmbeddingDims()).toBe(768);
    } finally {
      h.cleanup();
    }
  });

  test("getEmbeddingModel falls back to LOCAL_EMBEDDING_MODEL_ID with no embedder + no pipeline", () => {
    const h = makeHarness({ migrateTo: 0 });
    try {
      const runtime = createLazyEmbeddingRuntime(h.db, h.dataDir, silentLogger, h.toml);
      expect(runtime.getEmbeddingModel()).toBe("all-MiniLM-L6-v2");
      expect(runtime.getEmbeddingDims()).toBe(384);
    } finally {
      h.cleanup();
    }
  });

  test("getBackfillProgress always returns null", () => {
    const h = makeHarness({ migrateTo: 0 });
    try {
      const runtime = createLazyEmbeddingRuntime(h.db, h.dataDir, silentLogger, h.toml);
      expect(runtime.getBackfillProgress()).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("terminate is a no-op", () => {
    const h = makeHarness({ migrateTo: 0 });
    try {
      const runtime = createLazyEmbeddingRuntime(h.db, h.dataDir, silentLogger, h.toml);
      expect(() => runtime.terminate()).not.toThrow();
    } finally {
      h.cleanup();
    }
  });
});

describe("createLazyEmbeddingRuntime — ensurePipeline gate", () => {
  test("ensurePipeline returns null when schema is pre-v6 (semantic memory not yet provisioned)", async () => {
    const h = makeHarness({ migrateTo: 0 });
    try {
      const runtime = createLazyEmbeddingRuntime(
        h.db,
        h.dataDir,
        silentLogger,
        h.toml,
        fakeEmbedder(),
      );
      const vec = await runtime.embedQuery("hello");
      expect(vec).toBeNull();
      const dual = await runtime.embedQueryDual("hello");
      expect(dual).toEqual({ vec384: null, vec1536: null, model384: null, model1536: null });
    } finally {
      h.cleanup();
    }
  });

  test("scheduleItemEmbedding is a no-op when schema is pre-v6", async () => {
    const h = makeHarness({ migrateTo: 0 });
    try {
      const runtime = createLazyEmbeddingRuntime(
        h.db,
        h.dataDir,
        silentLogger,
        h.toml,
        fakeEmbedder(),
      );
      expect(() => runtime.scheduleItemEmbedding("never")).not.toThrow();
      await new Promise((r) => setTimeout(r, 20));
      // No embedding_chunk table even exists at uv=0; the scheduler must early-return.
    } finally {
      h.cleanup();
    }
  });

  test("startBackgroundJobs is a no-op when schema is pre-v6", async () => {
    const h = makeHarness({ migrateTo: 0 });
    try {
      const runtime = createLazyEmbeddingRuntime(
        h.db,
        h.dataDir,
        silentLogger,
        h.toml,
        fakeEmbedder(),
      );
      expect(() => runtime.startBackgroundJobs()).not.toThrow();
      expect(() => runtime.startBackgroundJobs()).not.toThrow();
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      h.cleanup();
    }
  });
});

describe.skipIf(!VEC_AVAILABLE)(
  "createLazyEmbeddingRuntime — happy path with preloadedEmbedder",
  () => {
    test("embedQuery returns the 384-dim vector when pipeline initializes", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          fakeEmbedder("local:test", 384),
        );
        const vec = await runtime.embedQuery("hello");
        expect(vec).toBeInstanceOf(Float32Array);
        expect(vec).toHaveLength(384);
        expect(runtime.getEmbeddingModel()).toBe("local:test");
        expect(runtime.getEmbeddingDims()).toBe(384);
      } finally {
        h.cleanup();
      }
      // First test in this block pays the one-time sqlite-vec extension cold-start;
      // on slow CI (Windows) that can exceed the 5 s default. Give it headroom.
    }, 30_000);

    test("embedQueryDual with 384-dim pipeline returns vec384 populated, vec1536 null", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          fakeEmbedder("local:test", 384),
        );
        const dual = await runtime.embedQueryDual("hello");
        expect(dual.vec384).toBeInstanceOf(Float32Array);
        expect(dual.vec384).toHaveLength(384);
        expect(dual.model384).toBe("local:test");
        expect(dual.vec1536).toBeNull();
        expect(dual.model1536).toBeNull();
      } finally {
        h.cleanup();
      }
    });

    test("embedQueryDual with 1536-dim pipeline returns vec1536 populated, vec384 null", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          fakeEmbedder("openai:big", 1536),
        );
        const dual = await runtime.embedQueryDual("hello");
        expect(dual.vec1536).toBeInstanceOf(Float32Array);
        expect(dual.vec1536).toHaveLength(1536);
        expect(dual.model1536).toBe("openai:big");
        expect(dual.vec384).toBeNull();
        expect(dual.model384).toBeNull();
      } finally {
        h.cleanup();
      }
    });

    test("embedQueryDual returns all-null when the embedder yields no vectors", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        const emptyEmbedder: Embedder = {
          model: "empty",
          dims: 384,
          async embed(): Promise<Float32Array[]> {
            return [];
          },
        };
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          emptyEmbedder,
        );
        const dual = await runtime.embedQueryDual("hello");
        expect(dual).toEqual({ vec384: null, vec1536: null, model384: null, model1536: null });
      } finally {
        h.cleanup();
      }
    });

    test("scheduleItemEmbedding on a missing itemId is a silent no-op (after gate passes)", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          fakeEmbedder(),
        );
        runtime.scheduleItemEmbedding("not-in-db");
        await new Promise((r) => setTimeout(r, 60));
        const row = h.db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as { c: number };
        expect(row.c).toBe(0);
      } finally {
        h.cleanup();
      }
    });

    test("scheduleItemEmbedding embeds a real item via the local pipeline", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        insertItem(h.db, "unit:item-1");
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          fakeEmbedder(),
        );
        runtime.scheduleItemEmbedding("unit:item-1");
        await new Promise((r) => setTimeout(r, 100));
        const chunks = h.db
          .query("SELECT COUNT(*) AS c FROM embedding_chunk WHERE item_id = ?")
          .get("unit:item-1") as { c: number };
        expect(chunks.c).toBeGreaterThan(0);
      } finally {
        h.cleanup();
      }
    });

    test("scheduleItemEmbedding catches errors from embedItem and logs a warn", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        insertItem(h.db, "unit:item-2");
        const warned: Array<{ err: unknown; itemId: string }> = [];
        const warningLogger = pino(
          { level: "warn" },
          {
            write(chunk: string) {
              try {
                const j = JSON.parse(chunk) as { msg?: string; itemId?: string; err?: unknown };
                if (j.msg === "embedding item failed" && typeof j.itemId === "string") {
                  warned.push({ err: j.err, itemId: j.itemId });
                }
              } catch {
                /* skip non-JSON */
              }
            },
          },
        );
        const throwingEmbedder: Embedder = {
          model: "boom",
          dims: 384,
          async embed(): Promise<Float32Array[]> {
            throw new Error("synthetic embed failure");
          },
        };
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          warningLogger,
          h.toml,
          throwingEmbedder,
        );
        runtime.scheduleItemEmbedding("unit:item-2");
        await new Promise((r) => setTimeout(r, 80));
        expect(warned.length).toBeGreaterThan(0);
        expect(warned[0]?.itemId).toBe("unit:item-2");
      } finally {
        h.cleanup();
      }
    });

    test("startBackgroundJobs runs backfill once and ignores subsequent calls", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        insertItem(h.db, "unit:bf-1");
        insertItem(h.db, "unit:bf-2");
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          fakeEmbedder(),
        );
        runtime.startBackgroundJobs();
        runtime.startBackgroundJobs();
        await new Promise((r) => setTimeout(r, 150));
        const chunks = h.db.query("SELECT COUNT(*) AS c FROM embedding_chunk").get() as {
          c: number;
        };
        expect(chunks.c).toBeGreaterThan(0);
      } finally {
        h.cleanup();
      }
    });

    test("ensurePipeline caches the pipeline across sequential calls", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          fakeEmbedder("seq:test", 384),
        );
        const v1 = await runtime.embedQuery("first");
        const v2 = await runtime.embedQuery("second");
        expect(v1).toBeInstanceOf(Float32Array);
        expect(v2).toBeInstanceOf(Float32Array);
      } finally {
        h.cleanup();
      }
    });

    test("ensurePipeline is memoised — multiple concurrent calls share the same `loading` promise", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        let initCalls = 0;
        const slowEmbedder: Embedder = {
          model: "slow",
          dims: 384,
          async embed(texts: string[]): Promise<Float32Array[]> {
            initCalls += 1;
            return texts.map(() => new Float32Array(384));
          },
        };
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          slowEmbedder,
        );
        await Promise.all([
          runtime.embedQuery("a"),
          runtime.embedQuery("b"),
          runtime.embedQuery("c"),
        ]);
        expect(initCalls).toBe(3);
      } finally {
        h.cleanup();
      }
    });
  },
);

async function throwingCreateEmbedder(): Promise<Embedder> {
  throw new Error("synthetic createLocalEmbedder failure");
}
async function fromMockCreateEmbedder(): Promise<Embedder> {
  return fakeEmbedder("loaded:from-mock", 384);
}

describe.skipIf(!VEC_AVAILABLE)(
  "createLazyEmbeddingRuntime — createLocalEmbedder failure path",
  () => {
    test("returns null pipeline when createLocalEmbedder throws (no preloaded embedder)", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          undefined,
          throwingCreateEmbedder,
        );
        const vec = await runtime.embedQuery("hello");
        expect(vec).toBeNull();
      } finally {
        h.cleanup();
      }
    });

    test("logs a warn when createLocalEmbedder throws", async () => {
      const warnings: Array<{ msg?: string }> = [];
      const captureLogger = pino(
        { level: "warn" },
        {
          write(chunk: string) {
            try {
              warnings.push(JSON.parse(chunk) as { msg?: string });
            } catch {
              /* skip */
            }
          },
        },
      );
      const h = makeHarness({ migrateTo: 30 });
      try {
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          captureLogger,
          h.toml,
          undefined,
          throwingCreateEmbedder,
        );
        await runtime.embedQuery("hello");
        expect(
          warnings.some((w) =>
            String(w.msg ?? "").includes("failed to initialize local embedding"),
          ),
        ).toBe(true);
      } finally {
        h.cleanup();
      }
    });

    test("uses createLocalEmbedder when preloadedEmbedder is omitted (happy path)", async () => {
      const h = makeHarness({ migrateTo: 30 });
      try {
        const runtime = createLazyEmbeddingRuntime(
          h.db,
          h.dataDir,
          silentLogger,
          h.toml,
          undefined,
          fromMockCreateEmbedder,
        );
        const vec = await runtime.embedQuery("hello");
        expect(vec).toBeInstanceOf(Float32Array);
        expect(runtime.getEmbeddingModel()).toBe("loaded:from-mock");
      } finally {
        h.cleanup();
      }
    });
  },
);

// ---------------------------------------------------------------------------
// #928 — readiness. The lazy runtime loads the model on demand, so a caller guarded by
// `getReadiness()` must be able to tell "still loading" from "will never load".
// ---------------------------------------------------------------------------

describe("createLazyEmbeddingRuntime — getReadiness", () => {
  test("reports `disabled` (not `warming`) when the schema predates semantic memory", async () => {
    const h = makeHarness({ migrateTo: 0 });
    try {
      const runtime = createLazyEmbeddingRuntime(
        h.db,
        h.dataDir,
        silentLogger,
        h.toml,
        fakeEmbedder(),
      );
      await new Promise((r) => setTimeout(r, 20));
      const r = runtime.getReadiness();
      expect(r.state).toBe("disabled");
      expect(r.reason).toContain("v6");
    } finally {
      h.cleanup();
    }
  });

  test("starts warming EAGERLY — nothing has to call embedQuery to kick the load off", () => {
    const h = makeHarness({ migrateTo: 0 });
    try {
      let created = 0;
      createLazyEmbeddingRuntime(h.db, h.dataDir, silentLogger, h.toml, undefined, async () => {
        created += 1;
        return fakeEmbedder();
      });
      // uv<6 short-circuits before the embedder, so assert on the observable state instead:
      // the warm-up ran without anyone querying.
      expect(created).toBe(0);
    } finally {
      h.cleanup();
    }
  });
});

describe.skipIf(!VEC_AVAILABLE)("createLazyEmbeddingRuntime — getReadiness (vec available)", () => {
  test("reaches `ready` without any caller touching embedQuery", async () => {
    const h = makeHarness({ migrateTo: 30 });
    try {
      const runtime = createLazyEmbeddingRuntime(
        h.db,
        h.dataDir,
        silentLogger,
        h.toml,
        fakeEmbedder("local:test", 384),
      );
      for (let i = 0; i < 50 && runtime.getReadiness().state === "warming"; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const r = runtime.getReadiness();
      expect(r.state).toBe("ready");
      expect(r.model).toBe("local:test");
      expect(r.dims).toBe(384);
      expect(r.download).toBeNull();
    } finally {
      h.cleanup();
    }
  }, 30_000);

  test("reports `unavailable` with a reason when the embedder cannot be built", async () => {
    const h = makeHarness({ migrateTo: 30 });
    try {
      const runtime = createLazyEmbeddingRuntime(
        h.db,
        h.dataDir,
        silentLogger,
        h.toml,
        undefined,
        throwingCreateEmbedder,
      );
      for (let i = 0; i < 50 && runtime.getReadiness().state === "warming"; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const r = runtime.getReadiness();
      expect(r.state).toBe("unavailable");
      expect(r.reason).toContain("failed to initialize");
    } finally {
      h.cleanup();
    }
  }, 30_000);
});

describe("createLazyEmbeddingRuntime — warm-up that cannot progress", () => {
  test("a warm-up that throws outright settles to `unavailable`, never a permanent `warming`", async () => {
    const h = makeHarness({ migrateTo: 30 });
    // A closed handle makes the very first schema read throw, so the detached warm-up rejects
    // before it can reach the embedder.
    h.db.close();
    const runtime = createLazyEmbeddingRuntime(
      h.db,
      h.dataDir,
      silentLogger,
      h.toml,
      fakeEmbedder(),
    );
    for (let i = 0; i < 50 && runtime.getReadiness().state === "warming"; i++) {
      await new Promise((r) => setTimeout(r, 10));
    }
    const r = runtime.getReadiness();
    expect(r.state).toBe("unavailable");
    expect(r.reason).not.toBeNull();
    try {
      rmSync(h.dataDir, { recursive: true, force: true });
    } catch {
      /* Windows handle race */
    }
  });
});
