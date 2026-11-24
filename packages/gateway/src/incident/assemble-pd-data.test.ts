import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { configMap, HOUR, resolverFor, serviceConfig, T0 } from "./__fixtures__/index-writers.ts";
import { writeJsmAlert, writePagerdutyIncident } from "./__fixtures__/trigger-writers.ts";
import { assembleOne } from "./assemble.ts";
import type { IncidentRecordV1 } from "./incident-record-types.ts";
import { getById } from "./incident-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const OPEN = T0 + HOUR / 2;
const NOW = OPEN + 10 * 60_000;

function db(): Database {
  const d = createMemoryIndexDb();
  dbs.push(d);
  return d;
}

function putModel(d: Database, key: string, resolver: ReturnType<typeof resolverFor>): void {
  upsertIndexedItem(
    d,
    {
      service: "snowflake",
      type: "data_model",
      externalId: key,
      title: key,
      bodyPreview: "",
      modifiedAt: T0,
      syncedAt: T0,
      metadata: { dataModelKey: key, derivedFromKeys: [] },
    },
    resolver,
  );
}

async function assemble(d: Database, cfgOver: Parameters<typeof serviceConfig>[0], itemId: string) {
  const cfg = serviceConfig(cfgOver);
  const r = await assembleOne({ db: d, loadServiceConfigs: () => configMap(cfg) }, itemId, NOW);
  if (r.outcome === "missing") throw new Error("missing");
  const row = getById(d, r.recordId);
  if (row === null) throw new Error("no record");
  return { markdown: row.markdown, record: JSON.parse(row.record_json) as IncidentRecordV1 };
}

describe("a PagerDuty incident of a service that declares data_models (OR-S4-DATA)", () => {
  test("renders the Data Incident Brief, with the models the globs match", async () => {
    const d = db();
    const resolver = resolverFor(serviceConfig());
    putModel(d, "analytics.payments.orders", resolver);
    putModel(d, "analytics.marketing.clicks", resolver);
    const id = writePagerdutyIncident(d, { id: "P", openedAtMs: OPEN, priority: "P1" }, resolver);
    const { markdown, record } = await assemble(d, {}, id);
    expect(markdown.startsWith("# Data incident ")).toBe(true);
    expect(markdown).toContain("## Monitored models");
    expect(record.data?.models).toEqual(["analytics.payments.orders"]);
    expect(markdown).not.toContain("analytics.marketing.clicks");
  });

  test("matching no indexed model is still the data brief, and says no table was matched", async () => {
    const d = db();
    const resolver = resolverFor(serviceConfig());
    const id = writePagerdutyIncident(d, { id: "P", openedAtMs: OPEN, priority: "P1" }, resolver);
    const { markdown, record } = await assemble(d, {}, id);
    expect(record.data?.models).toEqual([]);
    expect(markdown).toContain("_No monitored table._");
  });
});

describe("a PagerDuty incident that is not a data incident", () => {
  test("a bound service with no data_models keeps the general brief and no data lane", async () => {
    const d = db();
    const cfg = serviceConfig({ dataModels: [] });
    const resolver = resolverFor(cfg);
    putModel(d, "analytics.payments.orders", resolver);
    const id = writePagerdutyIncident(d, { id: "P", openedAtMs: OPEN, priority: "P1" }, resolver);
    const { markdown, record } = await assemble(d, { dataModels: [] }, id);
    expect(markdown.startsWith("# Incident ")).toBe(true);
    expect(record.data).toBeNull();
  });

  test("an unbound incident keeps the general brief", async () => {
    const d = db();
    const resolver = resolverFor(serviceConfig());
    putModel(d, "analytics.payments.orders", resolver);
    const id = writePagerdutyIncident(
      d,
      { id: "P", openedAtMs: OPEN, priority: "P1", pagerdutyServiceId: "UNBOUND" },
      resolver,
    );
    const { markdown, record } = await assemble(d, {}, id);
    expect(record.trigger.service).toBe("pagerduty");
    expect(record.binding.bound).toBe(false);
    expect(markdown.startsWith("# Incident ")).toBe(true);
    expect(record.data).toBeNull();
  });

  test("a JSM alert of a data_models service is not made a data incident by this rule", async () => {
    const d = db();
    const resolver = resolverFor(serviceConfig());
    putModel(d, "analytics.payments.orders", resolver);
    const id = writeJsmAlert(
      d,
      { id: "J", openedAtMs: OPEN, priority: "P1", tags: ["payments"] },
      resolver,
    );
    const { record } = await assemble(d, {}, id);
    expect(record.data).toBeNull();
  });
});
