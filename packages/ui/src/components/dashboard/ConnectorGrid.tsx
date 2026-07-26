import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useCallback, useEffect } from "react";
import { Link } from "react-router";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { useIpcSubscription } from "../../hooks/useIpcSubscription";
import type { ConnectorStatus } from "../../ipc/types";
import { useNimbusStore } from "../../store";
import { ConnectorTile } from "./ConnectorTile";

interface HealthChangedPayload {
  readonly name: string;
  readonly health: ConnectorStatus["health"];
  readonly degradationReason?: string;
}

export function ConnectorGrid(): ReactNode {
  const setConnectors = useNimbusStore((s) => s.setConnectors);
  const patchConnector = useNimbusStore((s) => s.patchConnector);
  const connectors = useNimbusStore((s) => s.connectors);
  const highlight = useNimbusStore((s) => s.highlightConnector);
  const recomputeAggregate = useNimbusStore((s) => s.recomputeAggregate);
  const setConnectorsMenu = useNimbusStore((s) => s.setConnectorsMenu);

  const { data } = useIpcQuery<ConnectorStatus[]>("connector.listStatus", 30_000);
  useEffect(() => {
    if (data && data !== connectors) setConnectors(data);
  }, [data, connectors, setConnectors]);

  useEffect(() => {
    recomputeAggregate(connectors);
    const items = connectors.map((c) => ({ name: c.name, health: c.health }));
    setConnectorsMenu(items);
    invoke("set_connectors_menu", { items }).catch(() => undefined);
  }, [connectors, recomputeAggregate, setConnectorsMenu]);

  const onHealth = useCallback(
    (payload: HealthChangedPayload) => {
      const patch: Partial<ConnectorStatus> = { health: payload.health };
      if (payload.degradationReason !== undefined) {
        patch.degradationReason = payload.degradationReason;
      }
      patchConnector(payload.name, patch);
    },
    [patchConnector],
  );
  useIpcSubscription<HealthChangedPayload>("connector://health-changed", onHealth);

  if (connectors.length === 0) {
    return (
      <section aria-label="Connectors" className="text-[var(--color-fg-muted)] text-sm">
        No connectors configured.{" "}
        <Link to="/onboarding" className="underline">
          Open onboarding
        </Link>
        .
      </section>
    );
  }

  return (
    <section
      aria-label="Connectors"
      className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3"
    >
      {connectors.map((c) => (
        <ConnectorTile key={c.name} status={c} highlighted={c.name === highlight} />
      ))}
    </section>
  );
}
