/**
 * Coverage for flush-scheduler.ts — timer-driven telemetry flush.
 *
 * Timer strategy: stub `globalThis.setInterval` / `globalThis.clearInterval`
 * so tests can capture the registered callback and invoke it synchronously.
 * This avoids real wall-clock waits and exercises all branches deterministically.
 *
 * Fetch strategy: replace `globalThis.fetch` with a counting closure that
 * records call count and last request body, then restore in afterEach.
 *
 * Filesystem: real temp dirs + real TOML files so `readFileSync` / `existsSync`
 * calls behave naturally; the DB is migrated to V30 so `collectIndexMetrics`
 * finds all expected tables (item, embedding_chunk, sync_state).
 */

import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { startTelemetryFlushScheduler } from "./flush-scheduler.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type TickFn = () => void;

/** Replaces globalThis.setInterval with a stub that captures the callback. */
function installFakeTimers(): {
  capturedTick: () => TickFn | undefined;
  capturedIntervalMs: () => number | undefined;
  clearIntervalMock: ReturnType<typeof mock>;
  restore: () => void;
} {
  let capturedCb: TickFn | undefined;
  let capturedMs: number | undefined;

  const origSetInterval = globalThis.setInterval;
  const origClearInterval = globalThis.clearInterval;

  const clearIntervalMock = mock((_handle: unknown) => {});

  // biome-ignore lint/suspicious/noExplicitAny: stubbing a global
  (globalThis as any).setInterval = (cb: TickFn, ms: number) => {
    capturedCb = cb;
    capturedMs = ms;
    return 999_999; // fake handle id
  };
  // biome-ignore lint/suspicious/noExplicitAny: stubbing a global
  (globalThis as any).clearInterval = clearIntervalMock;

  return {
    capturedTick: () => capturedCb,
    capturedIntervalMs: () => capturedMs,
    clearIntervalMock,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restoring a global
      (globalThis as any).setInterval = origSetInterval;
      // biome-ignore lint/suspicious/noExplicitAny: restoring a global
      (globalThis as any).clearInterval = origClearInterval;
    },
  };
}

/** Replaces globalThis.fetch with a counting spy. */
function installFetchSpy(opts: { ok: boolean; status?: number; throws?: string }): {
  callCount: () => number;
  lastBody: () => unknown;
  restore: () => void;
} {
  const origFetch = globalThis.fetch;
  let count = 0;
  let lastBody: unknown;

  // biome-ignore lint/suspicious/noExplicitAny: stubbing a global
  (globalThis as any).fetch = async (_url: string, init?: RequestInit) => {
    count += 1;
    if (init?.body !== undefined) {
      try {
        lastBody = JSON.parse(init.body as string);
      } catch {
        lastBody = init.body;
      }
    }
    if (opts.throws !== undefined) {
      throw new Error(opts.throws);
    }
    return { ok: opts.ok, status: opts.status ?? (opts.ok ? 200 : 500) };
  };

  return {
    callCount: () => count,
    lastBody: () => lastBody,
    restore: () => {
      // biome-ignore lint/suspicious/noExplicitAny: restoring a global
      (globalThis as any).fetch = origFetch;
    },
  };
}

type Harness = {
  db: Database;
  dataDir: string;
  tomlPath: string;
  cleanup: () => void;
};

/**
 * Creates a temp dir with a TOML file and a migrated DB.
 * The DB is migrated to V30 so that `collectIndexMetrics` finds all expected
 * tables (item, embedding_chunk, sync_state) without throwing.
 */
function makeHarness(tomlContent?: string): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "nimbus-flush-sched-"));
  const tomlPath = join(dataDir, "nimbus.toml");
  const content =
    tomlContent ??
    `[telemetry]\nenabled = true\nflush_interval_seconds = 60\nendpoint = "https://example.com/ingest"\n`;
  writeFileSync(tomlPath, content, "utf8");
  const db = new Database(join(dataDir, "nimbus.db"));
  runIndexedSchemaMigrations(db, 30);
  return {
    db,
    dataDir,
    tomlPath,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {
        /* Windows file-handle race */
      }
    },
  };
}

const silentLogger = pino({ level: "silent" });

/**
 * Yield for `ms` milliseconds using the *real* setTimeout, bypassing the stub.
 * We capture globalThis.setTimeout before the test suite modifies setInterval —
 * since we only stub setInterval, globalThis.setTimeout is the real one at call time.
 */
