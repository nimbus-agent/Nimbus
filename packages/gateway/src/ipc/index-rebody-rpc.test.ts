import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import pino from "pino";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { loadSchedulerState, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import {
  buildTargetServicesSql,
  computePendingByService,
  dispatchIndexRebodyRpc,
  type IndexRebodyRpcContext,
  IndexRebodyRpcError,
  parseRebodyParams,
  resolveTargetServices,
} from "./index-rebody-rpc.ts";

function freshCtx(overrides: Partial<IndexRebodyRpcContext> = {}) {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  const events: Array<{ method: string; params: unknown }> = [];
  const ctx: IndexRebodyRpcContext = {
    db,
    logger: pino({ level: "silent" }),
    notify: (method: string, params: unknown) => {
      events.push({ method, params });
    },
    ...overrides,
  };
  return { db, ctx, events };
}

function seedIncomplete(db: Database, service: string, externalId: string, type = "message") {
  upsertIndexedItem(db, {
    service,
    type,
    externalId,
    title: "T",
    bodyPreview: "preview only, never declared complete",
    modifiedAt: 1,
    syncedAt: 1,
  });
}

function seedComplete(db: Database, service: string, externalId: string, type = "message") {
  upsertIndexedItem(db, {
    service,
    type,
    externalId,
    title: "T",
    body: "short full body",
    modifiedAt: 1,
    syncedAt: 1,
  });
}

describe("dispatchIndexRebodyRpc", () => {
  test("returns { kind: 'miss' } for unknown methods", async () => {
    const { ctx } = freshCtx();
    const out = await dispatchIndexRebodyRpc("foo.bar", null, ctx);
    expect(out.kind).toBe("miss");
  });

  test("dry run reports the remaining incomplete count per service without fetching", async () => {
    const { ctx, db, events } = freshCtx();
    seedIncomplete(db, "slack", "1");
    seedIncomplete(db, "slack", "2");
    seedIncomplete(db, "slack", "3");
    seedComplete(db, "slack", "4");
    seedComplete(db, "slack", "5");

    const out = await dispatchIndexRebodyRpc("index.rebody", { dryRun: true }, ctx);
    expect(out.kind).toBe("hit");
    const hit = (out as { kind: "hit"; value: { jobId: string } }).value;
    expect(hit.jobId).toMatch(/^rebody_/);

    await new Promise((r) => setTimeout(r, 50));
    const done = events.find((e) => e.method === "index.rebodyDone");
    expect(done).toBeDefined();
    expect((done?.params as Record<string, unknown> | undefined)?.["pending"]).toEqual({
      slack: 3,
    });
    // No progress notifications and no other-service side effects: dry-run never targets anything.
    expect(events.find((e) => e.method === "index.rebodyProgress")).toBeUndefined();
  });

  test("params reject a non-object and an empty service", async () => {
    const { ctx } = freshCtx();
    await expect(dispatchIndexRebodyRpc("index.rebody", "nope", ctx)).rejects.toBeInstanceOf(
      IndexRebodyRpcError,
    );
    await expect(
      dispatchIndexRebodyRpc("index.rebody", { service: "" }, ctx),
    ).rejects.toBeInstanceOf(IndexRebodyRpcError);
  });

  test("params reject an empty type", async () => {
    const { ctx } = freshCtx();
    await expect(dispatchIndexRebodyRpc("index.rebody", { type: "" }, ctx)).rejects.toBeInstanceOf(
      IndexRebodyRpcError,
    );
  });

  test("cancel for unknown jobId returns { cancelled: false }", async () => {
    const { ctx } = freshCtx();
    const out = await dispatchIndexRebodyRpc(
      "index.rebodyCancel",
      { jobId: "rebody_does_not_exist" },
      ctx,
    );
    expect(out.kind).toBe("hit");
    expect((out as { kind: "hit"; value: { cancelled: boolean } }).value.cancelled).toBe(false);
  });

  test("cancel rejects a non-string jobId", async () => {
    const { ctx } = freshCtx();
    await expect(
      dispatchIndexRebodyRpc("index.rebodyCancel", { jobId: 42 }, ctx),
    ).rejects.toBeInstanceOf(IndexRebodyRpcError);
  });

  test("cancel rejects null params (rec falls back to {})", async () => {
    const { ctx } = freshCtx();
    await expect(dispatchIndexRebodyRpc("index.rebodyCancel", null, ctx)).rejects.toBeInstanceOf(
      IndexRebodyRpcError,
    );
  });

  test("real run with explicit service clears the watermark and, with no scheduler wired, still succeeds", async () => {
    const { ctx, db, events } = freshCtx();
    seedIncomplete(db, "notion", "p1");
    upsertSchedulerRegistration(db, "notion", 60_000, Date.now(), true);
    // Simulate an existing watermark that rebody must clear.
    db.query(`UPDATE scheduler_state SET cursor = ? WHERE service_id = ?`).run(
      "some-cursor",
      "notion",
    );
    expect(loadSchedulerState(db, "notion")?.cursor).toBe("some-cursor");

    const out = await dispatchIndexRebodyRpc("index.rebody", { service: "notion" }, ctx);
    expect(out.kind).toBe("hit");
    await new Promise((r) => setTimeout(r, 50));

    expect(loadSchedulerState(db, "notion")?.cursor).toBeNull();
    const progressEvents = events.filter((e) => e.method === "index.rebodyProgress");
    expect(progressEvents.length).toBe(1);
    const done = events.find((e) => e.method === "index.rebodyDone");
    expect(done).toBeDefined();
    const payload = done?.params as Record<string, unknown> | undefined;
    expect(payload?.["targeted"]).toEqual(["notion"]);
    expect(payload?.["succeeded"]).toBe(1);
    expect(payload?.["failed"]).toBe(0);
  });

  test("real run auto-targets every service with pending rows, respecting limit", async () => {
    const { ctx, db, events } = freshCtx();
    seedIncomplete(db, "confluence", "1");
    seedIncomplete(db, "jira", "1");
    seedComplete(db, "github", "1");

    const out = await dispatchIndexRebodyRpc("index.rebody", { limit: 1 }, ctx);
    expect(out.kind).toBe("hit");
    await new Promise((r) => setTimeout(r, 50));

    const done = events.find((e) => e.method === "index.rebodyDone");
    const payload = done?.params as Record<string, unknown> | undefined;
    expect((payload?.["targeted"] as string[]).length).toBe(1);
  });

  test("real run with a live syncScheduler that succeeds", async () => {
    const calls: string[] = [];
    const { ctx, db, events } = freshCtx({
      syncScheduler: {
        forceSync: async (serviceId: string) => {
          calls.push(serviceId);
        },
      },
    });
    seedIncomplete(db, "slack", "1");

    const out = await dispatchIndexRebodyRpc("index.rebody", { service: "slack" }, ctx);
    expect(out.kind).toBe("hit");
    await new Promise((r) => setTimeout(r, 50));

    expect(calls).toEqual(["slack"]);
    const done = events.find((e) => e.method === "index.rebodyDone");
    const payload = done?.params as Record<string, unknown> | undefined;
    expect(payload?.["succeeded"]).toBe(1);
    expect(payload?.["failed"]).toBe(0);
  });

  test("real run with a live syncScheduler that throws counts it as failed, not fatal", async () => {
    const { ctx, db, events } = freshCtx({
      syncScheduler: {
        forceSync: async () => {
          throw new Error("rate limited");
        },
      },
    });
    seedIncomplete(db, "jira", "1");

    const out = await dispatchIndexRebodyRpc("index.rebody", { service: "jira" }, ctx);
    expect(out.kind).toBe("hit");
    await new Promise((r) => setTimeout(r, 50));

    const done = events.find((e) => e.method === "index.rebodyDone");
    expect(done).toBeDefined();
    const payload = done?.params as Record<string, unknown> | undefined;
    expect(payload?.["succeeded"]).toBe(0);
    expect(payload?.["failed"]).toBe(1);
    expect(events.find((e) => e.method === "index.rebodyError")).toBeUndefined();
  });

  test("cancel aborts a real run before it processes further targets", async () => {
    const { ctx, db } = freshCtx({
      syncScheduler: {
        forceSync: async () => {
          await new Promise((r) => setTimeout(r, 30));
        },
      },
    });
    seedIncomplete(db, "a", "1");
    seedIncomplete(db, "b", "1");
    seedIncomplete(db, "c", "1");

    const out = await dispatchIndexRebodyRpc("index.rebody", {}, ctx);
    const hit = (out as { kind: "hit"; value: { jobId: string } }).value;
    const cancelOut = await dispatchIndexRebodyRpc("index.rebodyCancel", { jobId: hit.jobId }, ctx);
    expect((cancelOut as { kind: "hit"; value: { cancelled: boolean } }).value.cancelled).toBe(
      true,
    );
    await new Promise((r) => setTimeout(r, 100));
  });
});

describe("parseRebodyParams", () => {
  test("null params throws", () => {
    expect(() => parseRebodyParams(null)).toThrow(IndexRebodyRpcError);
  });

  test("array params throws", () => {
    expect(() => parseRebodyParams([])).toThrow(IndexRebodyRpcError);
  });

  test("primitive params throws", () => {
    expect(() => parseRebodyParams("x")).toThrow(IndexRebodyRpcError);
    expect(() => parseRebodyParams(1)).toThrow(IndexRebodyRpcError);
  });

  test("empty object yields all-undefined params", () => {
    expect(parseRebodyParams({})).toEqual({});
  });

  test("service present and non-empty is accepted", () => {
    expect(parseRebodyParams({ service: "slack" })).toEqual({ service: "slack" });
  });

  test("service present but not a string throws", () => {
    expect(() => parseRebodyParams({ service: 5 })).toThrow(IndexRebodyRpcError);
  });

  test("type present and non-empty is accepted", () => {
    expect(parseRebodyParams({ type: "issue" })).toEqual({ type: "issue" });
  });

  test("type present but not a string throws", () => {
    expect(() => parseRebodyParams({ type: 5 })).toThrow(IndexRebodyRpcError);
  });

  test("limit non-number is ignored", () => {
    expect(parseRebodyParams({ limit: "10" }).limit).toBeUndefined();
  });

  test("limit NaN is ignored", () => {
    expect(parseRebodyParams({ limit: Number.NaN }).limit).toBeUndefined();
  });

  test("limit <= 0 is ignored", () => {
    expect(parseRebodyParams({ limit: 0 }).limit).toBeUndefined();
    expect(parseRebodyParams({ limit: -3 }).limit).toBeUndefined();
  });

  test("valid positive limit is floored", () => {
    expect(parseRebodyParams({ limit: 4.9 }).limit).toBe(4);
  });

  test("dryRun non-true is ignored", () => {
    expect(parseRebodyParams({ dryRun: "yes" }).dryRun).toBeUndefined();
    expect(parseRebodyParams({ dryRun: false }).dryRun).toBeUndefined();
  });

  test("dryRun true is accepted", () => {
    expect(parseRebodyParams({ dryRun: true }).dryRun).toBe(true);
  });
});

describe("computePendingByService", () => {
  test("empty index returns empty object", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    expect(computePendingByService(db)).toEqual({});
  });

  test("groups pending counts per service, excluding complete rows", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    seedIncomplete(db, "gmail", "1");
    seedIncomplete(db, "gmail", "2");
    seedComplete(db, "gmail", "3");
    seedIncomplete(db, "github", "1");
    expect(computePendingByService(db)).toEqual({ gmail: 2, github: 1 });
  });
});

describe("buildTargetServicesSql", () => {
  test("no type filter", () => {
    const { sql, params } = buildTargetServicesSql({});
    expect(sql).not.toContain("AND type");
    expect(params).toEqual([]);
  });

  test("with type filter", () => {
    const { sql, params } = buildTargetServicesSql({ type: "issue" });
    expect(sql).toContain("AND type = ?");
    expect(params).toEqual(["issue"]);
  });
});

describe("resolveTargetServices", () => {
  test("explicit service short-circuits the query", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    expect(resolveTargetServices({ service: "slack" }, db)).toEqual(["slack"]);
  });

  test("auto-detects distinct services with pending rows", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    seedIncomplete(db, "b", "1");
    seedIncomplete(db, "a", "1");
    seedComplete(db, "c", "1");
    expect(resolveTargetServices({}, db)).toEqual(["a", "b"]);
  });

  test("limit caps the auto-detected list", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    seedIncomplete(db, "b", "1");
    seedIncomplete(db, "a", "1");
    expect(resolveTargetServices({ limit: 1 }, db)).toEqual(["a"]);
  });
});
