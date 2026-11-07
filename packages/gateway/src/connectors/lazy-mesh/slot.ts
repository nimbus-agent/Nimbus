// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
import type { MCPClient } from "@mastra/mcp";

import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { LazyDrainTracker } from "./drain.ts";
import type { DailyNoteGrantDeps } from "./obsidian-daily-note-grant.ts";

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
  /**
   * True while the owner's `connector.writes.enable obsidian` approval includes the daily-note
   * append (OR-B4-1). Absent, `false` or throwing: the Obsidian spawn gets NO write grant.
   */
  readonly obsidianWriteGrantEnabled?: (() => boolean) | undefined;
  /** The facts `obsidianWriteGrantPaths` reads. Absent: no write grant (fail closed). */
  readonly obsidianWriteGrantDeps?: DailyNoteGrantDeps | undefined;
  /**
   * Awaited before the Obsidian client is created, with the read roots and the write list this
   * spawn will be granted. On Windows it revokes the profile's earlier ACEs (they outlive the
   * child and a grant only merges rights); a rejection refuses the spawn.
   */
  readonly obsidianPreSpawn?:
    | ((plan: {
        readonly roots: readonly string[];
        readonly writePaths: readonly string[];
        /** The UTC date the daily-note files are for (only with a grant). */
        readonly day?: string;
      }) => Promise<void>)
    | undefined;
  /**
   * Runs the Obsidian spawn decision (and the mesh's restart) one at a time, so a grant read before
   * a disable can never create a client after the disable's stop. Absent: runs inline.
   */
  readonly obsidianSerial?: (<T>(fn: () => Promise<T>) => Promise<T>) | undefined;
  /**
   * Detaches the Obsidian client when its grant names an earlier UTC day's daily note, so the next
   * spawn grants today's. Absent: no rollover (the sandbox still refuses yesterday's file).
   */
  readonly obsidianRefreshStale?: (() => void) | undefined;
  /** The sandbox ROOT (`PlatformPaths.sandboxDir`). Despite the name, not a cwd: `wrapServerSpec` derives each spawn's own leaf under it. */
  readonly sandboxCwd: string;
  /**
   * Called by the GitHub spawn with the GitHub Enterprise Server `host[:port]` the child was
   * started with (`null` for github.com), so the consent preview names the instance the write
   * will actually reach. Absent in tests that do not care.
   */
  readonly recordGithubInstance?: ((host: string | null) => void) | undefined;
  clearLazyIdle(key: string): void;
  getLazyClient(key: string): MCPClient | undefined;
  setLazyClient(key: string, client: MCPClient): void;
  bumpToolsEpoch(): void;
  scheduleLazyDisconnect(key: string): void;
}
