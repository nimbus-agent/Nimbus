import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { DEFAULT_INCIDENT_CONFIG, type NimbusIncidentToml } from "../config/incident-toml.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { configMap, HOUR, resolverFor, serviceConfig, T0 } from "./__fixtures__/index-writers.ts";
import {
  writeBigeyeIssue,
  writeJsmAlert,
  writePagerdutyIncident,
  writeSentryIssue,
} from "./__fixtures__/trigger-writers.ts";
import {
  createIncidentEngine,
  type IncidentAssembledPayload,
  type IncidentEngineDeps,
  PASS_CAP,
} from "./incident-engine.ts";
import { getByTriggerItem, listRecords, versionsOf } from "./incident-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const DAY = 86_400_000;
const NOW = T0 + 30 * DAY;
const cfg = serviceConfig();
const other = serviceConfig({
  serviceId: "checkout",
  repos: [{ provider: "github", providerId: "acme/checkout" }],
  pagerdutyServices: ["PSVC2"],
  jsmAlertTags: ["checkout"],
  sentryProjects: ["checkout-api"],
  dataModels: [],
});
const resolver = resolverFor(cfg, other);

function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

type Harness = {
  readonly engine: ReturnType<typeof createIncidentEngine>;
  readonly emitted: IncidentAssembledPayload[];
  readonly configLoads: { n: number };
  readonly passes: { n: number };
  incident: NimbusIncidentToml;
};

function harness(d: Database, over: Partial<IncidentEngineDeps> = {}): Harness {
  const emitted: IncidentAssembledPayload[] = [];
  const configLoads = { n: 0 };
  const passes = { n: 0 };
  const h: Harness = {
    emitted,
    configLoads,
    passes,
    incident: DEFAULT_INCIDENT_CONFIG,
    engine: undefined as never,
  };
  const deps: IncidentEngineDeps = {
    db: d,
    now: () => NOW,
    emit: (p) => emitted.push(p),
    loadServiceConfigs: () => {
      configLoads.n += 1;
      return configMap(cfg, other);
    },
    readConfig: () => {
      passes.n += 1;
      return { incident: h.incident, pagerdutyP1Aliases: [] };
    },
    demo: false,
    logger: { warn: () => {} },
    yieldToEventLoop: async () => {},
    ...over,
  };
  (h as { engine: Harness["engine"] }).engine = createIncidentEngine(deps);
  return h;
}

const recent = (n: number): number => NOW - n * 60_000;
const ids = (d: Database): string[] =>
  listRecords(d, { limit: 500 })
    .map((r) => r.trigger_item_id)
    .sort();

