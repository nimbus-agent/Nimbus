import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { BriefingCounts } from "../agents/_lib/briefing-types.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { type BriefingStore, createBriefingStore, SlotTakenError } from "./briefing-store.ts";

const COUNTS: BriefingCounts = {
  meetings: 1,
  onCallShifts: 0,
  incidents: 2,
  reviews: 3,
  ticketsDue: 4,
  unreadMail: 5,
  unreadChat: 6,
};

let db: Database;
let store: BriefingStore;
beforeEach(() => {
  db = openMemoryIndexDatabase();
  store = createBriefingStore(db);
});
afterEach(() => db.close());

describe("briefing runs", () => {
  test("insertRun returns the id and the row round-trips, counts included", () => {
    const id = store.insertRun({
      firedAt: 100,
      firedBy: "schedule",
      status: "ok",
      headline: "3 meetings",
      markdown: "# hi",
      counts: COUNTS,
      toastOutcome: "delivered",
      slotAt: 50,
    });
    const got = store.get(id);
    expect(got).toEqual({
      id,
      firedAt: 100,
      firedBy: "schedule",
      status: "ok",
      headline: "3 meetings",
      markdown: "# hi",
      counts: COUNTS,
      toastOutcome: "delivered",
      slotAt: 50,
      errorMsg: null,
    });
    expect(store.get("nope")).toBeNull();
  });

  test("a second schedule run on the same slot throws SlotTakenError and inserts nothing", () => {
    store.insertRun({ firedAt: 1, firedBy: "schedule", status: "ok", headline: "a", slotAt: 7 });
    expect(() =>
      store.insertRun({
        firedAt: 2,
        firedBy: "schedule",
        status: "skipped",
        headline: "b",
        slotAt: 7,
      }),
    ).toThrow(SlotTakenError);
    expect(db.query("SELECT count(*) AS n FROM briefing_run").get()).toEqual({ n: 1 });
  });

  test("manual runs (no slot) never collide", () => {
    store.insertRun({ firedAt: 1, firedBy: "manual", status: "ok", headline: "a" });
    store.insertRun({ firedAt: 2, firedBy: "manual", status: "ok", headline: "b" });
    expect(store.list(10)).toHaveLength(2);
  });

  test("setToastOutcome updates the stored outcome", () => {
    const id = store.insertRun({ firedAt: 1, firedBy: "manual", status: "ok", headline: "a" });
    expect(store.get(id)?.toastOutcome).toBeNull();
    store.setToastOutcome(id, "rate_limited");
    expect(store.get(id)?.toastOutcome).toBe("rate_limited");
  });

  test("latestOk skips skipped and failed runs; none gives null", () => {
    expect(store.latestOk()).toBeNull();
    const ok = store.insertRun({
      firedAt: 10,
      firedBy: "manual",
      status: "ok",
      headline: "ok",
      markdown: "m",
    });
    store.insertRun({
      firedAt: 20,
      firedBy: "schedule",
      status: "skipped",
      headline: "s",
      slotAt: 1,
    });
    store.insertRun({
      firedAt: 30,
      firedBy: "manual",
      status: "failed",
      headline: "f",
      errorMsg: "boom",
    });
    expect(store.latestOk()?.id).toBe(ok);
    expect(store.latestOk()?.markdown).toBe("m");
  });

  test("list is newest first, limited, and carries no markdown; lastRun is any status", () => {
    store.insertRun({ firedAt: 10, firedBy: "manual", status: "ok", headline: "a", markdown: "x" });
    store.insertRun({
      firedAt: 30,
      firedBy: "manual",
      status: "failed",
      headline: "c",
      errorMsg: "e",
    });
    store.insertRun({ firedAt: 20, firedBy: "manual", status: "ok", headline: "b", markdown: "y" });
    const rows = store.list(2);
    expect(rows.map((r) => r.headline)).toEqual(["c", "b"]);
    expect("markdown" in (rows[0] ?? {})).toBe(false);
    expect(store.lastRun()?.headline).toBe("c");
    expect(store.lastRun()?.errorMsg).toBe("e");
  });

  test("lastSlotAt is MAX(slot_at) or null; lastRun of an empty table is null", () => {
    expect(store.lastSlotAt()).toBeNull();
    expect(store.lastRun()).toBeNull();
    store.insertRun({ firedAt: 1, firedBy: "schedule", status: "ok", headline: "a", slotAt: 5 });
    store.insertRun({
      firedAt: 2,
      firedBy: "schedule",
      status: "skipped",
      headline: "b",
      slotAt: 9,
    });
    store.insertRun({ firedAt: 3, firedBy: "manual", status: "ok", headline: "c" });
    expect(store.lastSlotAt()).toBe(9);
  });

  test("pruneRuns deletes only runs fired before the cutoff", () => {
    store.insertRun({ firedAt: 5, firedBy: "manual", status: "ok", headline: "old" });
    store.insertRun({ firedAt: 50, firedBy: "manual", status: "ok", headline: "new" });
    expect(store.pruneRuns(10)).toBe(1);
    expect(store.list(10).map((r) => r.headline)).toEqual(["new"]);
  });

  test("a corrupt or incomplete counts_json reads back as null counts", () => {
    const id = store.insertRun({ firedAt: 1, firedBy: "manual", status: "ok", headline: "a" });
    expect(store.get(id)?.counts).toBeNull();
    db.run("UPDATE briefing_run SET counts_json = '{bad' WHERE id = ?", [id]);
    expect(store.get(id)?.counts).toBeNull();
    db.run("UPDATE briefing_run SET counts_json = '5' WHERE id = ?", [id]);
    expect(store.get(id)?.counts).toBeNull();
    db.run("UPDATE briefing_run SET counts_json = '{\"meetings\":1}' WHERE id = ?", [id]);
    expect(store.get(id)?.counts).toBeNull();
    db.run("UPDATE briefing_run SET counts_json = 'null' WHERE id = ?", [id]);
    expect(store.get(id)?.counts).toBeNull();
  });
});

describe("deadline notices", () => {
  test("insert, get, update, prune", () => {
    expect(store.getNotice("i1")).toBeNull();
    store.insertNotice({ itemId: "i1", dueAtMs: 100, notifiedAt: 1 });
    store.insertNotice({ itemId: "i2", dueAtMs: 1000, notifiedAt: 1 });
    expect(store.getNotice("i1")).toEqual({ itemId: "i1", dueAtMs: 100, notifiedAt: 1 });
    store.updateNotice({ itemId: "i1", dueAtMs: 200, notifiedAt: 2 });
    expect(store.getNotice("i1")).toEqual({ itemId: "i1", dueAtMs: 200, notifiedAt: 2 });
    expect(store.pruneNotices(500)).toBe(1);
    expect(store.getNotice("i1")).toBeNull();
    expect(store.getNotice("i2")).not.toBeNull();
  });
});
