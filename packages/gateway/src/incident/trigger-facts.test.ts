import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { ITEM_HISTORY_SPECS } from "../index/item-history-keys.ts";
import {
  writeBigeyeIssue,
  writeJsmAlert,
  writeMonteCarloIncident,
  writePagerdutyIncident,
  writeSentryIssue,
} from "./__fixtures__/trigger-writers.ts";
import {
  qualifies,
  qualifiesSql,
  qualifyingLabels,
  type TriggerConfig,
  triggerFacts,
} from "./trigger-facts.ts";
import {
  isTriggerPair,
  isTriggerService,
  TRIGGER_SERVICES,
  TRIGGER_SOURCES,
  type TriggerService,
  triggerTypeOf,
} from "./trigger-sources.ts";

const T = Date.parse("2026-11-10T12:00:00.000Z");
const HOUR = 3_600_000;
const NONE: TriggerConfig = { severities: [], bigeyeSlaStatuses: [], pagerdutyP1Aliases: [] };

type Row = { id: string; service: string; metadata: string | null };

function rowOf(db: Database, id: string): Row {
  return db.query("SELECT id, service, metadata FROM item WHERE id = ?").get(id) as Row;
}

function factsOf(db: Database, id: string) {
  const r = rowOf(db, id);
  return triggerFacts({ service: r.service as TriggerService, metadata: r.metadata });
}

describe("trigger sources", () => {
  test("the five pairs are exactly the trigger entries of the item-history specs", () => {
    expect(TRIGGER_SOURCES.map((s) => `${s.service}:${s.type}`)).toEqual([
      "pagerduty:incident",
      "jira:alert",
      "sentry:error_issue",
      "montecarlo:data_quality_test",
      "bigeye:data_quality_test",
    ]);
    for (const s of TRIGGER_SOURCES)
      expect(ITEM_HISTORY_SPECS.has(`${s.service}:${s.type}`)).toBe(true);
    expect(TRIGGER_SERVICES).toHaveLength(5);
    expect(isTriggerService("jira")).toBe(true);
    expect(isTriggerService("github")).toBe(false);
    expect(isTriggerPair("jira", "alert")).toBe(true);
    expect(isTriggerPair("jira", "issue")).toBe(false);
    expect(triggerTypeOf("bigeye")).toBe("data_quality_test");
  });
});

