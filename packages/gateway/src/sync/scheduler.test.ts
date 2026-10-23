import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import pino from "pino";
import { getConnectorHealth, transitionHealth } from "../connectors/health.ts";
import { insertUserMcpConnector } from "../connectors/user-mcp-store.ts";
import { createUserMcpSyncable } from "../connectors/user-mcp-sync.ts";
import { dbRun } from "../db/write.ts";
import { recordSyncEgress } from "../egress/sync-egress.ts";
import { LocalIndex } from "../index/local-index.ts";
import { setGatewayEventBroadcast } from "../ipc/gateway-events.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { ProviderRateLimiter } from "./rate-limiter.ts";
import {
  pauseIfPreflightRefuses,
  preflightRefusal,
  resumeOrPauseForConfinement,
  SyncScheduler,
} from "./scheduler.ts";
import { loadSchedulerState } from "./scheduler-store.ts";
import { unboundSyncCapabilities } from "./sync-capabilities.ts";
import type { SyncRuntimeContext } from "./types.ts";
import {
  RateLimitError,
  type Syncable,
  type SyncContext,
  type SyncResult,
  syncNoopResult,
  UnauthenticatedError,
} from "./types.ts";

/** A trivial always-succeeding syncable used as a fixture. */
function okSyncable(serviceId: string, intervalMs = 60_000): Syncable {
  return {
    serviceId,
    defaultIntervalMs: intervalMs,
    initialSyncDepthDays: 30,
    async sync(): Promise<SyncResult> {
      return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
    },
  };
}

/** A syncable that throws a caller-supplied value. */
function throwingSyncable(serviceId: string, thrown: unknown): Syncable {
  return {
    serviceId,
    defaultIntervalMs: 60_000,
    initialSyncDepthDays: 30,
    async sync(): Promise<SyncResult> {
      throw thrown;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function testContext(db: Database): SyncRuntimeContext {
  return {
    ...unboundSyncCapabilities(),
    db,
    vault: createMemoryVault(),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    sandboxCwd: os.tmpdir(),
    credentialFor: () => ({ credential: "personal" }),
    runTeamList: async () => [],
    depth: "full",
  };
}

describe("SyncScheduler", () => {
  test("two connectors run on their intervals", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let a = 0;
    let b = 0;
    const ca: Syncable = {
      serviceId: "a",
      defaultIntervalMs: 40,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        a += 1;
        return {
          cursor: "c",
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 0,
        };
      },
    };
    const cb: Syncable = {
      serviceId: "b",
      defaultIntervalMs: 40,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        b += 1;
        return {
          cursor: "c",
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 0,
        };
      },
    };
    const sched = new SyncScheduler(ctx, { maxConcurrentSyncs: 2 });
    sched.register(ca);
    sched.register(cb);
    sched.start();
    await sleep(200);
    sched.stop();
    expect(a).toBeGreaterThanOrEqual(2);
    expect(b).toBeGreaterThanOrEqual(2);
  });

  test("backoff on failure sets next_sync_at and consecutive_failures", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const c: Syncable = {
      serviceId: "fail",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        throw new Error("boom");
      },
    };
    const before = Date.now();
    const sched = new SyncScheduler(ctx, {}, { random: () => 0 });
    sched.register(c);
    try {
      await sched.forceSync("fail");
      throw new Error("expected forceSync to reject");
    } catch (e) {
      expect(e).toBeInstanceOf(Error);
      expect((e as Error).message).toBe("boom");
    }
    sched.stop();
    const row = loadSchedulerState(db, "fail");
    expect(row).not.toBeNull();
    expect(row?.consecutive_failures).toBe(1);
    expect(row?.status).toBe("backoff");
    expect(row?.next_sync_at).toBeGreaterThanOrEqual(before + 3900);
    expect(row?.next_sync_at).toBeLessThanOrEqual(before + 4500);
  });

  test("persists cursor across scheduler instances", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const cursors: Array<string | null> = [];
    const c: Syncable = {
      serviceId: "persist",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(_ctx, cursor): Promise<SyncResult> {
        cursors.push(cursor);
        return {
          cursor: "next",
          itemsUpserted: 1,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 1,
        };
      },
    };
    const s1 = new SyncScheduler(ctx);
    s1.register(c);
    await s1.forceSync("persist");
    s1.stop();

    const s2 = new SyncScheduler(ctx);
    s2.register(c);
    await s2.forceSync("persist");
    s2.stop();

    expect(cursors[0]).toBeNull();
    expect(cursors[1]).toBe("next");
  });

  test("maxConcurrentSyncs caps parallel runs across services", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let concurrent = 0;
    let peak = 0;
    const make = (id: string): Syncable => ({
      serviceId: id,
      defaultIntervalMs: 20,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        concurrent += 1;
        peak = Math.max(peak, concurrent);
        await sleep(60);
        concurrent -= 1;
        return {
          cursor: null,
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 60,
        };
      },
    });
    const sched = new SyncScheduler(ctx, { maxConcurrentSyncs: 3 });
    for (const id of ["c1", "c2", "c3", "c4"]) {
      sched.register(make(id));
    }
    sched.start();
    await sleep(250);
    sched.stop();
    expect(peak).toBeLessThanOrEqual(3);
  });

  test("catchUpOnRestart false resets overdue next_sync without running sync", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const c: Syncable = {
      serviceId: "late",
      defaultIntervalMs: 10_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        runs += 1;
        return {
          cursor: null,
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 0,
        };
      },
    };
    const sched = new SyncScheduler(ctx, { catchUpOnRestart: false });
    sched.register(c);
    db.run(`UPDATE scheduler_state SET next_sync_at = ? WHERE service_id = ?`, [1, "late"]);
    sched.start();
    await sleep(80);
    sched.stop();
    expect(runs).toBe(0);
    const row = loadSchedulerState(db, "late");
    expect(row?.next_sync_at).not.toBe(1);
    expect(row?.next_sync_at).toBeGreaterThan(Date.now() - 100);
  });

  test("hasMore re-queues continuation without waiting interval", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let n = 0;
    const times: number[] = [];
    const c: Syncable = {
      serviceId: "pages",
      defaultIntervalMs: 400,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        n += 1;
        times.push(Date.now());
        if (n === 1) {
          return {
            cursor: "p1",
            itemsUpserted: 0,
            itemsDeleted: 0,
            hasMore: true,
            durationMs: 0,
          };
        }
        return {
          cursor: "p2",
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 0,
        };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.register(c);
    sched.start();
    await sleep(150);
    sched.stop();
    expect(n).toBe(2);
    expect(times).toHaveLength(2);
    const t0 = times[0];
    const t1 = times[1];
    if (t0 === undefined || t1 === undefined) {
      throw new Error("expected two sync timestamps");
    }
    expect(t1 - t0).toBeLessThan(200);
  });

  test("setInterval validates the interval argument", () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const c: Syncable = {
      serviceId: "iv",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        return {
          cursor: null,
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 0,
        };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.register(c);
    // < 1 branch
    expect(() => sched.setInterval("iv", 0)).toThrow();
    // negative branch
    expect(() => sched.setInterval("iv", -5)).toThrow();
    // !Number.isFinite branch
    expect(() => sched.setInterval("iv", Number.NaN)).toThrow();
    expect(() => sched.setInterval("iv", Number.POSITIVE_INFINITY)).toThrow();
    // valid branch (both predicates false)
    expect(() => sched.setInterval("iv", 5_000)).not.toThrow();
    const row = loadSchedulerState(db, "iv");
    expect(row?.interval_ms).toBe(5_000);
  });

  test("forceSync formats varied connector failures into the error message", async () => {
    const cases: Array<{ id: string; thrown: unknown; expected: string }> = [
      // Error with empty message -> uses err.name
      { id: "emptymsg", thrown: new Error(""), expected: "Error" },
      // non-Error object -> String(err) === "[object Object]" -> generic message
      { id: "objerr", thrown: {}, expected: "Sync failed" },
      // string rejection
      { id: "strerr", thrown: "string failure", expected: "string failure" },
      // whitespace-only string rejection -> trims to empty -> generic message
      { id: "wsstrerr", thrown: "   ", expected: "Sync failed" },
      // long message -> truncated with ellipsis suffix
      {
        id: "longerr",
        thrown: new Error("z".repeat(3000)),
        expected: `${"z".repeat(2048)}…`,
      },
    ];
    for (const { id, thrown, expected } of cases) {
      const db = openMemoryIndexDatabase();
      const ctx = testContext(db);
      const c: Syncable = {
        serviceId: id,
        defaultIntervalMs: 60_000,
        initialSyncDepthDays: 30,
        async sync(): Promise<SyncResult> {
          throw thrown;
        },
      };
      const sched = new SyncScheduler(ctx, {}, { random: () => 0 });
      sched.register(c);
      try {
        await sched.forceSync(id);
        throw new Error("expected forceSync to reject");
      } catch (e) {
        expect(e).toBeInstanceOf(Error);
        expect((e as Error).message).toBe(expected);
      }
      await sched.stop();
      const row = loadSchedulerState(db, id);
      expect(row?.error_msg).toBe(expected);
      expect(row?.status).toBe("backoff");
    }
  });

  test("getStatus reflects paused/error/backoff and ignores unknown services", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const c: Syncable = {
      serviceId: "stat",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        return {
          cursor: null,
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 0,
        };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.register(c);

    // unknown service -> empty
    expect(sched.getStatus("does-not-exist")).toEqual([]);

    // error status branch
    db.run(`UPDATE scheduler_state SET status = 'error' WHERE service_id = ?`, ["stat"]);
    expect(sched.getStatus("stat")[0]?.status).toBe("error");

    // backoff status branch
    db.run(`UPDATE scheduler_state SET status = 'backoff' WHERE service_id = ?`, ["stat"]);
    expect(sched.getStatus("stat")[0]?.status).toBe("backoff");

    // paused branch (and resume() while not started is a no-op for tick)
    sched.pause("stat");
    expect(sched.getStatus("stat")[0]?.status).toBe("paused");
    expect(sched.getStatus("stat")[0]?.enabled).toBe(false);
    sched.resume("stat");
    expect(sched.getStatus("stat")[0]?.status).not.toBe("paused");

    // no serviceId -> returns all known services
    expect(sched.getStatus().length).toBeGreaterThanOrEqual(1);
  });

  test("start() is a no-op after stop()", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const c: Syncable = {
      serviceId: "noop",
      defaultIntervalMs: 10,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        runs += 1;
        return {
          cursor: null,
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 0,
        };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.register(c);
    await sched.stop();
    // started=false but stopped=true -> early return, no interval armed
    sched.start();
    await sleep(40);
    expect(runs).toBe(0);
  });

  test("fifth consecutive failure notifies and sets error status", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let notifications = 0;
    const c: Syncable = {
      serviceId: "die",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        throw new Error("x");
      },
    };
    const sched = new SyncScheduler(
      ctx,
      {},
      {
        random: () => 0,
        notify: async () => {
          notifications += 1;
        },
      },
    );
    sched.register(c);
    db.run(
      `UPDATE scheduler_state SET consecutive_failures = 4, status = 'ok', next_sync_at = ?, paused = 0 WHERE service_id = ?`,
      [Date.now() + 60 * 60 * 1000, "die"],
    );
    sched.start();
    try {
      await sched.forceSync("die");
    } catch {
      /* expected failure */
    }
    sched.stop();
    expect(notifications).toBe(1);
    const row = loadSchedulerState(db, "die");
    expect(row?.status).toBe("error");
    expect(row?.consecutive_failures).toBe(5);
  });
});

