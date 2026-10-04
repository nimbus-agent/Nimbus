/**
 * Coverage for the `SyncScheduler` gates `scheduler.test.ts` does not reach: the dispatch gate for a
 * job that is already QUEUED when its connector's state changes, the force path's edge cases, the
 * connectivity recheck timer, and the double-check `runJob` makes before running anything.
 *
 * Every test injects `isOnline` — the default probe is a real DNS lookup — and waits on events
 * (deferreds resolved by the fixture) rather than on wall-clock sleeps. `within` only bounds a wait
 * so a regression fails in two seconds instead of hanging to the runner's timeout.
 */
import type { Database } from "bun:sqlite";
import { describe, expect, jest, test } from "bun:test";
import os from "node:os";
import pino from "pino";
import {
  getConnectorHealth,
  getConnectorHealthHistory,
  transitionHealth,
} from "../connectors/health.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { ProviderRateLimiter } from "./rate-limiter.ts";
import { SyncScheduler } from "./scheduler.ts";
import {
  type SchedulerStateRow,
  SqliteSchedulerStateRepository,
} from "./scheduler-state-repository.ts";
import { unboundSyncCapabilities } from "./sync-capabilities.ts";
import type { Syncable, SyncResult, SyncRuntimeContext, SyncStatus } from "./types.ts";
import { UnauthenticatedError } from "./types.ts";

type Deferred<T> = { promise: Promise<T>; resolve: (value: T) => void };

function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** Awaits `p`, failing fast with `label` if it has not settled within `ms`. */
async function within<T>(p: Promise<T>, label: string, ms = 2_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** One macrotask turn — every microtask queued so far (a run's `.finally` → `pump`) has run. */
function macrotask(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}

/** Drains the microtask queue without touching timers — safe while fake timers are installed. */
async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 100; i += 1) {
    await Promise.resolve();
  }
}

const OK: SyncResult = {
  cursor: null,
  itemsUpserted: 0,
  itemsDeleted: 0,
  hasMore: false,
  durationMs: 0,
};

const online = async (): Promise<boolean> => true;

function ctxFor(db: Database, extra: Partial<SyncRuntimeContext> = {}): SyncRuntimeContext {
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
    ...extra,
  };
}

type Probe = {
  syncable: Syncable;
  calls: () => number;
  /** Resolves on the FIRST `sync()` call. */
  entered: Promise<void>;
};

/** A syncable that counts its calls; `run` decides each call's outcome (default: succeed now). */
function probe(
  serviceId: string,
  run: (call: number) => Promise<SyncResult> = async () => OK,
  intervalMs = 60_000,
): Probe {
  let n = 0;
  const entered = deferred();
  return {
    syncable: {
      serviceId,
      defaultIntervalMs: intervalMs,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        n += 1;
        entered.resolve();
        return run(n);
      },
    },
    calls: () => n,
    entered: entered.promise,
  };
}

function telemetryBytes(db: Database, service: string): Array<number | null> {
  return (
    db
      .query(`SELECT bytes_transferred FROM sync_telemetry WHERE service = ? ORDER BY id`)
      .all(service) as Array<{ bytes_transferred: number | null }>
  ).map((r) => r.bytes_transferred);
}