function yieldMs(ms = 80): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe("startTelemetryFlushScheduler — initial tick on start", () => {
  let fakeTimers: ReturnType<typeof installFakeTimers>;
  let fetchSpy: ReturnType<typeof installFetchSpy>;
  let harness: Harness;

  beforeEach(() => {
    fakeTimers = installFakeTimers();
    fetchSpy = installFetchSpy({ ok: true });
    harness = makeHarness();
  });

  afterEach(() => {
    fakeTimers.restore();
    fetchSpy.restore();
    harness.cleanup();
  });

  it("calls fetch immediately on start (initial tick fires synchronously)", async () => {
    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    // Yield so the fire-and-forget fetch promise chain settles.
    await yieldMs(80);

    expect(fetchSpy.callCount()).toBeGreaterThan(0);
    handle.stop();
  });

  it("registers an interval with the configured flush interval ms", () => {
    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    const ms = fakeTimers.capturedIntervalMs();
    // TOML says 60 s; source clamps to [60_000, 86_400_000].
    expect(ms).toBe(60_000);
    handle.stop();
  });
});

describe("startTelemetryFlushScheduler — timer-driven subsequent tick (re-arm)", () => {
  let fakeTimers: ReturnType<typeof installFakeTimers>;
  let fetchSpy: ReturnType<typeof installFetchSpy>;
  let harness: Harness;

  beforeEach(() => {
    fakeTimers = installFakeTimers();
    fetchSpy = installFetchSpy({ ok: true });
    harness = makeHarness();
  });

  afterEach(() => {
    fakeTimers.restore();
    fetchSpy.restore();
    harness.cleanup();
  });

  it("invokes fetch again when the captured interval callback fires", async () => {
    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    await yieldMs(80);
    const callsAfterStart = fetchSpy.callCount();
    expect(callsAfterStart).toBeGreaterThan(0);

    // Manually fire the interval callback (simulates the timer firing a second time).
    const tick = fakeTimers.capturedTick();
    expect(tick).toBeDefined();
    tick?.();

    await yieldMs(80);

    expect(fetchSpy.callCount()).toBeGreaterThan(callsAfterStart);
    handle.stop();
  });
});

describe("startTelemetryFlushScheduler — disabled telemetry marker file", () => {
  let fakeTimers: ReturnType<typeof installFakeTimers>;
  let fetchSpy: ReturnType<typeof installFetchSpy>;
  let harness: Harness;

  beforeEach(() => {
    fakeTimers = installFakeTimers();
    fetchSpy = installFetchSpy({ ok: true });
    harness = makeHarness();
  });

  afterEach(() => {
    fakeTimers.restore();
    fetchSpy.restore();
    harness.cleanup();
  });

  it("skips fetch when .nimbus-telemetry-disabled marker file exists", async () => {
    // Create the disabled marker before the scheduler starts.
    writeFileSync(join(harness.dataDir, ".nimbus-telemetry-disabled"), "", "utf8");

    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    await yieldMs(80);

    expect(fetchSpy.callCount()).toBe(0);
    handle.stop();
  });
});

describe("startTelemetryFlushScheduler — cfg.enabled = false", () => {
  let fakeTimers: ReturnType<typeof installFakeTimers>;
  let fetchSpy: ReturnType<typeof installFetchSpy>;
  let harness: Harness;

  beforeEach(() => {
    fakeTimers = installFakeTimers();
    fetchSpy = installFetchSpy({ ok: true });
    // TOML with enabled = false
    harness = makeHarness(
      `[telemetry]\nenabled = false\nflush_interval_seconds = 60\nendpoint = "https://example.com/ingest"\n`,
    );
  });

  afterEach(() => {
    fakeTimers.restore();
    fetchSpy.restore();
    harness.cleanup();
  });

  it("skips fetch when telemetry enabled = false in TOML", async () => {
    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    await yieldMs(80);

    expect(fetchSpy.callCount()).toBe(0);
    handle.stop();
  });
});

describe("startTelemetryFlushScheduler — stop / shutdown", () => {
  let fakeTimers: ReturnType<typeof installFakeTimers>;
  let fetchSpy: ReturnType<typeof installFetchSpy>;
  let harness: Harness;

  beforeEach(() => {
    fakeTimers = installFakeTimers();
    fetchSpy = installFetchSpy({ ok: true });
    harness = makeHarness();
  });

  afterEach(() => {
    fakeTimers.restore();
    fetchSpy.restore();
    harness.cleanup();
  });

  it("stop() calls clearInterval and subsequent tick() calls are no-ops", async () => {
    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    await yieldMs(80);
    handle.stop();

    // clearInterval must have been called with the fake handle id.
    expect(fakeTimers.clearIntervalMock.mock.calls.length).toBeGreaterThan(0);

    // Subsequent interval ticks must be no-ops (stopped = true guard).
    const callsBefore = fetchSpy.callCount();
    const tick = fakeTimers.capturedTick();
    tick?.();
    await yieldMs(80);
    expect(fetchSpy.callCount()).toBe(callsBefore);
  });

  it("stop() is idempotent — calling twice does not throw", async () => {
    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });
    await yieldMs(30);
    expect(() => {
      handle.stop();
      handle.stop();
    }).not.toThrow();
  });
});

