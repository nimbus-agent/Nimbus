import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { processEnvDelete, processEnvSet } from "./env-access.ts";
import {
  createLifecycleWriter,
  DEFAULT_HEARTBEAT_MS,
  formatLifecycleLine,
  installGatewayLifecycleDiagnostics,
  LIFECYCLE_LOGGER_NAME,
  type ProcessLifecycleHost,
  resolveHeartbeatMs,
  resolveLifecycleLogPath,
  type TimerHandle,
} from "./exit-diagnostics.ts";

type Listener = (...args: never[]) => void;

/** A `process` stand-in that records handler registrations and exit calls. */
function makeHost(): {
  host: ProcessLifecycleHost;
  listeners: Map<string, Listener[]>;
  exits: number[];
  emit: (event: string, ...args: unknown[]) => void;
} {
  const listeners = new Map<string, Listener[]>();
  const exits: number[] = [];
  const host: ProcessLifecycleHost = {
    pid: 4242,
    on(event: string, listener: Listener): void {
      const cur = listeners.get(event) ?? [];
      cur.push(listener);
      listeners.set(event, cur);
    },
    memoryUsage() {
      return { rss: 100 * 1024 * 1024, heapUsed: 40 * 1024 * 1024, external: 5 * 1024 * 1024 };
    },
    exit(code: number): never {
      exits.push(code);
      // Deliberately does NOT throw: the real `process.exit` never returns, but a fake that
      // threw would mask whether the handler wrote its record BEFORE asking to exit.
      return undefined as never;
    },
  };
  const emit = (event: string, ...args: unknown[]): void => {
    for (const l of listeners.get(event) ?? []) {
      (l as (...a: unknown[]) => void)(...args);
    }
  };
  return { host, listeners, exits, emit };
}

type Harness = ReturnType<typeof makeHost> & {
  lines: string[];
  records: () => Array<Record<string, unknown>>;
  timers: Array<{ ms: number; fn: () => void; unrefCalls: number; cleared: boolean }>;
  stop: () => void;
};

