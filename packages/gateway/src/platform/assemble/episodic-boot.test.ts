import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EmbeddingRuntime } from "../../embedding/embedding-runtime.ts";
import type { LlmRouter } from "../../llm/router.ts";
import { migratedDb } from "../../memory/episodic.test-helpers.ts";
import { SessionMemoryStore } from "../../memory/session-memory-store.ts";
import type { PlatformPaths } from "../paths.ts";
import { attachEpisodicMemory, EPISODIC_PRUNE_MS, EPISODIC_SWEEP_MS } from "./episodic-boot.ts";

type Timer = { cb: () => void; ms: number };

describe("attachEpisodicMemory", () => {
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  let timers: Timer[];
  let cleared: number;
  let configDir: string;

  beforeEach(() => {
    timers = [];
    cleared = 0;
    configDir = mkdtempSync(join(tmpdir(), "nimbus-episodic-boot-"));
    mkdirSync(configDir, { recursive: true });
    globalThis.setInterval = ((cb: () => void, ms: number) => {
      timers.push({ cb, ms });
      return realSetInterval(() => {}, 3_600_000);
    }) as typeof setInterval;
    globalThis.clearInterval = ((h: Parameters<typeof clearInterval>[0]) => {
      cleared += 1;
      realClearInterval(h);
    }) as typeof clearInterval;
  });
  afterEach(() => {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    rmSync(configDir, { recursive: true, force: true });
  });

  const pathsOf = (demo?: boolean): PlatformPaths =>
    ({
      configDir,
      dataDir: configDir,
      logDir: configDir,
      socketPath: join(configDir, "s"),
      extensionsDir: configDir,
      tempDir: configDir,
      sandboxDir: configDir,
      ...(demo === true ? { demo: true } : {}),
    }) as PlatformPaths;

  const llmRegistry = { llmRouter: {} as LlmRouter };
  const rt = (vec: Float32Array | null) =>
    ({ getEmbeddingDims: () => 384, embedQuery: async () => vec }) as unknown as EmbeddingRuntime;

  function storeOf() {
    const db = migratedDb();
    return { db, store: new SessionMemoryStore({ db, dims: 384, embedText: async () => null }) };
  }

  test("attaches to the session store with a sweep timer and a daily prune, both stopped on shutdown", () => {
    const { db, store } = storeOf();
    const sidecarStops: Array<() => void> = [];
    const m = attachEpisodicMemory(store, {
      db,
      rt: rt(null),
      llmRegistry,
      paths: pathsOf(),
      sidecarStops,
    });
    expect(m).toBeDefined();
    expect(store.episodic).toBe(m);
    expect(timers.map((t) => t.ms)).toEqual([EPISODIC_SWEEP_MS, EPISODIC_PRUNE_MS]);
    for (const t of timers) t.cb();
    for (const stop of sidecarStops) stop();
    expect(cleared).toBe(2);
  });

  test("a demo gateway, a missing store and an old schema attach nothing (I41)", () => {
    const { db, store } = storeOf();
    expect(
      attachEpisodicMemory(store, {
        db,
        rt: null,
        llmRegistry,
        paths: pathsOf(true),
        sidecarStops: [],
      }),
    ).toBeUndefined();
    expect(store.episodic).toBeUndefined();
    expect(
      attachEpisodicMemory(undefined, {
        db,
        rt: null,
        llmRegistry,
        paths: pathsOf(),
        sidecarStops: [],
      }),
    ).toBeUndefined();
    db.run("PRAGMA user_version = 106");
    expect(
      attachEpisodicMemory(store, {
        db,
        rt: null,
        llmRegistry,
        paths: pathsOf(),
        sidecarStops: [],
      }),
    ).toBeUndefined();
    expect(timers).toHaveLength(0);
  });

  test("with no embedding runtime the memory still attaches, and nothing is embedded", async () => {
    const { db, store } = storeOf();
    writeFileSync(join(configDir, "nimbus.toml"), "[memory]\nepisodic = true\n");
    const m = attachEpisodicMemory(store, {
      db,
      rt: null,
      llmRegistry,
      paths: pathsOf(),
      sidecarStops: [],
    });
    expect(m).toBeDefined();
    expect(await m?.recallBlock("anything", true)).toBeUndefined();
  });
});
