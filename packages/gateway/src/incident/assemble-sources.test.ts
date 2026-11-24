import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { configMap, HOUR, resolverFor, serviceConfig, T0 } from "./__fixtures__/index-writers.ts";
import {
  writeBigeyeIssue,
  writeJsmAlert,
  writeMonteCarloIncident,
  writePagerdutyIncident,
  writeSentryIssue,
} from "./__fixtures__/trigger-writers.ts";
import { assembleOne } from "./assemble.ts";
import type { IncidentRecordV1 } from "./incident-record-types.ts";
import { getById } from "./incident-store.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

const OPEN = T0 + HOUR / 2;
const NOW = OPEN + 10 * 60_000;
// The Monte Carlo and Bigeye triggers bind through `data_models`, so this file binds a service that declares them
// (and its PagerDuty incident is then a data incident, by OR-S4-DATA).
const dataCfg = serviceConfig();
const dataResolver = resolverFor(dataCfg);

function stored(d: Database, id: string): IncidentRecordV1 {
  const row = getById(d, id);
  if (row === null) throw new Error("record missing");
  return JSON.parse(row.record_json) as IncidentRecordV1;
}

async function assemble(d: Database, itemId: string) {
  const r = await assembleOne({ db: d, loadServiceConfigs: () => configMap(dataCfg) }, itemId, NOW);
  if (r.outcome === "missing") throw new Error("missing");
  return r;
}

describe("assembleOne, every source", () => {
  test("every source assembles from its real writer; Bigeye has unknown status and no open time", async () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    const ids = [
      writePagerdutyIncident(d, { id: "P", openedAtMs: OPEN, priority: "P1" }, dataResolver),
      writeJsmAlert(
        d,
        { id: "J", openedAtMs: OPEN, priority: "P1", tags: ["payments"] },
        dataResolver,
      ),
      writeSentryIssue(d, { id: "S", level: "fatal", firstSeenMs: OPEN }, dataResolver),
      writeMonteCarloIncident(d, { id: "M", severity: "SEV-1", firstSeenMs: OPEN }, dataResolver),
      writeBigeyeIssue(d, { id: "B", slaStatus: "breached", syncedAtMs: OPEN }, dataResolver),
    ];
    for (const id of ids) {
      const r = await assemble(d, id);
      expect(r.outcome).toBe("created");
    }
    const bigeye = stored(d, (await assemble(d, ids[4] as string)).recordId);
    expect(bigeye.trigger).toMatchObject({
      status: "unknown",
      severity: null,
      slaStatus: "breached",
    });
    expect(bigeye.trigger.opened).toEqual({ ms: null, basis: "none" });
    expect(bigeye.change.skipped).toBe("no_open_time");
    expect(bigeye.concurrent.skipped).toBe("no_open_time");
    expect(bigeye.data?.models).toEqual(["analytics.payments.orders"]);
    expect(bigeye.gaps.some((g) => g.detail.includes("no open time"))).toBe(true);
    const mc = stored(d, (await assemble(d, ids[3] as string)).recordId);
    expect(mc.data).not.toBeNull();
    expect(mc.trigger.severity).toBe("sev1");
    const jsm = stored(d, (await assemble(d, ids[1] as string)).recordId);
    expect(jsm.data).toBeNull();
    expect(jsm.binding.via).toBe("jsm_alert_tag");
  });
});
