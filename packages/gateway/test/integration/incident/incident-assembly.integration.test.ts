import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { runDataDelete } from "../../../src/commands/data-delete.ts";
import { DEFAULT_INCIDENT_CONFIG } from "../../../src/config/incident-toml.ts";
import { DEFAULT_ONCALL_PUSH_CONFIG } from "../../../src/config/oncall-push-toml.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { syncPagerdutyIncidentItems } from "../../../src/connectors/pagerduty-sync.ts";
import {
  configMap,
  HOUR,
  markSynced,
  resolverFor,
  serviceConfig,
  writeDeployment,
  writePagerdutyShift,
  writeSlackMessage,
} from "../../../src/incident/__fixtures__/index-writers.ts";
import {
  writeBigeyeIssue,
  writeJsmAlert,
  writeMonteCarloIncident,
  writePagerdutyIncident,
  writeSentryIssue,
} from "../../../src/incident/__fixtures__/trigger-writers.ts";
import { createIncidentEngine } from "../../../src/incident/incident-engine.ts";
import { pruneIncidentRecordsWithBriefs } from "../../../src/incident/incident-erasure.ts";
import { getByTriggerItem, versionsOf } from "../../../src/incident/incident-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { createOncallPushRunner } from "../../../src/oncall-push/push-runner.ts";
import { PushStore } from "../../../src/oncall-push/push-store.ts";
import { findPersonByCanonicalEmail } from "../../../src/people/person-store.ts";
import { memVault } from "../../fixtures/data-test-helpers.ts";

/**
 * IC3 acceptance, every source and the whole lifecycle, over real SQLite with the real connector writers and graph
 * populators (no hand-seeded edges): assembly per source, re-assembly into versions, erasure and retention of the
 * records AND the pushed briefs built from them, and the on-call push over records.
 */
const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-12T12:00:00.000Z");
const OPEN = NOW - 10 * 60_000;
const cfg = serviceConfig({ serviceId: "payments", pagerdutyServices: ["PSVC1"] });
const resolver = resolverFor(cfg);

