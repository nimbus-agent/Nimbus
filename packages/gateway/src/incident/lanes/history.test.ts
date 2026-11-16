import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { T0 } from "../__fixtures__/index-writers.ts";
import { writePagerdutyIncident } from "../__fixtures__/trigger-writers.ts";
import { historyLane } from "./history.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

function hist(
  d: Database,
  itemId: string,
  key: string,
  from: string | null,
  to: string | null,
  at: number,
): void {
  d.run(
    `INSERT INTO item_history (item_id, service, type, key, old_value, new_value, observed_at_ms)
     VALUES (?, 'pagerduty', 'incident', ?, ?, ?, ?)`,
    [itemId, key, from, to, at],
  );
}

describe("history", () => {
  test("oldest first, cap 20 with the truncated count and the service history start", () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    const id = writePagerdutyIncident(d, { id: "H", openedAtMs: T0 });
    d.run("DELETE FROM item_history");
    for (let i = 0; i < 25; i += 1)
      hist(d, id, "status", `s${String(i)}`, `s${String(i + 1)}`, T0 + i);
    const r = historyLane(d, { itemId: id, openedAtMs: T0, historyStartsMs: T0 });
    expect(r.lane.total).toBe(25);
    expect(r.lane.truncated).toBe(5);
    expect(r.lane.rows).toHaveLength(20);
    expect(r.lane.rows[0]).toMatchObject({ key: "status", from: "s0", to: "s1", observedAtMs: T0 });
    expect(r.lane.rows[19]?.observedAtMs).toBe(T0 + 19);
    expect(r.lane.startsMs).toBe(T0);
    expect(r.gaps).toEqual([]);
  });

  test("history that begins after the open time says so", () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    const r = historyLane(d, { itemId: "pagerduty:x", openedAtMs: T0, historyStartsMs: T0 + 1000 });
    expect(r.gaps).toHaveLength(1);
    expect(r.gaps[0]?.detail).toContain("first observed state stands in");
    expect(
      historyLane(d, { itemId: "pagerduty:x", openedAtMs: null, historyStartsMs: null }).gaps,
    ).toEqual([]);
  });

  test("an assignee key is shown as a count, never as addresses", () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    hist(
      d,
      "pagerduty:x",
      "assignee_emails",
      "[]",
      JSON.stringify(["a@acme.test", "b@acme.test"]),
      T0,
    );
    hist(d, "pagerduty:x", "resolved_by_email", null, "a@acme.test", T0 + 1);
    hist(d, "pagerduty:x", "status", "triggered\n## Gaps", "resolved", T0 + 2);
    const r = historyLane(d, { itemId: "pagerduty:x", openedAtMs: T0, historyStartsMs: T0 });
    expect(r.lane.rows[0]).toMatchObject({ from: "0 assigned", to: "2 assigned" });
    expect(r.lane.rows[1]).toMatchObject({ from: null, to: "set" });
    expect(JSON.stringify(r.lane)).not.toContain("@");
    expect(r.lane.rows[2]?.from).not.toContain("\n");
  });
});
