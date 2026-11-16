import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { buildRecord } from "./__fixtures__/record-builder.ts";
import { incidentIdFor, resolveIncidentRef } from "./incident-id.ts";
import {
  eraseIncidentRecordsForService,
  getById,
  getByTriggerItem,
  listRecords,
  pruneIncidentRecords,
  recordsCitingService,
  upsertIncidentRecord,
  versionJson,
  versionsOf,
} from "./incident-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

function up(
  d: Database,
  over: Parameters<typeof buildRecord>[0] & { sha?: string; now?: number; cited?: string[] } = {},
) {
  const record = buildRecord(over);
  return upsertIncidentRecord(d, {
    record,
    markdown: `md ${over.sha ?? "h1"}`,
    recordSha256: over.sha ?? "h1",
    citedServices: over.cited ?? [record.trigger.service],
    nowMs: over.now ?? 5_000,
  });
}

describe("incidentIdFor", () => {
  test("is inc_ plus 16 hex and stable", () => {
    const id = incidentIdFor("pagerduty:PD1");
    expect(id).toMatch(/^inc_[0-9a-f]{16}$/);
    expect(incidentIdFor("pagerduty:PD1")).toBe(id);
    expect(incidentIdFor("pagerduty:PD2")).not.toBe(id);
  });
});

describe("upsertIncidentRecord", () => {
  test("inserts version 1 with checked_at equal to assembled_at", () => {
    const d = db();
    const r = up(d);
    expect(r).toMatchObject({ outcome: "created", version: 1, status: "open" });
    const row = getByTriggerItem(d, "pagerduty:PD1");
    expect(row).toMatchObject({
      id: r.recordId,
      version: 1,
      assembled_at_ms: 5_000,
      checked_at_ms: 5_000,
      trigger_service: "pagerduty",
      opened_at_ms: 1_000_000,
    });
    expect(JSON.parse(row?.record_json ?? "{}").version).toBe(1);
    expect(versionsOf(d, r.recordId)).toHaveLength(1);
  });

  test("the same hash writes no version and only moves checked_at_ms", () => {
    const d = db();
    const first = up(d);
    const before = getById(d, first.recordId);
    const again = up(d, { now: 9_000 });
    expect(again).toMatchObject({ outcome: "unchanged", version: 1 });
    const after = getById(d, first.recordId);
    expect(after?.version).toBe(1);
    expect(after?.assembled_at_ms).toBe(5_000);
    expect(after?.record_json).toBe(before?.record_json);
    expect(after?.checked_at_ms).toBe(9_000);
    expect(versionsOf(d, first.recordId)).toHaveLength(1);
  });

  test("a different hash updates the row and inserts version 2; version 1 stays byte-identical", () => {
    const d = db();
    const first = up(d);
    const v1 = versionJson(d, first.recordId, 1);
    const next = up(d, { sha: "h2", status: "closed", now: 8_000 });
    expect(next).toMatchObject({ outcome: "updated", version: 2, status: "closed" });
    const row = getById(d, first.recordId);
    expect(row).toMatchObject({
      version: 2,
      status: "closed",
      assembled_at_ms: 8_000,
      checked_at_ms: 8_000,
    });
    expect(JSON.parse(row?.record_json ?? "{}").version).toBe(2);
    expect(versionJson(d, first.recordId, 1)).toBe(v1);
    expect(versionsOf(d, first.recordId).map((v) => v.version)).toEqual([1, 2]);
  });

  test("record and version are one transaction: a failing version insert leaves version N intact", () => {
    const d = db();
    const first = up(d);
    // Pre-seed version 2 so the second insert collides on the primary key.
    d.run("INSERT INTO incident_record_version VALUES (?, 2, 1, 'x', '[]', '{}')", [
      first.recordId,
    ]);
    expect(() => up(d, { sha: "h2" })).toThrow();
    const row = getById(d, first.recordId);
    expect(row?.version).toBe(1);
    expect(row?.record_sha256).toBe("h1");
  });

  test("a different trigger item with the same id fails loudly", () => {
    const d = db();
    const r = up(d);
    expect(() =>
      d.run(
        `INSERT INTO incident_record (id, trigger_item_id, trigger_service, trigger_type, title, status, version,
           assembled_at_ms, checked_at_ms, record_sha256, cited_services, record_json, markdown)
         VALUES (?, 'other:1', 'pagerduty', 'incident', 't', 'open', 1, 1, 1, 'h', '[]', '{}', 'm')`,
        [r.recordId],
      ),
    ).toThrow();
  });
});

