import { isConnectorConfigured } from "../sync/connector-configured.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { USER_MCP_SERVICE_ID_PATTERN } from "./user-mcp-store.ts";

/**
 * Whether the act door (I28) may advertise, queue and accept an action on `service`: a registered
 * user MCP server, the obsidian mesh server when it can spawn, or a catalog connector by its Vault
 * keys. Obsidian has no Vault keys, so the manifest check would answer it TRUE vacuously; its server
 * is spawned only when `[[filesystem.roots]]` were present at boot (`startObsidianMcp`), so this reads
 * that same boot-time snapshot. Stated bound: a root holding no `.obsidian` vault still counts.
 */
export function createProposableServiceConfigured(deps: {
  readonly vault: NimbusVault;
  readonly isUserMcpRegistered: (serviceId: string) => boolean;
  /** `[[filesystem.roots]]` count in the snapshot the mesh's obsidian server spawns from. */
  readonly obsidianRootCount: number;
}): (service: string) => Promise<boolean> {
  return async (service) => {
    if (USER_MCP_SERVICE_ID_PATTERN.test(service)) return deps.isUserMcpRegistered(service);
    if (service === "obsidian") return deps.obsidianRootCount > 0;
    return isConnectorConfigured(deps.vault, service);
  };
}
