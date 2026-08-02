import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import {
  parseStoredTelemetrySessionId,
  readErrorCode,
  startTelemetryFlushScheduler,
} from "./flush-scheduler.ts";

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
      service TEXT NOT NULL,
      body TEXT
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

// ---------------------------------------------------------------------------
// Pure-helper unit tests (visibility-only exports added to cover branches)
// ---------------------------------------------------------------------------

describe("parseStoredTelemetrySessionId — pure helper", () => {
  it("returns undefined for an empty string (fails regex)", () => {
    expect(parseStoredTelemetrySessionId("")).toBeUndefined();
  });

  it("returns undefined for a clearly non-UUID string", () => {
    expect(parseStoredTelemetrySessionId("not-a-uuid")).toBeUndefined();
  });

  it("returns undefined for a UUID that is version 3, not 4", () => {
    // Version 3 UUID: 3rd group starts with '3', not '4'
    expect(parseStoredTelemetrySessionId("550e8400-e29b-31d4-a716-446655440000")).toBeUndefined();
  });

  it("returns lowercase for a valid v4 UUID (uppercase input)", () => {
    const upper = "550E8400-E29B-41D4-A716-446655440000";
    const result = parseStoredTelemetrySessionId(upper);
    expect(result).toBe(upper.toLowerCase());
  });

  it("returns the UUID with leading/trailing whitespace stripped", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    expect(parseStoredTelemetrySessionId(`  ${uuid}  `)).toBe(uuid);
  });
});