describe("class R and C selection by checked_at_ms (the store's index contract)", () => {
  test("least recently checked first, and an unchanged check moves a record to the back", () => {
    const d = db();
    up(d, { itemId: "pagerduty:A", now: 100 });
    up(d, { itemId: "pagerduty:B", now: 200 });
    const order = () =>
      (
        d
          .query(
            "SELECT trigger_item_id AS t FROM incident_record WHERE status = 'open' ORDER BY checked_at_ms ASC, id ASC",
          )
          .all() as { t: string }[]
      ).map((r) => r.t);
    expect(order()).toEqual(["pagerduty:A", "pagerduty:B"]);
    up(d, { itemId: "pagerduty:A", now: 300 }); // unchanged
    expect(order()).toEqual(["pagerduty:B", "pagerduty:A"]);
  });
});

describe("listRecords", () => {
  test("orders by open time DESC then id, a NULL open time last, and filters", () => {
    const d = db();
    up(d, { itemId: "pagerduty:A", openedAtMs: 10 });
    up(d, { itemId: "pagerduty:B", openedAtMs: 30 });
    up(d, {
      itemId: "bigeye:C",
      service: "bigeye",
      type: "data_quality_test",
      openedAtMs: null,
      status: "unknown",
    });
    up(d, {
      itemId: "jira:D",
      service: "jira",
      type: "alert",
      openedAtMs: 20,
      status: "closed",
      boundService: "payments",
    });
    const ids = (f: Parameters<typeof listRecords>[1]) =>
      listRecords(d, f).map((r) => r.trigger_item_id);
    expect(ids({ limit: 50 })).toEqual(["pagerduty:B", "jira:D", "pagerduty:A", "bigeye:C"]);
    expect(ids({ limit: 2 })).toEqual(["pagerduty:B", "jira:D"]);
    expect(ids({ limit: 50, open: true })).toEqual(["pagerduty:B", "pagerduty:A"]);
    expect(ids({ limit: 50, service: "payments" })).toEqual(["jira:D"]);
    expect(ids({ limit: 50, source: "bigeye" })).toEqual(["bigeye:C"]);
  });
});

describe("pruneIncidentRecords", () => {
  test("deletes by the two-arm rule, versions first, in batches", () => {
    const d = db();
    up(d, { itemId: "pagerduty:old", openedAtMs: 100, now: 9_999_999 }); // old open time, recent assembly
    up(d, { itemId: "pagerduty:new", openedAtMs: 9_000_000, now: 100 }); // recent open time, old assembly
    up(d, {
      itemId: "bigeye:oldnull",
      service: "bigeye",
      type: "data_quality_test",
      openedAtMs: null,
      now: 100,
    });
    up(d, {
      itemId: "bigeye:newnull",
      service: "bigeye",
      type: "data_quality_test",
      openedAtMs: null,
      now: 9_000_000,
    });
    up(d, { itemId: "pagerduty:old", sha: "h2", openedAtMs: 100, now: 9_999_999 }); // gives it a version 2
    const deleted = pruneIncidentRecords(d, 1_000_000, 1);
    expect(deleted).toHaveLength(1);
    const rest = pruneIncidentRecords(d, 1_000_000);
    expect([...deleted, ...rest].sort((a, b) => (a < b ? -1 : 1))).toEqual([
      "bigeye:oldnull",
      "pagerduty:old",
    ]);
    expect(
      (
        d.query("SELECT trigger_item_id AS t FROM incident_record ORDER BY id").all() as {
          t: string;
        }[]
      )
        .map((r) => r.t)
        .sort((a, b) => (a < b ? -1 : 1)),
    ).toEqual(["bigeye:newnull", "pagerduty:new"]);
    // no orphan versions with foreign keys off
    expect(
      d
        .query(
          "SELECT count(*) AS n FROM incident_record_version WHERE record_id NOT IN (SELECT id FROM incident_record)",
        )
        .get(),
    ).toEqual({ n: 0 });
  });
});