describe("SyncScheduler — error-path + lifecycle branch coverage", () => {
  test("forceSync on a RateLimitError aborts: transitions health to rate_limited and rejects", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const retryAfter = new Date(Date.now() + 60_000);
    const sched = new SyncScheduler(ctx, {}, { random: () => 0 });
    sched.register(throwingSyncable("rl", new RateLimitError(retryAfter, "slow down")));
    await expect(sched.forceSync("rl")).rejects.toThrow(/slow down/);
    await sched.stop();
    expect(getConnectorHealth(db, "rl").state).toBe("rate_limited");
    // The state row is NOT marked backoff/error — the abort path only records telemetry.
    const row = loadSchedulerState(db, "rl");
    expect(row?.status).not.toBe("error");
  });

  test("forceSync on an UnauthenticatedError aborts: transitions health + notifies + rejects", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let notifications = 0;
    const sched = new SyncScheduler(
      ctx,
      {},
      {
        random: () => 0,
        notify: async () => {
          notifications += 1;
        },
      },
    );
    sched.register(throwingSyncable("auth", new UnauthenticatedError("token revoked")));
    await expect(sched.forceSync("auth")).rejects.toThrow(/token revoked/);
    await sched.stop();
    expect(getConnectorHealth(db, "auth").state).toBe("unauthenticated");
    expect(notifications).toBe(1);
  });

  test("scheduled (non-force) RateLimitError aborts silently (no force waiter)", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const sched = new SyncScheduler(ctx, {}, { random: () => 0 });
    // A short interval means the connector is due shortly after start; the scheduled
    // (non-force) job hits the RateLimitError abort arm → health rate_limited.
    sched.register({
      ...throwingSyncable("rl2", new RateLimitError(new Date(Date.now() + 60_000))),
      defaultIntervalMs: 10,
    });
    sched.start();
    await sleep(150);
    await sched.stop();
    expect(getConnectorHealth(db, "rl2").state).toBe("rate_limited");
  });

  /** Succeeds once with cursor "c-ok", then throws `thrown` on every later run. */
  function okThenThrows(serviceId: string, thrown: unknown): Syncable {
    let calls = 0;
    return {
      serviceId,
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        calls += 1;
        if (calls > 1) throw thrown;
        return { cursor: "c-ok", itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
  }

  test("a RateLimitError carrying a resume cursor persists it and still reports rate_limited", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const sched = new SyncScheduler(ctx, {}, { random: () => 0 });
    const retryAfter = new Date(Date.now() + 60_000);
    sched.register(
      okThenThrows("rlc", new RateLimitError(retryAfter, "slow down", { resumeCursor: "c-page2" })),
    );
    await sched.forceSync("rlc");
    const before = loadSchedulerState(db, "rlc");
    await expect(sched.forceSync("rlc")).rejects.toThrow(/slow down/);
    await sched.stop();
    const row = loadSchedulerState(db, "rlc");
    expect(row?.cursor).toBe("c-page2");
    // Nothing else about the row moves: not a success, not a failure strike.
    expect(row?.last_sync_at).toBe(before?.last_sync_at ?? null);
    expect(row?.status).toBe("ok");
    expect(row?.consecutive_failures).toBe(0);
    const health = getConnectorHealth(db, "rlc");
    expect(health.state).toBe("rate_limited");
    expect(health.retryAfter?.getTime()).toBe(retryAfter.getTime());
  });

  test("an UnauthenticatedError carrying a resume cursor persists it, notifies and reports unauthenticated", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let notifications = 0;
    const sched = new SyncScheduler(
      ctx,
      {},
      {
        random: () => 0,
        notify: async () => {
          notifications += 1;
        },
      },
    );
    sched.register(
      okThenThrows("uac", new UnauthenticatedError("token revoked", { resumeCursor: "c-page2" })),
    );
    await sched.forceSync("uac");
    await expect(sched.forceSync("uac")).rejects.toThrow(/token revoked/);
    await sched.stop();
    expect(loadSchedulerState(db, "uac")?.cursor).toBe("c-page2");
    expect(getConnectorHealth(db, "uac").state).toBe("unauthenticated");
    expect(notifications).toBe(1);
  });

  test("a RateLimitError WITHOUT a resume cursor leaves the stored cursor untouched", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const sched = new SyncScheduler(ctx, {}, { random: () => 0 });
    sched.register(okThenThrows("rln", new RateLimitError(new Date(Date.now() + 60_000))));
    await sched.forceSync("rln");
    await expect(sched.forceSync("rln")).rejects.toBeInstanceOf(RateLimitError);
    await sched.stop();
    expect(loadSchedulerState(db, "rln")?.cursor).toBe("c-ok");
    expect(getConnectorHealth(db, "rln").state).toBe("rate_limited");
  });

  test("unregister removes the connector and rejects any pending force waiter", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const sched = new SyncScheduler(ctx);
    sched.register(okSyncable("temp"));
    expect(sched.getStatus("temp")).toHaveLength(1);
    sched.unregister("temp");
    expect(sched.getStatus("temp")).toEqual([]);
    await sched.stop();
  });

  test("register after start triggers an immediate tick", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const c: Syncable = {
      serviceId: "afterstart",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        runs += 1;
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.start();
    sched.register(c);
    // The newly-registered connector is due immediately (next_sync_at == now-ish).
    await sleep(120);
    await sched.stop();
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  test("resume() while started triggers a tick", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const c: Syncable = {
      serviceId: "res",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        runs += 1;
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.register(c);
    sched.pause("res");
    sched.start();
    await sleep(40);
    expect(runs).toBe(0); // paused → no run
    sched.resume("res"); // started → resume tick → due → runs
    await sleep(120);
    await sched.stop();
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  test("offline scheduler skips connectors and marks them skipped_offline", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const c: Syncable = {
      serviceId: "off",
      defaultIntervalMs: 10,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        runs += 1;
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
    const sched = new SyncScheduler(ctx, {}, { isOnline: async () => false, initialOnline: false });
    sched.register(c);
    sched.start();
    await sleep(120);
    await sched.stop();
    // Offline → the tick early-returns; the connector never runs. `skipped_offline` is a
    // history-only event, so whatever state was there is left alone.
    //
    // Asserted against a SEEDED healthy row. It used to assert on a connector with no row at
    // all, which passed only because `buildSnapshot` hard-coded `healthy` for that case — the
    // F6 defect. That made this test agree with the bug while appearing to test the skip.
    expect(runs).toBe(0);
    expect(getConnectorHealth(db, "off").state).toBe("not_configured");

    transitionHealth(db, "off", { type: "sync_success" });
    transitionHealth(db, "off", { type: "skipped_offline" });
    expect(getConnectorHealth(db, "off").state).toBe("healthy");
  });

  test("rate_limited connector within its retry window is skipped by the tick health gate", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const c: Syncable = {
      serviceId: "rlskip",
      defaultIntervalMs: 10,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        runs += 1;
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.register(c);
    transitionHealth(db, "rlskip", {
      type: "rate_limited",
      retryAfter: new Date(Date.now() + 60_000),
    });
    sched.start();
    await sleep(80);
    await sched.stop();
    expect(runs).toBe(0);
  });

  test("scheduled (non-force) failure records backoff and resolves waiters (non-force arm)", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const sched = new SyncScheduler(ctx, {}, { random: () => 0 });
    sched.register({ ...throwingSyncable("schedfail", new Error("nope")), defaultIntervalMs: 10 });
    sched.start();
    await sleep(150);
    await sched.stop();
    const row = loadSchedulerState(db, "schedfail");
    expect(row?.status).toBe("backoff");
    expect(row?.consecutive_failures).toBeGreaterThanOrEqual(1);
  });

  test("forceSync on a paused connector still runs (paused gate is bypassed for force)", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const c: Syncable = {
      serviceId: "pausedforce",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        runs += 1;
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.register(c);
    sched.pause("pausedforce");
    await sched.forceSync("pausedforce");
    await sched.stop();
    expect(runs).toBe(1);
  });

  test("forceSync on an error-status connector still runs (error gate bypassed for force)", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const c: Syncable = {
      serviceId: "errforce",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        runs += 1;
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.register(c);
    db.run(`UPDATE scheduler_state SET status = 'error' WHERE service_id = ?`, ["errforce"]);
    await sched.forceSync("errforce");
    await sched.stop();
    expect(runs).toBe(1);
  });

  test("getStatus skips a connector whose scheduler_state row is missing", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const sched = new SyncScheduler(ctx);
    sched.register(okSyncable("present"));
    sched.register(okSyncable("ghostrow"));
    // Delete one connector's state row; getStatus(all) must skip it (loadState null → continue).
    db.run(`DELETE FROM scheduler_state WHERE service_id = ?`, ["ghostrow"]);
    const all = sched.getStatus();
    expect(all.some((s) => s.serviceId === "present")).toBe(true);
    expect(all.some((s) => s.serviceId === "ghostrow")).toBe(false);
    await sched.stop();
  });

  test("rate_limited connector whose retry window has passed is allowed to dispatch", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const c: Syncable = {
      serviceId: "rlexpired",
      defaultIntervalMs: 10,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        runs += 1;
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.register(c);
    // retryAfter already in the past → healthGate returns false (not skipped).
    transitionHealth(db, "rlexpired", {
      type: "rate_limited",
      retryAfter: new Date(Date.now() - 1000),
    });
    sched.start();
    await sleep(120);
    await sched.stop();
    expect(runs).toBeGreaterThanOrEqual(1);
  });

  test("getStatus syncing branch reflects an in-flight connector", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const c: Syncable = {
      serviceId: "slow",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        await gate;
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
    const sched = new SyncScheduler(ctx);
    sched.register(c);
    const p = sched.forceSync("slow");
    // Spin until the job is in flight, then assert the syncing status.
    let status = sched.getStatus("slow")[0]?.status;
    for (let i = 0; i < 50 && status !== "syncing"; i += 1) {
      await sleep(5);
      status = sched.getStatus("slow")[0]?.status;
    }
    expect(status).toBe("syncing");
    release?.();
    await p;
    await sched.stop();
  });

  test("a connector with no depth row resolves to full", () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const sched = new SyncScheduler(ctx);
    sched.register(okSyncable("no-depth-row"));
    const statuses = sched.getStatus("no-depth-row");
    expect(statuses).toHaveLength(1);
    const status = statuses[0];
    expect(status).toBeDefined();
    expect(status!.depth).toBe("full");
  });

  // Closes the gap the shared-template `this.ctx` (always `depth: "full"` in every fixture) can't
  // catch: a forced/scheduled run must receive the connector's OWN persisted depth, not the
  // template's. Regressing `runJob` back to `connector.sync(this.ctx, ...)` would make this fail
  // (captured depth reverts to "full") while every other test in this file — and the `getStatus`
  // depth-shape tests in scheduler-status-shape.test.ts — stays green, because none of them read
  // the depth actually handed to `sync()`.
  test("a forced sync passes the connector's persisted depth, not the shared template's", async () => {
    const db = openMemoryIndexDatabase();
    const idx = new LocalIndex(db);
    const ctx = testContext(db); // depth: "full"
    const sched = new SyncScheduler(ctx);
    let capturedDepth: SyncContext["depth"] | undefined;
    sched.register({
      serviceId: "depth-capture",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(runCtx): Promise<SyncResult> {
        capturedDepth = runCtx.depth;
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    });
    idx.setConnectorDepth("depth-capture", "metadata_only");
    await sched.forceSync("depth-capture");
    await sched.stop();
    expect(capturedDepth).toBe("metadata_only");
  });

  // The regression the test ABOVE structurally cannot catch: it calls
  // `setConnectorDepth` first, which creates the `sync_state` row, so the
  // `INSERT OR IGNORE` inside `transitionHealth()` -> `upsertHealthRow()` is
  // a no-op and its column list is never exercised. A connector whose depth
  // was NEVER set takes the other path: run 1 sees no row at all (
  // `getDepthForService` falls back to "full"), then the success transition
  // CREATES the row — and if that insert omits `depth`, the row inherits
  // V21's stale `DEFAULT 'summary'` and every later run silently indexes at
  // 512 chars with `body_complete` pinned to 0. Only a SECOND run observes
  // it, hence the two forced syncs.
  test("a connector whose depth was never set still syncs at full on the SECOND run", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const sched = new SyncScheduler(ctx);
    const seenDepths: Array<SyncContext["depth"]> = [];
    sched.register({
      serviceId: "never-configured",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(runCtx): Promise<SyncResult> {
        seenDepths.push(runCtx.depth);
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    });

    await sched.forceSync("never-configured");
    await sched.forceSync("never-configured");
    await sched.forceSync("never-configured");
    await sched.stop();

    expect(seenDepths).toEqual(["full", "full", "full"]);
    const row = db
      .query(`SELECT depth FROM sync_state WHERE connector_id = ?`)
      .get("never-configured") as { depth: string } | null;
    expect(row?.depth).toBe("full");
  });

  describe("appendSyncEgress", () => {
    test("an unbound ext_ job with a blank declared credential appends no sync.run row; with it set, exactly one", async () => {
      const db = openMemoryIndexDatabase();
      const vault = createMemoryVault();
      const ctx: SyncRuntimeContext = {
        ...testContext(db),
        vault,
        extensionCredentialsFor: (id) =>
          id === "ext_a_b" ? { token: { env: "T", vaultKey: "ext.ext_a_b.token" } } : undefined,
      };
      const rows: Array<{ destination: string; sourceType: string; method: string }> = [];
      const sched = new SyncScheduler(ctx, undefined, {
        appendSyncEgress: (r) => rows.push(r),
      });
      sched.register(okSyncable("ext_a_b"));

      await sched.forceSync("ext_a_b");
      expect(rows).toHaveLength(0);

      await vault.set("ext.ext_a_b.token", "secret");
      await sched.forceSync("ext_a_b");
      await sched.stop();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ destination: "ext_a_b", method: "sync.run" });
    });

    test("a sync run appends exactly one per-run sync egress row before syncing", async () => {
      const db = openMemoryIndexDatabase();
      const ctx = testContext(db);
      const rows: Array<{ destination: string; sourceType: string; method: string }> = [];
      let syncCalls = 0;
      const sched = new SyncScheduler(ctx, undefined, {
        appendSyncEgress: (r) => rows.push(r),
      });
      sched.register({
        serviceId: "egress-svc",
        defaultIntervalMs: 60_000,
        initialSyncDepthDays: 30,
        async sync(): Promise<SyncResult> {
          syncCalls++;
          return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
        },
      });

      await sched.forceSync("egress-svc");
      await sched.stop();

      expect(syncCalls).toBe(1);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ destination: "egress-svc", sourceType: "sync" });
    });

    test("appendSyncEgress fires again on a second run — one row per run, not per registration", async () => {
      const db = openMemoryIndexDatabase();
      const ctx = testContext(db);
      const rows: Array<{ destination: string; sourceType: string; method: string }> = [];
      const sched = new SyncScheduler(ctx, undefined, {
        appendSyncEgress: (r) => rows.push(r),
      });
      sched.register({
        serviceId: "egress-svc-2",
        defaultIntervalMs: 60_000,
        initialSyncDepthDays: 30,
        async sync(): Promise<SyncResult> {
          return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
        },
      });

      await sched.forceSync("egress-svc-2");
      await sched.forceSync("egress-svc-2");
      await sched.stop();

      expect(rows).toHaveLength(2);
    });

    test("a failing egress append aborts the run — the connector's sync() is never called", async () => {
      const db = openMemoryIndexDatabase();
      const ctx = testContext(db);
      let synced = false;
      const sched = new SyncScheduler(ctx, undefined, {
        appendSyncEgress: () => {
          throw new Error("ledger down");
        },
      });
      sched.register({
        serviceId: "egress-fail-svc",
        defaultIntervalMs: 60_000,
        initialSyncDepthDays: 30,
        async sync(): Promise<SyncResult> {
          synced = true;
          return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
        },
      });

      await sched.forceSync("egress-fail-svc").catch(() => {});
      await sched.stop();

      expect(synced).toBe(false);
    });

    test("omitting appendSyncEgress leaves sync behavior unchanged (existing callers construct as-is)", async () => {
      const db = openMemoryIndexDatabase();
      const ctx = testContext(db);
      const sched = new SyncScheduler(ctx);
      let syncCalls = 0;
      sched.register({
        serviceId: "no-egress-svc",
        defaultIntervalMs: 60_000,
        initialSyncDepthDays: 30,
        async sync(): Promise<SyncResult> {
          syncCalls++;
          return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
        },
      });

      await sched.forceSync("no-egress-svc");
      await sched.stop();

      expect(syncCalls).toBe(1);
    });

    // I29 CRITICAL 1: a connector with NO Vault credential must not ledger `sync` egress at all —
    // its own `sync()` already short-circuits to a noop without touching the network, so an
    // unconditional append before every run fabricated an "authorized" row for a call that
    // provably never left the machine. `github` is a real `connector-secrets-manifest.ts` entry
    // (`["github.pat"]`); `testContext`'s vault (`createMemoryVault()`) starts empty, so this is
    // exactly the "empty Vault" scenario the review's executed proof describes.
    test("a registered connector with no Vault credential ledgers ZERO sync egress rows on a forced sync", async () => {
      const db = openMemoryIndexDatabase();
      const ctx = testContext(db);
      const rows: Array<{ destination: string; sourceType: string; method: string }> = [];
      let syncCalls = 0;
      const sched = new SyncScheduler(ctx, undefined, {
        appendSyncEgress: (r) => rows.push(r),
      });
      sched.register({
        serviceId: "github",
        defaultIntervalMs: 60_000,
        initialSyncDepthDays: 30,
        async sync(): Promise<SyncResult> {
          syncCalls++;
          return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
        },
      });

      await sched.forceSync("github");
      await sched.stop();

      // The connector's own sync() is not run at all: the scheduler records the no-op itself.
      expect(syncCalls).toBe(0);
      expect(rows).toHaveLength(0);
    });

    test("the SAME connector ledgers a row once its Vault credential is set", async () => {
      const db = openMemoryIndexDatabase();
      const ctx = testContext(db);
      await ctx.vault.set("github.pat", "t");
      const rows: Array<{ destination: string; sourceType: string; method: string }> = [];
      const sched = new SyncScheduler(ctx, undefined, {
        appendSyncEgress: (r) => rows.push(r),
      });
      sched.register({
        serviceId: "github",
        defaultIntervalMs: 60_000,
        initialSyncDepthDays: 30,
        async sync(): Promise<SyncResult> {
          return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
        },
      });

      await sched.forceSync("github");
      await sched.stop();

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ destination: "github", sourceType: "sync" });
    });

    test("multiple unconfigured cloud connectors, force-synced, ledger ZERO rows total", async () => {
      const db = openMemoryIndexDatabase();
      const ctx = testContext(db);
      const rows: Array<{ destination: string; sourceType: string; method: string }> = [];
      const sched = new SyncScheduler(ctx, undefined, {
        appendSyncEgress: (r) => rows.push(r),
      });
      for (const serviceId of ["github", "slack", "notion"]) {
        sched.register({
          serviceId,
          defaultIntervalMs: 60_000,
          initialSyncDepthDays: 30,
          async sync(): Promise<SyncResult> {
            return {
              cursor: null,
              itemsUpserted: 0,
              itemsDeleted: 0,
              hasMore: false,
              durationMs: 0,
            };
          },
        });
      }

      await Promise.all(["github", "slack", "notion"].map((id) => sched.forceSync(id)));
      await sched.stop();

      expect(rows).toHaveLength(0);
    });
  });
});

