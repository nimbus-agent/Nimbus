import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { DEFAULT_INCIDENT_CONFIG } from "../config/incident-toml.ts";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { configMap, resolverFor, serviceConfig, T0 } from "../incident/__fixtures__/index-writers.ts";
import { writePagerdutyIncident } from "../incident/__fixtures__/trigger-writers.ts";
import { IncidentError } from "../incident/assemble.ts";
import { createIncidentEngine } from "../incident/incident-engine.ts";
import { draftIncidentUpdate } from "./update-draft.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const cfg = serviceConfig();
const resolver = resolverFor(cfg);
const NOW = T0 + 2 * 3_600_000;

/** A record with two versions: open, then acknowledged. */
async function seededTwoVersions(): Promise<{ d: Database; recordId: string }> {
  const d = createMemoryIndexDb();
  dbs.push(d);
  let clock = NOW;
  const engine = createIncidentEngine({
    db: d,
    now: () => clock,
    emit: () => {},
    loadServiceConfigs: () => configMap(cfg),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
    yieldToEventLoop: async () => {},
  });
  const item = writePagerdutyIncident(
    d,
    { id: "UP1", openedAtMs: T0, priority: "P1", title: "Checkout errors" },
    resolver,
  );
  await engine.assembleNow(item);
  clock = NOW + 600_000;
  writePagerdutyIncident(
    d,
    {
      id: "UP1",
      openedAtMs: T0,
      status: "resolved",
      updatedAtMs: T0 + 300_000,
      priority: "P1",
      title: "Checkout errors",
    },
    resolver,
  );
  await engine.assembleNow(item);
  const recordId = (d.query("SELECT id FROM incident_record").get() as { id: string }).id;
  return { d, recordId };
}

describe("draftIncidentUpdate", () => {
  test("drafts the current version by default and an older one when asked", async () => {
    const { d, recordId } = await seededTwoVersions();
    const now = draftIncidentUpdate(d, recordId, { audience: "stakeholders", nowMs: NOW });
    expect(now.version).toBe(2);
    expect(now.currentVersion).toBe(2);
    expect(now.text).toContain("Incident update: Checkout errors");
    expect(now.text).toContain("Status: Resolved");
    const v1 = draftIncidentUpdate(d, recordId, { audience: "engineers", version: 1, nowMs: NOW });
    expect(v1.version).toBe(1);
    expect(v1.text).toContain("Status: Ongoing");
    expect(v1.text).toContain(`Record: ${recordId} (version 1)`);
  });

  test("a missing record or version is a typed error", async () => {
    const { d, recordId } = await seededTwoVersions();
    expect(() =>
      draftIncidentUpdate(d, "inc_ffffffffffffffff", { audience: "stakeholders", nowMs: NOW }),
    ).toThrow(IncidentError);
    expect(() =>
      draftIncidentUpdate(d, recordId, { audience: "stakeholders", version: 9, nowMs: NOW }),
    ).toThrow(/version/);
  });

  test("a draft writes nothing", async () => {
    const { d, recordId } = await seededTwoVersions();
    const count = (t: string): number =>
      (d.query(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    const before = [count("incident_record_version"), count("audit_log"), count("egress_ledger")];
    draftIncidentUpdate(d, recordId, { audience: "engineers", nowMs: NOW });
    expect([count("incident_record_version"), count("audit_log"), count("egress_ledger")]).toEqual(
      before,
    );
  });
});