function install(opts?: {
  heartbeatMs?: number;
  activity?: () => readonly string[];
  extras?: () => Readonly<Record<string, unknown>>;
}): Harness {
  const h = makeHost();
  const lines: string[] = [];
  const timers: Harness["timers"] = [];
  const handles = new Map<TimerHandle, Harness["timers"][number]>();
  const handle = installGatewayLifecycleDiagnostics({
    host: h.host,
    write: (line) => lines.push(line),
    hostname: "testbox",
    version: "9.9.9",
    now: () => 1_700_000_000_000,
    heartbeatMs: opts?.heartbeatMs ?? 60_000,
    ...(opts?.activity === undefined ? {} : { activity: opts.activity }),
    ...(opts?.extras === undefined ? {} : { extras: opts.extras }),
    setIntervalFn: (fn: () => void, ms: number): TimerHandle => {
      const rec = { ms, fn, unrefCalls: 0, cleared: false };
      timers.push(rec);
      const handle: TimerHandle = {
        unref(): void {
          rec.unrefCalls += 1;
        },
      };
      handles.set(handle, rec);
      return handle;
    },
    // Resolved by handle identity, so `stop()` clearing the WRONG timer would fail the test.
    clearIntervalFn: (t: TimerHandle): void => {
      const rec = handles.get(t);
      if (rec !== undefined) {
        rec.cleared = true;
      }
    },
  });
  return {
    ...h,
    lines,
    timers,
    stop: handle.stop,
    records: () => lines.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

describe("formatLifecycleLine", () => {
  test("emits one pino-shaped JSON line so existing log greps still match", () => {
    const line = formatLifecycleLine(
      { pid: 7, hostname: "box", now: () => 1234 },
      60,
      "process_exit",
      "gateway process exiting",
      { code: 0 },
    );
    expect(line.endsWith("\n")).toBe(true);
    expect(line.indexOf("\n")).toBe(line.length - 1);
    const rec = JSON.parse(line) as Record<string, unknown>;
    expect(rec).toMatchObject({
      level: 60,
      time: 1234,
      pid: 7,
      hostname: "box",
      name: LIFECYCLE_LOGGER_NAME,
      event: "process_exit",
      code: 0,
      msg: "gateway process exiting",
    });
  });

  test("a multi-line value stays on one line (JSON-escaped), so the log stays parseable", () => {
    const line = formatLifecycleLine(
      { pid: 7, hostname: "box", now: () => 1 },
      60,
      "uncaught_exception",
      "boom",
      { stack: "Error: x\n  at a\n  at b" },
    );
    expect(line.indexOf("\n")).toBe(line.length - 1);
    expect((JSON.parse(line) as { stack: string }).stack).toContain("\n  at a");
  });
});

describe("installGatewayLifecycleDiagnostics — exit paths", () => {
  test("writes a boot record naming the pid and version", () => {
    const h = install();
    const boot = h.records()[0];
    expect(boot).toMatchObject({ event: "boot", pid: 4242, version: "9.9.9" });
  });

  test("process 'exit' writes a record carrying the exit code", () => {
    const h = install();
    h.emit("exit", 0);
    const rec = h.records().find((r) => r["event"] === "process_exit");
    expect(rec).toBeDefined();
    expect(rec?.["code"]).toBe(0);
  });

  test("'beforeExit' is recorded and marks the later exit as an event-loop drain", () => {
    const h = install();
    h.emit("beforeExit", 0);
    h.emit("exit", 0);
    const before = h.records().find((r) => r["event"] === "before_exit");
    expect(before).toBeDefined();
    // The discriminator: drained loop vs. an explicit process.exit().
    expect(h.records().find((r) => r["event"] === "process_exit")?.["drained"]).toBe(true);
  });

  test("an exit with no preceding 'beforeExit' is NOT reported as a drain", () => {
    const h = install();
    h.emit("exit", 1);
    expect(h.records().find((r) => r["event"] === "process_exit")?.["drained"]).toBe(false);
  });

  test("uncaughtException is written at fatal level with the stack, then exits 1", () => {
    const h = install();
    h.emit("uncaughtException", new Error("kaboom"), "uncaughtException");
    const rec = h.records().find((r) => r["event"] === "uncaught_exception");
    expect(rec?.["level"]).toBe(60);
    expect(String(rec?.["stack"])).toContain("kaboom");
    expect(h.exits).toEqual([1]);
  });

  test("unhandledRejection is written at fatal level, then exits 1", () => {
    const h = install();
    h.emit("unhandledRejection", new Error("nope"));
    const rec = h.records().find((r) => r["event"] === "unhandled_rejection");
    expect(rec?.["level"]).toBe(60);
    expect(String(rec?.["reason"])).toContain("nope");
    expect(h.exits).toEqual([1]);
  });

  test("a non-Error rejection reason is still recorded rather than dropped", () => {
    const h = install();
    h.emit("unhandledRejection", "plain string reason");
    expect(
      String(h.records().find((r) => r["event"] === "unhandled_rejection")?.["reason"]),
    ).toContain("plain string reason");
  });

  test("a non-numeric exit code is recorded as null rather than a bogus number", () => {
    // Bun/Node pass the code positionally; a future runtime that omits it must not produce
    // `"code": undefined` (dropped by JSON.stringify) and silently lose the field.
    const h = install();
    h.emit("beforeExit");
    h.emit("exit");
    expect(h.records().find((r) => r["event"] === "before_exit")?.["code"]).toBeNull();
    expect(h.records().find((r) => r["event"] === "process_exit")?.["code"]).toBeNull();
  });

  test("a missing uncaughtException origin is recorded as null", () => {
    const h = install();
    h.emit("uncaughtException", new Error("no-origin"));
    expect(h.records().find((r) => r["event"] === "uncaught_exception")?.["origin"]).toBeNull();
  });

  test("an Error with no stack still records its name and message", () => {
    const h = install();
    const err = new Error("stackless");
    Reflect.deleteProperty(err, "stack");
    h.emit("uncaughtException", err);
    const rec = h.records().find((r) => r["event"] === "uncaught_exception");
    expect(rec?.["reason"]).toBe("Error: stackless");
    expect(rec?.["stack"]).toBeUndefined();
  });

  test("registers exactly one listener per lifecycle event", () => {
    const h = install();
    for (const ev of ["exit", "beforeExit", "uncaughtException", "unhandledRejection"]) {
      expect(h.listeners.get(ev)?.length).toBe(1);
    }
  });
});

describe("installGatewayLifecycleDiagnostics — heartbeat", () => {
  test("the heartbeat timer is unref'd so it cannot itself keep the loop alive", () => {
    // Load-bearing: a ref'd heartbeat would prevent the very event-loop drain the
    // 'beforeExit' record exists to detect, turning a silent exit into a silent hang.
    const h = install();
    expect(h.timers).toHaveLength(1);
    expect(h.timers[0]?.unrefCalls).toBe(1);
  });

  test("a heartbeat records uptime, rss and the in-flight sync services", () => {
    const h = install({ activity: () => ["blame", "filesystem"] });
    h.timers[0]?.fn();
    const hb = h.records().find((r) => r["event"] === "heartbeat");
    expect(hb).toBeDefined();
    expect(hb?.["rssMb"]).toBe(100);
    expect(hb?.["syncing"]).toEqual(["blame", "filesystem"]);
  });

  test("extras are merged into the heartbeat (embedding runtime state)", () => {
    const h = install({ extras: () => ({ embeddings: "warming" }) });
    h.timers[0]?.fn();
    expect(h.records().find((r) => r["event"] === "heartbeat")?.["embeddings"]).toBe("warming");
  });

  test("an extras provider that throws does not break the heartbeat", () => {
    const h = install({
      extras: () => {
        throw new Error("embedding runtime gone");
      },
    });
    expect(() => h.timers[0]?.fn()).not.toThrow();
    expect(h.records().find((r) => r["event"] === "heartbeat")).toBeDefined();
  });

  test("an activity provider that throws does not break the heartbeat", () => {
    const h = install({
      activity: () => {
        throw new Error("scheduler gone");
      },
    });
    expect(() => h.timers[0]?.fn()).not.toThrow();
    expect(h.records().find((r) => r["event"] === "heartbeat")).toBeDefined();
  });

  test("heartbeatMs <= 0 disables the heartbeat entirely", () => {
    const h = install({ heartbeatMs: 0 });
    expect(h.timers).toHaveLength(0);
  });

  test("stop() clears the heartbeat timer", () => {
    const h = install();
    h.stop();
    expect(h.timers[0]?.cleared).toBe(true);
  });
});

describe("resolveLifecycleLogPath", () => {
  const KEY = "NIMBUS_GATEWAY_LOG_PATH";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) {
      processEnvDelete(KEY);
    } else {
      processEnvSet(KEY, original);
    }
  });

  test("prefers NIMBUS_GATEWAY_LOG_PATH — the exact file the CLI wrote the spawn banner to", () => {
    const p = join(tmpdir(), "explicit-gateway.log");
    processEnvSet(KEY, p);
    expect(resolveLifecycleLogPath()).toBe(p);
  });

  test("falls back to the platform daily log when the env var is empty", () => {
    processEnvSet(KEY, "");
    const resolved = resolveLifecycleLogPath();
    expect(resolved).not.toBe("");
    expect(resolved).toContain("gateway-");
  });

  test("falls back to the platform daily log when the env var is unset", () => {
    processEnvDelete(KEY);
    expect(resolveLifecycleLogPath()).toContain("gateway-");
  });
});

