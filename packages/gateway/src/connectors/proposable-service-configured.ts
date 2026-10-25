import { isConnectorConfigured } from "../sync/connector-configured.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { MESH_ONLY_SERVER_IDS } from "./lazy-mesh/tool-map.ts";
import { USER_MCP_SERVICE_ID_PATTERN } from "./user-mcp-store.ts";

type MeshOnlyServerId = (typeof MESH_ONLY_SERVER_IDS)[number];

const MESH_ONLY: ReadonlySet<string> = new Set(MESH_ONLY_SERVER_IDS);

/**
 * Whether the act door (I28) may advertise, queue and accept an action on `service`: a registered
 * user MCP server, a mesh-only server when it can spawn, or a catalog connector by its Vault keys.
 * A mesh-only server has no Vault keys, so the manifest check would answer it TRUE vacuously; each
 * one needs its own check, and `meshOnly` is total over `MESH_ONLY_SERVER_IDS` so a new one is a
 * compile error rather than a vacuous yes.
 */
export function createProposableServiceConfigured(deps: {
  readonly vault: NimbusVault;
  readonly isUserMcpRegistered: (serviceId: string) => boolean;
  readonly meshOnly: { readonly [K in MeshOnlyServerId]: () => boolean };
}): (service: string) => Promise<boolean> {
  return async (service) => {
    if (USER_MCP_SERVICE_ID_PATTERN.test(service)) return deps.isUserMcpRegistered(service);
    if (MESH_ONLY.has(service)) return deps.meshOnly[service as MeshOnlyServerId]();
    return isConnectorConfigured(deps.vault, service);
  };
}