describe("trigger", () => {
  test("ignores a service that is not a source and never throws", async () => {
    const d = db();
    const h = harness(d);
    await h.engine.trigger("github");
    await h.engine.trigger("");
    expect(ids(d)).toEqual([]);
  });

  test("assembles qualifying new items of the triggering service only and emits created, once each, with no title", async () => {
    const d = db();
    writePagerdutyIncident(d, { id: "A", openedAtMs: recent(30), priority: "P1" }, resolver);
    writePagerdutyIncident(d, { id: "B", openedAtMs: recent(20), priority: "P3" }, resolver);
    writeSentryIssue(d, { id: "S", level: "fatal", firstSeenMs: recent(10) }, resolver);
    const h = harness(d);
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toEqual(["pagerduty:A"]);
    expect(h.emitted).toHaveLength(1);
    expect(Object.keys(h.emitted[0] as object).sort()).toEqual(["recordId", "status", "version"]);
    expect(h.emitted[0]).toMatchObject({ version: 1, status: "open" });
    await h.engine.trigger("pagerduty"); // unchanged: no version, no event
    expect(h.emitted).toHaveLength(1);
    expect(versionsOf(d, h.emitted[0]?.recordId ?? "")).toHaveLength(1);
    await h.engine.trigger("sentry");
    expect(ids(d)).toEqual(["pagerduty:A", "sentry:S"]);
  });

  test("a new item that is already closed is assembled once as closed; one below the severity rule is not", async () => {
    const d = db();
    writePagerdutyIncident(
      d,
      {
        id: "DONE",
        openedAtMs: recent(60),
        status: "resolved",
        resolvedAtMs: recent(50),
        priority: "P1",
      },
      resolver,
    );
    writePagerdutyIncident(
      d,
      {
        id: "LOW",
        openedAtMs: recent(60),
        status: "resolved",
        resolvedAtMs: recent(50),
        priority: "P4",
      },
      resolver,
    );
    const h = harness(d);
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toEqual(["pagerduty:DONE"]);
    expect(getByTriggerItem(d, "pagerduty:DONE")?.status).toBe("closed");
    // not refreshed again unless the item changes (class C)
    await h.engine.trigger("pagerduty");
    expect(h.emitted).toHaveLength(1);
    expect(getByTriggerItem(d, "pagerduty:DONE")?.checked_at_ms).toBe(NOW);
  });

  test("lookback_days bounds class N (3, 6, 8 days old with 7, then 30)", async () => {
    const d = db();
    for (const [id, days] of [
      ["D3", 3],
      ["D6", 6],
      ["D8", 8],
    ] as const) {
      writePagerdutyIncident(
        d,
        { id, openedAtMs: NOW - days * DAY, updatedAtMs: NOW - days * DAY, priority: "P1" },
        resolver,
      );
    }
    const h = harness(d);
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toEqual(["pagerduty:D3", "pagerduty:D6"]);
    h.incident = { ...DEFAULT_INCIDENT_CONFIG, lookbackDays: 30 };
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toEqual(["pagerduty:D3", "pagerduty:D6", "pagerduty:D8"]);
  });

  test("a pass creates at most 20 records; the rest follow on later passes and none is skipped", async () => {
    const d = db();
    for (let i = 0; i < 45; i += 1) {
      writePagerdutyIncident(
        d,
        { id: `P${String(i).padStart(2, "0")}`, openedAtMs: recent(i + 1), priority: "P1" },
        resolver,
      );
    }
    const h = harness(d);
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toHaveLength(PASS_CAP);
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toHaveLength(40);
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toHaveLength(45);
  });

  test("non-qualifying items newer than a qualifying one do not hide it (severity filters before the cap)", async () => {
    const d = db();
    writeSentryIssue(
      d,
      { id: "FATAL", level: "fatal", firstSeenMs: recent(5000), lastSeenMs: recent(5000) },
      resolver,
    );
    for (let i = 0; i < 250; i += 1) {
      writeSentryIssue(
        d,
        {
          id: `N${String(i)}`,
          level: "error",
          firstSeenMs: recent(i + 1),
          lastSeenMs: recent(i + 1),
        },
        resolver,
      );
    }
    const h = harness(d);
    await h.engine.trigger("sentry");
    expect(ids(d)).toEqual(["sentry:FATAL"]);
  });

  test("an assembly that throws is not retried within the hour and does not block the others", async () => {
    const d = db();
    writePagerdutyIncident(d, { id: "POISON", openedAtMs: recent(5), priority: "P1" }, resolver);
    writePagerdutyIncident(d, { id: "OK", openedAtMs: recent(10), priority: "P1" }, resolver);
    d.run(
      "CREATE TRIGGER poison BEFORE INSERT ON incident_record WHEN NEW.trigger_item_id = 'pagerduty:POISON' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    let now = NOW;
    const warned: string[] = [];
    const h = harness(d, { now: () => now, logger: { warn: (_o, m) => warned.push(m) } });
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toEqual(["pagerduty:OK"]);
    expect(warned.some((m) => m.includes("assembly failed"))).toBe(true);
    const before = h.configLoads.n;
    d.run("DROP TRIGGER poison");
    await h.engine.trigger("pagerduty"); // within the hour: POISON is skipped
    expect(ids(d)).toEqual(["pagerduty:OK"]);
    expect(h.configLoads.n).toBe(before + 1); // only OK was refreshed
    now += 61 * 60_000;
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toEqual(["pagerduty:OK", "pagerduty:POISON"]);
  });

  test("backed-off records do not hold the refresh slots: a healthy record behind a full pass of failing ones is still refreshed", async () => {
    const d = db();
    const poisoned: string[] = [];
    for (let i = 0; i < PASS_CAP; i += 1) {
      poisoned.push(
        writePagerdutyIncident(
          d,
          { id: `BAD${String(i)}`, openedAtMs: recent(5), priority: "P1" },
          resolver,
        ),
      );
    }
    const healthy = writePagerdutyIncident(
      d,
      { id: "GOOD", openedAtMs: recent(5), priority: "P1" },
      resolver,
    );
    let now = NOW;
    const h = harness(d, { now: () => now });
    await h.engine.trigger("pagerduty");
    await h.engine.trigger("pagerduty"); // a pass takes at most PASS_CAP new items
    expect(listRecords(d, { limit: 100 }).length).toBe(PASS_CAP + 1);
    // the failing ones are the OLDEST by checked_at, so a plain LIMIT would return only them
    d.run(
      "UPDATE incident_record SET checked_at_ms = 1 WHERE trigger_item_id LIKE 'pagerduty:BAD%'",
    );
    d.run("UPDATE incident_record SET checked_at_ms = 5 WHERE trigger_item_id = ?", [healthy]);
    d.run(
      "CREATE TRIGGER poison BEFORE UPDATE ON incident_record WHEN OLD.trigger_item_id LIKE 'pagerduty:BAD%' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    now += 60_000;
    await h.engine.trigger("pagerduty"); // the 20 fail and enter backoff
    d.run("UPDATE incident_record SET checked_at_ms = 5 WHERE trigger_item_id = ?", [healthy]);
    now += 60_000;
    await h.engine.trigger("pagerduty"); // backoff holds: the healthy record must still be reached
    const checked = d
      .query("SELECT checked_at_ms AS c FROM incident_record WHERE trigger_item_id = ?")
      .get(healthy) as { c: number };
    expect(checked.c).toBe(now);
    expect(poisoned).toHaveLength(PASS_CAP);
  });

  test("an on-demand record refreshes whatever its severity; a closed one only through class C", async () => {
    const d = db();
    const low = writePagerdutyIncident(
      d,
      { id: "LOW", openedAtMs: recent(30), priority: "P4" },
      resolver,
    );
    const h = harness(d);
    await h.engine.assembleNow(low);
    expect(h.emitted).toHaveLength(1);
    writePagerdutyIncident(
      d,
      {
        id: "LOW",
        openedAtMs: recent(30),
        priority: "P4",
        status: "acknowledged",
        updatedAtMs: recent(2),
      },
      resolver,
    );
    await h.engine.trigger("pagerduty"); // class R
    expect(h.emitted).toHaveLength(2);
    expect(h.emitted[1]?.version).toBe(2);
    writePagerdutyIncident(
      d,
      {
        id: "LOW",
        openedAtMs: recent(30),
        priority: "P4",
        status: "resolved",
        resolvedAtMs: recent(1),
        updatedAtMs: recent(1),
      },
      resolver,
    );
    await h.engine.trigger("pagerduty");
    expect(getByTriggerItem(d, low)?.status).toBe("closed");
    const closedChecked = getByTriggerItem(d, low)?.checked_at_ms;
    await h.engine.trigger("pagerduty"); // closed and unchanged: class C does not select it
    expect(getByTriggerItem(d, low)?.checked_at_ms).toBe(closedChecked);
    // the item changes again: class C picks it up
    writePagerdutyIncident(
      d,
      {
        id: "LOW",
        openedAtMs: recent(30),
        priority: "P4",
        status: "resolved",
        resolvedAtMs: recent(1),
        updatedAtMs: NOW,
      },
      resolver,
    );
    d.run("UPDATE incident_record SET checked_at_ms = ? WHERE trigger_item_id = ?", [
      NOW - 1000,
      low,
    ]);
    await h.engine.trigger("pagerduty");
    expect(getByTriggerItem(d, low)?.checked_at_ms).toBe(NOW);
  });

  test("class C never re-selects an item dated in the future; class R goes least recently checked first", async () => {
    const d = db();
    const a = writePagerdutyIncident(
      d,
      { id: "A", openedAtMs: recent(30), priority: "P1" },
      resolver,
    );
    const b = writePagerdutyIncident(
      d,
      { id: "B", openedAtMs: recent(20), priority: "P1" },
      resolver,
    );
    const h = harness(d);
    await h.engine.assembleNow(a);
    await h.engine.assembleNow(b);
    d.run("UPDATE incident_record SET checked_at_ms = 1 WHERE trigger_item_id = ?", [b]);
    d.run("UPDATE incident_record SET checked_at_ms = 2 WHERE trigger_item_id = ?", [a]);
    // refresh only the first by a cap of one: simulate by reading the selection order directly
    const { selectRefreshItemIds, selectChangedItemIds } = await import("./incident-selection.ts");
    expect(selectRefreshItemIds(d, "pagerduty", 1)).toEqual([b]);
    expect(selectRefreshItemIds(d, "pagerduty", 5)).toEqual([b, a]);
    d.run("UPDATE incident_record SET status = 'closed'");
    d.run("UPDATE item SET modified_at = ?", [NOW + DAY]);
    // IC4: a tracked state change observed since the check also reselects, so the fixture has none
    d.run("DELETE FROM item_history");
    expect(selectChangedItemIds(d, "pagerduty", NOW)).toEqual([]);
    expect(selectChangedItemIds(d, "pagerduty", NOW + 2 * DAY)).toHaveLength(2);
  });

  test("a record whose item vanished is touched, so it does not stay first for ever", async () => {
    const d = db();
    const a = writePagerdutyIncident(
      d,
      { id: "GONE", openedAtMs: recent(30), priority: "P1" },
      resolver,
    );
    const h = harness(d);
    await h.engine.assembleNow(a);
    d.run("DELETE FROM item");
    await h.engine.trigger("pagerduty");
    expect(getByTriggerItem(d, a)?.checked_at_ms).toBe(NOW);
    expect(h.emitted).toHaveLength(1);
  });
});

describe("one pass sees concurrent records converge", () => {
  test("two records of different services within 30 minutes list each other after one pass", async () => {
    const d = db();
    writeJsmAlert(
      d,
      { id: "J1", openedAtMs: recent(20), priority: "P1", tags: ["payments"] },
      resolver,
    );
    writeJsmAlert(
      d,
      { id: "J2", openedAtMs: recent(15), priority: "P1", tags: ["checkout"] },
      resolver,
    );
    const h = harness(d);
    await h.engine.trigger("jira");
    const a = JSON.parse(getByTriggerItem(d, "jira:J1")?.record_json ?? "{}");
    const b = JSON.parse(getByTriggerItem(d, "jira:J2")?.record_json ?? "{}");
    expect(a.concurrent.records.map((r: { triggerItemId: string }) => r.triggerItemId)).toEqual([
      "jira:J2",
    ]);
    expect(b.concurrent.records.map((r: { triggerItemId: string }) => r.triggerItemId)).toEqual([
      "jira:J1",
    ]);
    // the newer item is assembled first and sees nobody; the second sweep re-assembles it
    expect(getByTriggerItem(d, "jira:J2")?.version).toBe(2);
    expect(getByTriggerItem(d, "jira:J1")?.version).toBe(1);
  });
});

describe("configuration, demo and single flight", () => {
  test("[incident] enabled = false stops the automatic pass; assembleNow still works", async () => {
    const d = db();
    const a = writePagerdutyIncident(
      d,
      { id: "A", openedAtMs: recent(30), priority: "P1" },
      resolver,
    );
    const h = harness(d);
    h.incident = { ...DEFAULT_INCIDENT_CONFIG, enabled: false };
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toEqual([]);
    expect((await h.engine.assembleNow(a)).outcome).toBe("created");
    expect(h.emitted).toHaveLength(1);
  });

  test("a demo engine's trigger is a no-op", async () => {
    const d = db();
    writePagerdutyIncident(d, { id: "A", openedAtMs: recent(30), priority: "P1" }, resolver);
    const h = harness(d, { demo: true });
    await h.engine.trigger("pagerduty");
    expect(ids(d)).toEqual([]);
  });

  test("the loop yields between records (N - 1 times)", async () => {
    const d = db();
    for (let i = 0; i < 4; i += 1) {
      writePagerdutyIncident(
        d,
        { id: `Y${String(i)}`, openedAtMs: recent(i + 1), priority: "P1" },
        resolver,
      );
    }
    let yields = 0;
    const h = harness(d, {
      yieldToEventLoop: async () => {
        yields += 1;
      },
    });
    await h.engine.trigger("pagerduty");
    // 4 records in the first sweep (3 yields) and a second sweep of the 4 that changed (3 more)
    expect(yields).toBe(6);
  });

  test("two concurrent assembleNow calls on one item run once and write one version", async () => {
    const d = db();
    const a = writePagerdutyIncident(
      d,
      { id: "A", openedAtMs: recent(30), priority: "P1" },
      resolver,
    );
    const h = harness(d);
    const [x, y] = await Promise.all([h.engine.assembleNow(a), h.engine.assembleNow(a)]);
    expect(x).toBe(y);
    expect(h.configLoads.n).toBe(1);
    expect(h.emitted).toHaveLength(1);
  });

  test("assembleNow JOINS a pass that is assembling the same item, and the reverse", async () => {
    const d = db();
    const a = writePagerdutyIncident(
      d,
      { id: "A", openedAtMs: recent(30), priority: "P1" },
      resolver,
    );
    const h = harness(d);
    const pass = h.engine.trigger("pagerduty"); // the first assembly starts synchronously
    const joined = h.engine.assembleNow(a);
    await Promise.all([pass, joined]);
    expect(h.configLoads.n).toBe(1);
    expect(versionsOf(d, getByTriggerItem(d, a)?.id ?? "")).toHaveLength(1);
    expect(h.emitted).toHaveLength(1);
    // reverse: assembleNow first, the pass reaches the same item while it is in flight
    const d2 = db();
    const b = writePagerdutyIncident(
      d2,
      { id: "B", openedAtMs: recent(30), priority: "P1" },
      resolver,
    );
    const h2 = harness(d2);
    const now = h2.engine.assembleNow(b);
    const pass2 = h2.engine.trigger("pagerduty");
    await Promise.all([now, pass2]);
    expect(h2.configLoads.n).toBe(1);
    expect(h2.emitted).toHaveLength(1);
  });

  test("the in-flight entry is removed even when assembly throws: a second call assembles again", async () => {
    const d = db();
    const a = writePagerdutyIncident(
      d,
      { id: "A", openedAtMs: recent(30), priority: "P1" },
      resolver,
    );
    d.run(
      "CREATE TRIGGER boom BEFORE INSERT ON incident_record BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    const h = harness(d);
    await expect(h.engine.assembleNow(a)).rejects.toThrow("boom");
    d.run("DROP TRIGGER boom");
    expect((await h.engine.assembleNow(a)).outcome).toBe("created");
  });

  test("a trigger that lands during a pass sets one rerun and does not start a second pass", async () => {
    const d = db();
    for (let i = 0; i < 3; i += 1) {
      writePagerdutyIncident(
        d,
        { id: `R${String(i)}`, openedAtMs: recent(i + 1), priority: "P1" },
        resolver,
      );
    }
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let gates = 0;
    const h = harness(d, {
      yieldToEventLoop: () => {
        gates += 1;
        return gates === 1 ? gate : Promise.resolve();
      },
    });
    const first = h.engine.trigger("pagerduty");
    const second = h.engine.trigger("pagerduty");
    const third = h.engine.trigger("pagerduty");
    release();
    await Promise.all([first, second, third]);
    expect(ids(d)).toHaveLength(3);
    // three triggers during one pass: the pass plus exactly one rerun
    expect(h.passes.n).toBe(2);
    // a Bigeye item without sla statuses is never auto-triggered
    writeBigeyeIssue(d, { id: "B", slaStatus: "breached", syncedAtMs: recent(5) }, resolver);
    await h.engine.trigger("bigeye");
    expect(ids(d)).toHaveLength(3);
    h.incident = { ...DEFAULT_INCIDENT_CONFIG, bigeyeSlaStatuses: ["breached"] };
    await h.engine.trigger("bigeye");
    expect(ids(d)).toContain("bigeye:B");
    expect(HOUR).toBeGreaterThan(0);
  });

  test("a throwing emit never breaks assembly", async () => {
    const d = db();
    const a = writePagerdutyIncident(
      d,
      { id: "A", openedAtMs: recent(30), priority: "P1" },
      resolver,
    );
    const warned: string[] = [];
    const h = harness(d, {
      emit: () => {
        throw new Error("listener blew up");
      },
      logger: { warn: (_o, m) => warned.push(m) },
    });
    expect((await h.engine.assembleNow(a)).outcome).toBe("created");
    expect(warned).toContain("incident engine: emit failed");
  });
});
