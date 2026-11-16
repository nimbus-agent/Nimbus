import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { buildRecord } from "./__fixtures__/record-builder.ts";
import {
  INCIDENT_PRUNE_INTERVAL_MS,
  type IncidentRetentionTimer,
  startIncidentRetention,
} from "./incident-retention.ts";
import { markRecordChecked, upsertIncidentRecord } from "./incident-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const DAY = 86_400_000;
const NOW = 1000 * DAY;

function seed(d: Database, itemId: string, openedAtMs: number): void {
  upsertIncidentRecord(d, {
    record: buildRecord({ itemId, openedAtMs }),
    markdown: "m",
    recordSha256: itemId,
    citedServices: ["pagerduty"],
    nowMs: NOW,
  });
}

const count = (d: Database): number =>
  (d.query("SELECT count(*) AS n FROM incident_record").get() as { n: number }).n;

describe("startIncidentRetention", () => {
  test("runs one pass at boot and one per interval, reading the retention days each tick", async () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    seed(d, "pagerduty:old", NOW - 400 * DAY);
    seed(d, "pagerduty:mid", NOW - 100 * DAY);
    let days = 365;
    let tick: () => void = () => {};
    let delay = 0;
    const timer: IncidentRetentionTimer = { clear: () => {} };
    const h = startIncidentRetention(d, {
      retentionDays: () => days,
      nowMs: () => NOW,
      setTimer: (fn, ms) => {
        tick = fn;
        delay = ms;
        return timer;
      },
    });
    await h.idle();
    expect(count(d)).toBe(1);
    expect(delay).toBe(INCIDENT_PRUNE_INTERVAL_MS);
    days = 30; // an edited config applies on the next tick
    tick();
    await h.idle();
    expect(count(d)).toBe(0);
  });

  test("a tick while a pass runs is not doubled; a throwing prune never escapes; stop clears the timer", async () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    const errors: unknown[] = [];
    let cleared = false;
    let tick: () => void = () => {};
    const h = startIncidentRetention(d, {
      retentionDays: () => {
        throw new Error("config read failed");
      },
      nowMs: () => NOW,
      onError: (e) => errors.push(e),
      setTimer: (fn) => {
        tick = fn;
        return {
          clear: () => {
            cleared = true;
          },
        };
      },
    });
    tick(); // lands while the boot pass is still in flight
    await h.idle();
    expect(errors).toHaveLength(1);
    h.stop();
    expect(cleared).toBe(true);
  });

  test("the default timer is a real interval that stop() clears", async () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    const h = startIncidentRetention(d, { retentionDays: () => 365, nowMs: () => NOW });
    await h.idle();
    h.stop();
    expect(count(d)).toBe(0);
  });
});

describe("markRecordChecked", () => {
  test("moves only checked_at_ms", () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    seed(d, "pagerduty:a", NOW - DAY);
    markRecordChecked(d, "pagerduty:a", NOW + 5);
    expect(
      d.query("SELECT checked_at_ms, assembled_at_ms, version FROM incident_record").get(),
    ).toEqual({ checked_at_ms: NOW + 5, assembled_at_ms: NOW, version: 1 });
  });
});