describe("triggerFacts over the real writers", () => {
  test("PagerDuty: open, resolved with a provider time, severity lower-cased and not collapsed", () => {
    const db = createMemoryIndexDb();
    const open = writePagerdutyIncident(db, { id: "A", openedAtMs: T, priority: "P1" });
    const done = writePagerdutyIncident(db, {
      id: "B",
      openedAtMs: T,
      status: "resolved",
      resolvedAtMs: T + HOUR,
      priority: "SEV1",
    });
    const a = factsOf(db, open);
    expect(a).toMatchObject({
      status: "open",
      severity: "p1",
      severityRaw: "P1",
      openedAtMs: T,
      openedAtBasis: "provider",
      closedAtMs: null,
      closedAtBasis: "none",
      metadataValid: true,
    });
    const b = factsOf(db, done);
    expect(b).toMatchObject({
      status: "closed",
      severity: "sev1", // a PagerDuty SEV1 is NOT collapsed into p1
      closedAtMs: T + HOUR,
      closedAtBasis: "provider",
    });
    db.close();
  });

  test("PagerDuty: a resolved incident without a resolution time reads closed, time not recorded", () => {
    const db = createMemoryIndexDb();
    const id = writePagerdutyIncident(db, { id: "C", openedAtMs: T, status: "resolved" });
    db.run("UPDATE item SET metadata = json_remove(metadata, '$.resolved_at_ms')");
    expect(factsOf(db, id)).toMatchObject({
      status: "closed",
      closedAtMs: null,
      closedAtBasis: "none",
    });
    // a missing status reads open (isActiveIncidentStatus: fail toward showing)
    db.run("UPDATE item SET metadata = json_remove(metadata, '$.status')");
    expect(factsOf(db, id).status).toBe("open");
    db.close();
  });

  test("JSM alert: priority label, status, provider open and close times", () => {
    const db = createMemoryIndexDb();
    const open = writeJsmAlert(db, { id: "J1", openedAtMs: T, priority: "P1", status: "open" });
    const closed = writeJsmAlert(db, {
      id: "J2",
      openedAtMs: T,
      priority: "P2",
      status: "closed",
      closeTimeMs: 60_000,
    });
    expect(factsOf(db, open)).toMatchObject({ status: "open", severity: "p1", openedAtMs: T });
    expect(factsOf(db, closed)).toMatchObject({
      status: "closed",
      severity: "p2",
      closedAtMs: T + 60_000,
      closedAtBasis: "provider",
    });
    db.close();
  });

  test("Sentry: level, resolved and ignored are closed, the close time is observed", () => {
    const db = createMemoryIndexDb();
    const a = writeSentryIssue(db, { id: "S1", level: "fatal", firstSeenMs: T });
    const b = writeSentryIssue(db, {
      id: "S2",
      level: "error",
      status: "resolved",
      firstSeenMs: T,
    });
    const c = writeSentryIssue(db, {
      id: "S3",
      level: "warning",
      status: "ignored",
      firstSeenMs: T,
    });
    expect(factsOf(db, a)).toMatchObject({
      status: "open",
      severity: "fatal",
      openedAtMs: T,
      openedAtBasis: "provider",
      closedAtBasis: "none",
    });
    expect(factsOf(db, b)).toMatchObject({
      status: "closed",
      closedAtMs: null,
      closedAtBasis: "observed",
    });
    expect(factsOf(db, c).status).toBe("closed");
    db.close();
  });

  test.each([
    ["SEV-1", "sev1"],
    ["sev_1", "sev1"],
    ["Sev 1", "sev1"],
    ["High", "high"],
    ["SEV1", "sev1"],
  ])("Monte Carlo severity %s normalises to %s", (raw, label) => {
    const db = createMemoryIndexDb();
    const id = writeMonteCarloIncident(db, { id: "M1", severity: raw, firstSeenMs: T });
    expect(factsOf(db, id)).toMatchObject({
      severity: label,
      severityRaw: raw,
      status: "open",
      openedAtMs: T,
      openedAtBasis: "provider",
    });
    db.close();
  });

  test("Monte Carlo: resolved and closed are closed; any other word reads open", () => {
    const db = createMemoryIndexDb();
    for (const [status, expected] of [
      ["resolved", "closed"],
      ["CLOSED", "closed"],
      ["investigating", "open"],
    ] as const) {
      const id = writeMonteCarloIncident(db, {
        id: `M-${status}`,
        status,
        severity: "high",
        firstSeenMs: T,
      });
      expect(factsOf(db, id).status).toBe(expected);
    }
    db.close();
  });

  test("Bigeye: unknown status, no severity, no open time, slaStatus lower-cased", () => {
    const db = createMemoryIndexDb();
    const id = writeBigeyeIssue(db, { id: "B1", slaStatus: "BREACHED", syncedAtMs: T });
    expect(factsOf(db, id)).toMatchObject({
      status: "unknown",
      severity: null,
      openedAtMs: null,
      openedAtBasis: "none",
      slaStatus: "breached",
    });
    db.close();
  });

  test("malformed or non-object metadata returns empty facts without throwing", () => {
    for (const metadata of [null, "", "{nope", "[1]", "3", '"x"']) {
      const f = triggerFacts({ service: "pagerduty", metadata });
      expect(f.metadataValid).toBe(false);
      expect(f.status).toBe("unknown");
      expect(f.severity).toBeNull();
    }
  });

  test("a writer that renames a key the facts read fails this pin", () => {
    const db = createMemoryIndexDb();
    const pd = rowOf(
      db,
      writePagerdutyIncident(db, {
        id: "P",
        openedAtMs: T,
        priority: "P1",
        status: "resolved",
        resolvedAtMs: T,
      }),
    );
    const keys = (r: Row) => Object.keys(JSON.parse(r.metadata ?? "{}") as object);
    for (const k of ["status", "severity", "opened_at_ms", "resolved_at_ms"])
      expect(keys(pd)).toContain(k);
    const jsm = rowOf(
      db,
      writeJsmAlert(db, {
        id: "J",
        openedAtMs: T,
        priority: "P1",
        status: "closed",
        closeTimeMs: 1,
      }),
    );
    for (const k of ["status", "priority", "opened_at_ms", "closed_at_ms"])
      expect(keys(jsm)).toContain(k);
    const sn = rowOf(db, writeSentryIssue(db, { id: "S", level: "fatal", firstSeenMs: T }));
    for (const k of ["status", "level", "firstSeen"]) expect(keys(sn)).toContain(k);
    const mc = rowOf(
      db,
      writeMonteCarloIncident(db, { id: "M", severity: "high", firstSeenMs: T }),
    );
    for (const k of ["status", "severity", "firstSeenAt"]) expect(keys(mc)).toContain(k);
    const be = rowOf(db, writeBigeyeIssue(db, { id: "B", slaStatus: "ok", syncedAtMs: T }));
    expect(keys(be)).toContain("slaStatus");
    db.close();
  });
});

