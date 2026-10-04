import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { dbRun } from "../db/write.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { PushStore } from "./push-store.ts";

let db: Database;
let store: PushStore;
beforeEach(() => {
  db = createMemoryIndexDb(); // migrates to CURRENT_SCHEMA_VERSION, so V64 must exist
  store = new PushStore(db);
});
afterEach(() => db.close());

const OK = { status: "ok", sessionId: "s1", briefMarkdown: "# brief", briefJson: "{}" } as const;
const FAILED = {
  status: "failed",
  sessionId: null,
  failureCode: "timeout: no brief in 30000ms",
} as const;

describe("PushStore", () => {
  const must = <T>(v: T | null): T => {
    if (v === null) throw new Error("expected a row");
    return v;
  };

  const incident = (externalId: string, title: string, metadata: Record<string, unknown>) =>
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId,
      title,
      body: "",
      modifiedAt: 1,
      syncedAt: 1,
      authorId: null,
      url: null,
      metadata,
    });

  test("listWithIncident joins title + PagerDuty service id, newest first, in one query", () => {
    incident("A", "checkout: 5xx", { pagerduty_service_id: "PSVC" });
    store.insert("pagerduty:A", OK, 1000);
    store.insert("pagerduty:GONE", FAILED, 2000); // its incident is not (or no longer) indexed
    expect(store.listWithIncident(10)).toEqual([
      { row: must(store.get("pagerduty:GONE")), title: null, pagerdutyServiceId: null },
      { row: must(store.get("pagerduty:A")), title: "checkout: 5xx", pagerdutyServiceId: "PSVC" },
    ]);
  });

  test("one malformed item.metadata does not fail the list (json_extract RAISES unguarded)", () => {
    incident("A", "a", { pagerduty_service_id: "PSVC" });
    incident("B", "b", { pagerduty_service_id: "PB" });
    store.insert("pagerduty:A", OK, 1);
    store.insert("pagerduty:B", OK, 2);
    // Simulated corruption: no writer produces this, which is exactly why the guard exists.
    dbRun(db, "UPDATE item SET metadata = 'not json' WHERE id = ?", ["pagerduty:B"]);
    const out = store.listWithIncident(10);
    expect(out.map((l) => [l.row.incidentId, l.title, l.pagerdutyServiceId])).toEqual([
      ["pagerduty:B", "b", null],
      ["pagerduty:A", "a", "PSVC"],
    ]);
    expect(store.incidentPagerdutyServiceId("pagerduty:B")).toBeNull();
  });

  test("incidentPagerdutyServiceId: value, absent field, absent incident", () => {
    incident("A", "a", { pagerduty_service_id: "PSVC" });
    incident("N", "n", {});
    expect(store.incidentPagerdutyServiceId("pagerduty:A")).toBe("PSVC");
    expect(store.incidentPagerdutyServiceId("pagerduty:N")).toBeNull();
    expect(store.incidentPagerdutyServiceId("pagerduty:NOPE")).toBeNull();
  });

  test("schema is V64", () => {
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(
      64,
    );
  });

  test("insert ok, then has/get/newest", () => {
    expect(store.has("pagerduty:P1")).toBe(false);
    const row = store.insert("pagerduty:P1", OK, 1000);
    expect(row).toMatchObject({
      incidentId: "pagerduty:P1",
      status: "ok",
      briefMarkdown: "# brief",
      createdAt: 1000,
      retriedAt: null,
      delivery: {},
    });
    expect(store.has("pagerduty:P1")).toBe(true);
    expect(store.newest()?.incidentId).toBe("pagerduty:P1");
  });

  test("insert twice for one incident throws — the table IS the dedup", () => {
    store.insert("pagerduty:P1", OK, 1000);
    expect(() => store.insert("pagerduty:P1", OK, 2000)).toThrow();
  });

  test("failed row keeps the code and no brief", () => {
    expect(store.insert("pagerduty:P2", FAILED, 1000)).toMatchObject({
      status: "failed",
      failureCode: FAILED.failureCode,
      briefMarkdown: null,
    });
  });

  test("applyRetry keeps created_at and sets retried_at", () => {
    store.insert("pagerduty:P2", FAILED, 1000);
    const row = store.applyRetry("pagerduty:P2", OK, 5000);
    expect(row).toMatchObject({
      status: "ok",
      createdAt: 1000,
      retriedAt: 5000,
      failureCode: null,
      briefMarkdown: "# brief",
    });
  });

  test("a FAILED retry records the new session id and code, stays failed", () => {
    store.insert("pagerduty:P3", FAILED, 1000);
    const row = store.applyRetry(
      "pagerduty:P3",
      { status: "failed", sessionId: "s-retry", failureCode: "brief_error: boom" },
      6000,
    );
    expect(row).toMatchObject({
      status: "failed",
      sessionId: "s-retry",
      failureCode: "brief_error: boom",
      createdAt: 1000,
      retriedAt: 6000,
    });
  });

  test("a FAILED retry never downgrades a row a concurrent attempt already made ok", () => {
    store.insert("pagerduty:P4", FAILED, 1000);
    store.applyRetry("pagerduty:P4", OK, 5000);
    const row = store.applyRetry(
      "pagerduty:P4",
      { status: "failed", sessionId: "s-late", failureCode: "brief_error: late" },
      6000,
    );
    expect(row).toMatchObject({
      status: "ok",
      failureCode: null,
      briefMarkdown: "# brief",
      retriedAt: 5000,
    });
  });

  test("recordDelivery merges per sink", () => {
    store.insert("pagerduty:P1", OK, 1000);
    store.recordDelivery("pagerduty:P1", "toast", { outcome: "delivered", at: 1 });
    store.recordDelivery("pagerduty:P1", "event", { outcome: "failed", reason: "x", at: 2 });
    expect(store.get("pagerduty:P1")?.delivery).toEqual({
      toast: { outcome: "delivered", at: 1 },
      event: { outcome: "failed", reason: "x", at: 2 },
    });
  });

  test("incidentTitle reads the indexed incident title, null when absent", () => {
    // The real writer (the same call shape demo/seed.ts's writeItems uses), never a raw INSERT.
    upsertIndexedItem(db, {
      service: "pagerduty",
      type: "incident",
      externalId: "T1",
      title: "checkout: 5xx",
      body: "",
      modifiedAt: 1,
      syncedAt: 1,
      authorId: null,
      url: null,
      metadata: {},
    });
    expect(store.incidentTitle("pagerduty:T1")).toBe("checkout: 5xx");
    expect(store.incidentTitle("pagerduty:NOPE")).toBeNull();
  });

  test("list is newest first, bounded; prune drops old rows", () => {
    store.insert("a", OK, 1000);
    store.insert("b", OK, 3000);
    store.insert("c", OK, 2000);
    expect(store.list(2).map((r) => r.incidentId)).toEqual(["b", "c"]);
    expect(store.pruneOlderThan(2500)).toBe(2);
    expect(store.list(10).map((r) => r.incidentId)).toEqual(["b"]);
  });

  describe("reconcileEnabledState (spec § 4.1)", () => {
    test("enabled + no row → stamps now", () => {
      store.reconcileEnabledState(true, 7000);
      expect(store.enabledAt()).toBe(7000);
    });
    test("enabled + existing row → keeps the original", () => {
      store.reconcileEnabledState(true, 7000);
      store.reconcileEnabledState(true, 9000);
      expect(store.enabledAt()).toBe(7000);
    });
    test("disabled → clears, so the next enable never backfills the gap", () => {
      store.reconcileEnabledState(true, 7000);
      store.reconcileEnabledState(false, 8000);
      expect(store.enabledAt()).toBeNull();
      store.reconcileEnabledState(true, 9000);
      expect(store.enabledAt()).toBe(9000);
    });
  });
});