describe("readErrorCode — pure helper", () => {
  it("returns the code string when present and is a string", () => {
    const err = { code: "ENOENT" };
    expect(readErrorCode(err)).toBe("ENOENT");
  });

  it("returns undefined when code property exists but is a number, not a string", () => {
    const err = { code: 42 };
    expect(readErrorCode(err)).toBeUndefined();
  });

  it("returns undefined for a plain Error without a code property", () => {
    expect(readErrorCode(new Error("oops"))).toBeUndefined();
  });

  it("returns undefined for null", () => {
    expect(readErrorCode(null)).toBeUndefined();
  });

  it("returns undefined for a primitive string", () => {
    expect(readErrorCode("ENOENT")).toBeUndefined();
  });

  it("returns undefined for a number", () => {
    expect(readErrorCode(404)).toBeUndefined();
  });

  it("returns undefined for undefined", () => {
    expect(readErrorCode(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Session-file state branches exercised through startTelemetryFlushScheduler
// ---------------------------------------------------------------------------

describe("startTelemetryFlushScheduler — corrupt session file", () => {
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

  it("proceeds to fetch even when .nimbus-telemetry-session contains garbage", async () => {
    // Write a corrupt (non-UUID) session file — exercises the 'corrupt' branch
    writeFileSync(join(harness.dataDir, ".nimbus-telemetry-session"), "not-a-uuid\n", "utf8");

    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    await yieldMs(80);
    handle.stop();

    // persistCorruptSessionFile is called; a new session id is minted and fetch fires
    expect(fetchSpy.callCount()).toBeGreaterThan(0);
  });
});

describe("startTelemetryFlushScheduler — valid pre-existing session file", () => {
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

  it("reuses the session id from an existing valid .nimbus-telemetry-session file", async () => {
    // Pre-populate with a valid v4 UUID — exercises the 'valid' branch in readOrCreateSessionId
    const knownId = "550e8400-e29b-41d4-a716-446655440000";
    writeFileSync(join(harness.dataDir, ".nimbus-telemetry-session"), `${knownId}\n`, "utf8");

    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    await yieldMs(80);
    handle.stop();

    expect(fetchSpy.callCount()).toBeGreaterThan(0);
    const body = fetchSpy.lastBody() as Record<string, unknown>;
    expect(body["session_id"]).toBe(knownId);
  });
});

describe("startTelemetryFlushScheduler — interval clamping", () => {
  let fakeTimers: ReturnType<typeof installFakeTimers>;
  let fetchSpy: ReturnType<typeof installFetchSpy>;

  beforeEach(() => {
    fakeTimers = installFakeTimers();
    fetchSpy = installFetchSpy({ ok: true });
  });

  afterEach(() => {
    fakeTimers.restore();
    fetchSpy.restore();
  });

  it("clamps flush_interval_seconds below 60 to exactly 60 000 ms", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nimbus-flush-clamp-lo-"));
    const tomlPath = join(dataDir, "nimbus.toml");
    writeFileSync(
      tomlPath,
      `[telemetry]\nenabled = true\nflush_interval_seconds = 1\nendpoint = "https://example.com/ingest"\n`,
      "utf8",
    );
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT NOT NULL, body TEXT); CREATE TABLE embedding_chunk (id INTEGER PRIMARY KEY, item_id TEXT NOT NULL); CREATE TABLE sync_state (connector_id TEXT PRIMARY KEY, last_sync_at INTEGER);",
    );

    const handle = startTelemetryFlushScheduler({
      dataDir,
      activeTomlPath: tomlPath,
      getDatabase: () => db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    const ms = fakeTimers.capturedIntervalMs();
    handle.stop();
    db.close();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    expect(ms).toBe(60_000);
  });

  it("clamps flush_interval_seconds above 86400 to exactly 86 400 000 ms", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "nimbus-flush-clamp-hi-"));
    const tomlPath = join(dataDir, "nimbus.toml");
    writeFileSync(
      tomlPath,
      `[telemetry]\nenabled = true\nflush_interval_seconds = 999999\nendpoint = "https://example.com/ingest"\n`,
      "utf8",
    );
    const db = new Database(":memory:");
    db.exec(
      "CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT NOT NULL, body TEXT); CREATE TABLE embedding_chunk (id INTEGER PRIMARY KEY, item_id TEXT NOT NULL); CREATE TABLE sync_state (connector_id TEXT PRIMARY KEY, last_sync_at INTEGER);",
    );

    const handle = startTelemetryFlushScheduler({
      dataDir,
      activeTomlPath: tomlPath,
      getDatabase: () => db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    const ms = fakeTimers.capturedIntervalMs();
    handle.stop();
    db.close();
    try {
      rmSync(dataDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }

    expect(ms).toBe(86_400_000);
  });
});

describe("startTelemetryFlushScheduler — fetch throws a non-Error value", () => {
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

  it("logs warn via String(err) when fetch rejects with a non-Error value", async () => {
    const origFetch = globalThis.fetch;
    // Reject with a plain string — exercises the `String(err)` branch in the .catch handler
    (globalThis as unknown as Record<string, unknown>)["fetch"] = async () => {
      return Promise.reject("plain-string-rejection");
    };
    try {
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
    } finally {
      (globalThis as unknown as Record<string, unknown>)["fetch"] = origFetch;
    }
  });
});

describe("startTelemetryFlushScheduler — outer tick catch with non-Error thrown", () => {
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

  it("logs tick error via String(e) when getDatabase throws a non-Error value", async () => {
    const origFetch = globalThis.fetch;
    (globalThis as unknown as Record<string, unknown>)["fetch"] = async () => ({
      ok: true,
      status: 200,
    });
    try {
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

      // Throw a non-Error value to exercise the `String(e)` branch in outer catch
      const handle = startTelemetryFlushScheduler({
        dataDir: harness.dataDir,
        activeTomlPath: harness.tomlPath,
        getDatabase: () => {
          throw "synthetic-string-error";
        },
        gatewayVersion: "0.1.0-test",
        logger: warnLogger,
      });

      await yieldMs(80);
      handle.stop();

      expect(warnMessages.some((m) => m.includes("telemetry flush tick failed"))).toBe(true);
    } finally {
      (globalThis as unknown as Record<string, unknown>)["fetch"] = origFetch;
    }
  });
});

describe("startTelemetryFlushScheduler — disabled marker file unreadable (non-ENOENT)", () => {
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

  it("proceeds to fetch when the disabled marker check throws a non-ENOENT error", async () => {
    // Simulate by stubbing readFileSync to throw EACCES for the disabled-marker path
    // but still allow other files to be read normally.
    // We cannot use mock.module so we exercise via an OS-level trick:
    // On any platform, reading a directory as a file gives a different error than ENOENT.
    // Create a directory named ".nimbus-telemetry-disabled" instead of a file.
    const { mkdirSync } = await import("node:fs");
    mkdirSync(join(harness.dataDir, ".nimbus-telemetry-disabled"), { recursive: true });

    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    await yieldMs(80);
    handle.stop();

    // The "ignore unreadable marker" branch is hit; telemetry proceeds to fetch
    expect(fetchSpy.callCount()).toBeGreaterThan(0);
  });
});

describe("startTelemetryFlushScheduler — stop() with handle already null (second call)", () => {
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

  it("second stop() does not call clearInterval again (handle is null)", async () => {
    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
    });

    await yieldMs(30);
    handle.stop(); // first: clearInterval called, handle set to null
    const callsAfterFirst = fakeTimers.clearIntervalMock.mock.calls.length;
    handle.stop(); // second: handle is null, clearInterval NOT called again
    const callsAfterSecond = fakeTimers.clearIntervalMock.mock.calls.length;

    expect(callsAfterSecond).toBe(callsAfterFirst); // no extra clearInterval call
  });
});

describe("startTelemetryFlushScheduler — no coldStartMs (undefined spread)", () => {
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

  it("cold_start_ms defaults to 0 when coldStartMs is not provided", async () => {
    const handle = startTelemetryFlushScheduler({
      dataDir: harness.dataDir,
      activeTomlPath: harness.tomlPath,
      getDatabase: () => harness.db,
      gatewayVersion: "0.1.0-test",
      logger: silentLogger,
      // no coldStartMs
    });

    await yieldMs(100);
    handle.stop();

    expect(fetchSpy.callCount()).toBeGreaterThan(0);
    const body = fetchSpy.lastBody() as Record<string, unknown>;
    expect(body["cold_start_ms"]).toBe(0);
  });
});