describe("SyncScheduler — public readers", () => {
  test("syncableFor returns this scheduler's own registered connector, undefined otherwise", async () => {
    const db = openMemoryIndexDatabase();
    const sched = new SyncScheduler(ctxFor(db), {}, { isOnline: online });
    const a = probe("alpha");
    sched.register(a.syncable);
    expect(sched.syncableFor("alpha")).toBe(a.syncable);
    expect(sched.syncableFor("beta")).toBeUndefined();
    sched.unregister("alpha");
    expect(sched.syncableFor("alpha")).toBeUndefined();
    await sched.stop();
    db.close();
  });

  test("syncContextFor binds the runtime's resolveServiceId and scheduleItemEmbedding", async () => {
    const db = openMemoryIndexDatabase();
    const resolved: string[] = [];
    const scheduled: string[] = [];
    const sched = new SyncScheduler(
      ctxFor(db, {
        resolveServiceId: (item) => {
          resolved.push(`${item.service}/${item.type}`);
          return { kind: "unknown" };
        },
        scheduleItemEmbedding: (itemId) => {
          scheduled.push(itemId);
        },
      }),
      {},
      { isOnline: online },
    );
    const ctx = sched.syncContextFor("pagerduty");
    // An `incident` is one of the two graph types that consult resolveServiceId.
    ctx.upsertItem({
      service: "pagerduty",
      type: "incident",
      externalId: "P1",
      title: "Checkout is down",
      modifiedAt: 1_700_000_000_000,
      syncedAt: 1_700_000_000_000,
      metadata: {},
    });
    expect(resolved).toEqual(["pagerduty/incident"]);
    expect(scheduled).toEqual(["pagerduty:P1"]);
    await sched.stop();
    db.close();
  });

  test("getStatus reports a rate-limited connector's retry instant", async () => {
    const db = openMemoryIndexDatabase();
    const sched = new SyncScheduler(ctxFor(db), {}, { isOnline: online });
    sched.register(probe("limited").syncable);
    sched.register(probe("fine").syncable);
    const retryAt = new Date(Date.UTC(2031, 0, 2, 3, 4, 5));
    transitionHealth(db, "limited", { type: "rate_limited", retryAfter: retryAt });
    transitionHealth(db, "fine", { type: "sync_success" });

    const [limited] = sched.getStatus("limited");
    expect(limited?.healthState).toBe("rate_limited");
    expect(limited?.healthRetryAfterMs).toBe(retryAt.getTime());
    const [fine] = sched.getStatus("fine");
    expect(fine?.healthState).toBe("healthy");
    expect(fine?.healthRetryAfterMs).toBeNull();
    await sched.stop();
    db.close();
  });
});

describe("SyncScheduler — run outcomes", () => {
  test("catchUpOnRestart runs an overdue connector at start instead of pushing it back", async () => {
    const db = openMemoryIndexDatabase();
    const overdue = probe("overdue");
    const sched = new SyncScheduler(ctxFor(db), { catchUpOnRestart: true }, { isOnline: online });
    sched.register(overdue.syncable);
    const tenMinutesAgo = Date.now() - 10 * 60_000;
    db.run(`UPDATE scheduler_state SET next_sync_at = ? WHERE service_id = ?`, [
      tenMinutesAgo,
      "overdue",
    ]);
    sched.start();
    await within(overdue.entered, "the overdue connector to run on start");
    await sched.stop();
    expect(overdue.calls()).toBe(1);
    db.close();
  });

  test("without catch-up, a connector only just overdue (inside the startup slack) still runs at start", async () => {
    const db = openMemoryIndexDatabase();
    const barely = probe("barely");
    const sched = new SyncScheduler(ctxFor(db), { catchUpOnRestart: false }, { isOnline: online });
    sched.register(barely.syncable);
    // 1 ms overdue — strictly before start()'s clock, and 249 ms inside the 250 ms slack — so the
    // restart pass re-arms it for NOW rather than a full interval out.
    db.run(`UPDATE scheduler_state SET next_sync_at = ? WHERE service_id = ?`, [
      Date.now() - 1,
      "barely",
    ]);
    sched.start();
    await within(barely.entered, "the barely-overdue connector to run on start");
    await sched.stop();
    expect(barely.calls()).toBe(1);
    db.close();
  });

  test("a non-Error, non-string throw is reported in its string form", async () => {
    const db = openMemoryIndexDatabase();
    const sched = new SyncScheduler(ctxFor(db), {}, { isOnline: online, random: () => 0 });
    sched.register(
      probe("numeric", async () => {
        throw 42;
      }).syncable,
    );
    await expect(within(sched.forceSync("numeric"), "the failing run")).rejects.toThrow(/^42$/);
    expect(sched.getStatus("numeric")[0]?.lastError).toBe("42");
    await sched.stop();
    db.close();
  });

  test("bytesTransferred is floored into telemetry; a non-finite value is recorded as null", async () => {
    const db = openMemoryIndexDatabase();
    const sched = new SyncScheduler(ctxFor(db), {}, { isOnline: online });
    const results: SyncResult[] = [
      { ...OK, bytesTransferred: 1234.9 },
      { ...OK, bytesTransferred: Number.POSITIVE_INFINITY },
      { ...OK, bytesTransferred: Number.NaN },
      OK,
    ];
    sched.register(probe("bytes", async (call) => results[call - 1] ?? OK).syncable);
    for (let i = 0; i < results.length; i += 1) {
      await within(sched.forceSync("bytes"), `run ${i + 1}`);
    }
    expect(telemetryBytes(db, "bytes")).toEqual([1234, null, null, null]);
    await sched.stop();
    db.close();
  });

  test("a scheduled UnauthenticatedError notifies and marks the connector unauthenticated", async () => {
    const db = openMemoryIndexDatabase();
    const notified = deferred<{ title: string; body: string }>();
    const sched = new SyncScheduler(
      ctxFor(db),
      {},
      {
        isOnline: online,
        notify: async (title, body) => {
          notified.resolve({ title, body });
        },
      },
    );
    const authFail = probe("authfail", async () => {
      throw new UnauthenticatedError();
    });
    sched.register(authFail.syncable);
    sched.start();
    const { title, body } = await within(notified.promise, "the lost-auth notification");
    await sched.stop();
    expect(title).toBe("Nimbus connector lost authentication");
    expect(body).toBe(
      "authfail connector lost authentication. Run: nimbus connector auth authfail",
    );
    expect(getConnectorHealth(db, "authfail").state).toBe("unauthenticated");
    // An auth loss is not a sync failure: no backoff is recorded against the connector.
    expect(sched.getStatus("authfail")[0]?.consecutiveFailures).toBe(0);
    expect(authFail.calls()).toBe(1);
    db.close();
  });
});

