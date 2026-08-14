import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import pino from "pino";
import { PAGERDUTY_INCIDENT_META_VERSION } from "../connectors/pagerduty-attribution.ts";
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
  REBODY_REQUIRED_META_VERSION,
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

/**
 * A scheduler stub carrying BOTH members the rebody context picks. Written as
 * one helper rather than an inline literal per test so that widening the
 * picked surface again lands in a single place — and so no test can quietly
 * omit `setHistoryFloor` and stop covering the `--since` wiring.
 */
function schedulerStub(
  forceSync: (serviceId: string) => Promise<void>,
  onFloor?: (serviceId: string, floorMs: number) => void,
): NonNullable<IndexRebodyRpcContext["syncScheduler"]> {
  return {
    forceSync,
    setHistoryFloor: (serviceId: string, floorMs: number) => {
      onFloor?.(serviceId, floorMs);
    },
  };
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
    seedIncomplete(db, "figma", "1");
    seedIncomplete(db, "zoom", "1");
    seedIncomplete(db, "slack", "1");

    await dispatchIndexRebodyRpc("index.rebody", { dryRun: true }, ctx);
    await new Promise((r) => setTimeout(r, 50));

    const done = events.find((e) => e.method === "index.rebodyDone");
    const payload = done?.params as Record<string, unknown> | undefined;
    expect(payload?.["cannotImprove"]).toEqual(["figma", "zoom"]);
  });

  test("dry run flags a service merely ABSENT from REBODY_IMPROVABLE_SERVICES, not only the pre-inversion hardcoded three", async () => {
    // "brand-new-saas" is not in REBODY_IMPROVABLE_SERVICES — under the inverted,
    // correct-by-construction list it must still be reported as cannot-improve, with zero
    // maintenance action required.
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

  test("real run with an unknown/typo'd service emits index.rebodyError (-32602) and clears no watermark", async () => {
    const { ctx, db, events } = freshCtx();
    upsertSchedulerRegistration(db, "typo-service", 60_000, Date.now(), true);
    db.query(`UPDATE scheduler_state SET cursor = ? WHERE service_id = ?`).run(
      "existing-cursor",
      "typo-service",
    );

    const out = await dispatchIndexRebodyRpc("index.rebody", { service: "typo-service" }, ctx);
    expect(out.kind).toBe("hit");
    await new Promise((r) => setTimeout(r, 50));

    // Nothing was touched: no forceSync, no watermark clear, no wasted API quota.
    expect(loadSchedulerState(db, "typo-service")?.cursor).toBe("existing-cursor");
    const err = events.find((e) => e.method === "index.rebodyError");
    expect(err).toBeDefined();
    const errPayload = err?.params as Record<string, unknown> | undefined;
    expect(errPayload?.["code"]).toBe(-32602);
    expect(errPayload?.["message"]).toMatch(/typo-service/);
    expect(events.find((e) => e.method === "index.rebodyDone")).toBeUndefined();
  });

  test("real run with explicit service clears the watermark and, with no scheduler wired, still succeeds — but a cannot-improve service's pending count never moves", async () => {
    const { ctx, db, events } = freshCtx();
    seedIncomplete(db, "figma", "p1");
    upsertSchedulerRegistration(db, "figma", 60_000, Date.now(), true);
    // Simulate an existing watermark that rebody must clear.
    db.query(`UPDATE scheduler_state SET cursor = ? WHERE service_id = ?`).run(
      "some-cursor",
      "figma",
    );
    expect(loadSchedulerState(db, "figma")?.cursor).toBe("some-cursor");

    const out = await dispatchIndexRebodyRpc("index.rebody", { service: "figma" }, ctx);
    expect(out.kind).toBe("hit");
    await new Promise((r) => setTimeout(r, 50));

    expect(loadSchedulerState(db, "figma")?.cursor).toBeNull();
    const progressEvents = events.filter((e) => e.method === "index.rebodyProgress");
    expect(progressEvents).toHaveLength(1);
    const done = events.find((e) => e.method === "index.rebodyDone");
    expect(done).toBeDefined();
    const payload = done?.params as Record<string, unknown> | undefined;
    expect(payload?.["targeted"]).toEqual(["figma"]);
    // succeeded=1 (the watermark clear + no-scheduler path "succeeded") coexists with an
    // UNMOVED pending count — that is the honesty requirement this test is pinning down.
    expect(payload?.["succeeded"]).toBe(1);
    expect(payload?.["failed"]).toBe(0);
    expect(payload?.["pendingBefore"]).toEqual({ figma: 1 });
    expect(payload?.["pendingAfter"]).toEqual({ figma: 1 });
    expect(payload?.["cannotImprove"]).toEqual(["figma"]);
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
    expect((payload?.["targeted"] as string[] | undefined)?.length).toBe(1);
  });

  test("real run with a live syncScheduler that succeeds", async () => {
    const calls: string[] = [];
    const { ctx, db, events } = freshCtx({
      syncScheduler: schedulerStub(async (serviceId: string) => {
        calls.push(serviceId);
      }),
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

  test("sinceDays arms the connector's cold-start floor BEFORE the forced run", async () => {
    // Ordering is the whole point: the scheduler reads its stored floor while
    // building the run context inside `forceSync`. Setting it afterwards would
    // typecheck, pass a naive "was it called" assertion, and still let the run
    // it was meant to widen go out at the connector's own 30-day floor.
    const order: string[] = [];
    let floorArgs: { serviceId: string; floorMs: number } | undefined;
    const { ctx, db } = freshCtx({
      syncScheduler: schedulerStub(
        async (serviceId: string) => {
          order.push(`forceSync:${serviceId}`);
        },
        (serviceId, floorMs) => {
          order.push(`setHistoryFloor:${serviceId}`);
          floorArgs = { serviceId, floorMs };
        },
      ),
    });
    seedIncomplete(db, "jira", "1", "issue");

    const before = Date.now();
    await dispatchIndexRebodyRpc("index.rebody", { service: "jira", sinceDays: 365 }, ctx);
    await new Promise((r) => setTimeout(r, 50));

    expect(order).toEqual(["setHistoryFloor:jira", "forceSync:jira"]);
    expect(floorArgs?.serviceId).toBe("jira");
    // 365 days back from "now", allowing for the clock moving during the run.
    const expected = before - 365 * 86_400_000;
    expect(floorArgs?.floorMs).toBeGreaterThanOrEqual(expected);
    expect(floorArgs?.floorMs).toBeLessThanOrEqual(expected + 60_000);
  });

  test("omitting sinceDays arms no floor at all", async () => {
    // The floor is an explicit, owner-initiated widening. An unconditional
    // call here would re-walk history on a plain `nimbus index rebody`, which
    // is real API spend nobody asked for.
    let floorCalls = 0;
    const { ctx, db } = freshCtx({
      syncScheduler: schedulerStub(
        async () => undefined,
        () => {
          floorCalls += 1;
        },
      ),
    });
    seedIncomplete(db, "jira", "1", "issue");

    await dispatchIndexRebodyRpc("index.rebody", { service: "jira" }, ctx);
    await new Promise((r) => setTimeout(r, 50));

    expect(floorCalls).toBe(0);
  });

  test("real run with a live syncScheduler that throws counts it as failed, not fatal", async () => {
    const { ctx, db, events } = freshCtx({
      syncScheduler: schedulerStub(async () => {
        throw new Error("rate limited");
      }),
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

  test("cancel aborts a real run before it processes further targets — observably fewer than all 3 targets get forceSync'd", async () => {
    const forceSyncCalls: string[] = [];
    const { ctx, db, events } = freshCtx({
      syncScheduler: schedulerStub(async (serviceId: string) => {
        forceSyncCalls.push(serviceId);
        await new Promise((r) => setTimeout(r, 30));
      }),
    });
    seedIncomplete(db, "a", "1");
    seedIncomplete(db, "b", "1");
    seedIncomplete(db, "c", "1");

    const out = await dispatchIndexRebodyRpc("index.rebody", {}, ctx);
    const hit = (out as { kind: "hit"; value: { jobId: string } }).value;
    // Cancel immediately — before the first in-flight forceSync("a") has resolved, so the loop
    // must never reach "b" or "c".
    const cancelOut = await dispatchIndexRebodyRpc("index.rebodyCancel", { jobId: hit.jobId }, ctx);
    expect((cancelOut as { kind: "hit"; value: { cancelled: boolean } }).value.cancelled).toBe(
      true,
    );
    await new Promise((r) => setTimeout(r, 100));

    // This is the assertion that actually guards cancellation: deleting the `signal.aborted`
    // break in runRebody's loop makes forceSync get called for all 3 targets, whereas the old
    // assertion (only `cancelled === true`) would still pass either way.
    expect(forceSyncCalls.length).toBeLessThan(3);
    expect(forceSyncCalls).toEqual(["a"]);
    const done = events.find((e) => e.method === "index.rebodyDone");
    expect(done).toBeDefined();
    const payload = done?.params as Record<string, unknown> | undefined;
    expect(payload?.["targeted"]).toEqual(["a", "b", "c"]);
    const processed = (payload?.["succeeded"] as number) + (payload?.["failed"] as number);
    expect(processed).toBe(1);
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
    //   bitbucket-sync.ts:137, confluence-sync.ts:150, discord-sync.ts:203,
    //   github-sync.ts:207+247 (pr AND issue), _lib/gmail/api.ts:168, jira-sync.ts:268,
    //   linear-sync.ts:175, notion-sync.ts:245, obsidian-sync.ts:78, outlook-sync.ts:74,
    //   slack-sync.ts:282, snyk-issue-mapping.ts:117, _lib/teams/api.ts:88.
    for (const service of [
      "bitbucket",
      "confluence",
      "discord",
      "github",
      "gmail",
      "jira",
      "linear",
      "notion",
      "obsidian",
      "outlook",
      "slack",
      "snyk",
      "teams",
    ]) {
      expect(REBODY_IMPROVABLE_SERVICES.has(service)).toBe(true);
    }
  });

  test("notion and confluence can now be improved by rebody", () => {
    expect(REBODY_IMPROVABLE_SERVICES.has("notion")).toBe(true);
    expect(REBODY_IMPROVABLE_SERVICES.has("confluence")).toBe(true);
    expect(cannotImproveAmong({ notion: 3, confluence: 2, zoom: 1 })).toEqual(["zoom"]);
  });

  test("gmail and outlook can now be improved by rebody", () => {
    expect(REBODY_IMPROVABLE_SERVICES.has("gmail")).toBe(true);
    expect(REBODY_IMPROVABLE_SERVICES.has("outlook")).toBe(true);
    expect(cannotImproveAmong({ gmail: 2, outlook: 1, zoom: 1 })).toEqual(["zoom"]);
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
    expect(cannotImproveAmong({ slack: 2, figma: 5, jira: 1, zoom: 3 })).toEqual(["figma", "zoom"]);
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
    // One (service, version) pair per registered service, and nothing else.
    expect(params).toEqual([...REBODY_REQUIRED_META_VERSION].flat());
  });

  test("with type filter", () => {
    const { sql, params } = buildTargetServicesSql({ type: "issue" });
    expect(sql).toContain("AND type = ?");
    // The type filter is appended AFTER the metadata pairs — order is load-bearing,
    // since these are positional `?` bindings.
    expect(params.at(-1)).toBe("issue");
    expect(params).toHaveLength([...REBODY_REQUIRED_META_VERSION].flat().length + 1);
  });
});

describe("rebody eligibility by metadata version", () => {
  function freshDb(): Database {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    return db;
  }

  /** A row with a genuinely complete body, plus whatever metadata is passed. */
  function seedCompleteWithMeta(
    db: Database,
    service: string,
    externalId: string,
    type: string,
    metadata: Record<string, unknown>,
  ) {
    upsertIndexedItem(db, {
      service,
      type,
      externalId,
      title: "T",
      body: "short full body",
      modifiedAt: 1,
      syncedAt: 1,
      metadata,
    });
  }

  test("a service with complete bodies but stale metadata is eligible", () => {
    const db = freshDb();
    seedCompleteWithMeta(db, "jira", "PROJ-1", "issue", { jiraId: "1", key: "PROJ-1" });
    expect(resolveTargetServices({ service: "jira" }, db)).toEqual(["jira"]);
  });

  test("a service current on both counts is still refused", () => {
    const db = freshDb();
    seedCompleteWithMeta(db, "jira", "PROJ-1", "issue", {
      jiraId: "1",
      key: "PROJ-1",
      meta_v: 1,
    });
    expect(() => resolveTargetServices({ service: "jira" }, db)).toThrow(/nothing to recover/);
  });

  test("a service with no metadata requirement keeps body-only eligibility", () => {
    const db = freshDb();
    seedCompleteWithMeta(db, "slack", "C1", "message", {});
    expect(() => resolveTargetServices({ service: "slack" }, db)).toThrow(/nothing to recover/);
  });

  test("an incomplete body is still eligible regardless of metadata version", () => {
    const db = freshDb();
    seedIncomplete(db, "slack", "C1");
    expect(resolveTargetServices({ service: "slack" }, db)).toEqual(["slack"]);
  });

  test("sinceDays is validated, not silently dropped", () => {
    expect(parseRebodyParams({ sinceDays: 365 }).sinceDays).toBe(365);
    expect(() => parseRebodyParams({ sinceDays: 0 })).toThrow(/positive/);
    expect(() => parseRebodyParams({ sinceDays: -5 })).toThrow(/positive/);
    expect(() => parseRebodyParams({ sinceDays: "365" })).toThrow(/positive/);
  });

  test("a sinceDays window reaching before 1970 is refused with a legible message", () => {
    // `jqlFloorFromMs` would emit a negative year and Jira would answer with an
    // opaque 400; reject it here instead.
    expect(() => parseRebodyParams({ sinceDays: 40_000 })).toThrow(/before 1970/);
  });

  test("omitting sinceDays leaves it unset", () => {
    expect(parseRebodyParams({}).sinceDays).toBeUndefined();
  });
});

describe("resolveTargetServices", () => {
  test("explicit service with a matching pending row short-circuits the query", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    seedIncomplete(db, "slack", "1");
    expect(resolveTargetServices({ service: "slack" }, db)).toEqual(["slack"]);
  });

  test("explicit service with NO pending rows throws -32602 (refuses to spend API quota on nothing)", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    expect(() => resolveTargetServices({ service: "totally-unknown" }, db)).toThrow(
      IndexRebodyRpcError,
    );
  });

  test("explicit service that HAS pending rows but none of the requested type throws -32602 (type is honoured, not silently ignored)", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    // jira has a pending "message" row but the caller asks for type "issue" — must not silently
    // fall back to re-walking all of jira ignoring the type filter.
    seedIncomplete(db, "jira", "1", "message");
    let thrown: IndexRebodyRpcError | undefined;
    try {
      resolveTargetServices({ service: "jira", type: "issue" }, db);
    } catch (e) {
      thrown = e as IndexRebodyRpcError;
    }
    expect(thrown).toBeInstanceOf(IndexRebodyRpcError);
    expect(thrown?.message).toMatch(/type "issue"/);
  });

  test("explicit service + type that DOES match proceeds normally", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    seedIncomplete(db, "jira", "1", "issue");
    expect(resolveTargetServices({ service: "jira", type: "issue" }, db)).toEqual(["jira"]);
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

describe("REBODY_REQUIRED_META_VERSION", () => {
  test("pagerduty rows below the attribution meta version are eligible for rebody", () => {
    expect(REBODY_REQUIRED_META_VERSION.get("pagerduty")).toBe(PAGERDUTY_INCIDENT_META_VERSION);
  });
});
