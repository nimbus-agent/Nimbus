import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { HOUR, serviceConfig, T0, writePagerdutyShift } from "../__fixtures__/index-writers.ts";
import { oncallLane, personOrder } from "./oncall.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});
function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

const NOW = T0 + HOUR;
const cfg = serviceConfig();

function shift(d: Database, over: Partial<Parameters<typeof writePagerdutyShift>[1]> = {}): void {
  writePagerdutyShift(d, {
    startMs: NOW - HOUR,
    endMs: NOW + HOUR,
    fetchedAtMs: NOW - 5 * 60_000,
    ...over,
  });
}

describe("lane 7, on call", () => {
  test("a PagerDuty trigger is matched by its PagerDuty service id, with isMe and no e-mail", () => {
    const d = db();
    shift(d, { isMe: true });
    const r = oncallLane(d, {
      nowMs: NOW,
      cfg,
      triggerService: "pagerduty",
      pagerdutyServiceId: "PSVC1",
    });
    expect(r.lane).toMatchObject({
      status: "ok",
      youAreOnCall: true,
      resolvedVia: "service_id",
      rule: "on_call_now",
    });
    expect(r.lane.current[0]).toMatchObject({ userName: "Alex Rivera", isMe: true, level: 1 });
    expect(JSON.stringify(r.lane)).not.toContain("@");
    expect(r.stale).toBe(false);
  });

  test("another service's shift is no_match; a stale source is reported stale", () => {
    const d = db();
    shift(d, { serviceIds: ["OTHER"], fetchedAtMs: NOW - 2 * HOUR });
    const miss = oncallLane(d, {
      nowMs: NOW,
      cfg,
      triggerService: "pagerduty",
      pagerdutyServiceId: "PSVC1",
    });
    expect(miss.lane.status).toBe("no_match");
    expect(miss.gaps[0]?.detail).toContain("No on-call schedule");
    const hit = oncallLane(d, {
      nowMs: NOW,
      cfg,
      triggerService: "pagerduty",
      pagerdutyServiceId: "OTHER",
    });
    expect(hit.stale).toBe(true);
  });

  test("other sources use the bound service; an unbound non-PagerDuty trigger is skipped with a gap", () => {
    const d = db();
    shift(d, { isMe: false });
    const bound = oncallLane(d, {
      nowMs: NOW,
      cfg,
      triggerService: "jira",
      pagerdutyServiceId: null,
    });
    expect(bound.lane.status).toBe("ok");
    expect(bound.lane.youAreOnCall).toBe(false);
    const skipped = oncallLane(d, {
      nowMs: NOW,
      cfg: null,
      triggerService: "sentry",
      pagerdutyServiceId: null,
    });
    expect(skipped.lane.status).toBe("skipped");
    expect(skipped.gaps[0]?.detail).toContain("not bound");
    expect(skipped.stale).toBeNull();
  });

  test("no shift rows at all is no_data, the connector gap, never 'nobody is on call'", () => {
    const d = db();
    const r = oncallLane(d, {
      nowMs: NOW,
      cfg,
      triggerService: "pagerduty",
      pagerdutyServiceId: "PSVC1",
    });
    expect(r.lane.status).toBe("no_data");
    expect(r.lane.youAreOnCall).toBeNull();
    expect(r.gaps[0]?.category).toBe("missing_connector");
  });

  test("the next shift is listed and nobody-now reads none_on_call", () => {
    const d = db();
    shift(d, {
      startMs: NOW + HOUR,
      endMs: NOW + 9 * HOUR,
      userName: "Sam Lee",
      email: "sam@acme.test",
    });
    const r = oncallLane(d, {
      nowMs: NOW,
      cfg,
      triggerService: "pagerduty",
      pagerdutyServiceId: "PSVC1",
    });
    expect(r.lane.status).toBe("none_on_call");
    expect(r.lane.next[0]?.userName).toBe("Sam Lee");
    expect(JSON.stringify(r.lane)).not.toContain("sam@acme.test");
  });
});

describe("personOrder is a total order that falls through every key", () => {
  const base = {
    userName: "a",
    scheduleName: "s",
    level: 1,
    startMs: 1,
    endMs: 2,
    isMe: false,
  } as const;
  test("schedule, level, user, start, end, in that order; nulls sort as empty or zero", () => {
    expect(
      personOrder({ ...base, scheduleName: "a" }, { ...base, scheduleName: "b" }),
    ).toBeLessThan(0);
    expect(personOrder({ ...base, level: 1 }, { ...base, level: 2 })).toBeLessThan(0);
    expect(personOrder({ ...base, userName: "a" }, { ...base, userName: "b" })).toBeLessThan(0);
    expect(personOrder({ ...base, startMs: 1 }, { ...base, startMs: 2 })).toBeLessThan(0);
    expect(personOrder({ ...base, endMs: 1 }, { ...base, endMs: 2 })).toBeLessThan(0);
    expect(personOrder(base, { ...base })).toBe(0);
    const nulls = {
      ...base,
      scheduleName: null,
      level: null,
      userName: null,
      startMs: null,
      endMs: null,
    };
    expect(personOrder(nulls, { ...nulls })).toBe(0);
    expect(personOrder(nulls, base)).toBeLessThan(0);
  });
});