describe("SyncScheduler — connectivity", () => {
  test("an offline probe records a skip for a runnable connector, never for a paused or errored one", async () => {
    const db = openMemoryIndexDatabase();
    const probed = deferred();
    const sched = new SyncScheduler(
      ctxFor(db),
      {},
      {
        initialOnline: false,
        isOnline: async () => {
          probed.resolve();
          return false;
        },
      },
    );
    for (const id of ["runnable", "paused", "errored"]) {
      sched.register(probe(id).syncable);
    }
    transitionHealth(db, "runnable", { type: "sync_success" });
    sched.pause("paused");
    transitionHealth(db, "errored", { type: "persistent_error", error: "gave up" });
    sched.start();
    await within(probed.promise, "the connectivity probe");
    await macrotask();
    await sched.stop();

    const skips = (id: string) =>
      getConnectorHealthHistory(db, id).filter((h) => h.reason === "skipped (offline)").length;
    expect(skips("runnable")).toBe(1);
    expect(skips("paused")).toBe(0);
    expect(skips("errored")).toBe(0);
    expect(getConnectorHealth(db, "paused").state).toBe("paused");
    expect(getConnectorHealth(db, "errored").state).toBe("error");
    db.close();
  });

  test("a probe that comes back online only after stop() starts no run", async () => {
    const db = openMemoryIndexDatabase();
    const answer = deferred<boolean>();
    const probed = deferred();
    const sched = new SyncScheduler(
      ctxFor(db),
      {},
      {
        // Start offline so start()'s own synchronous tick queues nothing; the probe decides.
        initialOnline: false,
        isOnline: () => {
          probed.resolve();
          return answer.promise;
        },
      },
    );
    const due = probe("due");
    sched.register(due.syncable);
    sched.start();
    await within(probed.promise, "the start-up probe");
    await sched.stop();
    answer.resolve(true);
    await macrotask();
    await macrotask();
    expect(due.calls()).toBe(0);
    expect(sched.getStatus("due")[0]?.status).toBe("ok");
    db.close();
  });

  test("going offline arms a 30 s recheck that re-probes and runs the connector it skipped", async () => {
    const db = openMemoryIndexDatabase();
    let networkUp = false;
    let probes = 0;
    const sched = new SyncScheduler(
      ctxFor(db),
      {},
      {
        initialOnline: false,
        isOnline: async () => {
          probes += 1;
          return networkUp;
        },
      },
    );
    const net = probe("net");
    sched.register(net.syncable);
    jest.useFakeTimers();
    try {
      sched.start();
      await flushMicrotasks();
      expect(probes).toBe(1);
      expect(net.calls()).toBe(0);

      networkUp = true;
      // The 25 ms tick keeps firing meanwhile, but only the recheck probes the network.
      jest.advanceTimersByTime(29_999);
      await flushMicrotasks();
      expect(probes).toBe(1);
      expect(net.calls()).toBe(0);

      jest.advanceTimersByTime(1);
      await flushMicrotasks();
      expect(probes).toBe(2);
      expect(net.calls()).toBe(1);
      // `stop()` drains on a 10 ms poll, which fake timers would never fire: prove nothing is in flight.
      expect(sched.getStatus("net")[0]?.status).toBe("ok");
      await sched.stop();
    } finally {
      jest.useRealTimers();
    }
    db.close();
  });
});

