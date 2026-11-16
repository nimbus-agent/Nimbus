import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { configMap, resolverFor, serviceConfig, T0 } from "./__fixtures__/index-writers.ts";
import { writePagerdutyIncident } from "./__fixtures__/trigger-writers.ts";
import { createIncidentEngine } from "./incident-engine.ts";
import { DEFAULT_INCIDENT_CONFIG } from "../config/incident-toml.ts";
import { selectChangedItemIds } from "./incident-selection.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const DAY = 86_400_000;
const NOW = T0 + 30 * DAY;
const cfg = serviceConfig();
const resolver = resolverFor(cfg);

function seeded(): { d: Database; itemId: string } {
  const d = createMemoryIndexDb();
  dbs.push(d);
  const itemId = writePagerdutyIncident(
    d,
    { id: "R1", openedAtMs: NOW - 3_600_000, priority: "P1" },
    resolver,
  );
  return { d, itemId };
}

function mkEngine(d: Database, now: () => number): ReturnType<typeof createIncidentEngine> {
  return createIncidentEngine({
    db: d,
    now,
    emit: () => {},
    loadServiceConfigs: () => configMap(cfg),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
    yieldToEventLoop: async () => {},
  });
}

/** Assemble the item through the real engine, then force the record closed with the given check time. */
async function closeRecord(d: Database, itemId: string, checkedAtMs: number): Promise<void> {
  await mkEngine(d, () => NOW).assembleNow(itemId);
  d.run("UPDATE incident_record SET status = 'closed', checked_at_ms = ? WHERE trigger_item_id = ?", [
    checkedAtMs,
    itemId,
  ]);
}

function history(d: Database, itemId: string, observedAtMs: number): void {
  d.run(
    `INSERT INTO item_history (item_id, service, type, key, old_value, new_value, observed_at_ms)
     VALUES (?, 'pagerduty', 'incident', 'status', 'resolved', 'triggered', ?)`,
    [itemId, observedAtMs],
  );
}

describe("selectChangedItemIds: the item_history arm (IC4 task 1)", () => {
  test("1.1 a closed record reopened with an EARLIER provider time is selected by the history row; with no row it is not", async () => {
    const { d, itemId } = seeded();
    d.run("DELETE FROM item_history");
    await closeRecord(d, itemId, NOW - 1000);
    d.run("UPDATE item SET modified_at = ? WHERE id = ?", [NOW - 5000, itemId]);
    expect(selectChangedItemIds(d, "pagerduty", NOW)).toEqual([]);
    history(d, itemId, NOW - 500);
    expect(selectChangedItemIds(d, "pagerduty", NOW)).toEqual([itemId]);
  });

  test("1.2 a row observed at exactly checked_at_ms counts; another item's row, a row after now and a row before the check do not", async () => {
    const { d, itemId } = seeded();
    d.run("DELETE FROM item_history");
    await closeRecord(d, itemId, NOW - 1000);
    d.run("UPDATE item SET modified_at = ? WHERE id = ?", [NOW - 5000, itemId]);
    history(d, "pagerduty:OTHER", NOW - 500);
    history(d, itemId, NOW - 1001);
    history(d, itemId, NOW + 1);
    expect(selectChangedItemIds(d, "pagerduty", NOW)).toEqual([]);
    history(d, itemId, NOW - 1000);
    expect(selectChangedItemIds(d, "pagerduty", NOW)).toEqual([itemId]);
    // re-assembled unchanged: checked_at_ms advances past the row, so the record is not selected again
    d.run("UPDATE incident_record SET checked_at_ms = ?", [NOW]);
    expect(selectChangedItemIds(d, "pagerduty", NOW)).toEqual([]);
  });

  test("1.3 the history arm is served by item_history_item (EXPLAIN)", () => {
    const { d } = seeded();
    const plan = d
      .query(
        `EXPLAIN QUERY PLAN SELECT 1 FROM incident_record r
          WHERE EXISTS (SELECT 1 FROM item_history h WHERE h.item_id = r.trigger_item_id
                          AND h.observed_at_ms >= r.checked_at_ms AND h.observed_at_ms <= ?)`,
      )
      .all(NOW) as { detail: string }[];
    expect(plan.map((p) => p.detail).join("\n")).toContain("item_history_item");
  });

  test("1.4 over the real writers: a PagerDuty incident reopened with a late, earlier provider time becomes version 2, open", async () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    let clock = NOW;
    const engine = mkEngine(d, () => clock);
    const open = NOW - 3_600_000;
    const item = writePagerdutyIncident(
      d,
      {
        id: "RO",
        openedAtMs: open,
        status: "resolved",
        resolvedAtMs: open + 600_000,
        updatedAtMs: open + 600_000,
        priority: "P1",
      },
      resolver,
    );
    await engine.assembleNow(item);
    const first = d.query("SELECT status FROM incident_record WHERE trigger_item_id = ?").get(item);
    expect(first).toEqual({ status: "closed" });
    clock = NOW + 60_000;
    // the provider reopens it, stamping a time EARLIER than the check; the sync observes it now
    writePagerdutyIncident(
      d,
      { id: "RO", openedAtMs: open, status: "triggered", updatedAtMs: open + 300_000, priority: "P1" },
      resolver,
    );
    d.run("UPDATE item_history SET observed_at_ms = ? WHERE item_id = ? AND observed_at_ms > ?", [
      clock - 1000,
      item,
      0,
    ]);
    await engine.trigger("pagerduty");
    const row = d
      .query(
        "SELECT status FROM incident_record_version v JOIN incident_record r ON r.id = v.record_id WHERE r.trigger_item_id = ? ORDER BY v.version DESC LIMIT 1",
      )
      .get(item);
    expect(row).toBeDefined();
    const cur = d.query("SELECT status FROM incident_record WHERE trigger_item_id = ?").get(item);
    expect(cur).toEqual({ status: "open" });
  });
});
