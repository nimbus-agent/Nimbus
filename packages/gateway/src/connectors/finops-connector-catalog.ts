// The FinOps connectors' share of the connector catalog (Phase 10): their ids, sync interval and
// credential hint in one place, spread into `connector-catalog.ts`. Pure data with no import from the
// catalog, so there is no cycle.

/** Cost sources: Vantage (FO2) and the two Kubernetes allocation services (OR-S4-FINOPS). */
export const FINOPS_CONNECTOR_IDS = ["vantage", "opencost", "kubecost"] as const;

/** Six hours, in milliseconds (the catalog's own slow-sync interval too). */
export const HOUR6 = 6 * 60 * 60 * 1000;

/** Every FinOps sync runs every six hours. */
export const FINOPS_SYNC_INTERVAL_MS = {
  vantage: HOUR6,
  opencost: HOUR6,
  kubecost: HOUR6,
} as const;

export const FINOPS_CREDENTIAL_HINTS = {
  vantage: "uses a Vantage API token (Read scope is enough)",
  opencost: "uses the URL of your OpenCost service (an optional bearer token for an ingress)",
  kubecost: "uses the URL of your Kubecost service (an optional bearer token for an ingress)",
} as const;
