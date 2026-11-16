import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_INCIDENT_CONFIG } from "../config/incident-toml.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import {
  configMap,
  HOUR,
  resolverFor,
  serviceConfig,
  T0,
  writePagerdutyShift,
} from "../incident/__fixtures__/index-writers.ts";
import {
  writeBigeyeIssue,
  writeJsmAlert,
  writeMonteCarloIncident,
  writePagerdutyIncident,
  writeSentryIssue,
} from "../incident/__fixtures__/trigger-writers.ts";
import { createIncidentEngine } from "../incident/incident-engine.ts";
import { ownerOnCallForService } from "./owner-on-call.ts";
import {
  pushIncidentForItem,
  type RecordSelectInput,
  selectRecordPushCandidates,
} from "./push-record-selector.ts";

const NOW = T0 + HOUR;
const OPEN = NOW - 10 * 60_000;
const cfg = serviceConfig({ serviceId: "payments", pagerdutyServices: ["PSVC1"] });
const noPd = serviceConfig({
  serviceId: "ledger",
  pagerdutyServices: [],
  repos: [{ provider: "github", providerId: "acme/ledger" }],
  jsmAlertTags: ["ledger"],
  sentryProjects: ["ledger-api"],
  dataModels: [],
});
const resolver2 = resolverFor(cfg, noPd);

let db: Database;
afterEach(() => db.close());
beforeEach(() => {
  db = createMemoryIndexDb();
});

function engine() {
  return createIncidentEngine({
    db,
    now: () => NOW,
    emit: () => {},
    loadServiceConfigs: () => configMap(cfg, noPd),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
  });
}

async function assemble(...ids: string[]): Promise<void> {
  const e = engine();
  for (const id of ids) await e.assembleNow(id);
}

function proof(over: { isMe?: boolean; fetchedAtMs?: number; serviceIds?: string[] } = {}): void {
  writePagerdutyShift(db, {
    startMs: NOW - HOUR,
    endMs: NOW + HOUR,
    fetchedAtMs: over.fetchedAtMs ?? NOW - 60_000,
    isMe: over.isMe ?? true,
    serviceIds: over.serviceIds ?? ["PSVC1"],
  });
}

function input(over: Partial<RecordSelectInput> = {}): RecordSelectInput {
  return {
    sources: ["pagerduty", "jira"],
    severities: new Set(["p1"]),
    enabledAtMs: T0,
    nowMs: NOW,
    alreadyPushed: () => false,
    serviceConfig: (id) => [cfg, noPd].find((c) => c.serviceId === id),
    ...over,
  };
}

async function jsmP1(id = "J1"): Promise<string> {
  const item = writeJsmAlert(
    db,
    { id, openedAtMs: OPEN, priority: "P1", tags: ["payments"] },
    resolver2,
  );
  await assemble(item);
  return item;
}

