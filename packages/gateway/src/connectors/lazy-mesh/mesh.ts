import { MCPClient } from "@mastra/mcp";

import { writeToolCallLog } from "../../db/tool-call-log.ts";
import { getAgentRequestSessionId } from "../../engine/agent-request-context.ts";
import { wrapToolOutput } from "../../engine/tool-output-envelope.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { PlatformPaths } from "../../platform/paths.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import {
  ensureBitbucketMcp,
  ensureCircleciMcp,
  ensureConfluenceMcp,
  ensureDiscordMcp,
  ensureGithubMcp,
  ensureGitlabMcp,
  ensureGoogleDriveMcp,
  ensureJenkinsMcp,
  ensureJiraMcp,
  ensureKubernetesMcp,
  ensureLinearMcp,
  ensureMicrosoftBundleMcp,
  ensureNotionMcp,
  ensureObsidianMcp,
  ensurePagerdutyMcp,
  ensurePhase3BundleMcp,
  ensureSlackMcp,
  ensureZoomMcp,
} from "./connector-spawns.ts";
import { ensureCredentialConnectorsRunning } from "./credential-orchestration.ts";
import { LazyDrainTracker } from "./drain.ts";
import { manifestForFirstParty } from "./first-party-manifests.ts";
import { LAZY_MESH, USER_MESH_PREFIX, userMcpMeshKey } from "./keys.ts";
import type { LazyMcpSlot, MeshLogger, MeshSpawnContext } from "./slot.ts";
import { type LazyMeshToolMap, listLazyMeshClientTools, mergeToolMapsOrThrow } from "./tool-map.ts";
import { ensureUserMcpClient } from "./user-mcp.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

/**
 * Eager filesystem MCP + lazily spawned Google MCP bundle (Drive + Gmail + Photos) + Microsoft bundle (OneDrive + Outlook + Teams) + GitHub (includes GitHub Actions MCP child) / GitLab / Bitbucket / Slack / Linear / Jira / Notion / Confluence / Jenkins / CircleCI / PagerDuty / Kubernetes credential MCP when vault keys exist; Phase 3 bundle (AWS, Azure, GCP, IaC, Grafana, Sentry, New Relic, Datadog) when matching vault keys exist; Discord MCP when **`discord.enabled`** + **`discord.bot_token`** are set (Q2 §1.6 / Phase 2–5 + §4.3).
 */
export class LazyConnectorMesh {
  private readonly filesystem: MCPClient;
  /** Lazy MCP stdio children: built-in bundles use `LAZY_MESH.*`; user MCP uses `mesh:user:<serviceId>`. */
  private readonly lazySlots = new Map<string, LazyMcpSlot>();
  private readonly listUserMcpConnectors: () => readonly UserMcpConnectorRow[];
  private readonly inactivityMs: number;
  /** S8-F9 — optional db + logger so args_json failures can transition health and log. */
  private readonly healthDb: import("bun:sqlite").Database | undefined;
  /** Phase 5 T6 PR 2 — when supplied, listTools' wrapped execute writes tool_call_log rows. */
  private readonly auditDb: import("bun:sqlite").Database | undefined;
  private readonly logger: MeshLogger | undefined;
  private toolsEpoch = 0;
  /** Constructor-bound facade exposing the slot state-machine to extracted free functions. */
  private readonly spawnContext: MeshSpawnContext;

