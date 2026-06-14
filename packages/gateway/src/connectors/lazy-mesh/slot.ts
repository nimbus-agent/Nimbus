// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
import type { MCPClient } from "@mastra/mcp";

import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { LazyDrainTracker } from "./drain.ts";

export type LazyMcpSlot = {
  client: MCPClient | undefined;
  idleTimer: ReturnType<typeof setTimeout> | undefined;
  drain: LazyDrainTracker;
};

export type ServerSpec = {
  command: string;
  args: string[];
  env: Record<string, string>;
};

export interface MeshLogger {
  warn(bindings: Record<string, unknown>, msg?: string): void;
}

export interface MeshSpawnContext {
  readonly vault: NimbusVault;
  readonly logger?: MeshLogger | undefined;
  readonly healthDb?: import("bun:sqlite").Database | undefined;
  readonly obsidianVaultPaths?: readonly string[] | undefined;
  readonly sandboxCwd: string;
  clearLazyIdle(key: string): void;
  getLazyClient(key: string): MCPClient | undefined;
  setLazyClient(key: string, client: MCPClient): void;
  bumpToolsEpoch(): void;
  scheduleLazyDisconnect(key: string): void;
}