describe("resolveHeartbeatMs", () => {
  const KEY = "NIMBUS_HEARTBEAT_MS";
  let original: string | undefined;

  beforeEach(() => {
    original = process.env[KEY];
  });

  afterEach(() => {
    if (original === undefined) {
      processEnvDelete(KEY);
    } else {
      processEnvSet(KEY, original);
    }
  });

  test("defaults when unset", () => {
    processEnvDelete(KEY);
    expect(resolveHeartbeatMs()).toBe(DEFAULT_HEARTBEAT_MS);
  });

  test("defaults when empty", () => {
    processEnvSet(KEY, "");
    expect(resolveHeartbeatMs()).toBe(DEFAULT_HEARTBEAT_MS);
  });

  test("defaults on a non-numeric value rather than disabling the heartbeat", () => {
    processEnvSet(KEY, "not-a-number");
    expect(resolveHeartbeatMs()).toBe(DEFAULT_HEARTBEAT_MS);
  });

  test("honours an explicit interval", () => {
    processEnvSet(KEY, "5000");
    expect(resolveHeartbeatMs()).toBe(5000);
  });

  test("honours 0 as an explicit opt-out", () => {
    processEnvSet(KEY, "0");
    expect(resolveHeartbeatMs()).toBe(0);
  });
});

describe("createLifecycleWriter", () => {
  test("appends synchronously so the final record survives an abrupt exit", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-lifecycle-"));
    try {
      const p = join(dir, "gateway.log");
      const write = createLifecycleWriter(p);
      write('{"a":1}\n');
      write('{"a":2}\n');
      // Read immediately, with no flush/tick in between — proves the write is synchronous.
      expect(readFileSync(p, "utf8")).toBe('{"a":1}\n{"a":2}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a failing write is swallowed — diagnostics must never take the gateway down", () => {
    const write = createLifecycleWriter(join(tmpdir(), "no-such-dir-nimbus-xyz", "a.log"));
    expect(() => write("{}\n")).not.toThrow();
  });
});