  constructor(
    paths: PlatformPaths,
    private readonly vault: NimbusVault,
    options?: {
      inactivityMs?: number;
      listUserMcpConnectors?: () => readonly UserMcpConnectorRow[];
      /** S8-F9 — when supplied, args_json parse failures call transitionHealth. */
      healthDb?: import("bun:sqlite").Database;
      /** S8-F9 — when supplied, args_json parse failures emit a warn line. */
      logger?: MeshLogger;
      /** Phase 5 T6 PR 2 — when supplied, listTools' wrapped execute writes tool_call_log rows. */
      auditDb?: import("bun:sqlite").Database;
      /**
       * Wave A PR 2 — absolute paths of `[[filesystem.roots]]` discovered at
       * gateway boot. Threaded into `MeshSpawnContext.obsidianVaultPaths`
       * for `ensureObsidianMcp`. Empty/undefined → obsidian MCP not started.
       */
      obsidianVaultPaths?: readonly string[];
    },
  ) {
    this.inactivityMs = options?.inactivityMs ?? 300_000;
    this.listUserMcpConnectors = options?.listUserMcpConnectors ?? (() => []);
    this.healthDb = options?.healthDb;
    this.auditDb = options?.auditDb;
    this.logger = options?.logger;
    // I15 (T2 PR 1) — every lazy-mesh ServerSpec goes through
    // `wrapServerSpec` so MCPClient's internal child process lands in
    // `sandbox-wrapper.ts` → the platform sandbox runner. The filesystem
    // connector needs read access to `paths.dataDir`; we extend the
    // base manifest's `filesystem.read` at runtime because dataDir is
    // user-scoped (not known until Gateway boot).
    const fsBaseManifest = manifestForFirstParty("filesystem");
    const fsManifest = {
      ...fsBaseManifest,
      permissions: {
        ...fsBaseManifest.permissions,
        filesystem: {
          read: [...fsBaseManifest.permissions.filesystem.read, paths.dataDir],
          write: [...fsBaseManifest.permissions.filesystem.write, paths.dataDir],
        },
      },
    };
    this.filesystem = new MCPClient({
      servers: {
        filesystem: wrapServerSpec(
          {
            command: "bunx",
            args: ["@modelcontextprotocol/server-filesystem", paths.dataDir],
            env: extensionProcessEnv({}),
          },
          fsManifest,
          paths.dataDir,
        ),
      },
    });
    this.spawnContext = {
      vault: this.vault,
      logger: this.logger,
      healthDb: this.healthDb,
      obsidianVaultPaths: options?.obsidianVaultPaths,
      sandboxCwd: paths.dataDir,
      clearLazyIdle: (k) => this.clearLazyIdle(k),
      getLazyClient: (k) => this.getLazyClient(k),
      setLazyClient: (k, c) => this.setLazyClient(k, c),
      bumpToolsEpoch: () => this.bumpToolsEpoch(),
      scheduleLazyDisconnect: (k) => this.scheduleLazyDisconnect(k),
    };
  }

  getToolsEpoch(): number {
    return this.toolsEpoch;
  }

  private bumpToolsEpoch(): void {
    this.toolsEpoch += 1;
  }

  private lazySlot(key: string): LazyMcpSlot {
    let s = this.lazySlots.get(key);
    if (s === undefined) {
      s = { client: undefined, idleTimer: undefined, drain: new LazyDrainTracker() };
      this.lazySlots.set(key, s);
    }
    return s;
  }

  private getLazyClient(key: string): MCPClient | undefined {
    return this.lazySlots.get(key)?.client ?? undefined;
  }

  private setLazyClient(key: string, client: MCPClient): void {
    this.lazySlot(key).client = client;
  }

  private clearLazyIdle(key: string): void {
    const s = this.lazySlots.get(key);
    if (s?.idleTimer !== undefined) {
      clearTimeout(s.idleTimer);
      s.idleTimer = undefined;
    }
  }

