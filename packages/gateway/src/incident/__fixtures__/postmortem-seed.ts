import type { Database } from "bun:sqlite";

import { DEFAULT_INCIDENT_CONFIG } from "../../config/incident-toml.ts";
import { createMemoryIndexDb } from "../../connectors/connector-sync-test-helpers.ts";
import { createIncidentEngine } from "../incident-engine.ts";
import { configMap, resolverFor, serviceConfig, T0 } from "./index-writers.ts";
import { writePagerdutyIncident } from "./trigger-writers.ts";

const cfg = serviceConfig();
const resolver = resolverFor(cfg);

export const POSTMORTEM_NOW = T0 + 4 * 3_600_000;

export type SeededRecord = {
  readonly db: Database;
  readonly recordId: string;
  readonly itemId: string;
};

/**
 * A real in-memory index holding one assembled PagerDuty incident record, through the real writers and the
 * real engine. `resolved: false` leaves the trigger open (a post-mortem is refused for it).
 */
export async function seedPostmortemRecord(
  over: { readonly resolved?: boolean; readonly title?: string } = {},
): Promise<SeededRecord> {
  const db = createMemoryIndexDb();
  const engine = createIncidentEngine({
    db,
    now: () => POSTMORTEM_NOW,
    emit: () => {},
    loadServiceConfigs: () => configMap(cfg),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
    yieldToEventLoop: async () => {},
  });
  const title = over.title ?? "Checkout latency";
  const itemId = writePagerdutyIncident(
    db,
    { id: "PM9", title, openedAtMs: T0, priority: "P1" },
    resolver,
  );
  if (over.resolved !== false) {
    writePagerdutyIncident(
      db,
      {
        id: "PM9",
        title,
        openedAtMs: T0,
        status: "resolved",
        resolvedAtMs: T0 + 95 * 60_000,
        priority: "P1",
      },
      resolver,
    );
  }
  await engine.assembleNow(itemId);
  const recordId = (db.query("SELECT id FROM incident_record").get() as { id: string }).id;
  return { db, recordId, itemId };
}
