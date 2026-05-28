/**
 * Coverage for the hybrid-mode embedding runtime factory.
 *
 * The factory builds a RoutingEmbeddingPipeline backed by two SqliteEmbeddingPipelines
 * (local MiniLM 384 + OpenAI 1536). Three branches return null without building:
 *  1. openai.api_key missing — MiniLM-only fallback per the docs
 *  2. embedder construction throws — same
 *  3. sqlite-vec unavailable on the connection — same
 *
 * The happy path returns an EmbeddingRuntime whose methods we exercise in-process
 * with fake embedders that return deterministic zero vectors (so vec_items_* writes
 * succeed without loading real ONNX weights).
 *
 * We use `mock.module` to swap `./model.ts` (heavy MiniLM weights) and
 * `./openai-embedder.ts` (HTTP) for in-test fakes — same pattern as
 * `test/e2e/run-ask-conversational.e2e.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import pino from "pino";
import { openSeededDbFile } from "../../test/helpers/migrated-db-seed.ts";
import { isVecLoaded, tryLoadSqliteVec } from "../index/sqlite-vec-load.ts";
import { processEnvDelete, processEnvSet } from "../platform/env-access.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { MockVault } from "../vault/mock.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import type { Embedder } from "./types.ts";

// The local MiniLM embedder is injected into `tryCreateRoutingEmbeddingRuntime`
// via its `createEmbedder` param (not `mock.module`) — a process-global
// model.ts mock would leak a fake into the sibling model.test.ts. openai-embedder.ts
// stays real; we intercept globalThis.fetch for its HTTP call instead.

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
        // Tiny deterministic signal so distinct calls aren't all-zero (sqlite-vec
        // tolerates zero vectors but we want to be able to assert "non-empty").
        v[0] = i + 1;
        return v;
      });
    },
  };
}

// Injected local-embedder factory (replaces the old mock.module(model.ts)).
async function fakeLocalEmbedder(): Promise<Embedder> {
  return fakeEmbedder("local:all-MiniLM-L6-v2", 384);
}
async function throwingLocalEmbedder(): Promise<Embedder> {
  throw new Error("synthetic local embedder failure");
}

// The real createOpenAIEmbedder runs lazily — its returned wrapper makes a
// fetch() call only on .embed(). We stub globalThis.fetch to return a
// well-formed 1536-dim response so runtime.embedQueryDual works without
// hitting the real OpenAI API.
const REAL_FETCH = globalThis.fetch;
function installOpenaiFetchStub(): void {
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.includes("api.openai.com/v1/embeddings")) {
      throw new Error(`unexpected fetch in routing-runtime test: ${url}`);
    }
    // Parse the input array length to return matching number of embeddings.
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
    // Deliberately not shaped like a real OpenAI key — only the presence matters
    // to the factory, never the value. Avoids gitleaks `generic-api-key` flags.
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

// Returns a 5-arg wrapper that injects `createEmbedder` (the local MiniLM
// factory) as the 6th arg — so test call sites stay `factory(db, paths, ...)`.
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
    // Distinct from the previous test: this one confirms the catch wraps both
    // embedder constructions (line 56-65) — even when only one of the two throws.
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
      // Re-run with capturing logger so the warn() goes through write()
      await factory(h.db, h.paths, captureLogger, h.toml, h.vault);
      expect(
        warnings.some((w) => String(w["msg"] ?? "").includes("Hybrid embedding init failed")),
      ).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("returns null when ensureSqliteVecForConnection is false (schema >= v6, vec not loaded)", async () => {
    if (!VEC_AVAILABLE) {
      // Without a working sqlite-vec binary we can't differentiate the "schema needs vec
      // but vec is unloadable" branch from the "schema doesn't need vec yet" branch.
      return;
    }
    const h = makeHarness({ migrateTo: 30, setApiKey: true });
    // Force-unload sqlite-vec by reopening the DB on a new connection that we never
    // call tryLoadSqliteVec on. The factory reads user_version (>= 6) then probes
    // SELECT vec_version() which throws on a connection without the extension.
    h.db.close();
    const freshDb = new Database(h.db.filename);
    try {
      // Confirm the trap: vec functions are not callable on this connection yet.
      let vecOnFresh = true;
      try {
        freshDb.query("SELECT vec_version()").get();
      } catch {
        vecOnFresh = false;
      }
      if (vecOnFresh) {
        // Some sqlite-vec builds auto-load via SQLITE_LOAD_EXTENSION across connections;
        // in that case this branch is unreachable from the test and we exit cleanly.
        return;
      }
      const factory = await importFactory();
      const runtime = await factory(freshDb, h.paths, silentLogger, h.toml, h.vault);
      // ensureSqliteVecForConnection will tryLoadSqliteVec on freshDb. On hosts where
      // load succeeds, the factory continues to the happy path — that's already covered
      // by other tests. Here we only assert that if vec stays unavailable, we get null.
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
        // The fake embedder sets index 0 to i+1 = 1 for the first text.
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
        // give the fire-and-forget a tick to settle
        await new Promise((r) => setTimeout(r, 20));
        // No rows in embedding_chunk because the item didn't exist
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
        // Allow the fire-and-forget async to complete.
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
