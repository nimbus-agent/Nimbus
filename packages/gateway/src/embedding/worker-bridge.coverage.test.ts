/**
 * Paths of the embedding worker bridge that `worker-bridge.test.ts` leaves unexercised: the
 * `NIMBUS_EMBEDDING_INIT_TIMEOUT_MS` override (driven on a fake clock, so the 600 s default is
 * reachable without waiting for it), a message origin accepted because this realm has none of its
 * own, an `ok` result carrying no vector, and the two `postMessage` failures — the embed request
 * itself and the best-effort cancel after a query timeout.
 */
import { afterAll, afterEach, beforeEach, describe, expect, jest, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino, { type Logger } from "pino";

import { type EmbeddingTimeoutError, isEmbeddingTimeoutError } from "./embedding-readiness.ts";
import type { EmbeddingRuntime } from "./embedding-runtime.ts";
import { tryCreateEmbeddingWorkerBridge } from "./worker-bridge.ts";

// The worker is faked; nothing is written under this directory. Removed after the file so a run
// leaves no empty directory behind in the OS temp dir.
const DATA_DIR = mkdtempSync(join(tmpdir(), "nimbus-worker-bridge-cov-"));
afterAll(() => {
  rmSync(DATA_DIR, { recursive: true, force: true });
});
const INIT_KEY = "NIMBUS_EMBEDDING_INIT_TIMEOUT_MS";
const QUERY_KEY = "NIMBUS_EMBEDDING_QUERY_TIMEOUT_MS";
const DEFAULT_INIT_TIMEOUT_MS = 600_000;

type Posted = { readonly type: string; readonly [key: string]: unknown };

interface FakeWorker {
  /** Delivers one message to the bridge as if the worker posted it. */
  fire(data: unknown, origin?: string): void;
  readonly posted: Posted[];
}

let workers: FakeWorker[] = [];
const originalWorker = (globalThis as { Worker?: unknown }).Worker;
const savedEnv = { init: process.env[INIT_KEY], query: process.env[QUERY_KEY] };

/** Installs a fake `Worker` whose `postMessage` throws for any message type in `refuse`. */
function installFakeWorker(refuse: ReadonlySet<string> = new Set()): void {
  class Fake {
    onmessage: ((ev: MessageEvent) => void) | null = null;
    onerror: ((ev: ErrorEvent) => void) | null = null;
    readonly posted: Posted[] = [];
    constructor(_path: string) {
      workers.push({
        fire: (data, origin = "") => this.onmessage?.({ data, origin } as MessageEvent),
        posted: this.posted,
      });
    }
    postMessage(msg: Posted): void {
      if (refuse.has(msg.type)) throw new Error(`worker refused ${msg.type}`);
      this.posted.push(msg);
    }
    terminate(): void {}
  }
  (globalThis as { Worker?: unknown }).Worker = Fake;
}

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
}

// Bun 1.3 never fires a test's timeout while the event loop is otherwise idle (fake timers do not
// count), so a regression leaving an awaited query pending would hang the WHOLE run instead of
// failing one test. A real no-op interval, created before any test fakes the clock, keeps the loop
// alive so the per-test timeout can fire.
let keepAlive: ReturnType<typeof setInterval> | undefined;

beforeEach(() => {
  keepAlive = setInterval(() => {}, 1_000);
  workers = [];
  Reflect.deleteProperty(process.env, INIT_KEY);
  Reflect.deleteProperty(process.env, QUERY_KEY);
});

afterEach(() => {
  jest.useRealTimers();
  clearInterval(keepAlive);
  if (originalWorker === undefined) Reflect.deleteProperty(globalThis, "Worker");
  else (globalThis as { Worker?: unknown }).Worker = originalWorker;
  restoreEnv(INIT_KEY, savedEnv.init);
  restoreEnv(QUERY_KEY, savedEnv.query);
});

type LogLine = { level: number; msg: string; err?: { message?: string } };

