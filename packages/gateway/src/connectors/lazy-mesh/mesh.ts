import { MCPClient } from "@mastra/mcp";

import { writeToolCallLog } from "../../db/tool-call-log.ts";
import { getAgentRequestSessionId } from "../../engine/agent-request-context.ts";
import { wrapToolOutput } from "../../engine/tool-output-envelope.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { PlatformPaths } from "../../platform/paths.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { CONNECTOR_SERVICE_IDS } from "../connector-catalog.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import {
  ensureAppleMcp,
  ensureBitbucketMcp,
  ensureCanvaMcp,
  ensureCircleciMcp,
  ensureConfluenceMcp,
  ensureDiscordMcp,
  ensureFigmaMcp,
  ensureGithubMcp,
  ensureGitlabMcp,
  ensureGoogleDriveMcp,
  ensureHubspotMcp,
  ensureJenkinsMcp,
  ensureJiraMcp,
  ensureKubernetesMcp,
  ensureLinearMcp,
  ensureMendeleyMcp,
  ensureMicrosoftBundleMcp,
  ensureMiroMcp,
  ensureNotionMcp,
  ensureObsidianMcp,
  ensurePagerdutyMcp,
  ensurePhase3BundleMcp,
  ensureSalesforceMcp,
  ensureSlackMcp,
  ensureWorkdayMcp,
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

// Service ids longest-first so a multi-underscore id (e.g. "google_drive") is matched before a
// shorter prefix ("google_*" tools must not be mis-attributed). A tool key belongs to service `s`
// when it equals `s` or starts with `s_` (the mesh names each MCP server by its service id, and
// the MCP client prefixes every tool with `<serverKey>_`).
const SERVICE_IDS_BY_LENGTH_DESC: readonly string[] = [...CONNECTOR_SERVICE_IDS].sort(
  (a, b) => b.length - a.length,
);

/** The connector service id that owns a dispatcher tool key, or undefined if none matches. */
function serviceIdForToolKey(toolKey: string): string | undefined {
  for (const id of SERVICE_IDS_BY_LENGTH_DESC) {
    if (toolKey === id || toolKey.startsWith(`${id}_`)) return id;
  }
  return undefined;
}

export class LazyConnectorMesh {
  private readonly filesystem: MCPClient;
  private readonly lazySlots = new Map<string, LazyMcpSlot>();
  private readonly listUserMcpConnectors: () => readonly UserMcpConnectorRow[];
  private readonly inactivityMs: number;
  private readonly healthDb: import("bun:sqlite").Database | undefined;
  private readonly auditDb: import("bun:sqlite").Database | undefined;
  private readonly logger: MeshLogger | undefined;
  private readonly isConnectorAllowed: (serviceId: string) => boolean;
  private toolsEpoch = 0;
  private readonly spawnContext: MeshSpawnContext;

