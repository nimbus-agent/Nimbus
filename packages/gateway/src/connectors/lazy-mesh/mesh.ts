import { MCPClient } from "@mastra/mcp";
import { serviceOf } from "../../engine/service-of.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import type { PlatformPaths } from "../../platform/paths.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
  EMPTY_IAC_GRANTS,
  type IacGrants,
  type IacPathDeps,
} from "../connector-writes/iac-grants.ts";
import { CONNECTOR_WRITE_ROWS } from "../connector-writes/index.ts";
import type { K8sGrant } from "../connector-writes/k8s-grants.ts";
import type { UserMcpConnectorRow } from "../user-mcp-store.ts";
import { ensureCredentialConnectorsRunning } from "./credential-orchestration.ts";
import type { LazyDrainTracker } from "./drain.ts";
import { defaultCreateExtensionClient, ExtensionSlots } from "./extension-slot.ts";
import type { ExtensionSlotSource } from "./extension-slot-source.ts";
import { manifestForFirstParty } from "./first-party-manifests.ts";
import { type IacHost, IacRunner, routeIacTools } from "./iac-runner.ts";
import { LAZY_MESH } from "./keys.ts";
import type { LazyConnectorMeshOptions } from "./mesh/ctor-args.ts";
import { MeshExtensions } from "./mesh/extension-layer.ts";
import { buildIacPathDeps } from "./mesh/iac-path-deps.ts";
import { buildFirstPartyListing, type FirstPartyListingEntry } from "./mesh/listing-table.ts";
import { wrapToolsWithEnvelopeAndAudit } from "./mesh/tool-audit.ts";
import {
  buildSlotForToolMap,
  collectUserMcpToolMap,
  dropDisallowedConnectorTools,
  wrapMergedToolsWithRefcount,
} from "./mesh/tool-merge.ts";
import type { MeshLogger, MeshSpawnContext } from "./slot.ts";
import {
  type LazyMeshToolMap,
  listLazyMeshClientTools,
  mergeToolMapsOrThrow,
  meshServerForToolKey,
} from "./tool-map.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

export { userMcpProtectedRootsFor } from "./mesh/roots.ts";
export { USER_MCP_LISTING_DEADLINE_MS } from "./mesh/user-mcp-layer.ts";

/**
 * The lazy connector mesh. The class is built in layers (a chain of abstract classes under
 * `mesh/`, each holding one concern verbatim): `core.ts` (the slot registry), `ensure-runners.ts`
 * (the per-service ensure delegators and credential restarts), `obsidian-layer.ts` (the Obsidian
 * daily-note grant), `user-mcp-layer.ts` (user MCP servers and their write grants) and
 * `extension-layer.ts` (extension slots). This file holds the constructor (which wraps and wires
 * every spawn: I15), the first-party listing for the connector-write door, and the merged
 * dispatcher listing.
 */
export class LazyConnectorMesh extends MeshExtensions {
  private readonly filesystem: MCPClient;
  private readonly auditDb: import("bun:sqlite").Database | undefined;
  private readonly isConnectorAllowed: (serviceId: string) => boolean;
  /**
   * The first-party services the LATEST {@link listFirstPartyServerTools} call for them confirmed
   * mapped, configured and present in their slot's listing. {@link toolsGenerationFor} is
   * synchronous and must not read the Vault, so it answers `-1` for a service outside this set.
   */
  private readonly listedFirstParty = new Set<string>();
  private readonly firstPartyListing: Readonly<Record<string, FirstPartyListingEntry>>;
  protected readonly spawnContext: MeshSpawnContext;
  private readonly iacRunner: IacRunner;
  private readonly iacPathDeps: IacPathDeps;
  protected readonly extensionSlots: ExtensionSlots;

