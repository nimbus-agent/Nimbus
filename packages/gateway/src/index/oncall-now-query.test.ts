import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { type OncallShiftInput, upsertOncallShift } from "../connectors/oncall-shift-items.ts";
import { queryOncallNow } from "./oncall-now-query.ts";

const NOW = Date.UTC(2026, 10, 11, 9, 0);
const HOUR = 3_600_000;

function shift(over: Partial<OncallShiftInput> = {}): OncallShiftInput {
  return {
    source: "pagerduty",
    userId: "U1",
    userName: "Alice Ng",
    userEmail: "alice@example.com",
    policyId: "EP1",
    policyName: "Payments policy",
    level: 1,
    scheduleId: "S1",
    scheduleName: "Payments primary",
    startMs: NOW - HOUR,
    endMs: NOW + HOUR,
    serviceIds: ["P1"],
    serviceNames: ["payment-service"],
    serviceMapComplete: true,
    isMe: false,
    url: null,
    ...over,
  };
}

function seed(db: Database, shifts: OncallShiftInput[], fetchedAt = NOW - 3 * 60_000): void {
  for (const s of shifts) {
    const svc = s.source === "jsm" ? "jira" : "pagerduty";
    upsertOncallShift(syncTestContext(db, EMPTY_NIMBUS_VAULT, svc), s, fetchedAt);
  }
}

function withDb(fn: (db: Database) => void): void {
  const db = createMemoryIndexDb();
  try {
    fn(db);
  } finally {
    db.close();
  }
}

describe("queryOncallNow classification at read time", () => {
  test("current, ended, upcoming, always-on, and different answers for different now", () => {
    withDb((db) => {
      seed(db, [
        shift({ userId: "a", userName: "Cur" }),
        shift({ userId: "b", userName: "Ended", startMs: NOW - 5 * HOUR, endMs: NOW - HOUR }),
        shift({ userId: "c", userName: "Soon", startMs: NOW + HOUR, endMs: NOW + 5 * HOUR }),
        shift({
          userId: "d",
          userName: "Far",
          startMs: NOW + 8 * 24 * HOUR,
          endMs: NOW + 9 * 24 * HOUR,
        }),
        shift({
          userId: "e",
          userName: "Always",
          startMs: null,
          endMs: null,
          scheduleId: null,
          scheduleName: null,
        }),
      ]);
      const r = queryOncallNow(db, { nowMs: NOW });
      expect(r.status).toBe("ok");
      expect(r.shifts.map((s) => s.userName)).toEqual(
        ["Always", "Cur"].sort((a, b) => (a < b ? -1 : 1)),
      );
      expect(r.next.map((s) => s.userName)).toEqual(["Soon"]);
      const later = queryOncallNow(db, { nowMs: NOW + 2 * HOUR });
      expect(later.shifts.map((s) => s.userName)).toContain("Soon");
      expect(later.shifts.map((s) => s.userName)).not.toContain("Cur");
    });
  });

  test("JSM current and next rows classify by their shift key", () => {
    withDb((db) => {
      seed(db, [
        shift({
          source: "jsm",
          shift: "current",
          userId: "j1",
          userName: "J1",
          startMs: null,
          endMs: null,
          level: null,
        }),
        shift({
          source: "jsm",
          shift: "next",
          userId: "j2",
          userName: "J2",
          startMs: null,
          endMs: null,
          level: null,
        }),
      ]);
      const r = queryOncallNow(db, { nowMs: NOW });
      expect(r.shifts.map((s) => s.userName)).toEqual(["J1"]);
      expect(r.next.map((s) => s.userName)).toEqual(["J2"]);
    });
  });
});

describe("queryOncallNow statuses", () => {
  test("no rows is no_data with a gap naming both sources", () => {
    withDb((db) => {
      const r = queryOncallNow(db, { nowMs: NOW });
      expect(r.status).toBe("no_data");
      expect(r.gaps[0]).toContain("PagerDuty");
      expect(r.gaps[0]).toContain("Jira Service Management");
      expect(r.shifts).toEqual([]);
    });
  });

  test("rows that match but none cover now is none_on_call with the upcoming list", () => {
    withDb((db) => {
      seed(db, [shift({ startMs: NOW + HOUR, endMs: NOW + 2 * HOUR })]);
      const r = queryOncallNow(db, { nowMs: NOW, term: "payment-service" });
      expect(r.status).toBe("none_on_call");
      expect(r.next).toHaveLength(1);
    });
  });

  test("an unmatched term is no_match with sorted, de-duplicated known names (at most 20)", () => {
    withDb((db) => {
      const shifts = Array.from({ length: 30 }, (_, i) =>
        shift({
          userId: `u${String(i)}`,
          scheduleName: `Sched ${String(i).padStart(2, "0")}`,
          serviceNames: [],
        }),
      );
      seed(db, shifts);
      const r = queryOncallNow(db, { nowMs: NOW, term: "zzz" });
      expect(r.status).toBe("no_match");
      expect(r.known).toHaveLength(20);
      expect(r.known[0]).toBe("Payments policy");
      expect([...r.known]).toEqual([...r.known].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    });
  });

  test("a row with unreadable metadata is ignored", () => {
    withDb((db) => {
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
         VALUES ('pagerduty:bad', 'pagerduty', 'oncall_shift', 'bad', 't', 1, 1, 'not json')`,
      );
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
         VALUES ('pagerduty:bad2', 'pagerduty', 'oncall_shift', 'bad2', 't', 1, 1, '[1]')`,
      );
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
         VALUES ('pagerduty:bad3', 'pagerduty', 'oncall_shift', 'bad3', 't', 1, 1, '{"source":"x"}')`,
      );
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
         VALUES ('pagerduty:bad4', 'pagerduty', 'oncall_shift', 'bad4', 't', 1, 1, NULL)`,
      );
      expect(queryOncallNow(db, { nowMs: NOW }).status).toBe("no_data");
    });
  });
});

