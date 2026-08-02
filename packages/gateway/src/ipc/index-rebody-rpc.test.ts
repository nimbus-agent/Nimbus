import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import pino from "pino";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { loadSchedulerState, upsertSchedulerRegistration } from "../sync/scheduler-store.ts";
import {
  buildTargetServicesSql,
  cannotImproveAmong,
  clearedWatermarkWarning,
  computePendingByService,
  dispatchIndexRebodyRpc,
  type IndexRebodyRpcContext,
  IndexRebodyRpcError,
  parseRebodyParams,
  REBODY_IMPROVABLE_SERVICES,
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
    const payload = done?.params as Record<string, unknown> | undefined;
    expect(payload?.["pending"]).toEqual({ slack: 3 });
    // slack genuinely recovers on rebody, so it must not be flagged as unrecoverable.
    expect(payload?.["cannotImprove"]).toEqual([]);
    // No progress notifications and no other-service side effects: dry-run never targets anything.
    expect(events.find((e) => e.method === "index.rebodyProgress")).toBeUndefined();
  });

  test("dry run flags a cannot-improve service before any walk is paid for", async () => {
    const { ctx, db, events } = freshCtx();
    seedIncomplete(db, "notion", "1");
    seedIncomplete(db, "confluence", "1");
    seedIncomplete(db, "slack", "1");

    await dispatchIndexRebodyRpc("index.rebody", { dryRun: true }, ctx);
    await new Promise((r) => setTimeout(r, 50));

    const done = events.find((e) => e.method === "index.rebodyDone");
    const payload = done?.params as Record<string, unknown> | undefined;
    expect(payload?.["cannotImprove"]).toEqual(["confluence", "notion"]);
  });

  test("dry run flags a service merely ABSENT from REBODY_IMPROVABLE_SERVICES, not only the pre-inversion hardcoded three", async () => {
    // "brand-new-saas" is not notion/confluence/gmail (the old exception list) and is not in
    // REBODY_IMPROVABLE_SERVICES either — under the inverted, correct-by-construction list it
    // must still be reported as cannot-improve, with zero maintenance action required.
    const { ctx, db, events } = freshCtx();
    seedIncomplete(db, "brand-new-saas", "1");
    seedIncomplete(db, "slack", "1");

    await dispatchIndexRebodyRpc("index.rebody", { dryRun: true }, ctx);
    await new Promise((r) => setTimeout(r, 50));

    const done = events.find((e) => e.method === "index.rebodyDone");
    const payload = done?.params as Record<string, unknown> | undefined;
    expect(payload?.["pending"]).toEqual({ "brand-new-saas": 1, slack: 1 });
    expect(payload?.["cannotImprove"]).toEqual(["brand-new-saas"]);
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

  test("params reject a malformed limit (typo'd string instead of a number)", async () => {
    const { ctx } = freshCtx();
    await expect(
      dispatchIndexRebodyRpc("index.rebody", { limit: "3" }, ctx),
    ).rejects.toBeInstanceOf(IndexRebodyRpcError);
  });

  test("params reject a malformed dryRun (would otherwise silently become a real run)", async () => {
    const { ctx } = freshCtx();
    await expect(
      dispatchIndexRebodyRpc("index.rebody", { dryRun: "true" }, ctx),
    ).rejects.toBeInstanceOf(IndexRebodyRpcError);
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

  test("real run with explicit service clears the watermark and, with no scheduler wired, still succeeds — but a cannot-improve service's pending count never moves", async () => {
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
    // succeeded=1 (the watermark clear + no-scheduler path "succeeded") coexists with an
    // UNMOVED pending count — that is the honesty requirement this test is pinning down.
    expect(payload?.["succeeded"]).toBe(1);
    expect(payload?.["failed"]).toBe(0);
    expect(payload?.["pendingBefore"]).toEqual({ notion: 1 });
    expect(payload?.["pendingAfter"]).toEqual({ notion: 1 });
    expect(payload?.["cannotImprove"]).toEqual(["notion"]);
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
    expect(payload?.["failedServices"]).toEqual([]);
    expect(payload?.["warnings"]).toEqual([]);
    expect(payload?.["pendingAfter"]).toEqual({ slack: 1 });
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
    expect(payload?.["failedServices"]).toEqual(["jira"]);
    const warnings = payload?.["warnings"] as string[] | undefined;
    expect(warnings).toHaveLength(1);
    expect(warnings?.[0]).toBe(clearedWatermarkWarning("jira"));
    expect(warnings?.[0]).toMatch(/watermark was already cleared/);
    expect(warnings?.[0]).toMatch(/next scheduled sync/);
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

  // `limit` bounds how many connectors get an unbounded full-account network
  // re-walk, so — unlike index.reembed — a malformed value is a hard error,
  // never a silent fallback to "target everything".
  test("limit non-number throws", () => {
    expect(() => parseRebodyParams({ limit: "10" })).toThrow(IndexRebodyRpcError);
  });

  test("limit NaN throws", () => {
    expect(() => parseRebodyParams({ limit: Number.NaN })).toThrow(IndexRebodyRpcError);
  });

  test("limit <= 0 throws", () => {
    expect(() => parseRebodyParams({ limit: 0 })).toThrow(IndexRebodyRpcError);
    expect(() => parseRebodyParams({ limit: -3 })).toThrow(IndexRebodyRpcError);
  });

  test("limit Infinity throws (finite check)", () => {
    expect(() => parseRebodyParams({ limit: Number.POSITIVE_INFINITY })).toThrow(
      IndexRebodyRpcError,
    );
  });

  test("valid positive limit is floored", () => {
    expect(parseRebodyParams({ limit: 4.9 }).limit).toBe(4);
  });

  test("limit omitted entirely is fine", () => {
    expect(parseRebodyParams({}).limit).toBeUndefined();
  });

  // `dryRun` mistyped-into-a-real-run is the worst version of the same
  // failure mode, so a non-boolean is rejected rather than coerced.
  test("dryRun non-boolean throws", () => {
    expect(() => parseRebodyParams({ dryRun: "yes" })).toThrow(IndexRebodyRpcError);
    expect(() => parseRebodyParams({ dryRun: 1 })).toThrow(IndexRebodyRpcError);
  });

  test("dryRun false is accepted and yields dryRun undefined", () => {
    expect(parseRebodyParams({ dryRun: false }).dryRun).toBeUndefined();
  });

  test("dryRun true is accepted", () => {
    expect(parseRebodyParams({ dryRun: true }).dryRun).toBe(true);
  });

  test("dryRun omitted entirely is fine", () => {
    expect(parseRebodyParams({}).dryRun).toBeUndefined();
  });
});

describe("REBODY_IMPROVABLE_SERVICES", () => {
  test("membership verified against every item-writing code path for each service (see file-header comment)", () => {
    // Every item-writing call site for each of these passes body: (the declared-full variant):
    //   bitbucket-sync.ts:138, discord-sync.ts:203, github-sync.ts:207+247 (pr AND issue),
    //   jira-sync.ts:268, linear-sync.ts:175, obsidian-sync.ts:75, slack-sync.ts:282,
    //   snyk-issue-mapping.ts:117, _lib/teams/api.ts:89.
    for (const service of [
      "bitbucket",
      "discord",
      "github",
      "jira",
      "linear",
      "obsidian",
      "slack",
      "snyk",
      "teams",
    ]) {
      expect(REBODY_IMPROVABLE_SERVICES.has(service)).toBe(true);
    }
  });

  test("notion, confluence and gmail pass bodyPreview only — never in the set", () => {
    // notion-sync.ts:201, confluence-sync.ts:141, _lib/gmail/api.ts:174 — all bodyPreview only.
    expect(REBODY_IMPROVABLE_SERVICES.has("notion")).toBe(false);
    expect(REBODY_IMPROVABLE_SERVICES.has("confluence")).toBe(false);
    expect(REBODY_IMPROVABLE_SERVICES.has("gmail")).toBe(false);
  });

  test("zoom and nimbus are mixed (some item types migrated, some not) and are deliberately excluded", () => {
    // zoom:transcript passes body: but zoom:meeting passes bodyPreview: — mixed at the service
    // granularity rebody operates at, so zoom is excluded (the safe direction).
    expect(REBODY_IMPROVABLE_SERVICES.has("zoom")).toBe(false);
    // service:"nimbus" web_clip/research_brief pass body: but glossary_term passes bodyPreview: —
    // same mixed-service reasoning.
    expect(REBODY_IMPROVABLE_SERVICES.has("nimbus")).toBe(false);
  });

  test("an unknown/never-seen service defaults to cannot-improve — the point of inverting the list", () => {
    expect(REBODY_IMPROVABLE_SERVICES.has("some-brand-new-connector-nobody-has-heard-of")).toBe(
      false,
    );
  });
});

describe("cannotImproveAmong", () => {
  test("empty pending map yields empty list", () => {
    expect(cannotImproveAmong({})).toEqual([]);
  });

  test("filters to cannot-improve services only, sorted", () => {
    expect(cannotImproveAmong({ slack: 2, notion: 5, jira: 1, confluence: 3 })).toEqual([
      "confluence",
      "notion",
    ]);
  });

  test("a pending map with no cannot-improve services yields empty list", () => {
    expect(cannotImproveAmong({ slack: 2, jira: 1 })).toEqual([]);
  });

  test("a service absent from REBODY_IMPROVABLE_SERVICES is reported as cannot-improve by default", () => {
    // This is the behavior the inversion buys: an unrecognized service (never explicitly
    // hardcoded as an exception) is still flagged, because it is simply absent from the
    // inclusion list — no maintenance action was needed to catch it.
    expect(cannotImproveAmong({ "totally-unknown-service": 4 })).toEqual([
      "totally-unknown-service",
    ]);
  });
});

describe("clearedWatermarkWarning", () => {
  test("names the service and states the watermark/next-sync consequence", () => {
    const msg = clearedWatermarkWarning("confluence");
    expect(msg).toContain("confluence");
    expect(msg).toMatch(/watermark was already cleared/);
    expect(msg).toMatch(/next scheduled sync/);
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