  private scheduleLazyDisconnect(key: string): void {
    this.clearLazyIdle(key);
    const slot = this.lazySlot(key);
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = undefined;
      void this.stopLazyClient(key);
    }, this.inactivityMs);
  }

  private async stopLazyClient(key: string): Promise<void> {
    this.clearLazyIdle(key);
    const slot = this.lazySlots.get(key);
    if (slot === undefined) {
      return;
    }
    // S8-F7 — wait for in-flight calls before tearing down. Hard cap at
    // 10 minutes total so a stuck tool call cannot indefinitely defer
    // disconnect; beyond that, force-disconnect anyway.
    if (slot.drain.count > 0) {
      await Promise.race([
        slot.drain.awaitDrain(),
        new Promise<void>((r) => setTimeout(r, 10 * 60_000)),
      ]);
    }
    const c = slot.client;
    slot.client = undefined;
    if (slot.idleTimer === undefined) {
      this.lazySlots.delete(key);
    }
    if (c !== undefined) {
      this.bumpToolsEpoch();
      try {
        await c.disconnect();
      } catch {
        /* ignore */
      }
    }
  }

  private async stopUserMcpClient(serviceId: string): Promise<void> {
    await this.stopLazyClient(userMcpMeshKey(serviceId));
  }

  /**
   * S7-F10 — terminate the running MCP child process for an extension.
   * Called by `extension.disable` IPC and by `verifyExtensionsBestEffort`
   * when a hash mismatch is detected. Extension MCPs are stored under the
   * same `mesh:user:<id>` slot pattern as user MCPs, so we route through
   * the existing user-mesh teardown. We also attempt the bare extension-id
   * slot in case a future code path registers extensions there directly.
   *
   * Limitation: this only kills the immediate MCP child. Subprocesses
   * spawned BY the extension (helper daemons, background watchers) keep
   * running until they exit on their own. Closing that gap requires
   * platform-specific machinery (POSIX process groups, Windows Job
   * Objects) and is tracked under Phase 7 sandbox work.
   */
  public async stopExtensionClient(extensionId: string): Promise<void> {
    await this.stopUserMcpClient(extensionId);
    await this.stopLazyClient(extensionId);
  }

  /** Ensures the persisted user MCP server for `serviceId` is spawned (sync + agent tool listing). */
  async ensureUserMcpRunning(serviceId: string): Promise<void> {
    const rows = this.listUserMcpConnectors();
    const row = rows.find((r) => r.service_id === serviceId);
    if (row === undefined) {
      return;
    }
    await ensureUserMcpClient(this.spawnContext, row);
  }

  private async ensureUserMcpConnectorsRunning(): Promise<void> {
    const rows = this.listUserMcpConnectors();
    const active = new Set(rows.map((r) => r.service_id));
    for (const key of this.lazySlots.keys()) {
      if (!key.startsWith(USER_MESH_PREFIX)) {
        continue;
      }
      const id = key.slice(USER_MESH_PREFIX.length);
      if (!active.has(id)) {
        await this.stopUserMcpClient(id);
      }
    }
    for (const row of rows) {
      await ensureUserMcpClient(this.spawnContext, row);
    }
  }

  // --- per-connector ensure shells (delegate to free functions) ---

  async ensurePhase3BundleRunning(): Promise<void> {
    return ensurePhase3BundleMcp(this.spawnContext);
  }

  async ensureGoogleDriveRunning(): Promise<void> {
    return ensureGoogleDriveMcp(this.spawnContext);
  }

  async ensureMicrosoftBundleRunning(): Promise<void> {
    return ensureMicrosoftBundleMcp(this.spawnContext);
  }

  async ensureGithubRunning(): Promise<void> {
    return ensureGithubMcp(this.spawnContext);
  }

  async ensureGitlabRunning(): Promise<void> {
    return ensureGitlabMcp(this.spawnContext);
  }

  async ensureBitbucketRunning(): Promise<void> {
    return ensureBitbucketMcp(this.spawnContext);
  }

  async ensureSlackRunning(): Promise<void> {
    return ensureSlackMcp(this.spawnContext);
  }

  async ensureLinearRunning(): Promise<void> {
    return ensureLinearMcp(this.spawnContext);
  }

  async ensureJiraRunning(): Promise<void> {
    return ensureJiraMcp(this.spawnContext);
  }

  async ensureNotionRunning(): Promise<void> {
    return ensureNotionMcp(this.spawnContext);
  }

  async ensureObsidianRunning(): Promise<void> {
    return ensureObsidianMcp(this.spawnContext);
  }

  async ensureConfluenceRunning(): Promise<void> {
    return ensureConfluenceMcp(this.spawnContext);
  }

  async ensureDiscordRunning(): Promise<void> {
    return ensureDiscordMcp(this.spawnContext);
  }

  async ensureJenkinsRunning(): Promise<void> {
    return ensureJenkinsMcp(this.spawnContext);
  }

  async ensureCircleciRunning(): Promise<void> {
    return ensureCircleciMcp(this.spawnContext);
  }

  async ensurePagerdutyRunning(): Promise<void> {
    return ensurePagerdutyMcp(this.spawnContext);
  }

  async ensureKubernetesRunning(): Promise<void> {
    return ensureKubernetesMcp(this.spawnContext);
  }

  async ensureZoomRunning(): Promise<void> {
    return ensureZoomMcp(this.spawnContext);
  }

  // --- tool aggregation (kept; needs raw slot map access) ---

  /** Collect tool maps from all built-in lazy slots. */
  private async collectBuiltInToolMaps(): Promise<
    ReadonlyArray<{ map: LazyMeshToolMap; name: string }>
  > {
    const list = async (mesh: string): Promise<LazyMeshToolMap> =>
      listLazyMeshClientTools(this.getLazyClient(mesh));
    const fsTools = (await this.filesystem.listTools()) as LazyMeshToolMap;
    return [
      { map: fsTools, name: "filesystem" },
      { map: await list(LAZY_MESH.googleBundle), name: "google-bundle" },
      { map: await list(LAZY_MESH.microsoftBundle), name: "microsoft-bundle" },
      { map: await list(LAZY_MESH.github), name: "github" },
      { map: await list(LAZY_MESH.gitlab), name: "gitlab" },
      { map: await list(LAZY_MESH.bitbucket), name: "bitbucket" },
      { map: await list(LAZY_MESH.slack), name: "slack" },
      { map: await list(LAZY_MESH.linear), name: "linear" },
      { map: await list(LAZY_MESH.jira), name: "jira" },
      { map: await list(LAZY_MESH.notion), name: "notion" },
      { map: await list(LAZY_MESH.confluence), name: "confluence" },
      { map: await list(LAZY_MESH.discord), name: "discord" },
      { map: await list(LAZY_MESH.jenkins), name: "jenkins" },
      { map: await list(LAZY_MESH.circleci), name: "circleci" },
      { map: await list(LAZY_MESH.pagerduty), name: "pagerduty" },
      { map: await list(LAZY_MESH.kubernetes), name: "kubernetes" },
      { map: await list(LAZY_MESH.zoom), name: "zoom" },
      { map: await list(LAZY_MESH.phase3Bundle), name: "phase3-bundle" },
    ];
  }

  /** Merge tool maps from every active user MCP slot. */
  private async collectUserMcpToolMap(): Promise<LazyMeshToolMap> {
    let merged: LazyMeshToolMap = {};
    for (const [meshKey, slot] of this.lazySlots) {
      if (!meshKey.startsWith(USER_MESH_PREFIX) || slot.client === undefined) {
        continue;
      }
      merged = { ...merged, ...(await listLazyMeshClientTools(slot.client)) };
    }
    return merged;
  }

  /** Index every tool key to its owning slot's drain tracker. Best-effort; races with disconnect are ignored. */
  private async buildSlotForToolMap(): Promise<Map<string, LazyDrainTracker>> {
    const slotForTool = new Map<string, LazyDrainTracker>();
    for (const slot of this.lazySlots.values()) {
      if (slot.client === undefined) continue;
      try {
        const tools = (await slot.client.listTools()) as LazyMeshToolMap;
        for (const k of Object.keys(tools)) {
          if (!slotForTool.has(k)) slotForTool.set(k, slot.drain);
        }
      } catch {
        /* slot disappearing — skip */
      }
    }
    return slotForTool;
  }

  /**
   * S8-F7 — wrap each tool's execute with bump/drop counters keyed to the
   * owning slot, so stopLazyClient can defer disconnect while calls are in
   * flight.
   */
  private wrapMergedToolsWithRefcount(
    merged: LazyMeshToolMap,
    slotForTool: ReadonlyMap<string, LazyDrainTracker>,
  ): void {
    for (const key of Object.keys(merged)) {
      const value = merged[key];
      const original = value?.execute;
      const drain = slotForTool.get(key);
      if (value === undefined || original === undefined || drain === undefined) continue;
      merged[key] = {
        execute: async (input: unknown, ctx?: unknown): Promise<unknown> => {
          drain.bump();
          try {
            return await original(input, ctx);
          } finally {
            drain.drop();
          }
        },
      };
    }
  }

  /**
   * Bare tool map — for the planner path (`ConnectorDispatcher` →
   * `ToolExecutor`). Returns refcount-wrapped but otherwise structured tool
   * results so `ToolExecutor` consumers see the same shape as upstream MCPs.
   */
  async listToolsForDispatcher(): Promise<
    Record<string, { execute?: (input: unknown, context?: unknown) => Promise<unknown> }>
  > {
    await ensureCredentialConnectorsRunning(this.spawnContext);
    await this.ensureUserMcpConnectorsRunning();

    const builtIns = await this.collectBuiltInToolMaps();
    const userMcpMerged = await this.collectUserMcpToolMap();
    const merged = mergeToolMapsOrThrow([...builtIns, { map: userMcpMerged, name: "user-mcp" }]);
    const slotForTool = await this.buildSlotForToolMap();
    this.wrapMergedToolsWithRefcount(merged, slotForTool);
    return merged;
  }

  /**
   * Envelope-wrapped tool map — for the LLM-visible surface via Mastra. Each
   * tool's execute returns a `<tool_output>`-tagged string. Use this for the
   * agent / Mastra path; use `listToolsForDispatcher` for the planner path.
   */
  async listTools(): Promise<
    Record<string, { execute?: (input: unknown, context?: unknown) => Promise<unknown> }>
  > {
    const merged = await this.listToolsForDispatcher();
    const auditDb = this.auditDb;
    for (const key of Object.keys(merged)) {
      const value = merged[key];
      if (value === undefined) continue;
      const inner = value.execute;
      if (inner === undefined) continue;
      const service = key.split("_")[0] ?? "mcp";
      merged[key] = {
        execute: async (input: unknown, ctx?: unknown): Promise<string> => {
          const sessionId = getAgentRequestSessionId() ?? null;
          const calledAt = Date.now();
          let status: "ok" | "error" = "ok";
          let envelope: string;
          try {
            const raw = await inner(input, ctx);
            envelope = wrapToolOutput({ service, tool: key }, raw);
          } catch (err) {
            status = "error";
            envelope = wrapToolOutput({ service, tool: key }, { error: String(err) });
            if (auditDb !== undefined) {
              writeToolCallLog(auditDb, {
                sessionId,
                toolId: key,
                service,
                calledAt,
                durationMs: Date.now() - calledAt,
                resultEnvelope: envelope,
                status,
              });
            }
            throw err;
          }
          if (auditDb !== undefined) {
            writeToolCallLog(auditDb, {
              sessionId,
              toolId: key,
              service,
              calledAt,
              durationMs: Date.now() - calledAt,
              resultEnvelope: envelope,
              status,
            });
          }
          return envelope;
        },
      };
    }
    return merged;
  }

  async disconnect(): Promise<void> {
    for (const key of this.lazySlots.keys()) {
      await this.stopLazyClient(key);
    }
    try {
      await this.filesystem.disconnect();
    } catch {
      /* ignore */
    }
  }
}

export async function createLazyConnectorMesh(
  paths: PlatformPaths,
  vault: NimbusVault,
  options?: {
    inactivityMs?: number;
    listUserMcpConnectors?: () => readonly UserMcpConnectorRow[];
    healthDb?: import("bun:sqlite").Database;
    auditDb?: import("bun:sqlite").Database;
    logger?: MeshLogger;
    obsidianVaultPaths?: readonly string[];
  },
): Promise<LazyConnectorMesh> {
  return new LazyConnectorMesh(paths, vault, options);
}