describe("qualifies", () => {
  test("per-source defaults", () => {
    const db = createMemoryIndexDb();
    const cases: [string, boolean][] = [
      [writePagerdutyIncident(db, { id: "q1", openedAtMs: T, priority: "P1" }), true],
      [writePagerdutyIncident(db, { id: "q2", openedAtMs: T, priority: "P2" }), false],
      [writeJsmAlert(db, { id: "q3", openedAtMs: T, priority: "P1" }), true],
      [writeJsmAlert(db, { id: "q4", openedAtMs: T, priority: "P3" }), false],
      [writeSentryIssue(db, { id: "q5", level: "fatal", firstSeenMs: T }), true],
      [writeSentryIssue(db, { id: "q6", level: "error", firstSeenMs: T }), false],
      [writeMonteCarloIncident(db, { id: "q7", severity: "SEV-1", firstSeenMs: T }), true],
      [writeMonteCarloIncident(db, { id: "q8", severity: "High", firstSeenMs: T }), true],
      [writeMonteCarloIncident(db, { id: "q9", severity: "low", firstSeenMs: T }), false],
      [writeBigeyeIssue(db, { id: "q10", slaStatus: "breached", syncedAtMs: T }), false],
    ];
    for (const [id, want] of cases) {
      const r = rowOf(db, id);
      const svc = r.service as TriggerService;
      expect(qualifies(svc, triggerFacts({ service: svc, metadata: r.metadata }), NONE), id).toBe(
        want,
      );
    }
    db.close();
  });

  test("a non-empty severities list REPLACES the defaults; PagerDuty aliases add to the default only", () => {
    expect(qualifyingLabels("pagerduty", NONE)).toEqual(["p1"]);
    expect(
      qualifyingLabels("pagerduty", { ...NONE, pagerdutyP1Aliases: ["Sev1", "critical"] }),
    ).toEqual(["p1", "sev1", "critical"]);
    const replaced = { ...NONE, severities: ["p2"], pagerdutyP1Aliases: ["sev1"] };
    expect(qualifyingLabels("pagerduty", replaced)).toEqual(["p2"]);
    expect(qualifyingLabels("sentry", replaced)).toEqual(["p2"]);
    expect(qualifyingLabels("montecarlo", { ...NONE, severities: ["SEV-2"] })).toEqual(["sev2"]);
    expect(qualifyingLabels("bigeye", replaced)).toEqual([]);
  });

  test("Bigeye qualifies only through bigeye_sla_statuses", () => {
    const db = createMemoryIndexDb();
    const id = writeBigeyeIssue(db, { id: "b", slaStatus: "Breached", syncedAtMs: T });
    const r = rowOf(db, id);
    const f = triggerFacts({ service: "bigeye", metadata: r.metadata });
    expect(qualifies("bigeye", f, NONE)).toBe(false);
    expect(qualifies("bigeye", f, { ...NONE, bigeyeSlaStatuses: ["breached"] })).toBe(true);
    expect(qualifies("bigeye", f, { ...NONE, bigeyeSlaStatuses: ["ok"] })).toBe(false);
    db.close();
  });

  test("is status-blind: a closed item with a qualifying severity qualifies", () => {
    const db = createMemoryIndexDb();
    const id = writePagerdutyIncident(db, {
      id: "c",
      openedAtMs: T,
      status: "resolved",
      resolvedAtMs: T + 1,
      priority: "P1",
    });
    const r = rowOf(db, id);
    const f = triggerFacts({ service: "pagerduty", metadata: r.metadata });
    expect(f.status).toBe("closed");
    expect(qualifies("pagerduty", f, NONE)).toBe(true);
    db.close();
  });
});

