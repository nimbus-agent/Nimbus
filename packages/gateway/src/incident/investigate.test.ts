import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_INCIDENT_CONFIG } from "../config/incident-toml.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import {
  configMap,
  HOUR,
  markSynced,
  resolverFor,
  serviceConfig,
  T0,
  writeDeployment,
} from "./__fixtures__/index-writers.ts";
import { writePagerdutyIncident, writeSentryIssue } from "./__fixtures__/trigger-writers.ts";
import { createIncidentEngine } from "./incident-engine.ts";
import {
  INVESTIGATE_LEAD_CAP,
  INVESTIGATE_ROW_CAP,
  INVESTIGATE_SENTRY_SCAN_CAP,
  investigateRecord,
} from "./investigate.ts";

const dbs: Database[] = [];
const origFetch = globalThis.fetch;
beforeEach(() => {
  globalThis.fetch = (() => {
    throw new Error("investigate must never make a network call");
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = origFetch;
  for (const d of dbs.splice(0)) d.close();
});

const cfg = serviceConfig();
const configs = configMap(cfg);
const resolver = resolverFor(cfg);
const NOW = T0 + 3 * HOUR;

function engineFor(d: Database) {
  return createIncidentEngine({
    db: d,
    now: () => NOW,
    emit: () => {},
    loadServiceConfigs: () => configs,
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
    yieldToEventLoop: async () => {},
  });
}

async function seed(
  over: { deploy?: boolean; pagerdutyServiceId?: string } = {},
): Promise<{ d: Database; recordId: string }> {
  const d = createMemoryIndexDb();
  dbs.push(d);
  if (over.deploy !== false) writeDeployment(d, resolver, { startedAtMs: T0 - 20 * 60_000 });
  const item = writePagerdutyIncident(
    d,
    {
      id: "INV1",
      openedAtMs: T0,
      priority: "P1",
      ...(over.pagerdutyServiceId === undefined
        ? {}
        : { pagerdutyServiceId: over.pagerdutyServiceId }),
    },
    resolver,
  );
  await engineFor(d).assembleNow(item);
  const recordId = (d.query("SELECT id FROM incident_record").get() as { id: string }).id;
  return { d, recordId };
}

const run = (d: Database, recordId: string, c: typeof configs | null = configs) =>
  investigateRecord(d, { recordId, nowMs: NOW, serviceConfigs: c });

describe("investigateRecord", () => {
  test("returns null for an id that names no record", async () => {
    const { d } = await seed();
    expect(run(d, "inc_0000000000000000")).toBeNull();
  });

  test("lists the Sentry issues of the service's projects active in the window, newest first, other projects excluded", async () => {
    const { d, recordId } = await seed();
    writeSentryIssue(d, { id: "S1", firstSeenMs: T0 - 2 * HOUR, lastSeenMs: T0 + HOUR });
    writeSentryIssue(d, { id: "S2", firstSeenMs: T0 - HOUR, lastSeenMs: T0 + 2 * HOUR });
    writeSentryIssue(d, {
      id: "OTHER",
      firstSeenMs: T0,
      lastSeenMs: T0 + HOUR,
      project: "billing-web",
    });
    writeSentryIssue(d, { id: "OLD", firstSeenMs: T0 - 40 * HOUR, lastSeenMs: T0 - 30 * HOUR });
    const inv = run(d, recordId);
    expect(inv?.sentry.status).toBe("ok");
    expect(inv?.sentry.projects).toEqual(["payments-api"]);
    expect(inv?.sentry.rows.map((r) => r.itemId)).toEqual(["sentry:S2", "sentry:S1"]);
    expect(inv?.sentry.total).toBe(2);
  });

  test("the window runs from six hours before the open to now, edges inclusive", async () => {
    const { d, recordId } = await seed();
    writeSentryIssue(d, { id: "AT_FROM", firstSeenMs: T0 - 7 * HOUR, lastSeenMs: T0 - 6 * HOUR });
    writeSentryIssue(d, {
      id: "BEFORE",
      firstSeenMs: T0 - 7 * HOUR,
      lastSeenMs: T0 - 6 * HOUR - 1,
    });
    writeSentryIssue(d, { id: "AT_TO", firstSeenMs: T0, lastSeenMs: NOW });
    const inv = run(d, recordId);
    expect(inv?.span).toEqual({ fromMs: T0 - 6 * HOUR, toMs: NOW });
    expect(inv?.sentry.rows.map((r) => r.itemId).sort()).toEqual([
      "sentry:AT_FROM",
      "sentry:AT_TO",
    ]);
  });

  test("an issue first seen at or after the deployment start is marked, one a millisecond earlier is not", async () => {
    const { d, recordId } = await seed();
    const deployStart = T0 - 20 * 60_000;
    writeSentryIssue(d, { id: "ON", firstSeenMs: deployStart, lastSeenMs: T0 });
    writeSentryIssue(d, { id: "OFF", firstSeenMs: deployStart - 1000, lastSeenMs: T0 });
    const inv = run(d, recordId);
    const by = new Map(inv?.sentry.rows.map((r) => [r.itemId, r.newSinceDeploy]));
    expect(by.get("sentry:ON")).toBe(true);
    expect(by.get("sentry:OFF")).toBe(false);
  });

  test("leads: the deployment first, then marked issues, capped", async () => {
    const { d, recordId } = await seed();
    for (let i = 0; i < INVESTIGATE_LEAD_CAP + 5; i += 1) {
      writeSentryIssue(d, { id: `N${String(i)}`, firstSeenMs: T0, lastSeenMs: T0 + i });
    }
    const inv = run(d, recordId);
    expect(inv?.leads).toHaveLength(INVESTIGATE_LEAD_CAP);
    expect(inv?.leads[0]?.kind).toBe("deployment");
    expect(inv?.leads[0]?.text).toContain("timing only, not a proven cause");
    expect(inv?.leads.slice(1).every((l) => l.kind === "sentry_issue")).toBe(true);
  });

  test("without a deployment there is no deployment lead and nothing is marked new", async () => {
    const { d, recordId } = await seed({ deploy: false });
    writeSentryIssue(d, { id: "S1", firstSeenMs: T0, lastSeenMs: T0 + 1 });
    const inv = run(d, recordId);
    expect(inv?.leads).toEqual([]);
    expect(inv?.sentry.rows[0]?.newSinceDeploy).toBe(false);
  });

  test("rows are capped at the spec's 100 with the true total, and the scan cap is stated", async () => {
    const { d, recordId } = await seed();
    d.run("BEGIN");
    for (let i = 0; i < INVESTIGATE_ROW_CAP + 3; i += 1) {
      writeSentryIssue(d, { id: `C${String(i)}`, firstSeenMs: T0, lastSeenMs: T0 + i });
    }
    d.run("COMMIT");
    const inv = run(d, recordId);
    expect(inv?.sentry.rows).toHaveLength(INVESTIGATE_ROW_CAP);
    expect(inv?.sentry.total).toBe(INVESTIGATE_ROW_CAP + 3);
    expect(inv?.gaps.map((g) => g.code)).toContain("sentry_rows_capped");
    expect(INVESTIGATE_SENTRY_SCAN_CAP).toBeGreaterThan(INVESTIGATE_ROW_CAP);
  });

  test("an unbound record lists no Sentry issue and says why", async () => {
    const { d, recordId } = await seed({ pagerdutyServiceId: "UNKNOWN" });
    writeSentryIssue(d, { id: "S1", firstSeenMs: T0, lastSeenMs: T0 + 1 });
    const inv = run(d, recordId);
    expect(inv?.binding.bound).toBe(false);
    expect(inv?.sentry).toMatchObject({ status: "not_scoped", total: 0 });
    expect(inv?.gaps.map((g) => g.code)).toEqual(
      expect.arrayContaining(["sentry_not_scoped", "record_unbound"]),
    );
  });

  test("a bound service with no sentry_projects, or unreadable configs, lists none and says why", async () => {
    const { d, recordId } = await seed();
    writeSentryIssue(d, { id: "S1", firstSeenMs: T0, lastSeenMs: T0 + 1 });
    const bare = configMap(serviceConfig({ sentryProjects: [] }));
    expect(run(d, recordId, bare)?.sentry.status).toBe("no_projects");
    expect(run(d, recordId, null)?.sentry.status).toBe("no_config");
  });

  test("a Sentry-triggered record never lists its own trigger", async () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    const own = writeSentryIssue(
      d,
      { id: "SELF", firstSeenMs: T0 - HOUR, lastSeenMs: T0, level: "error" },
      resolver,
    );
    writeSentryIssue(d, { id: "SIB", firstSeenMs: T0 - HOUR, lastSeenMs: T0 + 1 }, resolver);
    await engineFor(d).assembleNow(own);
    const recordId = (d.query("SELECT id FROM incident_record").get() as { id: string }).id;
    const inv = run(d, recordId);
    expect(inv?.sentry.rows.map((r) => r.itemId)).toEqual(["sentry:SIB"]);
  });

  test("other open records of the same service are related and exclude the record itself", async () => {
    const { d, recordId } = await seed();
    const second = writePagerdutyIncident(
      d,
      { id: "INV2", openedAtMs: T0 + 1000, priority: "P1" },
      resolver,
    );
    await engineFor(d).assembleNow(second);
    const inv = run(d, recordId);
    expect(inv?.relatedOpen.total).toBe(1);
    expect(inv?.relatedOpen.items[0]?.title).toBe("Incident INV2");
    expect(inv?.leads.some((l) => l.kind === "open_record")).toBe(true);
  });

  test("related open records are oldest first, capped at 100 with the true total", async () => {
    const { d, recordId } = await seed();
    d.run("BEGIN");
    for (let i = 0; i < INVESTIGATE_ROW_CAP + 5; i += 1) {
      d.run(
        `INSERT INTO incident_record (id, trigger_item_id, trigger_service, trigger_type, service, title, severity,
           opened_at_ms, status, version, assembled_at_ms, checked_at_ms, record_sha256, cited_services, record_json, markdown)
         VALUES (?, ?, 'pagerduty', 'incident', 'payment-service', ?, NULL, ?, 'open', 1, 1, 1, 'h', '[]', '{}', 'm')`,
        [
          `inc_${String(i).padStart(16, "0")}`,
          `pagerduty:R${String(i)}`,
          `R${String(i)}`,
          i === 0 ? null : T0 + i,
        ],
      );
    }
    d.run("COMMIT");
    const rel = run(d, recordId)?.relatedOpen;
    expect(rel?.total).toBe(INVESTIGATE_ROW_CAP + 5);
    expect(rel?.items).toHaveLength(INVESTIGATE_ROW_CAP);
    expect(rel?.items[0]?.title).toBe("R1");
    expect(rel?.items.some((x) => x.title === "R0")).toBe(false);
    expect(rel?.items.some((x) => x.title === "R100")).toBe(true);
    expect(rel?.items.some((x) => x.title === "R101")).toBe(false);
  });

  test("actions linked by IC4 are listed from the audit rows", async () => {
    const { d, recordId } = await seed();
    d.run(
      "INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp, row_hash, prev_hash) VALUES (?,?,?,?,?,?)",
      [
        "slack.message.post",
        "approved",
        `{"incident":{"id":"${recordId}","version":1},"action":{"type":"slack.message.post"},"answerSource":"human"}`,
        T0 + 10 * 60_000,
        "h",
        "p",
      ],
    );
    const inv = run(d, recordId);
    expect(inv?.actions.map((a) => a.kind)).toEqual(["action_approved"]);
    expect(inv?.actions[0]?.atMs).toBe(T0 + 10 * 60_000);
  });

  test("the unindexed backends are gaps that say whether the connector is connected", async () => {
    const { d, recordId } = await seed();
    markSynced(d, "datadog", T0);
    const gaps = run(d, recordId)?.gaps ?? [];
    const dd = gaps.find((g) => g.code === "live_datadog");
    expect(dd?.detail).toContain("Datadog monitors are not read");
    expect(dd?.detail).toContain("the connector is connected");
    expect(gaps.find((g) => g.code === "live_grafana")?.detail).toContain("not connected");
    expect(gaps.map((g) => g.code)).toEqual(
      expect.arrayContaining(["live_newrelic", "live_cloudwatch"]),
    );
  });

  test("a read appends no egress row, makes no network call and writes nothing", async () => {
    const { d, recordId } = await seed();
    writeSentryIssue(d, { id: "S1", firstSeenMs: T0, lastSeenMs: T0 + 1 });
    const count = (t: string): number =>
      (d.query(`SELECT count(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = [count("egress_ledger"), count("audit_log"), count("incident_record")];
    const inv = run(d, recordId);
    expect(inv).not.toBeNull();
    expect([count("egress_ledger"), count("audit_log"), count("incident_record")]).toEqual(before);
  });

  test("two runs are identical", async () => {
    const { d, recordId } = await seed();
    writeSentryIssue(d, { id: "S1", firstSeenMs: T0, lastSeenMs: T0 + 1 });
    expect(JSON.stringify(run(d, recordId))).toBe(JSON.stringify(run(d, recordId)));
  });
});
