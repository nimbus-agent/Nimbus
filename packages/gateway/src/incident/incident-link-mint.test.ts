import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import { isIncidentLink } from "../engine/incident-link.ts";
import { configMap, resolverFor, serviceConfig, T0 } from "./__fixtures__/index-writers.ts";
import { writePagerdutyIncident } from "./__fixtures__/trigger-writers.ts";
import { DEFAULT_INCIDENT_CONFIG } from "../config/incident-toml.ts";
import { createIncidentEngine } from "./incident-engine.ts";
import { mintIncidentLink } from "./incident-link-mint.ts";

const dbs: Database[] = [];
afterEach(() => {
  for (const d of dbs.splice(0)) d.close();
});

describe("mintIncidentLink (IC4 2.2)", () => {
  test("reads the CURRENT version, returns a fresh frozen link, and refuses an unknown record", async () => {
    const d = createMemoryIndexDb();
    dbs.push(d);
    const cfg = serviceConfig();
    const item = writePagerdutyIncident(
      d,
      { id: "M1", openedAtMs: T0, priority: "P1" },
      resolverFor(cfg),
    );
    const engine = createIncidentEngine({
      db: d,
      now: () => T0 + 60_000,
      emit: () => {},
      loadServiceConfigs: () => configMap(cfg),
      readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
      demo: false,
      logger: { warn: () => {} },
      yieldToEventLoop: async () => {},
    });
    await engine.assembleNow(item);
    const id = (d.query("SELECT id FROM incident_record").get() as { id: string }).id;
    const one = mintIncidentLink(d, id);
    expect(one).toEqual({ id, version: 1 });
    expect(Object.isFrozen(one)).toBe(true);
    expect(isIncidentLink(one)).toBe(true);
    d.run("UPDATE incident_record SET version = 4 WHERE id = ?", [id]);
    const two = mintIncidentLink(d, id);
    expect(two.version).toBe(4);
    expect(two).not.toBe(one);
    expect(() => mintIncidentLink(d, "inc_ffffffffffffffff")).toThrow(/ERR_INCIDENT_NOT_FOUND|no incident/);
    try {
      mintIncidentLink(d, "inc_ffffffffffffffff");
    } catch (e) {
      expect((e as { code?: string }).code).toBe("ERR_INCIDENT_NOT_FOUND");
    }
  });
});
