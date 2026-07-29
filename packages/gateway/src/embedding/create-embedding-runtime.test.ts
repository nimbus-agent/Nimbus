import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { openSeededDbFile } from "../../test/helpers/migrated-db-seed.ts";
import type { NimbusEmbeddingToml } from "../config/nimbus-toml.ts";
import { processEnvDelete, processEnvSet } from "../platform/env-access.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { MockVault } from "../vault/mock.ts";
import {
  createEmbeddingRuntime,
  createEmbeddingRuntimeNonBlocking,
  type EmbeddingRuntimeOverrides,
} from "./create-embedding-runtime.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import type { Embedder } from "./types.ts";

const silentLogger = pino({ level: "silent" });

function defaultToml(provider: NimbusEmbeddingToml["provider"]): NimbusEmbeddingToml {
  return {
    enabled: true,
    provider,
    model: "all-MiniLM-L6-v2",
    chunkTokens: 256,
    chunkOverlapTokens: 32,
    backfillBatchSize: 50,
    pauseOnBattery: true,
  };
}

function makePaths(dir: string): PlatformPaths {
  return {
    configDir: dir,
    dataDir: dir,
    logDir: join(dir, "logs"),
    socketPath: join(dir, "gw.sock"),
    extensionsDir: join(dir, "ext"),
    tempDir: dir,
  };
}

type Harness = {
  db: Database;
  paths: PlatformPaths;
  vault: MockVault;
  cleanup: () => void;
};

function makeHarness(opts: { migrateTo: number; setOpenaiKey?: boolean }): Harness {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-cer-"));
  const db = openSeededDbFile(join(dir, "nimbus.db"), opts.migrateTo);
  const vault = new MockVault();
  if (opts.setOpenaiKey === true) {
    void vault.set("openai.api_key", "fixture-present");
  }
  return {
    db,
    paths: makePaths(dir),
    vault,
    cleanup: () => {
      db.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* Windows handle race; harmless */
      }
    },
  };
}