describe("SyncScheduler — one-shot history floor", () => {
  /** A syncable that records the `historyFloorMs` it was handed on each run. */
  function recordingSyncable(
    seen: Array<number | undefined>,
    onRun?: (call: number) => void,
  ): Syncable {
    let calls = 0;
    return {
      serviceId: "jira",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(ctx): Promise<SyncResult> {
        seen.push(ctx.historyFloorMs);
        calls += 1;
        onRun?.(calls);
        return { cursor: "c1", itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
  }

  /** `jira` is a real manifest id: seed its credential so the run is not skipped as unconfigured. */
  async function jiraContext(db: Database): Promise<SyncRuntimeContext> {
    const ctx = testContext(db);
    await ctx.vault.set("jira.api_token", "t");
    return ctx;
  }

  test("setHistoryFloor reaches the connector on the next run", async () => {
    const db = openMemoryIndexDatabase();
    const seen: Array<number | undefined> = [];
    const sched = new SyncScheduler(await jiraContext(db));
    sched.register(recordingSyncable(seen));

    const floor = Date.parse("2024-01-01T00:00:00.000Z");
    sched.setHistoryFloor("jira", floor);
    await sched.forceSync("jira");
    sched.stop();

    expect(seen).toEqual([floor]);
  });

  test("the floor is consumed by a successful run and not reused", async () => {
    const db = openMemoryIndexDatabase();
    const seen: Array<number | undefined> = [];
    const sched = new SyncScheduler(await jiraContext(db));
    sched.register(recordingSyncable(seen));

    sched.setHistoryFloor("jira", 1_700_000_000_000);
    await sched.forceSync("jira");
    await sched.forceSync("jira");
    sched.stop();

    expect(seen).toEqual([1_700_000_000_000, undefined]);
  });

  test("a rate-limited run KEEPS the floor for the retry", async () => {
    // The scheduler returns without persisting a cursor on RateLimitError, so
    // the next attempt is still a cold start. Dropping the floor here would
    // silently narrow the retry back to 30 days and the backfill would never
    // complete.
    const db = openMemoryIndexDatabase();
    const seen: Array<number | undefined> = [];
    const sched = new SyncScheduler(await jiraContext(db), {}, { random: () => 0 });
    sched.register(
      recordingSyncable(seen, (call) => {
        if (call === 1) {
          throw new RateLimitError(new Date(Date.now() + 1000), "rate limited");
        }
      }),
    );

    sched.setHistoryFloor("jira", 1_700_000_000_000);
    await sched.forceSync("jira").catch(() => undefined);
    await sched.forceSync("jira");
    sched.stop();

    expect(seen).toEqual([1_700_000_000_000, 1_700_000_000_000]);
  });
});

describe("SyncScheduler records whether a run had a credential at all (F6/F13)", () => {
  afterEach(() => setGatewayEventBroadcast(undefined));

  /**
   * ~90 registered syncables short-circuit to a network-free no-op when unconfigured, and the
   * scheduler recorded `sync_success` after every run regardless. So a connector nobody had set
   * up ended up with `healthy` and a fresh `lastSyncAt` — which is what `getConnectorStatus`
   * served to a model, and what `nimbus doctor` and `connector list` showed a human.
   *
   * `isConnectorConfigured` was already computed here, for the I29 egress gate, ~10 lines above
   * the site that lied.
   */
  function syncableNamed(serviceId: string, onRun: () => void): Syncable {
    return {
      serviceId,
      defaultIntervalMs: 10,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        onRun();
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
  }

  test("a run with no credential does not call sync() and leaves the connector not_configured", async () => {
    // The scheduler already knows the answer before `sync()`: running it anyway only made each
    // connector re-probe the Vault (one `secret-tool` spawn per key on Linux) to reach the same no-op.
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const sched = new SyncScheduler(ctx, {});
    // `jenkins` has manifest keys and the memory vault holds none of them.
    sched.register(syncableNamed("jenkins", () => (runs += 1)));
    sched.start();
    await sleep(120);
    await sched.stop();

    expect(runs).toBe(0);
    expect(getConnectorHealth(db, "jenkins").state).toBe("not_configured");
    expect(loadSchedulerState(db, "jenkins")?.last_sync_at).not.toBeNull();
  });

  test("the skipped run records exactly what an unconfigured no-op run recorded", async () => {
    // Health not_configured, status ok, lastSyncAt set, one telemetry row, NO sync.run egress row,
    // the onConnectorSyncSuccess hook, the cursor kept, and the next run at the normal interval.
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const egress: unknown[] = [];
    const hooked: Array<{ id: string; result: SyncResult }> = [];
    const sched = new SyncScheduler(
      ctx,
      {},
      {
        appendSyncEgress: (r) => egress.push(r),
        onConnectorSyncSuccess: (id, result) => hooked.push({ id, result }),
      },
    );
    let runs = 0;
    sched.register({
      serviceId: "jenkins",
      defaultIntervalMs: 600_000,
      initialSyncDepthDays: 30,
      // What every unconfigured built-in connector's own sync() returned before this change.
      async sync(_ctx, cursor): Promise<SyncResult> {
        runs += 1;
        return syncNoopResult(cursor, performance.now());
      },
    });
    dbRun(db, "UPDATE scheduler_state SET cursor = ? WHERE service_id = ?", ["kept", "jenkins"]);
    const before = Date.now();
    await sched.forceSync("jenkins");
    await sched.stop();

    expect(runs).toBe(0);
    const row = loadSchedulerState(db, "jenkins");
    expect(row?.status).toBe("ok");
    expect(row?.cursor).toBe("kept");
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.last_sync_at ?? 0).toBeGreaterThanOrEqual(before);
    expect((row?.next_sync_at ?? 0) - (row?.last_sync_at ?? 0)).toBe(600_000);
    expect(getConnectorHealth(db, "jenkins").state).toBe("not_configured");
    expect(egress).toEqual([]);
    const telemetry = db
      .query("SELECT items_upserted, had_more, error_msg FROM sync_telemetry WHERE service = ?")
      .all("jenkins");
    expect(telemetry).toEqual([{ items_upserted: 0, had_more: 0, error_msg: null }]);
    expect(hooked).toHaveLength(1);
    expect(hooked[0]?.id).toBe("jenkins");
    expect(hooked[0]?.result).toMatchObject({
      cursor: "kept",
      itemsUpserted: 0,
      itemsDeleted: 0,
      hasMore: false,
    });
  });

  test("the very first run of an unconfigured connector already reports not_configured", async () => {
    const db = openMemoryIndexDatabase();
    const sched = new SyncScheduler(testContext(db), {});
    sched.register(syncableNamed("jenkins", () => undefined));
    await sched.forceSync("jenkins");
    await sched.stop();

    expect(getConnectorHealth(db, "jenkins").state).toBe("not_configured");
    const row = db
      .query("SELECT configured, depth FROM sync_state WHERE connector_id = ?")
      .get("jenkins");
    expect(row).toEqual({ configured: 0, depth: "full" });
  });

  test("and announces no healthy transition", async () => {
    const db = openMemoryIndexDatabase();
    const seen: Array<{ method: string; params: Record<string, unknown> }> = [];
    setGatewayEventBroadcast((method, params) => seen.push({ method, params }));
    const sched = new SyncScheduler(testContext(db), {});
    sched.register(syncableNamed("jenkins", () => undefined));
    await sched.forceSync("jenkins");
    await sched.stop();

    const healthy = seen.filter(
      (e) =>
        e.method === "connector.healthChanged" &&
        e.params["name"] === "jenkins" &&
        e.params["health"] === "healthy",
    );
    expect(healthy).toEqual([]);
  });

  test("forceSync on an unconfigured service resolves without calling sync()", async () => {
    const db = openMemoryIndexDatabase();
    let runs = 0;
    const sched = new SyncScheduler(testContext(db), {});
    sched.register(syncableNamed("jenkins", () => (runs += 1)));
    await sched.forceSync("jenkins");
    await sched.stop();

    expect(runs).toBe(0);
  });

  test("a local-only service (filesystem) and a non-manifest id still call sync() with an empty Vault", async () => {
    // Neither has a manifest entry, so nothing in the Vault can say they are unconfigured.
    const db = openMemoryIndexDatabase();
    const seen: string[] = [];
    const sched = new SyncScheduler(testContext(db), {});
    sched.register(syncableNamed("filesystem", () => seen.push("filesystem")));
    sched.register(syncableNamed("user_mcp_local", () => seen.push("user_mcp_local")));
    await sched.forceSync("filesystem");
    await sched.forceSync("user_mcp_local");
    await sched.stop();

    expect(seen).toContain("filesystem");
    expect(seen).toContain("user_mcp_local");
  });

  test("an approved extension whose grant credentials are blank is not started; once set, it is", async () => {
    const db = openMemoryIndexDatabase();
    const vault = createMemoryVault();
    const ctx: SyncRuntimeContext = {
      ...testContext(db),
      vault,
      extensionCredentialsFor: (id) =>
        id === "ext_a_b" ? { token: { env: "T", vaultKey: "ext.ext_a_b.token" } } : undefined,
    };
    let runs = 0;
    const sched = new SyncScheduler(ctx, {});
    sched.register(syncableNamed("ext_a_b", () => (runs += 1)));

    await vault.set("ext.ext_a_b.token", "  ");
    await sched.forceSync("ext_a_b");
    expect(runs).toBe(0);

    await vault.set("ext.ext_a_b.token", "secret");
    await sched.forceSync("ext_a_b");
    await sched.stop();
    expect(runs).toBe(1);
  });

  describe("a warehouse connector pinned to a team credential", () => {
    function teamPinnedContext(db: Database): SyncRuntimeContext {
      return {
        ...testContext(db),
        credentialFor: (service) =>
          service === "snowflake"
            ? { credential: "team", teamEntry: "acme" }
            : { credential: "personal" },
      };
    }

    test("with the team entry's secrets set, sync() runs and one sync.run egress row is recorded", async () => {
      const db = openMemoryIndexDatabase();
      const ctx = teamPinnedContext(db);
      // The bare `snowflake.*` keys stay empty: a team run never reads them.
      await ctx.vault.set("teamvault.acme.snowflake.account", "acct");
      const egress: Array<{ destination: string; method: string }> = [];
      let runs = 0;
      const sched = new SyncScheduler(ctx, {}, { appendSyncEgress: (r) => egress.push(r) });
      sched.register(syncableNamed("snowflake", () => (runs += 1)));
      await sched.forceSync("snowflake");
      await sched.stop();

      expect(runs).toBe(1);
      expect(egress).toEqual([
        expect.objectContaining({ destination: "snowflake", method: "sync.run" }),
      ]);
      expect(getConnectorHealth(db, "snowflake").state).toBe("healthy");
    });

    test("with an empty team entry, the run is skipped and records no egress row", async () => {
      const db = openMemoryIndexDatabase();
      const ctx = teamPinnedContext(db);
      // A personal key does not count for a team-pinned service.
      await ctx.vault.set("snowflake.account", "acct");
      const egress: unknown[] = [];
      let runs = 0;
      const sched = new SyncScheduler(ctx, {}, { appendSyncEgress: (r) => egress.push(r) });
      sched.register(syncableNamed("snowflake", () => (runs += 1)));
      await sched.forceSync("snowflake");
      await sched.forceSync("snowflake");
      await sched.stop();

      expect(runs).toBe(0);
      expect(egress).toEqual([]);
      expect(getConnectorHealth(db, "snowflake").state).toBe("not_configured");
    });

    test("a personal warehouse keeps the manifest-key check", async () => {
      const db = openMemoryIndexDatabase();
      const ctx = testContext(db);
      let runs = 0;
      const sched = new SyncScheduler(ctx, {});
      sched.register(syncableNamed("snowflake", () => (runs += 1)));
      await sched.forceSync("snowflake");
      expect(runs).toBe(0);

      await ctx.vault.set("snowflake.account", "acct");
      await sched.forceSync("snowflake");
      await sched.stop();
      expect(runs).toBe(1);
    });
  });

  test("a run WITH a credential reports healthy", async () => {
    // The other direction: without this the fix could be "always not_configured", which would
    // report every working connector as unset.
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    await ctx.vault.set("jenkins.base_url", "https://ci.example.com");
    const sched = new SyncScheduler(ctx, {});
    sched.register(syncableNamed("jenkins", () => {}));
    sched.start();
    await sleep(120);
    await sched.stop();

    expect(getConnectorHealth(db, "jenkins").state).toBe("healthy");
  });
});

describe("per-service capability binding", () => {
  // The scoping MUST bind per service, not per gateway: `syncBase` in assemble.ts is built once and
  // shared by every connector, so binding there would scope all of them to whichever id was passed
  // first. `runJob` and `syncContextFor` are the first points that know the service.
  function ctxWithVaultSpy(db: Database): { ctx: SyncRuntimeContext; asked: string[] } {
    const asked: string[] = [];
    // Every key answers non-blank, so the service counts as configured and its `sync()` runs:
    // an unconfigured service's run is skipped before the syncable could read anything.
    const vault = {
      get: (key: string) => {
        asked.push(key);
        return Promise.resolve("seeded");
      },
    } as unknown as SyncRuntimeContext["vault"];
    return { ctx: { ...testContext(db), vault }, asked };
  }

  function secretReadingSyncable(serviceId: string): Syncable {
    return {
      serviceId,
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(ctx): Promise<SyncResult> {
        // `base_url`, not the first manifest key: the scheduler's configured-check reads keys in
        // manifest order and stops at the first non-blank one (`jira.api_token`), so only a later
        // key proves the read came from the syncable's bound `getSecret`.
        await ctx.getSecret?.("base_url" as never);
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
  }

  test("getSecret prefixes the service whose job is running", async () => {
    // One syncable per scheduler: registering several makes the scheduler run all of them, and
    // `isConnectorConfigured` probes each one's vault keys, which is normal behaviour rather than a
    // scoping violation. Isolating keeps the assertion about the capability.
    async function keysAskedDuring(serviceId: string): Promise<string[]> {
      const db = openMemoryIndexDatabase();
      LocalIndex.ensureSchema(db);
      const { ctx, asked } = ctxWithVaultSpy(db);
      const scheduler = new SyncScheduler(ctx);
      scheduler.register(secretReadingSyncable(serviceId));
      await scheduler.forceSync(serviceId);
      return asked;
    }

    expect(await keysAskedDuring("jira")).toContain("jira.base_url");
    expect(await keysAskedDuring("linear")).toContain("linear.base_url");

    // The same key NAME, bound to a different service, resolves a different vault key. That is the
    // whole property: today `ctx.vault.get("jira.api_token")` works from inside linear's syncable.
    const fromLinear = await keysAskedDuring("linear");
    expect(fromLinear.filter((k) => k.startsWith("jira."))).toEqual([]);
  });

  test("syncContextFor binds capabilities too — the targeted-fetch path", async () => {
    // assemble.ts routes POST /v1/items/fetch through syncContextFor, NOT runJob. A capability
    // bound only in runJob would be undefined here and, being Partial during the migration, would
    // fail silently rather than at compile time.
    const db = openMemoryIndexDatabase();
    LocalIndex.ensureSchema(db);
    const { ctx, asked } = ctxWithVaultSpy(db);
    const scheduler = new SyncScheduler(ctx);

    const fetchCtx = scheduler.syncContextFor("jira");
    expect(typeof fetchCtx.getSecret).toBe("function");
    await fetchCtx.getSecret?.("api_token" as never);
    expect(asked).toEqual(["jira.api_token"]);
  });
});

describe("syncDisabled", () => {
  // A demo-rooted gateway's scheduler must never run a job (I41 clause 6, spec § 11.2):
  // `syncDisabled` is the choke point inside the scheduler itself, not `!started` — `forceSync`
  // needs no `start()` and every finished job's `.finally` re-triggers `tick()`.
  function recordingSyncable(serviceId: string): { syncable: Syncable; calls: () => number } {
    let calls = 0;
    const syncable: Syncable = {
      serviceId,
      defaultIntervalMs: 25,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        calls += 1;
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };
    return { syncable, calls: () => calls };
  }

  test("forceSync rejects with ERR_SYNC_DISABLED and never runs the syncable", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const { syncable: fake, calls: fakeSyncCalls } = recordingSyncable("demo-svc");
    const scheduler = new SyncScheduler(ctx, undefined, { syncDisabled: true });
    scheduler.register(fake);
    await expect(scheduler.forceSync(fake.serviceId)).rejects.toThrow("ERR_SYNC_DISABLED");
    expect(fakeSyncCalls()).toBe(0);
  });

  test("register writes no scheduler state and start() schedules nothing", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const { syncable: fake, calls: fakeSyncCalls } = recordingSyncable("demo-svc");
    const scheduler = new SyncScheduler(ctx, undefined, { syncDisabled: true });
    scheduler.register(fake);
    scheduler.start();
    await sleep(80); // > 3 of the 25 ms tick intervals
    expect(fakeSyncCalls()).toBe(0);
    expect(scheduler.getStatus()).toEqual([]);
    await scheduler.stop();
  });

  test("without the option, behaviour is unchanged (negative control)", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    const { syncable: fake, calls: fakeSyncCalls } = recordingSyncable("demo-svc");
    const scheduler = new SyncScheduler(ctx, undefined, {});
    scheduler.register(fake);
    await scheduler.forceSync(fake.serviceId);
    expect(fakeSyncCalls()).toBe(1);
    await scheduler.stop();
  });
});

// I29: a registered user MCP server is picked up by this scheduler, but its "sync" only ensures the
// server process is running — no connector request — so the REAL appender (`recordSyncEgress`)
// must append nothing for it, decided from the `user_mcp_connector` row rather than a caller flag.
describe("appendSyncEgress — user MCP servers append no sync.run row", () => {
  function egressCount(db: Database, destination: string): number {
    return (
      db
        .query(
          "SELECT COUNT(*) AS n FROM egress_ledger WHERE source_type = 'sync' AND destination = ?",
        )
        .get(destination) as { n: number }
    ).n;
  }

  test("a run for a registered user-MCP id appends 0 rows; a normal connector still appends 1", async () => {
    const db = openMemoryIndexDatabase();
    insertUserMcpConnector(db, {
      service_id: "mcp_local_tool",
      command: "node",
      args_json: "[]",
      read_paths_json: "[]",
      net_hosts_json: "[]",
      model_access: 0,
    });
    const sched = new SyncScheduler(testContext(db), undefined, {
      appendSyncEgress: (row) => recordSyncEgress(db, { ...row, now: Date.now() }),
    });
    let ensured = 0;
    sched.register(
      createUserMcpSyncable("mcp_local_tool", async () => {
        ensured += 1;
      }),
    );
    sched.register({
      serviceId: "egress-normal-svc",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    });

    // The normal connector first: a forced run's trailing tick would otherwise pick it up as due
    // and run it a second time.
    await sched.forceSync("egress-normal-svc");
    await sched.forceSync("mcp_local_tool");
    await sched.stop();

    expect(ensured).toBeGreaterThanOrEqual(1);
    expect(egressCount(db, "mcp_local_tool")).toBe(0);
    expect(egressCount(db, "egress-normal-svc")).toBe(1);
  });
});

describe("sync_telemetry.items_dropped", () => {
  function telemetry(db: Database, service: string): Array<{ items_dropped: number }> {
    return db
      .query("SELECT items_dropped FROM sync_telemetry WHERE service = ? ORDER BY id")
      .all(service) as Array<{ items_dropped: number }>;
  }

  test("a success with `dropped` writes the sum of its three counts", async () => {
    const db = openMemoryIndexDatabase();
    const sched = new SyncScheduler(testContext(db));
    sched.register({
      ...okSyncable("drops"),
      async sync(): Promise<SyncResult> {
        return {
          cursor: null,
          itemsUpserted: 1,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 0,
          dropped: { undeclaredType: 1, malformed: 2, oversized: 4 },
        };
      },
    });
    await sched.forceSync("drops");
    await sched.stop();
    expect(telemetry(db, "drops")).toEqual([{ items_dropped: 7 }]);
  });

  test("a success without `dropped`, and a failed run, write 0", async () => {
    const db = openMemoryIndexDatabase();
    const sched = new SyncScheduler(testContext(db), {}, { random: () => 0 });
    sched.register(okSyncable("plain"));
    sched.register(throwingSyncable("boom", new Error("boom")));
    sched.register(throwingSyncable("rl", new RateLimitError(new Date(Date.now() + 60_000))));
    await sched.forceSync("plain");
    await sched.forceSync("boom").catch(() => undefined);
    await sched.forceSync("rl").catch(() => undefined);
    await sched.stop();
    // A tick between the forced runs may also start a due one, so count rows loosely.
    for (const service of ["plain", "boom", "rl"]) {
      const rows = telemetry(db, service);
      expect(rows.length).toBeGreaterThan(0);
      expect(new Set(rows.map((r) => r.items_dropped))).toEqual(new Set([0]));
    }
  });
});

describe("pauseIfPreflightRefuses / resumeOrPauseForConfinement", () => {
  function fakeScheduler(syncable: { preflight?: () => string | null } | undefined): {
    calls: string[];
    s: {
      syncableFor(id: string): { preflight?: () => string | null } | undefined;
      pause(id: string, reason?: string): void;
      resume(id: string): void;
    };
  } {
    const calls: string[] = [];
    return {
      calls,
      s: {
        syncableFor: () => syncable,
        pause: (id, reason) => calls.push(`pause ${id}: ${reason ?? "(none)"}`),
        resume: (id) => calls.push(`resume ${id}`),
      },
    };
  }

  test("nothing registered under the id is no refusal: resume, and no pause", () => {
    const f = fakeScheduler(undefined);
    expect(pauseIfPreflightRefuses(f.s, "svc")).toBe(false);
    expect(f.calls).toEqual([]);
    resumeOrPauseForConfinement(f.s, "svc");
    expect(f.calls).toEqual(["resume svc"]);
  });

  test("a syncable without a preflight, or one that passes, resumes", () => {
    for (const syncable of [{}, { preflight: () => null }]) {
      const f = fakeScheduler(syncable);
      resumeOrPauseForConfinement(f.s, "svc");
      expect(f.calls).toEqual(["resume svc"]);
    }
  });

  test("a refusal pauses with it verbatim and never resumes", () => {
    const REASON = "sandbox cannot confine this extension: no helper";
    const syncable = { preflight: () => REASON };
    const f = fakeScheduler(syncable);
    expect(pauseIfPreflightRefuses(f.s, "svc")).toBe(true);
    expect(f.calls).toEqual([`pause svc: ${REASON}`]);
    const g = fakeScheduler(syncable);
    resumeOrPauseForConfinement(g.s, "svc");
    expect(g.calls).toEqual([`pause svc: ${REASON}`]);
    // The same text the scheduler's due run records.
    expect(preflightRefusal(syncable)).toBe(REASON);
  });

  test("a throwing preflight pauses with `preflight failed: …` (fail closed)", () => {
    const f = fakeScheduler({
      preflight: () => {
        throw new Error("grant vanished");
      },
    });
    resumeOrPauseForConfinement(f.s, "svc");
    expect(f.calls).toEqual(["pause svc: preflight failed: grant vanished"]);
  });
});