describe("startTelemetryFlushScheduler — HTTP error response", () => {
  let fakeTimers: ReturnType<typeof installFakeTimers>;
  let fetchSpy: ReturnType<typeof installFetchSpy>;
  let harness: Harness;
  const warnMessages: string[] = [];

  beforeEach(() => {
    warnMessages.length = 0;
    fakeTimers = installFakeTimers();
    fetchSpy = installFetchSpy({ ok: false, status: 500 });
    harness = makeHarness();
  });

  afterEach(() => {
    fakeTimers.restore();
    fetchSpy.restore();
    harness.cleanup();
  });

  it("logs a warn when the telemetry endpoint returns a non-OK status", async () => {
    const warnLogger = pino(
      { level: "warn" },
      {
        write(chunk: string) {
          try {
            const j = JSON.parse(chunk) as { msg?: string };
            if (typeof j.msg === "string") {
              warnMessages.push(j.msg);
            }
          } catch {
            /* skip non-JSON */
          }
        },
      },
    );

    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: warnLogger,
    });

    // Give enough time for the fire-and-forget .then() chain to complete.
    await yieldMs(150);
    handle.stop();

    expect(warnMessages.some((m) => m.includes("telemetry POST failed"))).toBe(true);
  });
});

describe("startTelemetryFlushScheduler — fetch throws network error", () => {
  let fakeTimers: ReturnType<typeof installFakeTimers>;
  let fetchSpy: ReturnType<typeof installFetchSpy>;
  let harness: Harness;
  const warnMessages: string[] = [];

  beforeEach(() => {
    warnMessages.length = 0;
    fakeTimers = installFakeTimers();
    fetchSpy = installFetchSpy({ ok: true, throws: "network unreachable" });
    harness = makeHarness();
  });

  afterEach(() => {
    fakeTimers.restore();
    fetchSpy.restore();
    harness.cleanup();
  });

  it("logs a warn when fetch throws a network error", async () => {
    const warnLogger = pino(
      { level: "warn" },
      {
        write(chunk: string) {
          try {
            const j = JSON.parse(chunk) as { msg?: string };
            if (typeof j.msg === "string") {
              warnMessages.push(j.msg);
            }
          } catch {
            /* skip non-JSON */
          }
        },
      },
    );

    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: warnLogger,
    });

    // Give enough time for the fire-and-forget .catch() chain to complete.
    await yieldMs(150);
    handle.stop();

    expect(warnMessages.some((m) => m.includes("telemetry POST threw"))).toBe(true);
  });
});

describe("startTelemetryFlushScheduler — cold start attribution", () => {
  let fakeTimers: ReturnType<typeof installFakeTimers>;
  let fetchSpy: ReturnType<typeof installFetchSpy>;
  let harness: Harness;

  beforeEach(() => {
    fakeTimers = installFakeTimers();
    fetchSpy = installFetchSpy({ ok: true });
    harness = makeHarness();
  });

  afterEach(() => {
    fakeTimers.restore();
    fetchSpy.restore();
    harness.cleanup();
  });

  it("includes cold_start_ms in the POST payload when provided", async () => {
    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
      coldStartMs: 250,
    });

    await yieldMs(100);
    handle.stop();

    expect(fetchSpy.callCount()).toBeGreaterThan(0);
    const body = fetchSpy.lastBody() as Record<string, unknown>;
    expect(body["cold_start_ms"]).toBe(250);
  });
});

describe("startTelemetryFlushScheduler — tick error outer catch", () => {
  let fakeTimers: ReturnType<typeof installFakeTimers>;
  let harness: Harness;
  const warnMessages: string[] = [];

  beforeEach(() => {
    warnMessages.length = 0;
    fakeTimers = installFakeTimers();
    harness = makeHarness();
  });

  afterEach(() => {
    fakeTimers.restore();
    harness.cleanup();
  });

  it("catches synchronous errors from getDatabase() and logs telemetry flush tick failed", async () => {
    const origFetch = globalThis.fetch;
    // biome-ignore lint/suspicious/noExplicitAny: stubbing a global for this test
    (globalThis as any).fetch = async () => ({ ok: true, status: 200 });

    const warnLogger = pino(
      { level: "warn" },
      {
        write(chunk: string) {
          try {
            const j = JSON.parse(chunk) as { msg?: string };
            if (typeof j.msg === "string") {
              warnMessages.push(j.msg);
            }
          } catch {
            /* skip non-JSON */
          }
        },
      },
    );

    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => {
        throw new Error("synthetic db error");
      },
      gatewayVersion: "0.1.0-test",
      logger: warnLogger,
    });

    await yieldMs(80);
    handle.stop();

    // biome-ignore lint/suspicious/noExplicitAny: restoring a global
    (globalThis as any).fetch = origFetch;

    expect(warnMessages.some((m) => m.includes("telemetry flush tick failed"))).toBe(true);
  });
});
