/**
 * Service ids for the LOCAL, gateway-side syncables.
 *
 * These index `[[filesystem.roots]]` content rather than a cloud service, so
 * they have no entry in the connector catalog, no vault secret, and no OAuth
 * profile — but `assemble.ts` does register each one with the sync scheduler,
 * which is what makes them addressable at all.
 *
 * Enumerated here because the id is needed in two places that must not drift:
 * the registration site (`platform/assemble.ts`) and the RPC validator
 * (`ipc/connector-rpc-shared.ts`). Before this list existed the validator
 * accepted only catalog ids and `mcp_*` user-MCP ids, so `connector.sync`
 * rejected every one of these with "Invalid serviceId" — including the
 * `nimbus connector sync filesystem` that `nimbus init` and the README both
 * tell a first-time user to run.
 *
 * Membership here does NOT by itself authorise a sync: the caller still has to
 * clear the `persistedConnectorStatuses` check, so an id that was never
 * registered on this machine is still rejected.
 */
export const GATEWAY_SYNCABLE_SERVICE_IDS = ["blame", "filesystem", "obsidian", "openapi"] as const;

export type GatewaySyncableServiceId = (typeof GATEWAY_SYNCABLE_SERVICE_IDS)[number];

export function isGatewaySyncableServiceId(id: string): id is GatewaySyncableServiceId {
  return (GATEWAY_SYNCABLE_SERVICE_IDS as readonly string[]).includes(id);
}
