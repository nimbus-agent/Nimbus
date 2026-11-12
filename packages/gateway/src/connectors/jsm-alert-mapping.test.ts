import { describe, expect, test } from "bun:test";

import {
  JSM_ALERT_META_VERSION,
  mapJsmAlertToItem,
  parseAlertGet,
  parseAlertList,
} from "./jsm-alert-mapping.ts";

const CREATED = "2026-11-10T09:00:00.000Z";
const UPDATED = "2026-11-10T10:00:00.000Z";
const T0 = Date.parse(CREATED);
const CTX = { syncedAt: 42 };

const openP1 = {
  id: "alert-1",
  message: "Payments API 5xx",
  status: "open",
  priority: "P1",
  acknowledged: false,
  createdAt: CREATED,
  updatedAt: UPDATED,
  tags: ["payments", "prod"],
  entity: "payments-api",
  source: "datadog",
  responders: [
    { id: "user-1", type: "user" },
    { id: "team-9", type: "team" },
  ],
  description: "SECRET DESCRIPTION",
  owner: "owner@example.com",
  details: { runbook: "SECRET DETAIL" },
};

function meta(raw: unknown): Record<string, unknown> {
  const m = mapJsmAlertToItem(raw, CTX);
  if (m === null) throw new Error("expected a mapped row");
  return m.metadata;
}

describe("mapJsmAlertToItem", () => {
  test("an open P1 maps every metadata key of the design", () => {
    const row = mapJsmAlertToItem(openP1, CTX);
    expect(row).toMatchObject({
      service: "jira",
      type: "alert",
      externalId: "alert-1",
      title: "Payments API 5xx",
      bodyPreview: "open",
      url: null,
      canonicalUrl: null,
      modifiedAt: Date.parse(UPDATED),
      authorId: null,
      syncedAt: 42,
      pinned: false,
    });
    expect(row?.metadata).toEqual({
      alert_id: "alert-1",
      status: "open",
      priority: "P1",
      acknowledged: false,
      opened_at_ms: T0,
      updated_at_ms: Date.parse(UPDATED),
      tags: ["payments", "prod"],
      entity: "payments-api",
      source: "datadog",
      owner_team: "team-9",
      meta_v: JSM_ALERT_META_VERSION,
    });
  });

  test("no description, details, owner user or individual responder id reaches the metadata", () => {
    const text = JSON.stringify(meta(openP1));
    for (const leaked of ["SECRET", "owner@example.com", "user-1", "runbook"]) {
      expect(text).not.toContain(leaked);
    }
  });

  test("an acknowledged alert gets acknowledged_at_ms from report.ackTime", () => {
    const m = meta({ ...openP1, acknowledged: true, report: { ackTime: 60_000 } });
    expect(m["acknowledged"]).toBe(true);
    expect(m["acknowledged_at_ms"]).toBe(T0 + 60_000);
    expect(Object.hasOwn(m, "closed_at_ms")).toBe(false);
  });

  test("closed_at_ms only when closed AND report.closeTime is a finite non-negative number", () => {
    const closed = { ...openP1, status: "closed" };
    expect(meta({ ...closed, report: { closeTime: 120_000 } })["closed_at_ms"]).toBe(T0 + 120_000);
    expect(Object.hasOwn(meta(closed), "closed_at_ms")).toBe(false);
    expect(Object.hasOwn(meta({ ...closed, report: { closeTime: "soon" } }), "closed_at_ms")).toBe(
      false,
    );
    expect(Object.hasOwn(meta({ ...closed, report: { closeTime: -5 } }), "closed_at_ms")).toBe(
      false,
    );
    // An open alert never gets a close time, even when the report carries one.
    expect(Object.hasOwn(meta({ ...openP1, report: { closeTime: 5 } }), "closed_at_ms")).toBe(
      false,
    );
  });

  test("a numeric epoch createdAt is accepted; absent timestamps stay absent", () => {
    const m = meta({ id: "a", createdAt: 1_700_000_000_000 });
    expect(m["opened_at_ms"]).toBe(1_700_000_000_000);
    expect(Object.hasOwn(m, "updated_at_ms")).toBe(false);
    const noOpen = mapJsmAlertToItem({ id: "a", updatedAt: UPDATED }, CTX);
    expect(Object.hasOwn(noOpen?.metadata ?? {}, "opened_at_ms")).toBe(false);
    expect(noOpen?.modifiedAt).toBe(Date.parse(UPDATED));
  });

  test("with createdAt only modifiedAt is createdAt; with neither time the row is skipped", () => {
    expect(mapJsmAlertToItem({ id: "a", createdAt: CREATED }, CTX)?.modifiedAt).toBe(T0);
    expect(mapJsmAlertToItem({ id: "a" }, CTX)).toBeNull();
    expect(mapJsmAlertToItem({ id: "a", createdAt: "nope", updatedAt: 0 }, CTX)).toBeNull();
  });

  test("a record without a usable id is skipped", () => {
    expect(mapJsmAlertToItem({ createdAt: CREATED }, CTX)).toBeNull();
    expect(mapJsmAlertToItem({ id: "", createdAt: CREATED }, CTX)).toBeNull();
    expect(mapJsmAlertToItem(null, CTX)).toBeNull();
    expect(mapJsmAlertToItem([], CTX)).toBeNull();
  });

  test("garbage priority, tags and status degrade to null, [] and null", () => {
    const m = meta({ id: "a", createdAt: CREATED, priority: "urgent", tags: "x", status: 5 });
    expect(m["priority"]).toBeNull();
    expect(m["tags"]).toEqual([]);
    expect(m["status"]).toBeNull();
    expect(meta({ id: "a", createdAt: CREATED, priority: "P6" })["priority"]).toBeNull();
    expect(meta({ id: "a", createdAt: CREATED, priority: " P3 " })["priority"]).toBe("P3");
  });

  test("status is lower-cased", () => {
    expect(meta({ id: "a", createdAt: CREATED, status: "CLOSED" })["status"]).toBe("closed");
  });

  test("tags are flattened and capped at 20 x 100 characters; non-strings and blanks are dropped", () => {
    const tags = [
      "a\u0000b\nc",
      "x".repeat(150),
      42,
      "   ",
      ...Array.from({ length: 30 }, (_, i) => `t${String(i)}`),
    ];
    const t = meta({ id: "a", createdAt: CREATED, tags })["tags"] as string[];
    expect(t).toHaveLength(20);
    expect(t[0]).toBe("a b c");
    expect(t[1]).toHaveLength(100);
    expect(t).not.toContain("   ");
  });

  test("a control-character message is flattened and the title is capped at 512", () => {
    const row = mapJsmAlertToItem(
      { id: "a", createdAt: CREATED, message: `boom\u0007\r\n${"y".repeat(600)}` },
      CTX,
    );
    expect(row?.title.startsWith("boom y")).toBe(true);
    expect(row?.title).toHaveLength(512);
  });

  test("a missing message falls back to a title naming the id", () => {
    expect(mapJsmAlertToItem({ id: "a", createdAt: CREATED }, CTX)?.title).toBe("Alert a");
  });

  test("entity and source are flattened to 200 characters and dropped when blank", () => {
    const m = meta({ id: "a", createdAt: CREATED, entity: "e".repeat(300), source: "  " });
    expect((m["entity"] as string).length).toBe(200);
    expect(Object.hasOwn(m, "source")).toBe(false);
  });

  test("owner_team is the first team responder with a usable id, else null", () => {
    const base = { id: "a", createdAt: CREATED };
    expect(meta({ ...base, responders: [{ id: "u", type: "user" }] })["owner_team"]).toBeNull();
    expect(meta({ ...base, responders: "nope" })["owner_team"]).toBeNull();
    expect(
      meta({
        ...base,
        responders: [
          "junk",
          { id: 5, type: "team" },
          { id: "t1", type: "TEAM" },
          { id: "t2", type: "team" },
        ],
      })["owner_team"],
    ).toBe("t1");
  });
});