  constructor(paths: PlatformPaths, vault: NimbusVault, options?: LazyConnectorMeshOptions) {
    const platform = options?.platform ?? process.platform;
    super({ paths, vault, options, platform });
    this.auditDb = options?.auditDb;
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
          paths.sandboxDir,
        ),
      },
    });

    this.spawnContext = {
      vault: this.vault,
      logger: this.logger,
      healthDb: this.healthDb,
      obsidianVaultPaths: options?.obsidianVaultPaths,
      obsidianWriteGrantEnabled: options?.obsidianWriteGrantEnabled,
      obsidianWriteGrantDeps: this.obsidianGrantDeps,
      obsidianPreSpawn: (plan) => this.obsidianPreSpawn(plan),
      obsidianSerial: <T>(fn: () => Promise<T>) => this.runObsidianSerial(fn),
      obsidianRefreshStale: () => this.refreshStaleObsidian(),
      sandboxCwd: paths.sandboxDir,
      recordGithubInstance: (host) => this.recordGithubInstance(host),
      clearLazyIdle: (k) => this.clearLazyIdle(k),
      getLazyClient: (k) => this.getLazyClient(k),
      setLazyClient: (k, c) => this.setLazyClient(k, c),
      bumpToolsEpoch: () => this.bumpToolsEpoch(),
      scheduleLazyDisconnect: (k) => this.scheduleLazyDisconnect(k),
    };
    const listRowsNow = (): readonly UserMcpConnectorRow[] => this.listUserMcpConnectors();
    this.iacPathDeps = buildIacPathDeps(paths, platform, listRowsNow);
    this.iacRunner = new IacRunner({
      paths,
      vault,
      platform,
      grants: options?.iacGrants ?? (() => EMPTY_IAC_GRANTS),
      ...(options?.k8sGrants === undefined ? {} : { k8sGrants: options.k8sGrants }),
      pathDeps: this.iacPathDeps,
      ...options?.iacRunnerDeps,
    });
    this.firstPartyListing = buildFirstPartyListing(this.vault, this.spawnContext, this);
    this.extensionSlots = new ExtensionSlots(
      {
        getLazyClient: (k) => this.getLazyClient(k),
        setLazyClient: (k, c) => this.setLazyClient(k, c),
        clearLazyIdle: (k) => this.clearLazyIdle(k),
        bumpToolsEpoch: () => this.bumpToolsEpoch(),
        scheduleLazyDisconnect: (k) => this.scheduleLazyDisconnect(k),
        stopLazyClient: (k) => this.stopLazyClient(k),
      },
      {
        source: options?.extensionSlots,
        spawnGate: options?.extensionSpawnGate,
        healthDb: this.healthDb,
        createClient: options?.createExtensionClient ?? defaultCreateExtensionClient,
      },
    );
  }

  /** The iac runner, for the dispatcher's bound-write capabilities (D2). */
  iacHost(): IacHost {
    return this.iacRunner;
  }

  /** The filesystem facts the `enable iac` directory rule reads. */
  iacPathDepsForEnable(): IacPathDeps {
    return this.iacPathDeps;
  }

  /**
   * The generation of the slot hosting first-party `service`, or `-1` unless the service is in the
   * explicit listing map AND the latest {@link listFirstPartyServerTools} call for it found its own
   * credential configured and its server in that slot's listing — so a bundle running for a
   * configured sibling never gives an unconfigured service a generation. The connector-write door
   * treats `-1` as "not offerable". Never `NaN`.
   */
  toolsGenerationFor(service: string): number {
    const entry = this.firstPartyListingEntry(service);
    if (entry === undefined || !this.listedFirstParty.has(service)) return -1;
    return this.slotGenerations.get(entry.slot) ?? 0;
  }

  /**
   * ONE first-party server's tools, raw (`description` and `inputSchema` kept), for the model's
   * connector-write door. Order is the security property; every check precedes any slot touch:
   *  1. the service has rows in the write table (so never `mcp_*` / `ext_*`);
   *  2. org policy allows it (I22): a blocked service spawns nothing;
   *  3. it is in the explicit listing map (unmapped: fail closed) and the SERVICE's own credential
   *     is configured — read from the Vault/context only, never a token refresh or any network
   *     call — not merely "its slot is running": a bundle already up for a sibling does not make
   *     this service usable;
   *  4. only then THAT service's slot is ensured;
   *  5. the listing is filtered to keys this server owns; none ⇒ `undefined`, not `{}`. No other
   *     slot is ever spawned.
   * Each entry keeps ONLY `description` and `inputSchema`: the listed `execute` closure would
   * dispatch straight to the server, outside the executor's HITL and egress chokepoint, so it is
   * never handed out from here. The outcome also decides whether {@link toolsGenerationFor} gives
   * the service a generation (only after a defined listing).
   */
  async listFirstPartyServerTools(
    service: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    let out: Readonly<Record<string, unknown>> | undefined;
    try {
      out = await this.listFirstPartyServerToolsChecked(service);
    } finally {
      // Decided at the END, so a concurrent call keeps the previous answer meanwhile; a throw
      // leaves `out` undefined and clears it (fail closed).
      if (out === undefined) this.listedFirstParty.delete(service);
      else this.listedFirstParty.add(service);
    }
    return out;
  }

  private async listFirstPartyServerToolsChecked(
    service: string,
  ): Promise<Readonly<Record<string, unknown>> | undefined> {
    if (!CONNECTOR_WRITE_ROWS.some((r) => serviceOf(r.actionType) === service)) return undefined;
    if (!this.isConnectorAllowed(service)) return undefined;
    const entry = this.firstPartyListingEntry(service);
    if (entry === undefined) return undefined;
    if (!(await entry.configured())) return undefined;
    await this.filesystemSpawnGate;
    await entry.ensure();
    const all: Readonly<Record<string, unknown>> = await listLazyMeshClientTools(
      this.getLazyClient(entry.slot),
    );
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(all)) {
      if (meshServerForToolKey(key) !== service) continue;
      const listed = all[key];
      const rec =
        typeof listed === "object" && listed !== null ? (listed as Record<string, unknown>) : {};
      out[key] = { description: rec["description"], inputSchema: rec["inputSchema"] };
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }

  private firstPartyListingEntry(service: string): FirstPartyListingEntry | undefined {
    return Object.hasOwn(this.firstPartyListing, service)
      ? this.firstPartyListing[service]
      : undefined;
  }

  private async collectBuiltInToolMaps(): Promise<
    ReadonlyArray<{ map: LazyMeshToolMap; name: string }>
  > {
    const list = async (mesh: string): Promise<LazyMeshToolMap> =>
      listLazyMeshClientTools(this.getLazyClient(mesh));
    // The filesystem MCP spawns on its first listing; on Windows that grant must not race the
    // boot revoke of stale data-directory ACEs on the same DACL (see `filesystemSpawnGate`).
    await this.filesystemSpawnGate;
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
      // Spawned by `ensureCredentialConnectorsRunning` from the configured roots; listed here so the
      // dispatcher (and so the act door) can resolve its tools. Behind the same gate as the rest.
      { map: await list(LAZY_MESH.obsidian), name: "obsidian" },
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

  private collectUserMcpToolMap(): Promise<LazyMeshToolMap> {
    return collectUserMcpToolMap(this.lazySlots);
  }

  private buildSlotForToolMap(): Promise<Map<string, LazyDrainTracker>> {
    return buildSlotForToolMap(this.lazySlots);
  }

  async listToolsForDispatcher(): Promise<
    Record<string, { execute?: (input: unknown, context?: unknown) => Promise<unknown> }>
  > {
    await ensureCredentialConnectorsRunning(this.spawnContext);
    await this.ensureUserMcpConnectorsRunning();

    const builtIns = await this.collectBuiltInToolMaps();
    const userMcpMerged = await this.collectUserMcpToolMap();
    const merged = mergeToolMapsOrThrow([...builtIns, { map: userMcpMerged, name: "user-mcp" }]);
    dropDisallowedConnectorTools(merged, this.isConnectorAllowed);
    const slotForTool = await this.buildSlotForToolMap();
    wrapMergedToolsWithRefcount(merged, slotForTool);
    // The iac tools run in their own per-run children (D2), not in the listing slot.
    routeIacTools(merged, this.iacRunner);
    return merged;
  }

  async listTools(): Promise<
    Record<string, { execute?: (input: unknown, context?: unknown) => Promise<unknown> }>
  > {
    const merged = await this.listToolsForDispatcher();
    wrapToolsWithEnvelopeAndAudit(merged, this.auditDb);
    return merged;
  }

  async disconnect(): Promise<void> {
    // Slots are stopped concurrently, then the filesystem client. Each stop is independent and
    // never rejects; run one at a time, a single slot draining in-flight calls (up to ten minutes)
    // delayed the teardown of every slot after it. The key set is snapshotted up front — gateway
    // shutdown, the one production caller, stops the sync scheduler and IPC server before this.
    // An extension preparation still in flight is not in that snapshot, so it is told not to connect.
    this.extensionSlots.markAllStopped();
    // The IaC runner's per-run children are not in a slot: stop it too (kills them and waits, frees).
    const iacStopped = this.iacRunner.stop().catch(() => undefined);
    await Promise.all(Array.from(this.lazySlots.keys(), (key) => this.stopLazyClient(key)));
    await iacStopped;
    try {
      await this.filesystem.disconnect();
    } catch {
      /* ignore */
    }
  }
}

/**
 * Construction is synchronous; the Promise is this factory's contract with its callers, which
 * await it. `Promise.try` keeps a throwing constructor a rejection rather than a synchronous
 * throw, exactly as the former `async` declaration did.
 */
export function createLazyConnectorMesh(
  paths: PlatformPaths,
  vault: NimbusVault,
  options?: {
    inactivityMs?: number;
    listUserMcpConnectors?: () => readonly UserMcpConnectorRow[];
    healthDb?: import("bun:sqlite").Database;
    auditDb?: import("bun:sqlite").Database;
    logger?: MeshLogger;
    obsidianVaultPaths?: readonly string[];
    obsidianWriteGrantEnabled?: () => boolean;
    isConnectorAllowed?: (serviceId: string) => boolean;
    removeSandboxDir?: (dir: string) => void;
    filesystemSpawnGate?: Promise<void>;
    extensionSlots?: ExtensionSlotSource;
    extensionSpawnGate?: Promise<void>;
    iacGrants?: () => IacGrants;
    k8sGrants?: () => readonly K8sGrant[];
  },
): Promise<LazyConnectorMesh> {
  return Promise.try(() => new LazyConnectorMesh(paths, vault, options));
}