describe("selectRecordPushCandidates", () => {
  test("a bound, open, in-set record for a service the owner is on call for IS selected (positive control)", async () => {
    const id = await jsmP1();
    proof();
    const r = selectRecordPushCandidates(db, input());
    expect(r.notPushed).toEqual({});
    expect(r.candidates).toEqual([
      {
        id,
        title: "Alert J1",
        url: null,
        status: "open",
        severity: "P1",
        urgency: null,
        openedAtMs: OPEN,
        pagerdutyServiceId: null,
        assigneeEmails: [],
      },
    ]);
  });

  test("severity is the PUSH set: a p2 record that exists is not selected; [incident] severities is never read", async () => {
    const p2 = writeJsmAlert(
      db,
      { id: "J2", openedAtMs: OPEN, priority: "P2", tags: ["payments"] },
      resolver2,
    );
    await assemble(p2); // it exists only because it was assembled on demand
    proof();
    const r = selectRecordPushCandidates(db, input());
    expect(r.candidates).toEqual([]);
    expect(r.notPushed).toEqual({ severity_not_in_push_set: 1 });
    expect(
      selectRecordPushCandidates(db, input({ severities: new Set(["p1", "p2"]) })).candidates,
    ).toHaveLength(1);
  });

  test("a Sentry fatal and a Monte Carlo SEV-1 push only when the push set lists them; Monte Carlo matches through its normalised label", async () => {
    const sentry = writeSentryIssue(
      db,
      { id: "S1", level: "fatal", firstSeenMs: OPEN, project: "payments-api" },
      resolver2,
    );
    const mc = writeMonteCarloIncident(
      db,
      { id: "M1", severity: "SEV-1", firstSeenMs: OPEN },
      resolver2,
    );
    await assemble(sentry, mc);
    proof();
    const wide = input({ sources: ["sentry", "montecarlo"] });
    expect(selectRecordPushCandidates(db, wide).notPushed).toEqual({ severity_not_in_push_set: 2 });
    const pick = selectRecordPushCandidates(db, {
      ...wide,
      severities: new Set(["fatal", "SEV-1"]),
    });
    expect(pick.candidates.map((c) => c.id).sort()).toEqual([mc, sentry].sort());
    expect(pick.candidates.find((c) => c.id === mc)?.severity).toBe("SEV1");
  });

  test("each missing proof is its own reason, never a push", async () => {
    const unbound = writeJsmAlert(
      db,
      { id: "U", openedAtMs: OPEN, priority: "P1", tags: ["elsewhere"] },
      resolver2,
    );
    const ledger = writeJsmAlert(
      db,
      { id: "L", openedAtMs: OPEN, priority: "P1", tags: ["ledger"] },
      resolver2,
    );
    await assemble(unbound, ledger);
    // no shift rows at all: the bound service with PagerDuty ids has no data, the one without ids has none either
    expect(selectRecordPushCandidates(db, input()).notPushed).toEqual({
      unbound: 1,
      no_oncall_data: 1,
    });
    proof({ isMe: false });
    expect(selectRecordPushCandidates(db, input()).notPushed).toEqual({
      unbound: 1,
      no_oncall_data: 1,
    });
    await jsmP1();
    expect(selectRecordPushCandidates(db, input()).notPushed).toEqual({
      unbound: 1,
      no_oncall_data: 1,
      owner_not_on_call: 1,
    });
  });

  test("a stale shift row, a shift that ended and the owner on call for ANOTHER service are not proof", async () => {
    await jsmP1();
    proof({ fetchedAtMs: NOW - 2 * HOUR });
    expect(selectRecordPushCandidates(db, input()).notPushed).toEqual({ stale_oncall_data: 1 });
    db.run("DELETE FROM item WHERE type = 'oncall_shift'");
    writePagerdutyShift(db, {
      startMs: NOW - 3 * HOUR,
      endMs: NOW - HOUR,
      fetchedAtMs: NOW - 60_000,
      isMe: true,
      serviceIds: ["PSVC1"],
    });
    expect(selectRecordPushCandidates(db, input()).candidates).toEqual([]);
    db.run("DELETE FROM item WHERE type = 'oncall_shift'");
    proof({ serviceIds: ["OTHER"] });
    expect(selectRecordPushCandidates(db, input()).notPushed).toEqual({ no_oncall_data: 1 });
  });

  test("a JSM schedule named like the service, marked mine, with no service ids is NOT accepted (the exact-id path)", async () => {
    await jsmP1();
    proof({ serviceIds: [] });
    db.run(
      `UPDATE item SET title = 'payments', metadata = json_set(metadata, '$.schedule_name', 'payments', '$.service_names', json('["payments"]'))
        WHERE type = 'oncall_shift'`,
    );
    expect(selectRecordPushCandidates(db, input()).candidates).toEqual([]);
  });

  test("the opt-in and the PagerDuty exclusion are enforced INSIDE the selector, whatever the caller does", async () => {
    const jsm = await jsmP1();
    const sentry = writeSentryIssue(
      db,
      { id: "S1", level: "fatal", firstSeenMs: OPEN, project: "payments-api" },
      resolver2,
    );
    const mc = writeMonteCarloIncident(
      db,
      { id: "M1", severity: "SEV-1", firstSeenMs: OPEN },
      resolver2,
    );
    const pd = writePagerdutyIncident(
      db,
      { id: "PD1", openedAtMs: OPEN, priority: "P1" },
      resolver2,
    );
    await assemble(sentry, mc, pd);
    proof();
    const all = { severities: new Set(["p1", "fatal", "sev1"]) };
    expect(
      selectRecordPushCandidates(db, input({ ...all, sources: ["jira"] })).candidates.map(
        (c) => c.id,
      ),
    ).toEqual([jsm]);
    // PagerDuty in `sources` never selects a PagerDuty record through the on-call proof
    const withPd = selectRecordPushCandidates(
      db,
      input({ ...all, sources: ["pagerduty", "jira"] }),
    );
    expect(withPd.candidates.map((c) => c.id)).toEqual([jsm]);
    expect(withPd.candidates.some((c) => c.id === pd)).toBe(false);
    expect(
      selectRecordPushCandidates(db, input({ ...all, sources: ["pagerduty"] })).candidates,
    ).toEqual([]);
    expect(selectRecordPushCandidates(db, input({ ...all, sources: [] })).candidates).toEqual([]);
    // a quote, percent or underscore in a source id is data
    for (const s of ["ji'ra", "ji%", "j_ra", "' OR 1=1 --"]) {
      expect(selectRecordPushCandidates(db, input({ ...all, sources: [s] })).candidates).toEqual(
        [],
      );
    }
    expect(
      selectRecordPushCandidates(db, input({ ...all, sources: ["sentry", "montecarlo"] }))
        .candidates.map((c) => c.id)
        .sort(),
    ).toEqual([mc, sentry].sort());
  });

  test("closed, no-open-time, already-pushed and older-than-enable records are never candidates", async () => {
    const closed = writeJsmAlert(
      db,
      { id: "C", openedAtMs: OPEN, priority: "P1", status: "closed", tags: ["payments"] },
      resolver2,
    );
    const old = writeJsmAlert(
      db,
      { id: "O", openedAtMs: T0 - 2 * HOUR, priority: "P1", tags: ["payments"] },
      resolver2,
    );
    const pushed = await jsmP1("P");
    await assemble(closed, old);
    const bigeye = writeBigeyeIssue(
      db,
      { id: "B", slaStatus: "breached", syncedAtMs: OPEN },
      resolver2,
    );
    await assemble(bigeye);
    proof();
    const r = selectRecordPushCandidates(
      db,
      input({ alreadyPushed: (id) => id === pushed, enabledAtMs: T0 }),
    );
    expect(r.candidates).toEqual([]);
    expect(r.notPushed).toEqual({});
    // an open record with an in-set severity but no open time is its own reason
    db.run("UPDATE incident_record SET opened_at_ms = NULL WHERE trigger_item_id = ?", [pushed]);
    expect(selectRecordPushCandidates(db, input({ alreadyPushed: () => false })).notPushed).toEqual(
      {
        no_open_time: 1,
      },
    );
    // a Bigeye record has unknown status and no severity, so it is never a candidate
    expect(selectRecordPushCandidates(db, input({ sources: ["bigeye"] })).candidates).toEqual([]);
  });
});

