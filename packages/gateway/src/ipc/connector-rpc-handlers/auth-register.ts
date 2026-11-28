import type { ConnectorServiceId } from "../../connectors/connector-catalog.ts";
import { defaultSyncIntervalMsForService } from "../../connectors/connector-catalog.ts";
import type { LocalIndex } from "../../index/local-index.ts";

/** Companion cost syncs registered with their connector's credentials (each idle until its `[cost.*]` table exists). */
const COST_COMPANIONS: Partial<Record<ConnectorServiceId, ConnectorServiceId>> = {
  // Phase 7 slice 10: the Jenkins build-minutes cost sync.
  jenkins: "jenkins_billing",
};

/** Registers a connector with the scheduler, and its cost companion (first) when it has one. */
export function registerConnectorWithCompanions(
  localIndex: LocalIndex,
  id: ConnectorServiceId,
): void {
  for (const service of [COST_COMPANIONS[id], id]) {
    if (service === undefined) continue;
    localIndex.ensureConnectorSchedulerRegistration(
      service,
      defaultSyncIntervalMsForService(service),
      Date.now(),
    );
  }
}
