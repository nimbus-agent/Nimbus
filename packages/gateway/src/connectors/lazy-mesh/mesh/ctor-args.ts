import type { Database } from "bun:sqlite";
import type { PlatformPaths } from "../../../platform/paths.ts";
import type { SandboxPolicy } from "../../../platform/sandbox/sandbox-policy.ts";
import type { AppContainerGrantRevoker } from "../../../platform/sandbox/win32-grant-revoke.ts";
import type { NimbusVault } from "../../../vault/nimbus-vault.ts";
import type { IacGrants } from "../../connector-writes/iac-grants.ts";
import type { K8sGrant } from "../../connector-writes/k8s-grants.ts";
import type { UserMcpConnectorRow } from "../../user-mcp-store.ts";
import type { WriteDirDeps } from "../../write-dir-rules.ts";
import type { CreateExtensionClient } from "../extension-slot.ts";
import type { ExtensionSlotSource } from "../extension-slot-source.ts";
import type { IacRunnerDeps } from "../iac-runner.ts";
import type { DailyNoteGrantDeps } from "../obsidian-daily-note-grant.ts";
import type { ObsidianGrantLedgerStore } from "../obsidian-grant-ledger.ts";
import type { MeshLogger } from "../slot.ts";
import type { UserMcpGrantLedgerStore } from "../user-mcp-write-grant.ts";

/** The options `new LazyConnectorMesh(paths, vault, options)` takes. */
export interface LazyConnectorMeshOptions {
  inactivityMs?: number;
  listUserMcpConnectors?: () => readonly UserMcpConnectorRow[];
  healthDb?: Database;
  logger?: MeshLogger;
  auditDb?: Database;
  obsidianVaultPaths?: readonly string[];
  isConnectorAllowed?: (serviceId: string) => boolean;
  /** Test seam: the agent door's user-MCP listing deadline. Production: {@link USER_MCP_LISTING_DEADLINE_MS}. */
  userMcpListingDeadlineMs?: number;
  /** Test seam: deletes a user MCP sandbox leaf. Production: recursive, forced `rmSync`. */
  removeSandboxDir?: (dir: string) => void;
  /** Test seam: whether a user MCP sandbox leaf exists. Production: `existsSync`. */
  sandboxDirExists?: (dir: string) => boolean;
  /**
   * Settles when the boot-time Windows revoke of stale `dataDir` ACEs is done. The filesystem
   * MCP is the one spawn still granted `dataDir`, and its sandbox grant rewrites that same
   * DACL with an unlocked read-modify-write, so its first listing (which spawns it) awaits
   * this. Never rejects in production (`revokeLegacyDataDirGrantsAtBoot`).
   */
  filesystemSpawnGate?: Promise<void>;
  /** Enabled, approved extensions; each runs in its own lazy `mesh:ext:<serviceId>` slot. */
  extensionSlots?: ExtensionSlotSource;
  /** Awaited before an extension is prepared, exactly as `filesystemSpawnGate` is for a spawn. */
  extensionSpawnGate?: Promise<void>;
  /** Test seam: builds an extension slot's client. Production: `new MCPClient(...)`. */
  createExtensionClient?: CreateExtensionClient;
  /**
   * LIVE: the owner's `connector.writes.enable obsidian` approval includes the daily-note
   * append (OR-B4-1). Absent means never: the Obsidian sandbox gets no write grant.
   */
  obsidianWriteGrantEnabled?: () => boolean;
  /** Test seam: the host OS for the Obsidian revoke. Production: `process.platform`. */
  platform?: NodeJS.Platform;
  /** Test seam: the Obsidian pre-spawn revoker. Production: `appContainerGrantRevokerFor`. */
  obsidianGrantRevoker?: AppContainerGrantRevoker;
  /** Test seam: the facts the Obsidian grant reads. Production: real discovery and realpath. */
  obsidianWriteGrantDeps?: DailyNoteGrantDeps;
  /** Test seam: the clock that names today's daily note. Production: `new Date()`. */
  now?: () => Date;
  /** Test seam: the Obsidian grant ledger. Production: a file under `configDir`. */
  obsidianGrantLedger?: ObsidianGrantLedgerStore;
  /** The owner's V85 approval of IaC directories and clouds, read fresh per call. Absent: nothing approved. */
  iacGrants?: () => IacGrants;
  /** The owner's V86 Kubernetes (context, namespace) approvals, read fresh per call. Absent: nothing approved. */
  k8sGrants?: () => readonly K8sGrant[];
  /** Test seam: overrides of the IaC runner's dependencies. */
  iacRunnerDeps?: Partial<IacRunnerDeps>;
  /**
   * The sandbox runner's answer for a user MCP write-directory policy (`canConfine`). Absent
   * means it cannot be asked, and a server with a write directory is then never spawned.
   */
  userMcpCanConfine?: (policy: SandboxPolicy) => string | null;
  /** Test seam: overrides of the facts the write-directory rule reads. */
  userMcpWriteDirDeps?: Partial<WriteDirDeps>;
  /** Test seam: the user MCP grant ledger. Production: a file under `configDir`. */
  userMcpGrantLedger?: UserMcpGrantLedgerStore;
  /** Test seam: the Windows revoker for one user MCP policy id. */
  userMcpGrantRevokerFor?: (policyId: string) => AppContainerGrantRevoker;
}

/** What every layer of the mesh's class chain is built from (resolved once, by the final class). */
export interface MeshCtorArgs {
  readonly paths: PlatformPaths;
  readonly vault: NimbusVault;
  readonly options: LazyConnectorMeshOptions | undefined;
  /** `options.platform ?? process.platform`. */
  readonly platform: NodeJS.Platform;
}
