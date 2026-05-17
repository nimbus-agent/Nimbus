import type { MCPClient } from "@mastra/mcp";

import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { LazyDrainTracker } from "./drain.ts";

export type LazyMcpSlot = {
  client: MCPClient | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  /** S8-F7 — per-slot in-flight refcount. */
  drain: LazyDrainTracker;
};

export type ServerSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

/** Minimal logger shape — accepts the pino `(bindings, msg)` form. */
export interface MeshLogger {
  warn(bindings: Record<string, unknown>, msg?: string): void;
}

/**
 * Internal collaborator interface — wraps the slot state-machine on
 * `LazyConnectorMesh` so per-connector spawn functions can live in sibling
 * files without `this.` access. Not exported from `index.ts`.
 *
 * `logger` and `healthDb` are optional and used only by `recordArgsJsonFailure`
 * in `user-mcp.ts`.
 */
export interface MeshSpawnContext {
  readonly vault: NimbusVault;
  readonly logger?: MeshLogger | undefined;
  readonly healthDb?: import("bun:sqlite").Database | undefined;
  /**
   * Absolute paths of `[[filesystem.roots]]` discovered at gateway boot.
   * Used by `ensureObsidianMcp` to seed the obsidian MCP child via
   * `OBSIDIAN_VAULT_PATHS_JSON`. Empty/undefined → obsidian MCP not started.
   */
  readonly obsidianVaultPaths?: readonly string[] | undefined;
  /**
   * Sandbox cwd for first-party connectors (T2 PR 1 / `I15`). Each MCP
   * child is sandboxed with this directory as its working directory and
   * always-on read/write access. Threaded from `paths.dataDir` so the
   * connector can read/write its own scratch state within the user's
   * data directory.
   */
  readonly sandboxCwd: string;
  clearLazyIdle(key: string): void;
  getLazyClient(key: string): MCPClient | undefined;
  setLazyClient(key: string, client: MCPClient): void;
  bumpToolsEpoch(): void;
  scheduleLazyDisconnect(key: string): void;
}
