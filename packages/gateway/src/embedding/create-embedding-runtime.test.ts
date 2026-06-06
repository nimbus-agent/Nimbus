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
import { createEmbeddingRuntime } from "./create-embedding-runtime.ts";

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