/** A real pino logger writing into an array, so a test can read exactly what was logged. */
function capturingLogger(): { logger: Logger; lines: LogLine[] } {
  const lines: LogLine[] = [];
  const logger = pino(
    { level: "info" },
    {
      write: (s: string): void => {
        lines.push(JSON.parse(s) as LogLine);
      },
    },
  );
  return { logger, lines };
}

function makeBridge(logger: Logger): { bridge: EmbeddingRuntime; worker: FakeWorker } {
  const bridge = tryCreateEmbeddingWorkerBridge(
    ":memory:",
    DATA_DIR,
    { chunkTokens: 256, chunkOverlapTokens: 32, backfillBatchSize: 8, pauseOnBattery: false },
    logger,
  );
  const worker = workers.at(-1);
  if (bridge === null || worker === undefined)
    throw new Error("expected a bridge on a fake worker");
  return { bridge, worker };
}

/** Lets the promise chains that hang off a fired timer (race → catch → markUnavailable) run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

describe("init timeout (fake clock)", () => {
  test("a configured budget ends warming exactly when it elapses", async () => {
    process.env[INIT_KEY] = "250";
    jest.useFakeTimers();
    installFakeWorker();
    const { logger, lines } = capturingLogger();
    const { bridge } = makeBridge(logger);
    try {
      jest.advanceTimersByTime(249);
      await settle();
      expect(bridge.getReadiness().state).toBe("warming");

      jest.advanceTimersByTime(1);
      await settle();
      const r = bridge.getReadiness();
      expect(r.state).toBe("unavailable");
      expect(r.reason).toBe("embedding worker init timed out after 250ms");
      expect(lines.map((l) => l.msg)).toEqual([
        "embedding worker failed to initialize; semantic search disabled until the next gateway restart",
      ]);
      expect(lines[0]?.err?.message).toBe("embedding worker init timed out after 250ms");
    } finally {
      bridge.terminate();
    }
  });

  test.each([
    ["an empty value", ""],
    ["a non-number", "soon"],
    ["zero", "0"],
    ["a negative number", "-5"],
  ])("%s falls back to the 600 s default", async (_label, raw) => {
    process.env[INIT_KEY] = raw;
    jest.useFakeTimers();
    installFakeWorker();
    const { logger } = capturingLogger();
    const { bridge } = makeBridge(logger);
    try {
      jest.advanceTimersByTime(DEFAULT_INIT_TIMEOUT_MS - 1);
      await settle();
      expect(bridge.getReadiness().state).toBe("warming");
      jest.advanceTimersByTime(1);
      await settle();
      expect(bridge.getReadiness().reason).toBe(
        `embedding worker init timed out after ${String(DEFAULT_INIT_TIMEOUT_MS)}ms`,
      );
    } finally {
      bridge.terminate();
    }
  });

  test("a worker that becomes ready in time logs readiness, and the budget lapsing later is moot", async () => {
    process.env[INIT_KEY] = "100";
    jest.useFakeTimers();
    installFakeWorker();
    const { logger, lines } = capturingLogger();
    const { bridge, worker } = makeBridge(logger);
    try {
      worker.fire({ type: "ready" });
      await settle();
      expect(lines.map((l) => l.msg)).toEqual([
        "embedding worker initialized; semantic search is now active",
      ]);
      jest.advanceTimersByTime(100);
      await settle();
      expect(bridge.getReadiness()).toMatchObject({ state: "ready", reason: null });
      expect(lines).toHaveLength(1);
    } finally {
      bridge.terminate();
    }
  });
});

describe("message origin", () => {
  const g = globalThis as typeof globalThis & { origin?: unknown };

  function withRealmOrigin(value: unknown, body: () => void): void {
    const had = Object.hasOwn(g, "origin");
    const before = g.origin;
    Object.defineProperty(g, "origin", { value, configurable: true, writable: true });
    try {
      body();
    } finally {
      if (had)
        Object.defineProperty(g, "origin", { value: before, configurable: true, writable: true });
      else Reflect.deleteProperty(g, "origin");
    }
  }

  test.each([
    ["has no origin at all", undefined],
    ["has an empty origin", ""],
  ])("a named origin is accepted when this realm %s", (_label, realmOrigin) => {
    installFakeWorker();
    const { logger } = capturingLogger();
    withRealmOrigin(realmOrigin, () => {
      const { bridge, worker } = makeBridge(logger);
      try {
        expect(bridge.getReadiness().state).toBe("warming");
        worker.fire({ type: "ready" }, "blob:nimbus-embedding-worker");
        expect(bridge.getReadiness().state).toBe("ready");
      } finally {
        bridge.terminate();
      }
    });
  });

  test("control: a realm WITH an origin drops a message from a different one", () => {
    installFakeWorker();
    const { logger } = capturingLogger();
    withRealmOrigin("https://nimbus.test", () => {
      const { bridge, worker } = makeBridge(logger);
      try {
        worker.fire({ type: "ready" }, "blob:nimbus-embedding-worker");
        expect(bridge.getReadiness().state).toBe("warming");
      } finally {
        bridge.terminate();
      }
    });
  });
});

describe("embedQuery edges", () => {
  test.each([
    ["an empty vector list", []],
    ["a first row that is not an array", ["0.1,0.2"]],
  ])("an ok result with %s resolves null", async (_label, vectors) => {
    installFakeWorker();
    const { logger } = capturingLogger();
    const { bridge, worker } = makeBridge(logger);
    try {
      worker.fire({ type: "ready" });
      const pending = bridge.embedQuery("hello");
      const sent = worker.posted.find((m) => m.type === "embed_texts");
      expect(typeof sent?.["id"]).toBe("string");
      worker.fire({ type: "embed_texts_result", id: sent?.["id"], ok: true, vectors });
      expect(await pending).toBeNull();
    } finally {
      bridge.terminate();
    }
  });

  test("a worker that cannot accept the request resolves null and logs the failure", async () => {
    installFakeWorker(new Set(["embed_texts"]));
    const { logger, lines } = capturingLogger();
    const { bridge, worker } = makeBridge(logger);
    try {
      worker.fire({ type: "ready" });
      await settle();
      lines.length = 0;
      expect(await bridge.embedQuery("hello")).toBeNull();
      expect(lines.map((l) => l.msg)).toEqual(["embedQuery failed"]);
      expect(lines[0]?.err?.message).toBe("worker refused embed_texts");
      // A ready worker that merely refused one message stays ready.
      expect(bridge.getReadiness().state).toBe("ready");
    } finally {
      bridge.terminate();
    }
  });

  test("a cancel that cannot be posted is logged, and the query still rejects with the typed timeout", async () => {
    process.env[QUERY_KEY] = "50";
    jest.useFakeTimers();
    installFakeWorker(new Set(["cancel_embed"]));
    const { logger, lines } = capturingLogger();
    const { bridge, worker } = makeBridge(logger);
    try {
      worker.fire({ type: "ready" });
      await settle();
      lines.length = 0;
      // Settled into a variable rather than awaited: with the clock faked, a query that never
      // settles would never let the per-test timeout fire either, and the whole run would hang.
      let result: { resolved: Float32Array | null } | { rejected: unknown } | undefined;
      void bridge.embedQuery("starved").then(
        (v) => {
          result = { resolved: v };
        },
        (e: unknown) => {
          result = { rejected: e };
        },
      );
      expect(worker.posted.filter((m) => m.type === "embed_texts")).toHaveLength(1);
      jest.advanceTimersByTime(50);
      await settle();
      expect(result).toBeDefined();
      expect(result).not.toHaveProperty("resolved");
      const err = (result as { rejected: unknown }).rejected;
      expect(isEmbeddingTimeoutError(err)).toBe(true);
      expect((err as EmbeddingTimeoutError).timeoutMs).toBe(50);
      expect(lines.map((l) => l.msg)).toEqual(["could not cancel embed"]);
      expect(lines[0]?.err?.message).toBe("worker refused cancel_embed");
      // The refused cancel was never recorded as sent.
      expect(worker.posted.filter((m) => m.type === "cancel_embed")).toHaveLength(0);
    } finally {
      bridge.terminate();
    }
  });
});