describe("eraseIncidentRecordsForService", () => {
  test("by trigger service, by cited_services, by ANY version, and by invalid JSON; unrelated stay", () => {
    const d = db();
    up(d, { itemId: "pagerduty:own", cited: ["pagerduty"] });
    up(d, { itemId: "jira:cites", service: "jira", type: "alert", cited: ["jira", "slack"] });
    // version 1 cited slack, version 2 does not
    up(d, {
      itemId: "sentry:v",
      service: "sentry",
      type: "error_issue",
      cited: ["sentry", "slack"],
      sha: "a",
    });
    up(d, {
      itemId: "sentry:v",
      service: "sentry",
      type: "error_issue",
      cited: ["sentry"],
      sha: "b",
    });
    up(d, { itemId: "montecarlo:bad", service: "montecarlo", type: "data_quality_test" });
    d.run(
      "UPDATE incident_record SET cited_services = 'not json' WHERE trigger_item_id = 'montecarlo:bad'",
    );
    up(d, {
      itemId: "bigeye:keep",
      service: "bigeye",
      type: "data_quality_test",
      cited: ["bigeye"],
    });

    expect(
      recordsCitingService(d, "slack")
        .map((r) => r.trigger_item_id)
        .sort(),
    ).toEqual(["jira:cites", "montecarlo:bad", "sentry:v"]);
    const r = eraseIncidentRecordsForService(d, "slack");
    expect([...r.triggerItemIds].sort()).toEqual(["jira:cites", "montecarlo:bad", "sentry:v"]);
    expect(
      (
        d.query("SELECT trigger_item_id AS t FROM incident_record ORDER BY t").all() as {
          t: string;
        }[]
      ).map((x) => x.t),
    ).toEqual(["bigeye:keep", "pagerduty:own"]);
    expect(d.query("SELECT count(*) AS n FROM incident_record_version").get()).toEqual({ n: 2 });
    // trigger service arm
    expect(eraseIncidentRecordsForService(d, "pagerduty").triggerItemIds).toEqual([
      "pagerduty:own",
    ]);
  });

  test("a quote, percent or underscore in a service id is data", () => {
    const d = db();
    up(d, { itemId: "pagerduty:a", cited: ["slack"] });
    for (const s of ["sl_ck", "sl%", "x' OR '1'='1", ""]) {
      expect(eraseIncidentRecordsForService(d, s).recordIds).toEqual([]);
    }
    expect(getByTriggerItem(d, "pagerduty:a")).not.toBeNull();
  });
});

describe("resolveIncidentRef", () => {
  test("record id > trigger item id > provider id; ambiguity lists candidates; metacharacters are literal", () => {
    const d = db();
    const a = up(d, { itemId: "pagerduty:PD1" });
    d.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES
        ('pagerduty:PD1','pagerduty','incident','PD1','t',1,1),
        ('jira:X1','jira','alert','X1','t',1,1),
        ('sentry:X1','sentry','error_issue','X1','t',1,1),
        ('github:PD1','github','issue','PD1','t',1,1),
        ('github:note','github','issue','note','t',1,1)`,
    );
    expect(resolveIncidentRef(d, a.recordId)).toEqual({
      kind: "record",
      recordId: a.recordId,
      triggerItemId: "pagerduty:PD1",
    });
    expect(resolveIncidentRef(d, "pagerduty:PD1")).toMatchObject({ kind: "record" });
    expect(resolveIncidentRef(d, "PD1")).toMatchObject({
      kind: "record",
      triggerItemId: "pagerduty:PD1",
    });
    expect(resolveIncidentRef(d, "jira:X1")).toEqual({
      kind: "item",
      triggerItemId: "jira:X1",
      service: "jira",
    });
    expect(resolveIncidentRef(d, "X1")).toEqual({
      kind: "ambiguous",
      candidates: ["jira:X1", "sentry:X1"],
    });
    expect(resolveIncidentRef(d, "github:note")).toEqual({
      kind: "not_a_trigger",
      itemId: "github:note",
    });
    expect(resolveIncidentRef(d, "note")).toEqual({ kind: "none" });
    expect(resolveIncidentRef(d, "%")).toEqual({ kind: "none" });
    expect(resolveIncidentRef(d, "PD_")).toEqual({ kind: "none" });
  });
});