function setup(config = DEFAULT_INCIDENT_CONFIG) {
  const db = createMemoryIndexDb();
  dbs.push(db);
  const events: { recordId: string; version: number; status: string }[] = [];
  const engine = createIncidentEngine({
    db,
    now: () => NOW,
    emit: (p) => events.push(p),
    loadServiceConfigs: () => configMap(cfg),
    readConfig: () => ({ incident: config, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
  });
  return { db, engine, events };
}

describe("every source assembles end to end from its real writer", () => {
  test("PagerDuty, JSM, Sentry, Monte Carlo and a Bigeye item with bigeye_sla_statuses, each bound through its key", async () => {
    const { db, engine, events } = setup({
      ...DEFAULT_INCIDENT_CONFIG,
      bigeyeSlaStatuses: ["breached"],
    });
    writePagerdutyIncident(db, { id: "P", openedAtMs: OPEN, priority: "P1" }, resolver);
    writeJsmAlert(db, { id: "J", openedAtMs: OPEN, priority: "P1", tags: ["payments"] }, resolver);
    writeSentryIssue(db, { id: "S", level: "fatal", firstSeenMs: OPEN }, resolver);
    writeMonteCarloIncident(db, { id: "M", severity: "SEV-1", firstSeenMs: OPEN }, resolver);
    writeBigeyeIssue(db, { id: "B", slaStatus: "breached", syncedAtMs: OPEN }, resolver);
    writeJsmAlert(db, { id: "U", openedAtMs: OPEN, priority: "P1", tags: ["elsewhere"] }, resolver);
    for (const svc of ["pagerduty", "jira", "sentry", "montecarlo", "bigeye"]) {
      await engine.trigger(svc);
    }
    const rows = db
      .query("SELECT trigger_item_id AS t, service, status FROM incident_record ORDER BY t")
      .all() as { t: string; service: string | null; status: string }[];
    expect(rows.map((r) => r.t)).toEqual([
      "bigeye:B",
      "jira:J",
      "jira:U",
      "montecarlo:M",
      "pagerduty:P",
      "sentry:S",
    ]);
    expect(rows.find((r) => r.t === "bigeye:B")).toMatchObject({
      service: "payments",
      status: "unknown",
    });
    expect(rows.find((r) => r.t === "jira:U")?.service).toBeNull(); // the unbound alert, with its gap
    const unbound = JSON.parse(getByTriggerItem(db, "jira:U")?.record_json ?? "{}") as {
      gaps: { remediation?: string }[];
    };
    expect(unbound.gaps.some((g) => g.remediation?.includes("jsm_alert_tags"))).toBe(true);
    expect(events.length).toBeGreaterThanOrEqual(6);
  });

  test("a P1 that fired and resolved between two syncs gets a record with status closed; an old item gets none", async () => {
    const { db, engine } = setup();
    writePagerdutyIncident(
      db,
      {
        id: "DONE",
        openedAtMs: OPEN,
        status: "resolved",
        resolvedAtMs: OPEN + 5 * 60_000,
        priority: "P1",
      },
      resolver,
    );
    writePagerdutyIncident(
      db,
      { id: "OLD", openedAtMs: NOW - 9 * DAY, updatedAtMs: NOW - 9 * DAY, priority: "P1" },
      resolver,
    );
    await engine.trigger("pagerduty");
    expect(getByTriggerItem(db, "pagerduty:DONE")?.status).toBe("closed");
    expect(getByTriggerItem(db, "pagerduty:OLD")).toBeNull();
    // ... but on demand it can still be assembled
    expect((await engine.assembleNow("pagerduty:OLD")).outcome).toBe("created");
  });
});

describe("re-assembly", () => {
  test("a second sync that resolves the incident makes version 2 with the provider's resolution time; a no-op sync makes none", async () => {
    const { db, engine, events } = setup();
    writePagerdutyIncident(db, { id: "P", openedAtMs: OPEN, priority: "P1" }, resolver);
    await engine.trigger("pagerduty");
    const first = getByTriggerItem(db, "pagerduty:P");
    const v1 = db
      .query("SELECT record_json FROM incident_record_version WHERE record_id = ? AND version = 1")
      .get(first?.id ?? "") as { record_json: string };
    await engine.trigger("pagerduty"); // a no-op sync
    expect(versionsOf(db, first?.id ?? "")).toHaveLength(1);
    expect(events).toHaveLength(1);

    writePagerdutyIncident(
      db,
      {
        id: "P",
        openedAtMs: OPEN,
        priority: "P1",
        status: "resolved",
        resolvedAtMs: OPEN + 3 * 60_000,
        updatedAtMs: OPEN + 3 * 60_000,
      },
      resolver,
    );
    await engine.trigger("pagerduty");
    const second = getByTriggerItem(db, "pagerduty:P");
    expect(second).toMatchObject({ version: 2, status: "closed" });
    const rec = JSON.parse(second?.record_json ?? "{}") as {
      trigger: { closed: { ms: number; basis: string } };
    };
    expect(rec.trigger.closed).toEqual({ ms: OPEN + 3 * 60_000, basis: "provider" });
    const stillV1 = db
      .query("SELECT record_json FROM incident_record_version WHERE record_id = ? AND version = 1")
      .get(first?.id ?? "") as { record_json: string };
    expect(stillV1.record_json).toBe(v1.record_json);
    expect(events.map((e) => e.version)).toEqual([1, 2]);
  });
});

describe("erasure and retention reach the records and the briefs built from them", () => {
  test("connector remove of the chat service deletes the citing records AND their pushed briefs; unrelated ones stay", async () => {
    const { db, engine } = setup();
    markSynced(db, "slack", OPEN);
    writeSlackMessage(db, { ts: "1.000001", text: "payments is slow", atMs: OPEN + 60_000 });
    writePagerdutyIncident(db, { id: "WITHCHAT", openedAtMs: OPEN, priority: "P1" }, resolver);
    writeJsmAlert(
      db,
      { id: "NOCHAT", openedAtMs: OPEN, priority: "P1", tags: ["elsewhere"] },
      resolver,
    );
    await engine.trigger("pagerduty");
    await engine.trigger("jira");
    // the push has run first, so a real pushed row exists for each record
    const store = new PushStore(db);
    for (const id of ["pagerduty:WITHCHAT", "jira:NOCHAT"]) {
      const row = getByTriggerItem(db, id);
      store.insert(
        id,
        {
          status: "ok",
          sessionId: `incident:${row?.id ?? ""}:v1`,
          briefMarkdown: row?.markdown ?? "",
          briefJson: "{}",
        },
        NOW,
      );
    }
    expect(getByTriggerItem(db, "pagerduty:WITHCHAT")?.markdown).toContain("payments is slow");
    new LocalIndex(db).removeConnectorIndexData("slack");
    expect(getByTriggerItem(db, "pagerduty:WITHCHAT")).toBeNull();
    expect(store.get("pagerduty:WITHCHAT")).toBeNull();
    expect(getByTriggerItem(db, "jira:NOCHAT")).not.toBeNull();
    expect(store.get("jira:NOCHAT")).not.toBeNull();
    // it is re-assembled, without the erased service's text, on the next pass
    await engine.trigger("pagerduty");
    const again = getByTriggerItem(db, "pagerduty:WITHCHAT");
    expect(again?.markdown).not.toContain("payments is slow");
  });

  test("retention prunes both arms (an old open time, and no open time with an old assembly) together with their briefs", async () => {
    const { db, engine } = setup({ ...DEFAULT_INCIDENT_CONFIG, bigeyeSlaStatuses: ["breached"] });
    writePagerdutyIncident(
      db,
      { id: "OLD", openedAtMs: NOW - 8 * DAY, updatedAtMs: NOW - 8 * DAY, priority: "P1" },
      resolver,
    );
    writeBigeyeIssue(db, { id: "B", slaStatus: "breached", syncedAtMs: NOW - 8 * DAY }, resolver);
    writePagerdutyIncident(db, { id: "NEW", openedAtMs: OPEN, priority: "P1" }, resolver);
    for (const id of ["pagerduty:OLD", "bigeye:B", "pagerduty:NEW"]) await engine.assembleNow(id);
    db.run("UPDATE incident_record SET assembled_at_ms = ? WHERE trigger_item_id = 'bigeye:B'", [
      NOW - 400 * DAY,
    ]);
    const store = new PushStore(db);
    for (const id of ["pagerduty:OLD", "bigeye:B", "pagerduty:NEW"]) {
      store.insert(
        id,
        { status: "ok", sessionId: "s", briefMarkdown: "brief", briefJson: "{}" },
        NOW,
      );
    }
    const run = pruneIncidentRecordsWithBriefs(db, NOW - 7 * DAY);
    expect(run.recordsDeleted).toBe(2);
    expect(getByTriggerItem(db, "pagerduty:NEW")).not.toBeNull();
    expect(store.get("pagerduty:NEW")).not.toBeNull();
    expect(store.get("pagerduty:OLD")).toBeNull();
    expect(store.get("bigeye:B")).toBeNull();
  });

  test("nimbus data delete previews both counts and then deletes", async () => {
    const { db, engine } = setup();
    markSynced(db, "slack", OPEN);
    writeSlackMessage(db, { ts: "1.000001", text: "payments is slow", atMs: OPEN + 60_000 });
    writePagerdutyIncident(db, { id: "P", openedAtMs: OPEN, priority: "P1" }, resolver);
    await engine.assembleNow("pagerduty:P");
    new PushStore(db).insert(
      "pagerduty:P",
      { status: "ok", sessionId: "s", briefMarkdown: "b", briefJson: "{}" },
      NOW,
    );
    const index = new LocalIndex(db);
    const dry = await runDataDelete({ service: "slack", dryRun: true, vault: memVault(), index });
    expect(dry.preflight).toMatchObject({ incidentRecordsToDelete: 1, pushedBriefsToDelete: 1 });
    expect(getByTriggerItem(db, "pagerduty:P")).not.toBeNull();
    await runDataDelete({ service: "slack", dryRun: false, vault: memVault(), index });
    expect(getByTriggerItem(db, "pagerduty:P")).toBeNull();
  });
});

describe("the on-call push over records", () => {
  const ME = "me@acme.example";

  function runner(db: Database, engine: ReturnType<typeof setup>["engine"], sources: string[]) {
    const store = new PushStore(db);
    store.reconcileEnabledState(true, OPEN - HOUR);
    const me = findPersonByCanonicalEmail(db, ME);
    const delivered: string[] = [];
    return {
      store,
      delivered,
      run: createOncallPushRunner({
        db,
        store,
        config: { ...DEFAULT_ONCALL_PUSH_CONFIG, sources },
        isEnabled: () => true,
        pagerdutyAliases: [],
        resolveSelf: async () => me?.id ?? "owner",
        deliver: async (items) => {
          delivered.push(...items.map((i) => i.row.incidentId));
        },
        records: engine,
        serviceConfig: (id) => (id === "payments" ? cfg : undefined),
        now: () => NOW,
      }),
    };
  }

  /** The real PagerDuty syncable: an incident assigned to the owner, which also creates the owner's person row. */
  function seedPagerdutyAssignedToMe(db: Database): void {
    const ctx = syncTestContext(
      db,
      createStubVault({ "pagerduty.api_token": "tok" }),
      "pagerduty",
      "full",
      resolver,
    );
    syncPagerdutyIncidentItems(
      ctx,
      [
        {
          id: "PD1",
          status: "triggered",
          title: "payments 5xx",
          priority: { name: "P1" },
          created_at: new Date(OPEN).toISOString(),
          updated_at: new Date(OPEN).toISOString(),
          service: { id: "PSVC1" },
          assignments: [{ assignee: { id: "U1", type: "user", email: ME } }],
        },
      ],
      new Date(OPEN - DAY).toISOString(),
      OPEN,
      new Map(),
    );
  }

  test("a bound JSM P1 for a service whose PagerDuty shift is yours IS pushed; an unbound one, and one for a service you are not on call for, are NOT", async () => {
    const { db, engine } = setup();
    markSynced(db, "pagerduty", NOW);
    writeJsmAlert(
      db,
      { id: "BOUND", openedAtMs: OPEN, priority: "P1", tags: ["payments"] },
      resolver,
    );
    writeJsmAlert(
      db,
      { id: "UNBOUND", openedAtMs: OPEN, priority: "P1", tags: ["elsewhere"] },
      resolver,
    );
    await engine.trigger("jira");
    const { run, delivered, store } = runner(db, engine, ["pagerduty", "jira"]);
    // no shift data yet: nothing is pushed, no row is written for a skip
    const none = await run.run("jira");
    expect(none.notPushed).toMatchObject({ unbound: 1, no_oncall_data: 1 });
    expect(delivered).toEqual([]);
    // the owner goes on call for ANOTHER service: still not pushed
    writePagerdutyShift(db, {
      startMs: NOW - HOUR,
      endMs: NOW + HOUR,
      fetchedAtMs: NOW - 60_000,
      isMe: true,
      serviceIds: ["OTHER"],
    });
    expect((await run.run("jira")).notPushed).toMatchObject({ unbound: 1, no_oncall_data: 1 });
    expect(delivered).toEqual([]);
    // on call for this service: the bound alert is pushed once, the unbound one never
    db.run("DELETE FROM item WHERE type = 'oncall_shift'");
    writePagerdutyShift(db, {
      startMs: NOW - HOUR,
      endMs: NOW + HOUR,
      fetchedAtMs: NOW - 60_000,
      isMe: true,
      serviceIds: ["PSVC1"],
    });
    expect(await run.run("jira")).toMatchObject({ selected: 1, ok: 1, notPushed: { unbound: 1 } });
    expect(delivered).toEqual(["jira:BOUND"]);
    expect(store.get("jira:UNBOUND")).toBeNull();
    expect(store.get("jira:BOUND")?.briefMarkdown).toContain("# Incident");
  });

  test("with the default sources only PagerDuty pushes, and the pushed brief IS the record Markdown", async () => {
    const { db, engine } = setup();
    writeJsmAlert(
      db,
      { id: "BOUND", openedAtMs: OPEN, priority: "P1", tags: ["payments"] },
      resolver,
    );
    writeDeployment(db, resolver, { service: "payments", startedAtMs: OPEN - 20 * 60_000 });
    seedPagerdutyAssignedToMe(db);
    await engine.trigger("jira");
    expect(findPersonByCanonicalEmail(db, ME)).not.toBeNull();
    const { run, delivered, store } = runner(db, engine, ["pagerduty"]);
    expect(await run.run("pagerduty")).toMatchObject({ selected: 1, ok: 1 });
    expect(delivered).toEqual(["pagerduty:PD1"]);
    const record = getByTriggerItem(db, "pagerduty:PD1");
    expect(record).not.toBeNull();
    expect(store.get("pagerduty:PD1")?.briefMarkdown).toBe(record?.markdown);
    expect(store.get("jira:BOUND")).toBeNull();
  });
});
