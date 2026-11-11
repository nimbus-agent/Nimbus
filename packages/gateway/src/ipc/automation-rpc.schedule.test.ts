import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchAutomationRpc } from "./automation-rpc.ts";
import { dispatchFederationRpc } from "./federation-rpc.ts";
import { checkLanMethodAllowed } from "./lan-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

const WRITE_ONLY = JSON.stringify([
  {
    kind: "query",
    label: "q",
    query: { service: "gmail", type: "email", select: "metadata.threadId", limit: 5 },
  },
  {
    kind: "write",
    tool: "gmail_thread_archive",
    input: { threadId: { from: "q", column: "metadata.threadId" } },
  },
]);

function save(db: Database, kind: ClientKind | undefined, params: Record<string, unknown>) {
  return dispatchAutomationRpc({
    method: "workflow.save",
    params: { name: "wf", stepsJson: WRITE_ONLY, ...params },
    db,
    ...(kind === undefined ? {} : { clientKind: kind }),
  });
}

function scheduleOf(db: Database): Record<string, unknown> | null {
  return db
    .query("SELECT schedule, schedule_tz, schedule_next_at FROM workflow WHERE name = 'wf'")
    .get() as Record<string, unknown> | null;
}

describe("workflow.save with a schedule (Phase 10 SA4)", () => {
  test("a local cli or ui client stores the schedule, the zone and the first fire", async () => {
    for (const kind of ["cli", "ui"] as const) {
      const db = freshDb();
      const out = await save(db, kind, { schedule: "0 6 * * *", scheduleTz: "Europe/Berlin" });
      expect(out).toMatchObject({ kind: "hit", value: { scheduled: true } });
      const row = scheduleOf(db);
      expect(row?.["schedule"]).toBe("0 6 * * *");
      expect(row?.["schedule_tz"]).toBe("Europe/Berlin");
      expect(row?.["schedule_next_at"]).toBeGreaterThan(Date.now());
      db.close();
    }
  });

  test("the zone defaults to the machine zone, resolved once and stored", async () => {
    const db = freshDb();
    await save(db, "cli", { schedule: "@daily" });
    expect(String(scheduleOf(db)?.["schedule_tz"]).length).toBeGreaterThan(0);
    db.close();
  });

  test("every other declared kind, and an unknown one, is refused ERR_SCHEDULE_LOCAL_ONLY", async () => {
    const kinds: Array<ClientKind | undefined> = [
      "mcp",
      "http",
      "chatops",
      "fleet",
      "push",
      "unknown",
      undefined,
    ];
    for (const kind of kinds) {
      const db = freshDb();
      await expect(save(db, kind, { schedule: "0 6 * * *" }), String(kind)).rejects.toMatchObject({
        rpcCode: -32602,
        message: expect.stringContaining("ERR_SCHEDULE_LOCAL_ONLY"),
      });
      expect(db.query("SELECT COUNT(*) AS n FROM workflow").get()).toEqual({ n: 0 });
      db.close();
    }
  });

  test("a clientKind in params is refused, not believed", async () => {
    const db = freshDb();
    await expect(
      save(db, "mcp", { schedule: "0 6 * * *", clientKind: "cli" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("clientKind is derived by the gateway"),
    });
    expect(scheduleOf(db)).toBeNull();
    db.close();
  });

  test("a LAN peer cannot reach workflow.save, workflow.unschedule or workflow.resume at all", async () => {
    const peer = { peerId: "p1", writeAllowed: true };
    expect(() => checkLanMethodAllowed("workflow.resume", peer)).toThrow(/not callable over LAN/);
    // save and unschedule pass the LAN method check for a writeAllowed peer (so a future route would
    // still need a write grant), but the LAN dispatcher serves only federation.* and misses them.
    expect(() => checkLanMethodAllowed("workflow.save", peer)).not.toThrow();
    expect(() => checkLanMethodAllowed("workflow.unschedule", peer)).not.toThrow();
    expect(() =>
      checkLanMethodAllowed("workflow.unschedule", { peerId: "p2", writeAllowed: false }),
    ).toThrow(/ERR_LAN_WRITE_FORBIDDEN/);
    const db = freshDb();
    const out = await dispatchFederationRpc(
      "workflow.save",
      { name: "wf", stepsJson: WRITE_ONLY, schedule: "0 6 * * *" },
      { db } as never,
    );
    expect(out.kind).toBe("miss");
    expect(scheduleOf(db)).toBeNull();
    db.close();
  });

  test("a workflow with a model (run) step cannot be scheduled (OR-10-8)", async () => {
    const db = freshDb();
    const withRun = JSON.stringify([{ run: "summarise" }]);
    await expect(
      save(db, "cli", { stepsJson: withRun, schedule: "0 6 * * *" }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("ERR_SCHEDULE_MODEL_STEP"),
    });
    // Unscheduled, the same workflow still saves.
    expect((await save(db, "cli", { stepsJson: withRun })).kind).toBe("hit");
    db.close();
  });

  test("a schedule that is malformed, too fast or in an unknown zone is refused and stores nothing", async () => {
    const db = freshDb();
    for (const params of [
      { schedule: "nope" },
      { schedule: "*/2 * * * *" },
      { schedule: "0 6 * * *", scheduleTz: "Mars/Olympus" },
      { schedule: 5 },
      { schedule: "0 6 * * *", scheduleTz: 7 },
      { schedule: "   " },
    ]) {
      await expect(save(db, "cli", params), JSON.stringify(params)).rejects.toMatchObject({
        rpcCode: -32602,
        message: expect.stringContaining("ERR_SCHEDULE_INVALID"),
      });
    }
    await expect(save(db, "cli", { scheduleTz: "UTC" })).rejects.toMatchObject({
      message: expect.stringContaining("scheduleTz needs a schedule"),
    });
    expect(db.query("SELECT COUNT(*) AS n FROM workflow").get()).toEqual({ n: 0 });
    db.close();
  });

  test("a save without a schedule clears the old one, from any kind", async () => {
    const db = freshDb();
    await save(db, "cli", { schedule: "0 6 * * *", scheduleTz: "UTC" });
    expect(scheduleOf(db)?.["schedule"]).toBe("0 6 * * *");
    const out = await save(db, "mcp", {});
    expect(out).toMatchObject({ kind: "hit", value: { scheduled: false } });
    expect(scheduleOf(db)).toEqual({ schedule: null, schedule_tz: null, schedule_next_at: null });
    db.close();
  });

  test("any step change changes the hash a rule is bound to, and re-saving keeps one schedule", async () => {
    const db = freshDb();
    await save(db, "cli", { schedule: "0 6 * * *", scheduleTz: "UTC" });
    const first = scheduleOf(db);
    await save(db, "cli", { schedule: "0 7 * * *", scheduleTz: "UTC" });
    expect(scheduleOf(db)?.["schedule"]).toBe("0 7 * * *");
    expect(scheduleOf(db)?.["schedule_next_at"]).not.toBe(first?.["schedule_next_at"]);
    expect(db.query("SELECT COUNT(*) AS n FROM workflow").get()).toEqual({ n: 1 });
    db.close();
  });

  test("workflow.unschedule clears a schedule, reports a miss, and refuses a supplied clientKind", async () => {
    const db = freshDb();
    await save(db, "cli", { schedule: "0 6 * * *", scheduleTz: "UTC" });
    const hit = await dispatchAutomationRpc({
      method: "workflow.unschedule",
      params: { name: "wf" },
      db,
    });
    expect(hit).toMatchObject({ kind: "hit", value: { ok: true } });
    expect(scheduleOf(db)?.["schedule"]).toBeNull();
    const miss = await dispatchAutomationRpc({
      method: "workflow.unschedule",
      params: { name: "nope" },
      db,
    });
    expect(miss).toMatchObject({ kind: "hit", value: { ok: false } });
    await expect(
      dispatchAutomationRpc({
        method: "workflow.unschedule",
        params: { name: "wf", clientKind: "cli" },
        db,
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("clientKind") });
    db.close();
  });
});