  constructor(
    paths: PlatformPaths,
    private readonly vault: NimbusVault,
    options?: {
      inactivityMs?: number;
      listUserMcpConnectors?: () => readonly UserMcpConnectorRow[];
      healthDb?: import("bun:sqlite").Database;
      logger?: MeshLogger;
      auditDb?: import("bun:sqlite").Database;
      obsidianVaultPaths?: readonly string[];
      isConnectorAllowed?: (serviceId: string) => boolean;
    },
  ) {
    this.inactivityMs = options?.inactivityMs ?? 300_000;
    this.listUserMcpConnectors = options?.listUserMcpConnectors ?? (() => []);
    this.healthDb = options?.healthDb;
    this.auditDb = options?.auditDb;
    this.logger = options?.logger;
    // Org-policy connector allowlist (I22). Default permits everything (ungoverned). A blocked
    // connector's tools are filtered out at the universal dispatcher chokepoint below.
    this.isConnectorAllowed = options?.isConnectorAllowed ?? (() => true);
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

  public async stopExtensionClient(extensionId: string): Promise<void> {
    await this.stopUserMcpClient(extensionId);
    await this.stopLazyClient(extensionId);
  }

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

  async ensurePhase3BundleRunning(): Promise<void> {
    return ensurePhase3BundleMcp(this.spawnContext);
  }

  async ensureGoogleDriveRunning(): Promise<void> {
    // The value is deliberately dropped here. `ensureGoogleDriveMcp` reports which connectors
    // it registered so a test can observe fault isolation without reaching into `MCPClient`;
    // the MESH delegator's contract is "make it running", shared with eight sibling methods
    // that all resolve to nothing, and widening one of them would be noise at every call site.
    await ensureGoogleDriveMcp(this.spawnContext);
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

  async ensureMendeleyRunning(): Promise<void> {
    return ensureMendeleyMcp(this.spawnContext);
  }

  async ensureWorkdayRunning(): Promise<void> {
    return ensureWorkdayMcp(this.spawnContext);
  }

  async ensureAppleRunning(): Promise<void> {
    return ensureAppleMcp(this.spawnContext);
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

  async ensureHubspotRunning(): Promise<void> {
    return ensureHubspotMcp(this.spawnContext);
  }

  async ensureMiroRunning(): Promise<void> {
    return ensureMiroMcp(this.spawnContext);
  }

  async ensureCanvaRunning(): Promise<void> {
    return ensureCanvaMcp(this.spawnContext);
  }

  async ensureFigmaRunning(): Promise<void> {
    return ensureFigmaMcp(this.spawnContext);
  }

  async ensureSalesforceRunning(): Promise<void> {
    return ensureSalesforceMcp(this.spawnContext);
  }

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
      { map: await list(LAZY_MESH.mendeley), name: "mendeley" },
      { map: await list(LAZY_MESH.workday), name: "workday" },
      { map: await list(LAZY_MESH.apple), name: "apple" },
      { map: await list(LAZY_MESH.confluence), name: "confluence" },
      { map: await list(LAZY_MESH.discord), name: "discord" },
      { map: await list(LAZY_MESH.jenkins), name: "jenkins" },
      { map: await list(LAZY_MESH.circleci), name: "circleci" },
      { map: await list(LAZY_MESH.pagerduty), name: "pagerduty" },
      { map: await list(LAZY_MESH.kubernetes), name: "kubernetes" },
      { map: await list(LAZY_MESH.zoom), name: "zoom" },
      { map: await list(LAZY_MESH.hubspot), name: "hubspot" },
      { map: await list(LAZY_MESH.miro), name: "miro" },
      { map: await list(LAZY_MESH.canva), name: "canva" },
      { map: await list(LAZY_MESH.figma), name: "figma" },
      { map: await list(LAZY_MESH.salesforce), name: "salesforce" },
      { map: await list(LAZY_MESH.phase3Bundle), name: "phase3-bundle" },
    ];
  }

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

  async listToolsForDispatcher(): Promise<
    Record<string, { execute?: (input: unknown, context?: unknown) => Promise<unknown> }>
  > {
    await ensureCredentialConnectorsRunning(this.spawnContext);
    await this.ensureUserMcpConnectorsRunning();

    const builtIns = await this.collectBuiltInToolMaps();
    const userMcpMerged = await this.collectUserMcpToolMap();
    const merged = mergeToolMapsOrThrow([...builtIns, { map: userMcpMerged, name: "user-mcp" }]);
    this.dropDisallowedConnectorTools(merged);
    const slotForTool = await this.buildSlotForToolMap();
    this.wrapMergedToolsWithRefcount(merged, slotForTool);
    return merged;
  }

  /**
   * Org-policy connector allowlist enforcement (I22). Removes from the dispatcher tool map every
   * tool whose owning connector service id is not permitted by policy. Tools that do not map to a
   * known connector service (filesystem, user-MCP/extension tools) are left untouched — the policy
   * allowlist governs first-party cloud connectors only.
   */
  private dropDisallowedConnectorTools(merged: LazyMeshToolMap): void {
    for (const key of Object.keys(merged)) {
      const serviceId = serviceIdForToolKey(key);
      if (serviceId !== undefined && !this.isConnectorAllowed(serviceId)) {
        delete merged[key];
      }
    }
  }

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
                params: input,
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
              params: input,
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
    isConnectorAllowed?: (serviceId: string) => boolean;
  },
): Promise<LazyConnectorMesh> {
  return new LazyConnectorMesh(paths, vault, options);
}