describe("SyncScheduler — a job already queued behind a full slot", () => {
  type Hold = {
    name: string;
    block: (db: Database, sched: SyncScheduler, id: string) => void;
    statusWhileHeld: SyncStatus["status"];
    unblock: (db: Database, sched: SyncScheduler, id: string) => void;
  };
  const holds: Hold[] = [
    {
      name: "rate-limited within its retry window",
      block: (db, _s, id) => {
        transitionHealth(db, id, {
          type: "rate_limited",
          retryAfter: new Date(Date.now() + 60_000),
        });
      },
      statusWhileHeld: "ok",
      unblock: (db, _s, id) => {
        transitionHealth(db, id, { type: "sync_success" });
      },
    },
    {
      name: "paused",
      block: (_db, s, id) => {
        s.pause(id);
      },
      statusWhileHeld: "paused",
      unblock: (_db, s, id) => {
        s.resume(id);
      },
    },
    {
      name: "in the error state",
      block: (db, _s, id) => {
        db.run(`UPDATE scheduler_state SET status = 'error' WHERE service_id = ?`, [id]);
      },
      statusWhileHeld: "error",
      unblock: (db, _s, id) => {
        db.run(`UPDATE scheduler_state SET status = 'ok' WHERE service_id = ?`, [id]);
      },
    },
  ];

  // Each variant pins the OUTCOME — the queued job does not run until its hold clears — not which
  // gate enforces it. Only the rate-limit hold is enforced by `canStartJob` alone. A pause is also
  // refused by the `paused` health state, and both a pause and the error state are refused again by
  // `runJob`'s re-check of the state row (pinned on its own further down), so removing just one of
  // those layers leaves these variants green by design.
  for (const hold of holds) {
    test(`does not run while ${hold.name}, and runs once that clears`, async () => {
      const db = openMemoryIndexDatabase();
      let releaseBusy!: () => void;
      const busyGate = new Promise<void>((r) => {
        releaseBusy = r;
      });
      const busyDone = deferred();
      const busy = probe("busy", async () => {
        await busyGate;
        return OK;
      });
      const queued = probe("queued");
      const sched = new SyncScheduler(
        ctxFor(db),
        { maxConcurrentSyncs: 1 },
        {
          isOnline: online,
          onConnectorSyncSuccess: (id) => {
            if (id === "busy") busyDone.resolve();
          },
        },
      );
      sched.register(busy.syncable);
      sched.register(queued.syncable);
      // Both are due: the first tick queues both, `busy` takes the only slot, `queued` waits.
      sched.start();
      await within(busy.entered, "busy to take the slot");

      hold.block(db, sched, "queued");
      releaseBusy();
      await within(busyDone.promise, "busy to finish");
      await macrotask();

      expect(sched.getStatus("busy")[0]?.status).toBe("ok"); // the slot really is free
      expect(queued.calls()).toBe(0);
      expect(sched.getStatus("queued")[0]?.status).toBe(hold.statusWhileHeld);

      hold.unblock(db, sched, "queued");
      await within(queued.entered, "the held job to run once unblocked");
      await sched.stop();
      expect(queued.calls()).toBe(1);
      db.close();
    });
  }
});