describe("parseAlertList", () => {
  const entry = { id: "a" };

  test("accepts values, alerts and a bare array", () => {
    expect(parseAlertList(JSON.stringify({ values: [entry] }))?.alerts).toEqual([entry]);
    expect(parseAlertList(JSON.stringify({ alerts: [entry] }))?.alerts).toEqual([entry]);
    expect(parseAlertList(JSON.stringify([entry]))?.alerts).toEqual([entry]);
  });

  test("rejects a non-list, malformed JSON and a body with neither key", () => {
    expect(parseAlertList("{not json")).toBeNull();
    expect(parseAlertList(JSON.stringify({ values: "x" }))).toBeNull();
    expect(parseAlertList(JSON.stringify({ other: [] }))).toBeNull();
    expect(parseAlertList("5")).toBeNull();
  });

  test("counts entries that are not records or have no id", () => {
    const r = parseAlertList(JSON.stringify({ values: [entry, 3, { id: "" }, {}, null] }));
    expect(r?.alerts).toHaveLength(1);
    expect(r?.skipped).toBe(4);
  });
});

describe("parseAlertGet", () => {
  test("accepts the record at the root, under data and under result", () => {
    const rec = { id: "a", status: "closed" };
    expect(parseAlertGet(JSON.stringify(rec))).toEqual(rec);
    expect(parseAlertGet(JSON.stringify({ data: rec }))).toEqual(rec);
    expect(parseAlertGet(JSON.stringify({ result: rec }))).toEqual(rec);
  });

  test("rejects a reply with no id, malformed JSON and a non-object", () => {
    expect(parseAlertGet(JSON.stringify({ status: "x" }))).toBeNull();
    expect(parseAlertGet("{bad")).toBeNull();
    expect(parseAlertGet("[1]")).toBeNull();
  });
});
