import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { CascadeReadError, readCascade, readOpenCascadeRecords } from "./cascade-read.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const T = Date.parse("2026-11-10T10:00:00.000Z");
let n = 0;

function insert(
  d: Database,
  o: {
    id: string;
    service: string | null;
    status?: string;
    openedAtMs: number | null;
    deploymentId?: string;
    json?: string;
  },
): void {
  n += 1;
  const json =
    o.json ??
    JSON.stringify({ change: { deployment: o.deploymentId ? { id: o.deploymentId } : null } });
  d.run(
    `INSERT INTO incident_record (id, trigger_item_id, trigger_service, trigger_type, service, title, severity,
       opened_at_ms, status, version, assembled_at_ms, checked_at_ms, record_sha256, cited_services, record_json, markdown)
     VALUES (?, ?, 'pagerduty', 'incident', ?, 't', 'p1', ?, ?, 1, 1, 1, 'h', '[]', ?, 'm')`,
    [o.id, `pagerduty:${String(n)}`, o.service, o.openedAtMs, o.status ?? "open", json],
  );
}

function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

describe("7.8 readOpenCascadeRecords / readCascade over a real incident_record table", () => {
  test("only open rows with an open time; a closed record and one with no open time are excluded", () => {
    const d = db();
    insert(d, { id: "inc_0000000000000001", service: "api", openedAtMs: T });
    insert(d, {
      id: "inc_0000000000000002",
      service: "db",
      openedAtMs: T + 1000,
      deploymentId: "deployment:d1",
    });
    insert(d, { id: "inc_0000000000000003", service: "db", status: "closed", openedAtMs: T });
    insert(d, { id: "inc_0000000000000004", service: "db", status: "unknown", openedAtMs: T });
    insert(d, { id: "inc_0000000000000005", service: "db", openedAtMs: null });
    const rows = readOpenCascadeRecords(d);
    expect(rows.map((r) => r.id).sort()).toEqual(["inc_0000000000000001", "inc_0000000000000002"]);
    expect(rows.find((r) => r.id === "inc_0000000000000002")?.deploymentId).toBe("deployment:d1");
    expect(rows.find((r) => r.id === "inc_0000000000000001")?.deploymentId).toBeNull();
  });

  test("ranks them with the declared depends_on", () => {
    const d = db();
    insert(d, { id: "inc_0000000000000001", service: "api", openedAtMs: T });
    insert(d, { id: "inc_0000000000000002", service: "db", openedAtMs: T + 5000 });
    const { groups, info } = readCascade(
      d,
      new Map([
        ["api", ["db"]],
        ["db", []],
      ]),
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.root).toBe("inc_0000000000000002");
    expect(info.get("inc_0000000000000001")).toMatchObject({
      title: "t",
      source: "pagerduty",
      service: "api",
    });
  });

  test("a stored row whose JSON is not valid reads as no deployment (never throws); a failed SQL read is a typed error", () => {
    const d = db();
    insert(d, { id: "inc_0000000000000001", service: "api", openedAtMs: T, json: "{not json" });
    expect(readOpenCascadeRecords(d)[0]?.deploymentId).toBeNull();
    d.exec("DROP TABLE incident_record_version");
    d.exec("DROP TABLE incident_record");
    expect(() => readOpenCascadeRecords(d)).toThrow(CascadeReadError);
  });
});

describe("CascadeReadError names its cause", () => {
  test("a read that throws a value that is not an Error is reported as unknown, never rethrown raw", () => {
    const broken = {
      query: () => {
        throw "disk gone";
      },
    } as unknown as Database;
    expect(() => readOpenCascadeRecords(broken)).toThrow(CascadeReadError);
    expect(() => readOpenCascadeRecords(broken)).toThrow("the cascade could not be read: unknown");
  });

  test("an Error cause keeps its message", () => {
    expect(new CascadeReadError(new Error("no such table")).message).toBe(
      "the cascade could not be read: no such table",
    );
  });
});
