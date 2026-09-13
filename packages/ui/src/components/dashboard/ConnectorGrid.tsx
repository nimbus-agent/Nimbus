import { invoke } from "@tauri-apps/api/core";
import { type ReactNode, useCallback, useEffect } from "react";
import { Link } from "react-router";
import { useIpcQuery } from "../../hooks/useIpcQuery";
import { useIpcSubscription } from "../../hooks/useIpcSubscription";
import type { ConnectorHealth, ConnectorStatus } from "../../ipc/types";
import { useNimbusStore } from "../../store";
import { ConnectorTile } from "./ConnectorTile";

interface HealthChangedPayload {
  readonly name: string;
  readonly health: ConnectorStatus["health"];
  readonly degradationReason?: string;
}

// The dashboard's own health vocabulary — the six states `ConnectorTile`'s `dotColour` knows how
// to render. `connector.listStatus` reports the gateway's wider `ConnectorHealthState`, which also
// has `not_configured` (`packages/gateway/src/connectors/health.ts`); a raw `healthState` string is
// checked against this allow-list before it is trusted as a `ConnectorHealth`.
const KNOWN_CONNECTOR_HEALTH: ReadonlySet<string> = new Set<ConnectorHealth>([
  "healthy",
  "degraded",
  "error",
  "rate_limited",
  "unauthenticated",
  "paused",
]);

function toConnectorHealth(healthState: unknown): ConnectorHealth {
  // `healthState` is optional on the wire (`SyncStatus.healthState?: string`, gateway
  // `sync/types.ts`) — absent for a connector `getConnectorHealth` has never classified yet — and
  // can carry `"not_configured"`, which this dashboard has no tile state for. Both fall back to
  // "healthy": a connector nothing has flagged should not render as degraded/error before
  // anything has happened to earn that badge.
  return typeof healthState === "string" && KNOWN_CONNECTOR_HEALTH.has(healthState)
    ? (healthState as ConnectorHealth)
    : "healthy";
}

const KNOWN_DEPTHS: ReadonlySet<string> = new Set(["metadata_only", "summary", "full"]);

/**
 * `connector.listStatus` returns the gateway's `SyncStatus` (`packages/gateway/src/sync/types.ts`)
 * — `{ serviceId, healthState, lastError, itemCount, intervalMs, depth, enabled, ... }` — not this
 * package's `ConnectorStatus` (`{ name, health, ... }`). The old code asserted the RPC result WAS a
 * `ConnectorStatus[]` via the `useIpcQuery` generic and handed it straight to `setConnectors`,
 * which left every row's `name`/`health` `undefined` and made `patchConnector`'s `x.name === name`
 * match nothing. Map field-by-field instead, and drop a row with no string `serviceId` rather than
 * producing a tile with no name.
 */
function toConnectorStatuses(raw: unknown): ConnectorStatus[] {
  if (!Array.isArray(raw)) return [];
  const out: ConnectorStatus[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec["serviceId"] !== "string") continue;
    const status: ConnectorStatus = {
      name: rec["serviceId"],
      health: toConnectorHealth(rec["healthState"]),
    };
    if (typeof rec["lastError"] === "string") status.lastError = rec["lastError"];
    if (typeof rec["itemCount"] === "number") status.itemCount = rec["itemCount"];
    if (typeof rec["intervalMs"] === "number") status.intervalMs = rec["intervalMs"];
    if (typeof rec["depth"] === "string" && KNOWN_DEPTHS.has(rec["depth"])) {
      status.depth = rec["depth"] as "metadata_only" | "summary" | "full";
    }
    if (typeof rec["enabled"] === "boolean") status.enabled = rec["enabled"];
    out.push(status);
  }
  return out;
}

export function ConnectorGrid(): ReactNode {
  const setConnectors = useNimbusStore((s) => s.setConnectors);
  const patchConnector = useNimbusStore((s) => s.patchConnector);
  const connectors = useNimbusStore((s) => s.connectors);
  const highlight = useNimbusStore((s) => s.highlightConnector);
  const recomputeAggregate = useNimbusStore((s) => s.recomputeAggregate);
  const setConnectorsMenu = useNimbusStore((s) => s.setConnectorsMenu);

  const { data } = useIpcQuery<unknown>("connector.listStatus", 30_000);
  useEffect(() => {
    if (data !== null) setConnectors(toConnectorStatuses(data));
  }, [data, setConnectors]);

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