describe("qualifiesSql parity with qualifies", () => {
  const CONFIGS: TriggerConfig[] = [
    NONE,
    { ...NONE, pagerdutyP1Aliases: ["SEV1"] },
    { ...NONE, severities: ["p2", "sev-1", "FATAL", "high"] },
    { ...NONE, bigeyeSlaStatuses: ["Breached", "warn"] },
    { ...NONE, severities: ["it's", "100%", "a_b"] },
  ];

  test("every source, every spelling, malformed metadata: SQL and code agree", () => {
    const db = createMemoryIndexDb();
    let n = 0;
    const id = () => {
      n += 1;
      return `x${String(n)}`;
    };
    for (const p of [
      "P1",
      "p1",
      "P2",
      "SEV1",
      "sev-1",
      " P1 ",
      "it's",
      "100%",
      "a_b",
      "critical",
    ]) {
      writePagerdutyIncident(db, { id: id(), openedAtMs: T, priority: p });
      writeJsmAlert(db, { id: id(), openedAtMs: T, priority: p });
    }
    writePagerdutyIncident(db, { id: id(), openedAtMs: T }); // null severity
    for (const l of ["fatal", "FATAL", "error", "high", "p2"]) {
      writeSentryIssue(db, { id: id(), level: l, firstSeenMs: T });
    }
    for (const s of ["SEV-1", "sev_1", "High", "Sev 1", "sev1", "HIGH", "low", "sev-2", "SEV-2"]) {
      writeMonteCarloIncident(db, { id: id(), severity: s, firstSeenMs: T });
    }
    for (const s of ["Breached", "breached", "warn", "ok"]) {
      writeBigeyeIssue(db, { id: id(), slaStatus: s, syncedAtMs: T });
    }
    // malformed and non-object metadata, and a non-text severity
    db.run(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata)
       VALUES ('pagerduty:bad1','pagerduty','incident','bad1','t',1,1,'{nope'),
              ('pagerduty:bad2','pagerduty','incident','bad2','t',1,1,'[1]'),
              ('pagerduty:bad3','pagerduty','incident','bad3','t',1,1,'{"severity": 1}'),
              ('sentry:bad4','sentry','error_issue','bad4','t',1,1,NULL)`,
    );
    let compared = 0;
    for (const cfg of CONFIGS) {
      for (const service of TRIGGER_SERVICES) {
        const type = triggerTypeOf(service);
        const q = qualifiesSql(service, cfg);
        const viaSql = new Set(
          (
            db
              .query(`SELECT i.id FROM item i WHERE i.service = ? AND i.type = ? AND ${q.clause}`)
              .all(service, type, ...q.params) as { id: string }[]
          ).map((r) => r.id),
        );
        const all = db
          .query("SELECT id, service, metadata FROM item WHERE service = ? AND type = ?")
          .all(service, type) as Row[];
        for (const r of all) {
          const viaCode = qualifies(service, triggerFacts({ service, metadata: r.metadata }), cfg);
          expect(viaSql.has(r.id), `${service} ${r.id} ${JSON.stringify(cfg)}`).toBe(viaCode);
          compared += 1;
        }
      }
    }
    expect(compared).toBeGreaterThan(200);
    db.close();
  });

  test("a hostile configured label is bound data, and an empty label set matches nothing", () => {
    const q = qualifiesSql("pagerduty", { ...NONE, severities: ["x'); DROP TABLE item; --"] });
    expect(q.clause).not.toContain("DROP");
    expect(q.params).toEqual([JSON.stringify(["x'); drop table item; --"])]);
    expect(qualifiesSql("bigeye", NONE)).toEqual({ clause: "0", params: [] });
  });
});