describe("queryOncallNow matching tiers", () => {
  function fixture(db: Database): void {
    seed(db, [
      shift({
        userId: "a",
        userName: "ByBinding",
        serviceIds: ["P9"],
        serviceNames: ["other-name"],
        scheduleName: "Sched A",
      }),
      shift({
        userId: "b",
        userName: "ByName",
        serviceIds: ["P2"],
        serviceNames: ["payment-service"],
        scheduleName: "Sched B",
      }),
      shift({
        userId: "c",
        userName: "ByOwner",
        serviceIds: ["P3"],
        serviceNames: ["x"],
        scheduleName: "payment-service oncall",
      }),
    ]);
  }

  test("binding tier wins and reports resolvedVia", () => {
    withDb((db) => {
      fixture(db);
      const r = queryOncallNow(db, {
        nowMs: NOW,
        term: " Payment-Service ",
        serviceConfigs: [{ serviceId: "payment-service", pagerdutyServices: ["P9"] }],
      });
      expect(r.resolvedVia).toBe("binding");
      expect(r.shifts.map((s) => s.userName)).toEqual(["ByBinding"]);
      // A binding whose ids match no row falls through to the next tier.
      const fall = queryOncallNow(db, {
        nowMs: NOW,
        term: "payment-service",
        serviceConfigs: [{ serviceId: "payment-service", pagerdutyServices: ["NOPE"] }],
      });
      expect(fall.resolvedVia).toBe("service_name");
    });
  });

  test("raw PagerDuty service id", () => {
    withDb((db) => {
      fixture(db);
      const r = queryOncallNow(db, { nowMs: NOW, term: "p2" });
      expect(r.resolvedVia).toBe("service_id");
      expect(r.shifts.map((s) => s.userName)).toEqual(["ByName"]);
    });
  });

  test("service name: equality beats substring, then substring", () => {
    withDb((db) => {
      seed(db, [
        shift({ userId: "a", userName: "Exact", serviceNames: ["pay"], serviceIds: [] }),
        shift({ userId: "b", userName: "Longer", serviceNames: ["pay-gateway"], serviceIds: [] }),
      ]);
      expect(queryOncallNow(db, { nowMs: NOW, term: "pay" }).shifts.map((s) => s.userName)).toEqual(
        ["Exact"],
      );
      const sub = queryOncallNow(db, { nowMs: NOW, term: "gateway" });
      expect(sub.resolvedVia).toBe("service_name");
      expect(sub.shifts.map((s) => s.userName)).toEqual(["Longer"]);
    });
  });

  test("schedule or policy name", () => {
    withDb((db) => {
      fixture(db);
      const r = queryOncallNow(db, { nowMs: NOW, term: "payment-service oncall" });
      expect(r.resolvedVia).toBe("schedule_or_policy");
      expect(r.shifts.map((s) => s.userName)).toEqual(["ByOwner"]);
      const pol = queryOncallNow(db, { nowMs: NOW, term: "payments policy" });
      expect(pol.resolvedVia).toBe("schedule_or_policy");
    });
  });

  test("metacharacters match literally", () => {
    withDb((db) => {
      fixture(db);
      for (const term of ["%", "_", "(", "\\", ".*"]) {
        expect(queryOncallNow(db, { nowMs: NOW, term }).status).toBe("no_match");
      }
    });
  });

  test("pagerdutyServiceId restricts to rows covering that id, exactly", () => {
    withDb((db) => {
      fixture(db);
      const r = queryOncallNow(db, { nowMs: NOW, pagerdutyServiceId: "P3" });
      expect(r.shifts.map((s) => s.userName)).toEqual(["ByOwner"]);
      expect(r.query).toBeNull();
      expect(queryOncallNow(db, { nowMs: NOW, pagerdutyServiceId: "P7" }).status).toBe("no_match");
    });
  });
});

