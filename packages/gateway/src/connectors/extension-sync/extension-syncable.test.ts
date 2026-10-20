import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import os from "node:os";
import pino from "pino";

import { LocalIndex } from "../../index/local-index.ts";
import { ProviderRateLimiter } from "../../sync/rate-limiter.ts";
import { SyncScheduler } from "../../sync/scheduler.ts";
import { unboundSyncCapabilities } from "../../sync/sync-capabilities.ts";
import type { SyncContext, SyncRuntimeContext } from "../../sync/types.ts";
import { RateLimitError, UnauthenticatedError } from "../../sync/types.ts";
import { createMemoryVault, openMemoryIndexDatabase } from "../../testing/bun-test-support.ts";
import { getConnectorHealth } from "../health.ts";
import type { ExtensionIdentity } from "./extension-identity.ts";
import {
  createExtensionSyncable,
  EXTENSION_SYNC_BUDGET,
  type ExtensionSyncableDeps,
} from "./extension-syncable.ts";
import type { ExtensionSyncRequest } from "./sync-response.ts";

const IDENTITY: ExtensionIdentity = {
  extensionId: "com.example.x",
  codeServerId: "ext_x",
  indexServiceId: "ext_x",
  binding: undefined,
};

const wire = (ids: string[], cursor: string | null, hasMore: boolean) => ({
  status: "ok",
  items: ids.map((id) => ({
    type: "highlight",
    externalId: id,
    title: `t${id}`,
    modifiedAt: 5,
    metadata: {},
  })),
  cursor,
  hasMore,
});

function deps(over: Partial<ExtensionSyncableDeps> = {}): ExtensionSyncableDeps {
  return {
    identity: IDENTITY,
    intervalMs: 60_000,
    itemTypes: ["highlight"],
    callSync: async () => wire([], null, false),
    isConfigured: async () => true,
    canConfine: () => null,
    budget: EXTENSION_SYNC_BUDGET,
    ...over,
  };
}

/** A context whose writes are recorded; `writeBatch` records batch boundaries. */
function recordingCtx(): { ctx: SyncContext; upserts: string[]; batches: string[][] } {
  const upserts: string[] = [];
  const batches: string[][] = [];
  let current: string[] | null = null;
  const ctx = {
    ...unboundSyncCapabilities(),
    logger: pino({ level: "silent" }),
    rateLimiter: new ProviderRateLimiter(),
    sandboxCwd: os.tmpdir(),
    credentialFor: () => ({ credential: "personal" as const }),
    runTeamList: async () => [],
    depth: "full" as const,
    upsertItem: (row: { externalId: string }) => {
      upserts.push(row.externalId);
      current?.push(row.externalId);
    },
    writeBatch: <T>(fn: () => T): T => {
      const batch: string[] = [];
      current = batch;
      try {
        return fn();
      } finally {
        batches.push(batch);
        current = null;
      }
    },
  } as unknown as SyncContext;
  return { ctx, upserts, batches };
}

function scheduledCtx(db: Database): SyncRuntimeContext {
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
    extensionCredentialsFor: (id) =>
      id === "ext_x" ? { token: { env: "T", vaultKey: "ext.ext_x.token" } } : undefined,
  };
}

const openDbs: Database[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});
function freshDb(): Database {
  const db = openMemoryIndexDatabase();
  openDbs.push(db);
  return db;
}

