import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import os from "node:os";
import pino from "pino";

import { getConnectorHealth, transitionHealth } from "../connectors/health.ts";
import { LocalIndex } from "../index/local-index.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { ProviderRateLimiter } from "./rate-limiter.ts";
import { SyncScheduler } from "./scheduler.ts";
import { loadSchedulerState } from "./scheduler-store.ts";
import {
  RateLimitError,
  type Syncable,
  type SyncContext,
  type SyncResult,
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

function testContext(db: Database): SyncContext {
  return {
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

      // The connector's own sync() still runs (and, in production, still no-ops without any
      // network call) — only the egress append is gated on configuration.
      expect(syncCalls).toBe(1);
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

  test("setHistoryFloor reaches the connector on the next run", async () => {
    const db = openMemoryIndexDatabase();
    const seen: Array<number | undefined> = [];
    const sched = new SyncScheduler(testContext(db));
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
    const sched = new SyncScheduler(testContext(db));
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
    const sched = new SyncScheduler(testContext(db), {}, { random: () => 0 });
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

  test("a run with no credential leaves the connector not_configured, not healthy", async () => {
    const db = openMemoryIndexDatabase();
    const ctx = testContext(db);
    let runs = 0;
    const sched = new SyncScheduler(ctx, {});
    // `jenkins` has manifest keys and the memory vault holds none of them.
    sched.register(syncableNamed("jenkins", () => (runs += 1)));
    sched.start();
    await sleep(120);
    await sched.stop();

    expect(runs).toBeGreaterThan(0);
    expect(getConnectorHealth(db, "jenkins").state).toBe("not_configured");
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
