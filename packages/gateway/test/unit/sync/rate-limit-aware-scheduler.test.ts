import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import pino from "pino";

import { getConnectorHealth } from "../../../src/connectors/health.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import { SyncScheduler } from "../../../src/sync/scheduler.ts";
import { loadSchedulerState } from "../../../src/sync/scheduler-store.ts";
import type { Syncable, SyncContext, SyncResult } from "../../../src/sync/types.ts";
import { RateLimitError, UnauthenticatedError } from "../../../src/sync/types.ts";
import { createMemoryVault } from "../../../src/testing/bun-test-support.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

let db: Database;

function makeCtx(): SyncContext {
  return {
    db,
    vault: createMemoryVault(),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
  };
}

async function forceSyncExpectReject(sched: SyncScheduler, serviceId: string): Promise<void> {
  try {
    await sched.forceSync(serviceId);
  } catch {
    /* connector threw — forceSync rejects */
  }
}

function okConnector(id: string): Syncable {
  return {
    serviceId: id,
    defaultIntervalMs: 60_000,
    initialSyncDepthDays: 30,
    async sync(): Promise<SyncResult> {
      return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
    },
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});

afterEach(() => {
  db.close();
});

describe("RateLimitError", () => {
  test("transitions health to rate_limited after connector throws", async () => {
    const ctx = makeCtx();
    const retryAfter = new Date(Date.now() + 60_000);
    const c: Syncable = {
      ...okConnector("github"),
      async sync(): Promise<SyncResult> {
        throw new RateLimitError(retryAfter);
      },
    };

    const sched = new SyncScheduler(ctx, {}, { initialOnline: true, isOnline: async () => true });
    sched.register(c);
    await forceSyncExpectReject(sched, "github");
    sched.stop();

    const health = getConnectorHealth(db, "github");
    expect(health.state).toBe("rate_limited");
    expect(health.retryAfter).toBeDefined();
    expect(health.retryAfter?.getTime()).toBeCloseTo(retryAfter.getTime(), -2);
  });

  test("scheduler does not dispatch while within rate-limit window", async () => {
    const ctx = makeCtx();
    let syncCalls = 0;
    const retryAfter = new Date(Date.now() + 10_000);
    const c: Syncable = {
      serviceId: "rl-skip",
      defaultIntervalMs: 20, // very short so tick fires immediately if not gated
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        syncCalls++;
        if (syncCalls === 1) throw new RateLimitError(retryAfter);
        return { cursor: null, itemsUpserted: 0, itemsDeleted: 0, hasMore: false, durationMs: 0 };
      },
    };

    const sched = new SyncScheduler(ctx, {}, { initialOnline: true, isOnline: async () => true });
    sched.register(c);
    await forceSyncExpectReject(sched, "rl-skip");

    sched.start();
    await sleep(100);
    sched.stop();

    expect(syncCalls).toBe(1);

    const health = getConnectorHealth(db, "rl-skip");
    expect(health.state).toBe("rate_limited");
  });
});

describe("UnauthenticatedError", () => {
  test("transitions health to unauthenticated", async () => {
    const ctx = makeCtx();
    const c: Syncable = {
      ...okConnector("jira"),
      async sync(): Promise<SyncResult> {
        throw new UnauthenticatedError();
      },
    };

    const sched = new SyncScheduler(ctx, {}, { initialOnline: true, isOnline: async () => true });
    sched.register(c);
    await forceSyncExpectReject(sched, "jira");
    sched.stop();

    const health = getConnectorHealth(db, "jira");
    expect(health.state).toBe("unauthenticated");
  });

  test("calls notify with connector name when unauthenticated", async () => {
    const ctx = makeCtx();
    const notifications: Array<[string, string]> = [];
    const c: Syncable = {
      ...okConnector("slack"),
      async sync(): Promise<SyncResult> {
        throw new UnauthenticatedError();
      },
    };

    const sched = new SyncScheduler(
      ctx,
      {},
      {
        initialOnline: true,
        isOnline: async () => true,
        notify: async (title, body) => {
          notifications.push([title, body]);
        },
      },
    );
    sched.register(c);
    await forceSyncExpectReject(sched, "slack");
    sched.stop();

    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.[0]).toContain("authentication");
    expect(notifications[0]?.[1]).toContain("slack");
  });

  test("does NOT increment backoff attempt on unauthenticated error", async () => {
    const ctx = makeCtx();
    const c: Syncable = {
      ...okConnector("gdrive"),
      async sync(): Promise<SyncResult> {
        throw new UnauthenticatedError();
      },
    };

    const sched = new SyncScheduler(ctx, {}, { initialOnline: true, isOnline: async () => true });
    sched.register(c);
    await forceSyncExpectReject(sched, "gdrive");
    sched.stop();

    const row = loadSchedulerState(db, "gdrive");
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.status).toBe("ok");
  });
});

describe("connectivity guard", () => {
  test("when offline: no backoff_attempt incremented, no transient_error health transition", async () => {
    const ctx = makeCtx();
    let syncCalled = false;
    const c: Syncable = {
      serviceId: "guard-test",
      defaultIntervalMs: 10,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        syncCalled = true;
        throw new Error("should not be called when offline");
      },
    };

    const sched = new SyncScheduler(
      ctx,
      {},
      {
        initialOnline: false, // start offline — tick() will skip all dispatch
        isOnline: async () => false,
      },
    );
    sched.register(c);
    sched.start();
    await sleep(100);
    sched.stop();

    expect(syncCalled).toBe(false);

    const row = loadSchedulerState(db, "guard-test");
    expect(row?.consecutive_failures).toBe(0);
    expect(row?.status).toBe("ok");

    const health = getConnectorHealth(db, "guard-test");
    expect(health.state === "degraded" || health.state === "error").toBe(false);
    expect(health.backoffAttempt).toBe(0);
  });
});

describe("generic error", () => {
  test("transitions health to degraded on first failure", async () => {
    const ctx = makeCtx();
    const c: Syncable = {
      ...okConnector("gen-err"),
      async sync(): Promise<SyncResult> {
        throw new Error("network timeout");
      },
    };

    const sched = new SyncScheduler(ctx, {}, { initialOnline: true, isOnline: async () => true });
    sched.register(c);
    await forceSyncExpectReject(sched, "gen-err");
    sched.stop();

    const health = getConnectorHealth(db, "gen-err");
    expect(health.state).toBe("degraded");
    expect(health.backoffAttempt).toBe(1);
  });

  test("transitions health to error after 5 consecutive failures (persistent_error path)", async () => {
    const ctx = makeCtx();
    const c: Syncable = {
      serviceId: "multi-fail",
      defaultIntervalMs: 10,
      initialSyncDepthDays: 30,
      async sync(): Promise<SyncResult> {
        throw new Error("always fails");
      },
    };

    const sched = new SyncScheduler(
      ctx,
      {},
      { initialOnline: true, isOnline: async () => true, random: () => 0 },
    );
    sched.register(c);
    for (let i = 0; i < 5; i++) {
      await forceSyncExpectReject(sched, "multi-fail");
    }
    sched.stop();

    const row = loadSchedulerState(db, "multi-fail");
    expect(row?.status).toBe("error");

    const health = getConnectorHealth(db, "multi-fail");
    expect(health.state).toBe("error");
  });
});