describe("createExtensionSyncable", () => {
  test("loops pages within one run and returns hasMore false", async () => {
    const reqs: ExtensionSyncRequest[] = [];
    const pages = [wire(["1", "2"], "c1", true), wire(["3"], "c2", true), wire(["4"], "c3", false)];
    const s = createExtensionSyncable(
      deps({
        callSync: async (req) => {
          reqs.push(req);
          return pages[reqs.length - 1];
        },
      }),
    );
    const { ctx, upserts, batches } = recordingCtx();
    const r = await s.sync(ctx, "c0");
    expect(r).toMatchObject({ cursor: "c3", itemsUpserted: 4, hasMore: false });
    expect(upserts).toEqual(["1", "2", "3", "4"]);
    expect(batches).toEqual([["1", "2"], ["3"], ["4"]]);
    expect(reqs.map((q) => q.cursor)).toEqual(["c0", "c1", "c2"]);
    expect(reqs[0]?.depth).toBe("full");
    expect(Number.isFinite(reqs[0]?.historyFloorMs)).toBe(true);
    expect(s.serviceId).toBe("ext_x");
    expect(s.initialSyncDepthDays).toBe(30);
  });

  test("not configured -> no-op, never calls the extension", async () => {
    let calls = 0;
    const s = createExtensionSyncable(
      deps({
        isConfigured: async () => false,
        callSync: async () => {
          calls += 1;
          return wire([], null, false);
        },
      }),
    );
    const r = await s.sync(recordingCtx().ctx, "cur");
    expect(calls).toBe(0);
    expect(r).toMatchObject({ cursor: "cur", itemsUpserted: 0, hasMore: false });
  });

  test("timeout on page 3 fails the run and keeps pages 1-2", async () => {
    let n = 0;
    const s = createExtensionSyncable(
      deps({
        callSync: async () => {
          n += 1;
          if (n === 3) throw new Error("sync call exceeded 60000ms");
          return wire([`p${n}`], `c${n}`, true);
        },
      }),
    );
    const { ctx, upserts } = recordingCtx();
    await expect(s.sync(ctx, null)).rejects.toThrow(/exceeded/);
    expect(upserts).toEqual(["p1", "p2"]);
  });

  test("stops at maxPages and still reports hasMore false with the last cursor", async () => {
    let n = 0;
    const s = createExtensionSyncable(
      deps({
        budget: { ...EXTENSION_SYNC_BUDGET, maxPages: 2 },
        callSync: async () => {
          n += 1;
          return wire([`p${n}`], `c${n}`, true);
        },
      }),
    );
    const r = await s.sync(recordingCtx().ctx, null);
    expect(n).toBe(2);
    expect(r).toMatchObject({ cursor: "c2", hasMore: false, itemsUpserted: 2 });
  });

  test("stops once maxMs has elapsed", async () => {
    let n = 0;
    const s = createExtensionSyncable(
      deps({
        budget: { ...EXTENSION_SYNC_BUDGET, maxMs: 1 },
        callSync: async () => {
          n += 1;
          await new Promise((r) => setTimeout(r, 15));
          return wire([`p${n}`], `c${n}`, true);
        },
      }),
    );
    const r = await s.sync(recordingCtx().ctx, null);
    expect(n).toBe(1);
    expect(r.cursor).toBe("c1");
  });

  test("dropped counts are summed across pages and returned", async () => {
    const bad = { type: "tweet", externalId: "z", title: "t", modifiedAt: 1, metadata: {} };
    const pages = [
      { ...wire(["1"], "c1", true), items: [...wire(["1"], null, false).items, bad] },
      { ...wire(["2"], "c2", false), items: [...wire(["2"], null, false).items, bad, bad] },
    ];
    let n = 0;
    const s = createExtensionSyncable(deps({ callSync: async () => pages[n++] }));
    const r = await s.sync(recordingCtx().ctx, null);
    expect(r.dropped).toEqual({ undeclaredType: 3, malformed: 0, oversized: 0 });
    expect(r.itemsUpserted).toBe(2);
  });

  test("rate_limited -> RateLimitError carrying retryAfterMs", async () => {
    const s = createExtensionSyncable(
      deps({ callSync: async () => ({ status: "rate_limited", retryAfterMs: 5_000 }) }),
    );
    const before = Date.now();
    const err = await s.sync(recordingCtx().ctx, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect((err as RateLimitError).retryAfter.getTime()).toBeGreaterThanOrEqual(before + 5_000);
  });

  test("unauthenticated -> UnauthenticatedError", async () => {
    const s = createExtensionSyncable(
      deps({ callSync: async () => ({ status: "unauthenticated" }) }),
    );
    await expect(s.sync(recordingCtx().ctx, null)).rejects.toBeInstanceOf(UnauthenticatedError);
  });

  test("preflight wraps the confinement reason; null when it can confine", () => {
    expect(createExtensionSyncable(deps()).preflight?.()).toBeNull();
    const msg = createExtensionSyncable(deps({ canConfine: () => "no bwrap" })).preflight?.();
    expect(msg).toBe(
      "sandbox cannot confine this extension: no bwrap — fix it (see `nimbus doctor`), then run `nimbus connector resume ext_x`",
    );
  });
});

describe("scheduler integration", () => {
  test("one sync() call == one scheduler run == one sync.run row", async () => {
    const db = freshDb();
    const ctx = scheduledCtx(db);
    await ctx.vault.set("ext.ext_x.token", "secret");
    const rows: Array<{ method: string; destination: string }> = [];
    let calls = 0;
    const sched = new SyncScheduler(ctx, undefined, { appendSyncEgress: (r) => rows.push(r) });
    sched.register(
      createExtensionSyncable(
        deps({
          callSync: async () => {
            calls += 1;
            return wire([`i${calls}`], `c${calls}`, calls < 3);
          },
        }),
      ),
    );
    await sched.forceSync("ext_x");
    await sched.stop();
    expect(calls).toBe(3);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ method: "sync.run", destination: "ext_x" });
  });

  test("rate_limited -> RateLimitError -> health rate_limited", async () => {
    const db = freshDb();
    const ctx = scheduledCtx(db);
    await ctx.vault.set("ext.ext_x.token", "secret");
    const sched = new SyncScheduler(ctx);
    sched.register(
      createExtensionSyncable(
        deps({ callSync: async () => ({ status: "rate_limited", retryAfterMs: 60_000 }) }),
      ),
    );
    await sched.forceSync("ext_x").catch(() => undefined);
    await sched.stop();
    expect(getConnectorHealth(db, "ext_x").state).toBe("rate_limited");
  });

  test("preflight refusal pauses: paused=1, status paused, reason in last_error, NO sync.run row, no spawn, next tick does not queue it", async () => {
    const db = freshDb();
    const ctx = scheduledCtx(db);
    await ctx.vault.set("ext.ext_x.token", "secret");
    const rows: unknown[] = [];
    let spawns = 0;
    const sched = new SyncScheduler(ctx, undefined, { appendSyncEgress: (r) => rows.push(r) });
    sched.register(
      createExtensionSyncable(
        deps({
          canConfine: () => "no bwrap",
          callSync: async () => {
            spawns += 1;
            return wire([], null, false);
          },
        }),
      ),
    );
    await sched.forceSync("ext_x").catch(() => undefined);
    const row = db
      .query("SELECT paused FROM scheduler_state WHERE service_id = ?")
      .get("ext_x") as { paused: number };
    expect(row.paused).toBe(1);
    expect(rows).toHaveLength(0);
    expect(spawns).toBe(0);
    const health = getConnectorHealth(db, "ext_x");
    expect(health.state).toBe("paused");
    expect(health.lastError).toContain("sandbox cannot confine this extension: no bwrap");
    // paused reason shows in persistedConnectorStatuses
    const status = new LocalIndex(db).persistedConnectorStatuses("ext_x")[0];
    expect(status?.status).toBe("paused");
    expect(status?.lastError).toContain("no bwrap");
    // a later tick never queues it
    db.query("UPDATE scheduler_state SET next_sync_at = 0 WHERE service_id = ?").run("ext_x");
    (sched as unknown as { tick(): void }).tick();
    await new Promise((r) => setTimeout(r, 30));
    await sched.stop();
    expect(rows).toHaveLength(0);
    expect(spawns).toBe(0);
  });
});