describe("createEmbeddingRuntime — early-exit branches", () => {
  let originalSkip: string | undefined;
  let originalOpenaiEnv: string | undefined;

  beforeEach(() => {
    originalSkip = process.env["NIMBUS_SKIP_EMBEDDING_RUNTIME"];
    originalOpenaiEnv = process.env["OPENAI_API_KEY"];
    processEnvDelete("NIMBUS_SKIP_EMBEDDING_RUNTIME");
    processEnvDelete("OPENAI_API_KEY");
  });

  afterEach(() => {
    processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", originalSkip);
    processEnvSet("OPENAI_API_KEY", originalOpenaiEnv);
  });

  test("NIMBUS_SKIP_EMBEDDING_RUNTIME=1 returns null", async () => {
    processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", "1");
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("local"),
        true,
        h.vault,
      );
      expect(rt).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("envAllowsEmbeddings=false returns null", async () => {
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("local"),
        false,
        h.vault,
      );
      expect(rt).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("tomlEmbedding.enabled=false returns null", async () => {
    const h = makeHarness({ migrateTo: 30 });
    try {
      const toml = { ...defaultToml("local"), enabled: false };
      const rt = await createEmbeddingRuntime(h.db, h.paths, silentLogger, toml, true, h.vault);
      expect(rt).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("user_version < 6 returns null (DB not yet migrated to embedding schema)", async () => {
    const h = makeHarness({ migrateTo: 5 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("local"),
        true,
        h.vault,
      );
      expect(rt).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe("createEmbeddingRuntime — provider 'openai'", () => {
  let originalOpenaiEnv: string | undefined;

  beforeEach(() => {
    originalOpenaiEnv = process.env["OPENAI_API_KEY"];
    processEnvDelete("OPENAI_API_KEY");
    processEnvDelete("NIMBUS_SKIP_EMBEDDING_RUNTIME");
  });

  afterEach(() => {
    processEnvSet("OPENAI_API_KEY", originalOpenaiEnv);
  });

  test("warns and returns null when no api key in env or vault", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const captureLogger = pino(
      { level: "warn" },
      {
        write(chunk: string) {
          try {
            warnings.push(JSON.parse(chunk));
          } catch {
            /* ignore */
          }
        },
      },
    );
    const h = makeHarness({ migrateTo: 30, setOpenaiKey: false });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        captureLogger,
        defaultToml("openai"),
        true,
        h.vault,
      );
      expect(rt).toBeNull();
      expect(
        warnings.some(
          (w) =>
            typeof w["msg"] === "string" &&
            w["msg"].includes("OpenAI embedding: set OPENAI_API_KEY"),
        ),
      ).toBe(true);
    } finally {
      h.cleanup();
    }
  });

  test("builds a runtime when OPENAI_API_KEY env is set", async () => {
    processEnvSet("OPENAI_API_KEY", "env-present");
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("openai"),
        true,
        h.vault,
      );
      expect(rt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("builds a runtime when openai.api_key vault is set", async () => {
    const h = makeHarness({ migrateTo: 30, setOpenaiKey: true });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("openai"),
        true,
        h.vault,
      );
      expect(rt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("overrides MiniLM/Xenova model strings to text-embedding-3-small", async () => {
    const h = makeHarness({ migrateTo: 30, setOpenaiKey: true });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("openai"),
        true,
        h.vault,
      );
      expect(rt?.getEmbeddingModel()).toBe("openai:text-embedding-3-small");
    } finally {
      h.cleanup();
    }
  });

  test("Xenova-tagged model also triggers the override", async () => {
    const h = makeHarness({ migrateTo: 30, setOpenaiKey: true });
    try {
      const toml = { ...defaultToml("openai"), model: "Xenova/all-MiniLM-L6-v2" };
      const rt = await createEmbeddingRuntime(h.db, h.paths, silentLogger, toml, true, h.vault);
      expect(rt?.getEmbeddingModel()).toBe("openai:text-embedding-3-small");
    } finally {
      h.cleanup();
    }
  });

  test("trims whitespace from a vault key (vault stores '  fixture  ')", async () => {
    const h = makeHarness({ migrateTo: 30, setOpenaiKey: false });
    void h.vault.set("openai.api_key", "  fixture-present  ");
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("openai"),
        true,
        h.vault,
      );
      expect(rt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("whitespace-only vault key behaves like missing", async () => {
    const h = makeHarness({ migrateTo: 30, setOpenaiKey: false });
    void h.vault.set("openai.api_key", "   ");
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("openai"),
        true,
        h.vault,
      );
      expect(rt).toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

describe("createEmbeddingRuntime — provider 'hybrid' fallback + provider 'local'", () => {
  let originalOpenaiEnv: string | undefined;
  let originalSkip: string | undefined;

  beforeEach(() => {
    originalOpenaiEnv = process.env["OPENAI_API_KEY"];
    originalSkip = process.env["NIMBUS_SKIP_EMBEDDING_RUNTIME"];
    processEnvDelete("OPENAI_API_KEY");
    processEnvDelete("NIMBUS_SKIP_EMBEDDING_RUNTIME");
  });

  afterEach(() => {
    processEnvSet("OPENAI_API_KEY", originalOpenaiEnv);
    processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", originalSkip);
  });

  test("provider='hybrid' with no OpenAI key falls through to a local runtime (line 97 + fallthrough at 106-111)", async () => {
    const h = makeHarness({ migrateTo: 30, setOpenaiKey: false });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("hybrid"),
        true,
        h.vault,
      );
      expect(rt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("provider='local' builds a runtime via worker bridge or lazy fallback (lines 106-111)", async () => {
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("local"),
        true,
        h.vault,
      );
      expect(rt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers for DI-seam tests
// ---------------------------------------------------------------------------

function makeFakeRuntime(): EmbeddingRuntime {
  return {
    scheduleItemEmbedding(): void {
      /* no-op */
    },
    async embedQuery(): Promise<Float32Array | null> {
      return null;
    },
    async embedQueryDual(): Promise<{
      vec384: Float32Array | null;
      vec1536: Float32Array | null;
      model384: string | null;
      model1536: string | null;
    }> {
      return { vec384: null, vec1536: null, model384: null, model1536: null };
    },
    getEmbeddingModel(): string {
      return "fake:model";
    },
    getEmbeddingDims(): number {
      return 384;
    },
    getReadiness() {
      return {
        state: "ready" as const,
        elapsedMs: 0,
        model: "fake:model",
        dims: 384,
        download: null,
        reason: null,
      };
    },
    getBackfillProgress(): { done: number; total: number } | null {
      return null;
    },
    startBackgroundJobs(): void {
      /* no-op */
    },
    terminate(): void {
      /* no-op */
    },
  };
}

function makeFakeEmbedder(): Embedder {
  return {
    model: "fake:embedder",
    dims: 384,
    async embed(texts: string[]): Promise<Float32Array[]> {
      return texts.map(() => new Float32Array(384));
    },
  };
}

// ---------------------------------------------------------------------------
// DI-seam: hybrid returns non-null (line 91 — return hybrid)
// ---------------------------------------------------------------------------

describe("createEmbeddingRuntime — hybrid returns non-null (DI seam)", () => {
  let originalSkip: string | undefined;
  let originalOpenaiEnv: string | undefined;

  beforeEach(() => {
    originalSkip = process.env["NIMBUS_SKIP_EMBEDDING_RUNTIME"];
    originalOpenaiEnv = process.env["OPENAI_API_KEY"];
    processEnvDelete("NIMBUS_SKIP_EMBEDDING_RUNTIME");
    processEnvDelete("OPENAI_API_KEY");
  });

  afterEach(() => {
    processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", originalSkip);
    processEnvSet("OPENAI_API_KEY", originalOpenaiEnv);
  });

  test("returns the hybrid runtime when routingRuntimeFactory succeeds (covers return hybrid branch)", async () => {
    const fakeRuntime = makeFakeRuntime();
    const overrides: EmbeddingRuntimeOverrides = {
      routingRuntimeFactory: async () => fakeRuntime,
    };
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("hybrid"),
        true,
        h.vault,
        overrides,
      );
      expect(rt).toBe(fakeRuntime);
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// DI-seam: worker bridge returns null → createLazyEmbeddingRuntime (line 103)
// ---------------------------------------------------------------------------

describe("createEmbeddingRuntime — worker bridge null → lazy fallback (DI seam)", () => {
  let originalSkip: string | undefined;
  let originalOpenaiEnv: string | undefined;

  beforeEach(() => {
    originalSkip = process.env["NIMBUS_SKIP_EMBEDDING_RUNTIME"];
    originalOpenaiEnv = process.env["OPENAI_API_KEY"];
    processEnvDelete("NIMBUS_SKIP_EMBEDDING_RUNTIME");
    processEnvDelete("OPENAI_API_KEY");
  });

  afterEach(() => {
    processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", originalSkip);
    processEnvSet("OPENAI_API_KEY", originalOpenaiEnv);
  });

  test("falls back to createLazyEmbeddingRuntime when worker bridge returns null (covers line 103)", async () => {
    const overrides: EmbeddingRuntimeOverrides = {
      workerBridgeFactory: () => null,
    };
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("local"),
        true,
        h.vault,
        overrides,
      );
      // The lazy runtime is returned even when worker fails
      expect(rt).not.toBeNull();
      // getEmbeddingModel returns the LOCAL_EMBEDDING_MODEL_ID placeholder before pipeline loads
      expect(typeof rt?.getEmbeddingModel()).toBe("string");
    } finally {
      h.cleanup();
    }
  });

  test("hybrid falls through to lazy when routing fails and worker bridge also fails", async () => {
    const overrides: EmbeddingRuntimeOverrides = {
      routingRuntimeFactory: async () => null,
      workerBridgeFactory: () => null,
    };
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("hybrid"),
        true,
        h.vault,
        overrides,
      );
      expect(rt).not.toBeNull();
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// DI-seam: openai embedder factory throws → catch block (lines 52-59)
// ---------------------------------------------------------------------------

describe("createEmbeddingRuntime — openai embedder factory throws (DI seam)", () => {
  let originalOpenaiEnv: string | undefined;

  beforeEach(() => {
    originalOpenaiEnv = process.env["OPENAI_API_KEY"];
    processEnvSet("OPENAI_API_KEY", "test-key-for-catch");
    processEnvDelete("NIMBUS_SKIP_EMBEDDING_RUNTIME");
  });

  afterEach(() => {
    processEnvSet("OPENAI_API_KEY", originalOpenaiEnv);
  });

  test("returns null and logs when openai embedder factory throws an Error (covers Error branch in catch)", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const captureLogger = pino(
      { level: "warn" },
      {
        write(chunk: string) {
          try {
            warnings.push(JSON.parse(chunk) as Record<string, unknown>);
          } catch {
            /* ignore */
          }
        },
      },
    );
    const overrides: EmbeddingRuntimeOverrides = {
      openaiEmbedderFactory: async () => {
        throw new Error("factory-error-test");
      },
    };
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        captureLogger,
        defaultToml("openai"),
        true,
        h.vault,
        overrides,
      );
      expect(rt).toBeNull();
      const found = warnings.find(
        (w) => typeof w["msg"] === "string" && w["msg"].includes("OpenAI embedder init failed"),
      );
      expect(found).not.toBeUndefined();
      expect(found?.["errName"]).toBe("Error");
      expect(found?.["errMessage"]).toBe("factory-error-test");
    } finally {
      h.cleanup();
    }
  });

  test("returns null and logs when openai embedder factory throws a non-Error value (covers non-Error ternary branch)", async () => {
    const warnings: Array<Record<string, unknown>> = [];
    const captureLogger = pino(
      { level: "warn" },
      {
        write(chunk: string) {
          try {
            warnings.push(JSON.parse(chunk) as Record<string, unknown>);
          } catch {
            /* ignore */
          }
        },
      },
    );
    const overrides: EmbeddingRuntimeOverrides = {
      openaiEmbedderFactory: async () => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error
        throw "plain-string-error";
      },
    };
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        captureLogger,
        defaultToml("openai"),
        true,
        h.vault,
        overrides,
      );
      expect(rt).toBeNull();
      const found = warnings.find(
        (w) => typeof w["msg"] === "string" && w["msg"].includes("OpenAI embedder init failed"),
      );
      expect(found).not.toBeUndefined();
      // Non-Error thrown: ternary else branch → "Error" and String(err)
      expect(found?.["errName"]).toBe("Error");
      expect(found?.["errMessage"]).toBe("plain-string-error");
    } finally {
      h.cleanup();
    }
  });

  test("openai embedder factory returns fake embedder — runtime is non-null", async () => {
    const fakeEmbedder = makeFakeEmbedder();
    const overrides: EmbeddingRuntimeOverrides = {
      openaiEmbedderFactory: async () => fakeEmbedder,
    };
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = await createEmbeddingRuntime(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("openai"),
        true,
        h.vault,
        overrides,
      );
      expect(rt).not.toBeNull();
      // The lazy runtime's model comes from the preloaded embedder
      expect(rt?.getEmbeddingModel()).toBe("fake:embedder");
    } finally {
      h.cleanup();
    }
  });

  test("empty model string triggers override to text-embedding-3-small (covers empty-model branch)", async () => {
    let capturedModel: string | undefined;
    const overrides: EmbeddingRuntimeOverrides = {
      openaiEmbedderFactory: async (opts) => {
        capturedModel = opts["model"];
        return makeFakeEmbedder();
      },
    };
    const h = makeHarness({ migrateTo: 30 });
    try {
      const toml = { ...defaultToml("openai"), model: "   " };
      await createEmbeddingRuntime(h.db, h.paths, silentLogger, toml, true, h.vault, overrides);
      expect(capturedModel).toBe("text-embedding-3-small");
    } finally {
      h.cleanup();
    }
  });
});

// ---------------------------------------------------------------------------
// #928 — bind-first: the factory the gateway boot path uses must not await a model fetch.
// ---------------------------------------------------------------------------

describe("createEmbeddingRuntimeNonBlocking", () => {
  test("returns a runtime SYNCHRONOUSLY even when the underlying init never settles", () => {
    const h = makeHarness({ migrateTo: 30 });
    try {
      let workerFactoryCalls = 0;
      const rt = createEmbeddingRuntimeNonBlocking(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("hybrid"),
        true,
        h.vault,
        {
          // Hybrid awaits the local model load; a never-settling routing factory reproduces
          // a cold MiniLM fetch exactly, without touching the network.
          routingRuntimeFactory: () => new Promise<EmbeddingRuntime | null>(() => {}),
          workerBridgeFactory: () => {
            workerFactoryCalls += 1;
            return null;
          },
        },
      );
      expect(rt).not.toBeNull();
      expect(rt?.getReadiness().state).toBe("warming");
      // Nothing downstream of the stalled hybrid init has run yet — proof the caller was
      // handed a runtime before construction finished.
      expect(workerFactoryCalls).toBe(0);
    } finally {
      h.cleanup();
    }
  });

  test("a warming runtime refuses to hand back a null vector", async () => {
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = createEmbeddingRuntimeNonBlocking(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("hybrid"),
        true,
        h.vault,
        { routingRuntimeFactory: () => new Promise<EmbeddingRuntime | null>(() => {}) },
      );
      expect(rt).not.toBeNull();
      await expect(rt?.embedQuery("anything")).rejects.toThrow(/warming up/);
    } finally {
      h.cleanup();
    }
  });

  test("a rejected model fetch degrades to `unavailable` — it never escapes to the caller", async () => {
    const h = makeHarness({ migrateTo: 30 });
    try {
      const rt = createEmbeddingRuntimeNonBlocking(
        h.db,
        h.paths,
        silentLogger,
        defaultToml("hybrid"),
        true,
        h.vault,
        {
          routingRuntimeFactory: () => Promise.reject(new Error("ENOTFOUND huggingface.co")),
          workerBridgeFactory: () => {
            throw new Error("ENOTFOUND huggingface.co");
          },
        },
      );
      expect(rt).not.toBeNull();
      await new Promise((r) => setTimeout(r, 10));
      const readiness = rt?.getReadiness();
      expect(readiness?.state).toBe("unavailable");
      expect(readiness?.reason).toContain("ENOTFOUND");
      expect(await rt?.embedQuery("q")).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("returns null for the cheap synchronous disable reasons (no runtime at all)", () => {
    const h = makeHarness({ migrateTo: 30 });
    try {
      const off = { ...defaultToml("local"), enabled: false };
      expect(
        createEmbeddingRuntimeNonBlocking(h.db, h.paths, silentLogger, off, true, h.vault),
      ).toBeNull();
      expect(
        createEmbeddingRuntimeNonBlocking(
          h.db,
          h.paths,
          silentLogger,
          defaultToml("local"),
          false,
          h.vault,
        ),
      ).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("returns null when the index schema predates semantic memory (uv < 6)", () => {
    const h = makeHarness({ migrateTo: 5 });
    try {
      expect(
        createEmbeddingRuntimeNonBlocking(
          h.db,
          h.paths,
          silentLogger,
          defaultToml("local"),
          true,
          h.vault,
        ),
      ).toBeNull();
    } finally {
      h.cleanup();
    }
  });

  test("NIMBUS_SKIP_EMBEDDING_RUNTIME=1 still means no runtime at all", () => {
    const h = makeHarness({ migrateTo: 30 });
    const prev = process.env["NIMBUS_SKIP_EMBEDDING_RUNTIME"];
    try {
      processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", "1");
      expect(
        createEmbeddingRuntimeNonBlocking(
          h.db,
          h.paths,
          silentLogger,
          defaultToml("local"),
          true,
          h.vault,
        ),
      ).toBeNull();
    } finally {
      if (prev === undefined) {
        processEnvDelete("NIMBUS_SKIP_EMBEDDING_RUNTIME");
      } else {
        processEnvSet("NIMBUS_SKIP_EMBEDDING_RUNTIME", prev);
      }
      h.cleanup();
    }
  });
});