describe("ownerOnCallForService", () => {
  const svc = { pagerdutyServices: ["PSVC1"] };

  test("yes, no, no_data and stale, by exact PagerDuty service id", () => {
    expect(ownerOnCallForService(db, svc, NOW)).toBe("no_data");
    expect(ownerOnCallForService(db, { pagerdutyServices: [] }, NOW)).toBe("no_data");
    proof({ isMe: false });
    expect(ownerOnCallForService(db, svc, NOW)).toBe("no");
    db.run("DELETE FROM item WHERE type = 'oncall_shift'");
    proof();
    expect(ownerOnCallForService(db, svc, NOW)).toBe("yes");
    expect(ownerOnCallForService(db, { pagerdutyServices: ["NOPE", "PSVC1"] }, NOW)).toBe("yes");
    expect(ownerOnCallForService(db, { pagerdutyServices: ["NOPE"] }, NOW)).toBe("no_data");
    expect(ownerOnCallForService(db, svc, NOW + 3 * HOUR)).toBe("stale");
    db.run("DELETE FROM item WHERE type = 'oncall_shift'");
    proof({ fetchedAtMs: NOW - 2 * HOUR });
    expect(ownerOnCallForService(db, svc, NOW)).toBe("stale");
  });
});

describe("pushIncidentForItem", () => {
  test("a PagerDuty id through selectIncidentById, any other source from its record, unknown is null", async () => {
    const jsm = await jsmP1();
    const pd = writePagerdutyIncident(
      db,
      { id: "PD1", openedAtMs: OPEN, priority: "P1" },
      resolver2,
    );
    expect(pushIncidentForItem(db, jsm)).toMatchObject({
      id: jsm,
      severity: "P1",
      pagerdutyServiceId: null,
    });
    expect(pushIncidentForItem(db, pd)).toMatchObject({ id: pd, pagerdutyServiceId: "PSVC1" });
    expect(pushIncidentForItem(db, "jira:nope")).toBeNull();
    expect(pushIncidentForItem(db, "pagerduty:nope")).toBeNull();
  });
});
