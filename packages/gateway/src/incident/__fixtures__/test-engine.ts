import type { Database } from "bun:sqlite";

import { DEFAULT_INCIDENT_CONFIG } from "../../config/incident-toml.ts";
import { loadServiceConfigsOrEmpty } from "../../config/service-configs.ts";
import { createIncidentEngine, type IncidentEngine } from "../incident-engine.ts";

/**
 * A real incident engine over `db`, reading its service configs from `configDir`'s nimbus.toml (as the
 * gateway does). For tests of the on-call push, which pushes the record the engine assembles.
 */
export function engineForConfigDir(
  db: Database,
  configDir: string,
  now: () => number = Date.now,
): IncidentEngine {
  return createIncidentEngine({
    db,
    now,
    emit: () => {},
    loadServiceConfigs: () =>
      new Map(loadServiceConfigsOrEmpty(configDir, () => {}).map((c) => [c.serviceId, c])),
    readConfig: () => ({ incident: DEFAULT_INCIDENT_CONFIG, pagerdutyP1Aliases: [] }),
    demo: false,
    logger: { warn: () => {} },
  });
}