describe("SyncScheduler — forceSync edge cases", () => {
  test("a force request for a service already in flight re-runs it after, never concurrently", async () => {
    const db = openMemoryIndexDatabase();
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r;
    });
    const secondRun = deferred();
    const dup = probe("dup", async (call) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      try {
        if (call === 1) {
          await firstGate;
        } else {
          secondRun.resolve();
        }
        return OK;
      } finally {
        active -= 1;
      }
    });
    const sched = new SyncScheduler(ctxFor(db), {}, { isOnline: online });
    sched.register(dup.syncable);

    const first = sched.forceSync("dup");
    await within(dup.entered, "the first run to start");
    const second = sched.forceSync("dup");
    await macrotask();
    expect(dup.calls()).toBe(1);

    releaseFirst();
    await within(first, "the first force request");
    await within(second, "the second force request");
    await within(secondRun.promise, "the queued re-run");
    await sched.stop();
    expect(dup.calls()).toBe(2);
    expect(maxActive).toBe(1);
    db.close();
  });

  test("a force request for a service with no scheduler state waits until it registers", async () => {
    const db = openMemoryIndexDatabase();
    const sched = new SyncScheduler(ctxFor(db), {}, { isOnline: online });
    sched.start();
    let settled = false;
    const pending = sched.forceSync("late").then(
      () => {
        settled = true;
      },
      (err: unknown) => {
        settled = true;
        throw err;
      },
    );
    await macrotask();
    expect(settled).toBe(false);

    const late = probe("late");
    sched.register(late.syncable);
    await within(pending, "the force request to be served after registration");
    await sched.stop();
    expect(late.calls()).toBe(1);
    db.close();
  });

  test("a force request for an unregistered service whose state survives rejects", async () => {
    const db = openMemoryIndexDatabase();
    const sched = new SyncScheduler(ctxFor(db), {}, { isOnline: online });
    const gone = probe("gone");
    sched.register(gone.syncable);
    sched.unregister("gone");
    // `unregister` keeps the scheduler_state row, so the dispatch gate lets the force through and
    // `runJob` is the one that finds nothing to run.
    expect(
      db.query(`SELECT service_id FROM scheduler_state WHERE service_id = ?`).get("gone"),
    ).toEqual({ service_id: "gone" });
    await expect(within(sched.forceSync("gone"), "the force request")).rejects.toThrow(
      "Unknown service",
    );
    expect(gone.calls()).toBe(0);
    await sched.stop();
    db.close();
  });
});

/**
 * The real repository plus one injected write that lands on the N-th `loadState` of a service.
 * `canStartJob` reads the state row and `runJob` re-reads it before running anything; nothing in a
 * single JavaScript thread can change the row between the two, so this is the only way to reach
 * the re-check — and the write it injects is a real one, so the run sees a consistent row.
 */
class RacingRepository extends SqliteSchedulerStateRepository {
  private armed: { serviceId: string; onCall: number; write: () => void } | undefined;
  private seen = 0;
  fired = false;

  arm(serviceId: string, onCall: number, write: () => void): void {
    this.armed = { serviceId, onCall, write };
    this.seen = 0;
    this.fired = false;
  }

  override loadState(serviceId: string): SchedulerStateRow | null {
    const a = this.armed;
    if (a !== undefined && a.serviceId === serviceId) {
      this.seen += 1;
      if (this.seen === a.onCall) {
        this.armed = undefined;
        this.fired = true;
        a.write();
      }
    }
    return super.loadState(serviceId);
  }
}

