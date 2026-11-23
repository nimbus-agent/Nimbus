import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { configMap, HOUR, resolverFor, serviceConfig, T0 } from "./__fixtures__/index-writers.ts";
import {
  writeBigeyeIssue,
  writeJsmAlert,
  writeMonteCarloIncident,
  writePagerdutyIncident,
} from "./__fixtures__/trigger-writers.ts";
import { assembleOne } from "./assemble.ts";
import { getById } from "./incident-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const cfg = serviceConfig();
const resolver = resolverFor(cfg);
const OPEN = T0 + HOUR / 2;
const NOW = OPEN + 10 * 60_000;

function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

async function markdownOf(d: Database, itemId: string): Promise<string> {
  const r = await assembleOne({ db: d, loadServiceConfigs: () => configMap(cfg) }, itemId, NOW);
  if (r.outcome === "missing") throw new Error("missing");
  const row = getById(d, r.recordId);
  if (row === null) throw new Error("record missing");
  return row.markdown;
}

describe("the Data Incident Brief at assembly", () => {
  test("a Monte Carlo trigger is stored as the Data Incident Brief, from its real writer", async () => {
    const d = db();
    const md = await markdownOf(
      d,
      writeMonteCarloIncident(d, { id: "M", severity: "SEV-1", firstSeenMs: OPEN }, resolver),
    );
    expect(md.startsWith("# Data incident ")).toBe(true);
    expect(md).toContain("## Monitored models");
    expect(md).toContain("analytics.payments.orders");
    expect(md).toContain("## Data freshness");
  });

  test("a Bigeye trigger is the Data Incident Brief too", async () => {
    const d = db();
    const md = await markdownOf(
      d,
      writeBigeyeIssue(d, { id: "B", slaStatus: "breached", syncedAtMs: OPEN }, resolver),
    );
    expect(md.startsWith("# Data incident ")).toBe(true);
  });

  test("a PagerDuty incident and a JSM alert keep the general brief (no data lane)", async () => {
    const d = db();
    const pd = await markdownOf(
      d,
      writePagerdutyIncident(d, { id: "P", openedAtMs: OPEN, priority: "P1" }, resolver),
    );
    const jsm = await markdownOf(
      d,
      writeJsmAlert(d, { id: "J", openedAtMs: OPEN, priority: "P1", tags: ["payments"] }, resolver),
    );
    expect(pd.startsWith("# Incident ")).toBe(true);
    expect(jsm.startsWith("# Incident ")).toBe(true);
    expect(pd).not.toContain("## Monitored models");
  });
});
