import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { startTelemetryFlushScheduler } from "./flush-scheduler.ts";

type TickFn = () => void;

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
    return 999_999;
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

function makeHarness(tomlContent?: string): Harness {
  const dataDir = mkdtempSync(join(tmpdir(), "nimbus-flush-sched-"));
  const tomlPath = join(dataDir, "nimbus.toml");
  const content =
    tomlContent ??
    `[telemetry]\nenabled = true\nflush_interval_seconds = 60\nendpoint = "https://example.com/ingest"\n`;
  writeFileSync(tomlPath, content, "utf8");
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE item (
      id TEXT PRIMARY KEY,
      service TEXT NOT NULL
    );
    CREATE TABLE embedding_chunk (
      id INTEGER PRIMARY KEY,
      item_id TEXT NOT NULL
    );
    CREATE TABLE sync_state (
      connector_id TEXT PRIMARY KEY,
      last_sync_at INTEGER
    );
  `);
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

function yieldMs(ms = 80): Promise<void> {
  return new Promise<void>((r) => setTimeout(r, ms));
}

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

    expect(fakeTimers.clearIntervalMock.mock.calls.length).toBeGreaterThan(0);

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