describe("SyncScheduler — state that changes between the dispatch gate and the run", () => {
  test("a forced run whose state row vanished rejects instead of running", async () => {
    const db = openMemoryIndexDatabase();
    const repo = new RacingRepository(db);
    const sched = new SyncScheduler(
      ctxFor(db),
      {},
      { isOnline: online, schedulerStateRepository: repo },
    );
    const victim = probe("victim");
    sched.register(victim.syncable);
    // Read 1 is the dispatch gate, read 2 is runJob's re-check.
    repo.arm("victim", 2, () => {
      db.run(`DELETE FROM scheduler_state WHERE service_id = ?`, ["victim"]);
    });
    // Bounded by `within`: if the re-check regressed, runJob would throw outside its try, the force
    // request would never settle, and bun's own per-test timeout does not reliably fire in that
    // state (measured: the run spun at 100% CPU past it). The bound turns a hung job into a fail.
    await expect(within(sched.forceSync("victim"), "the forced run to settle")).rejects.toThrow(
      "Missing scheduler state",
    );
    expect(repo.fired).toBe(true);
    expect(victim.calls()).toBe(0);
    await sched.stop();
    db.close();
  });

  type Race = {
    name: string;
    write: (db: Database, id: string) => void;
    /** Undo the write; `undefined` when there is nothing to come back to. */
    restore?: (db: Database, sched: SyncScheduler, id: string) => void;
  };
  const races: Race[] = [
    {
      name: "its state row was deleted",
      write: (db, id) => {
        db.run(`DELETE FROM scheduler_state WHERE service_id = ?`, [id]);
      },
    },
    {
      name: "it was paused",
      write: (db, id) => {
        db.run(`UPDATE scheduler_state SET paused = 1 WHERE service_id = ?`, [id]);
      },
      restore: (_db, sched, id) => {
        sched.resume(id);
      },
    },
    {
      name: "it entered the error state",
      write: (db, id) => {
        db.run(`UPDATE scheduler_state SET status = 'error' WHERE service_id = ?`, [id]);
      },
      restore: (db, _sched, id) => {
        db.run(`UPDATE scheduler_state SET status = 'ok' WHERE service_id = ?`, [id]);
      },
    },
  ];

  test("a continuation queued for a connector removed mid-run is dropped, not run, and frees its slot", async () => {
    const db = openMemoryIndexDatabase();
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const firstDone = deferred();
    const mover = probe("mover", async () => {
      await gate;
      return { ...OK, hasMore: true };
    });
    // One slot: if the dropped continuation leaked it, the re-registered connector below could
    // never run and the final force request would time out.
    const sched = new SyncScheduler(
      ctxFor(db),
      { maxConcurrentSyncs: 1 },
      {
        isOnline: online,
        onConnectorSyncSuccess: (id) => {
          if (id === "mover") firstDone.resolve();
        },
      },
    );
    sched.register(mover.syncable);
    const forced = sched.forceSync("mover");
    await within(mover.entered, "the first run to start");
    sched.unregister("mover");
    await expect(within(forced, "unregister to reject the waiting force request")).rejects.toThrow(
      "Connector removed",
    );

    // The run already in flight still finishes and, having more pages, queues a continuation. That
    // job passes the dispatch gate (unregister keeps the state row) and only runJob finds no
    // connector — it must be dropped, never run as a failure against an undefined connector.
    release();
    await within(firstDone.promise, "the in-flight run to finish");
    await macrotask();
    expect(mover.calls()).toBe(1);
    expect(
      db
        .query(`SELECT error_msg, had_more FROM sync_telemetry WHERE service = ? ORDER BY id`)
        .all("mover"),
    ).toEqual([{ error_msg: null, had_more: 1 }]);
    expect(
      db
        .query(`SELECT status, consecutive_failures FROM scheduler_state WHERE service_id = ?`)
        .get("mover"),
    ).toEqual({ status: "ok", consecutive_failures: 0 });

    const again = probe("mover");
    sched.register(again.syncable);
    await within(sched.forceSync("mover"), "a force request once the slot is free again");
    expect(again.calls()).toBe(1);
    expect(mover.calls()).toBe(1);
    await sched.stop();
    db.close();
  });

  for (const race of races) {
    test(`a scheduled run is dropped when ${race.name} after the gate`, async () => {
      const db = openMemoryIndexDatabase();
      const repo = new RacingRepository(db);
      // catchUpOnRestart keeps start() from reading the row, so read 1 is the gate, read 2 the re-check.
      const sched = new SyncScheduler(
        ctxFor(db),
        { catchUpOnRestart: true },
        { isOnline: online, schedulerStateRepository: repo },
      );
      const victim = probe("victim");
      sched.register(victim.syncable);
      repo.arm("victim", 2, () => {
        race.write(db, "victim");
      });
      sched.start();
      await macrotask();
      expect(repo.fired).toBe(true);
      expect(victim.calls()).toBe(0);

      if (race.restore !== undefined) {
        race.restore(db, sched, "victim");
        await within(victim.entered, "the connector to run once its state is restored");
        expect(victim.calls()).toBe(1);
      }
      await sched.stop();
      db.close();
    });
  }
});