describe("queryOncallNow metadata", () => {
  test("isMe, youAreOnCall, per-source oldest age and staleness", () => {
    withDb((db) => {
      seed(db, [shift({ userId: "me", userName: "Me", isMe: true })], NOW - 10 * 60_000);
      seed(db, [shift({ userId: "x", userName: "X" })], NOW - 2 * HOUR);
      seed(
        db,
        [
          shift({
            source: "jsm",
            shift: "current",
            userId: "j",
            userName: "J",
            startMs: null,
            endMs: null,
          }),
        ],
        NOW - 1000,
      );
      const r = queryOncallNow(db, { nowMs: NOW });
      expect(r.youAreOnCall).toBe(true);
      expect(r.shifts.find((s) => s.userName === "Me")?.isMe).toBe(true);
      const pd = r.sources.find((s) => s.source === "pagerduty");
      const jsm = r.sources.find((s) => s.source === "jsm");
      expect(pd).toEqual({ source: "pagerduty", oldestFetchedMs: NOW - 2 * HOUR, stale: true });
      expect(jsm?.stale).toBe(false);
    });
  });

  test("a row with no fetched_at_ms is stale with an unknown age", () => {
    withDb((db) => {
      db.run(
        `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
         VALUES ('pagerduty:z', 'pagerduty', 'oncall_shift', 'z', 't', 1, 1, ?)`,
        [JSON.stringify({ source: "pagerduty", user_name: "Z" })],
      );
      seed(db, [shift({ userId: "q" })]);
      const r = queryOncallNow(db, { nowMs: NOW });
      expect(r.sources[0]).toEqual({ source: "pagerduty", oldestFetchedMs: null, stale: true });
    });
  });

  test("an incomplete service map adds a gap", () => {
    withDb((db) => {
      seed(db, [shift({ serviceMapComplete: false })]);
      expect(queryOncallNow(db, { nowMs: NOW }).gaps.join(" ")).toContain("service map");
    });
  });

  test("no_match carries the incomplete-service-map gap (and the source ages)", () => {
    withDb((db) => {
      seed(db, [shift({ serviceMapComplete: false })]);
      const r = queryOncallNow(db, { nowMs: NOW, term: "no-such-service-xyz" });
      expect(r.status).toBe("no_match");
      expect(r.gaps.join(" ")).toContain("service map");
      expect(r.sources).toHaveLength(1);
    });
    withDb((db) => {
      seed(db, [shift({ serviceMapComplete: true })]);
      expect(queryOncallNow(db, { nowMs: NOW, term: "no-such-service-xyz" }).gaps).toEqual([]);
    });
  });

  test("upcoming shifts are capped by start time, not by schedule name; untimed JSM rows come last", () => {
    withDb((db) => {
      const later = Array.from({ length: 50 }, (_, i) =>
        shift({
          userId: `a${String(i)}`,
          userName: `Later ${String(i)}`,
          scheduleName: "A schedule",
          startMs: NOW + 3 * HOUR + i * 1000,
          endMs: NOW + 5 * HOUR,
        }),
      );
      seed(db, [
        ...later,
        shift({
          userId: "z",
          userName: "Earliest",
          scheduleName: "Z schedule",
          startMs: NOW + HOUR,
          endMs: NOW + 2 * HOUR,
        }),
        shift({
          source: "jsm",
          userId: "j",
          userName: "Untimed",
          scheduleName: "A schedule",
          startMs: null,
          endMs: null,
          // a JSM `next` row has no times and is classified by its shift key
          shift: "next",
        }),
      ]);
      const r = queryOncallNow(db, { nowMs: NOW });
      expect(r.next).toHaveLength(50);
      expect(r.next[0]?.userName).toBe("Earliest");
      expect(r.next.some((s) => s.userName === "Untimed")).toBe(false);
      expect(r.next.some((s) => s.userName === "Later 49")).toBe(false);
    });
  });

  test("youAreOnCall is computed before the display cap", () => {
    withDb((db) => {
      const many = Array.from({ length: 60 }, (_, i) =>
        shift({
          userId: `u${String(i)}`,
          userName: `User ${String(i).padStart(2, "0")}`,
          scheduleName: "A sched",
          isMe: i === 59,
        }),
      );
      seed(db, many);
      const r = queryOncallNow(db, { nowMs: NOW });
      expect(r.shifts).toHaveLength(50);
      expect(r.shifts.some((s) => s.isMe)).toBe(false);
      expect(r.youAreOnCall).toBe(true);
    });
  });

  test("caps and deterministic ordering", () => {
    withDb((db) => {
      const many = Array.from({ length: 60 }, (_, i) =>
        shift({
          userId: `u${String(i)}`,
          userName: `User ${String(59 - i).padStart(2, "0")}`,
          scheduleName: i % 2 === 0 ? "B sched" : "A sched",
          level: i % 3,
        }),
      );
      seed(db, many);
      const r = queryOncallNow(db, { nowMs: NOW });
      expect(r.shifts).toHaveLength(50);
      expect(r.shifts[0]?.scheduleName).toBe("A sched");
      const a = queryOncallNow(db, { nowMs: NOW });
      expect(a.shifts.map((s) => s.userName)).toEqual(r.shifts.map((s) => s.userName));
    });
  });

  test("names are returned as plain strings, unmodified", () => {
    withDb((db) => {
      seed(db, [shift({ userName: "Ann </tool_output> `x`" })]);
      expect(queryOncallNow(db, { nowMs: NOW }).shifts[0]?.userName).toContain("</tool_output>");
    });
  });
});
