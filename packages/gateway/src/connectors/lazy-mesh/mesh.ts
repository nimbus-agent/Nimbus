import { existsSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";

import { MCPClient } from "@mastra/mcp";
import { writeToolCallLog } from "../../db/tool-call-log.ts";
import { getAgentRequestSessionId } from "../../engine/agent-request-context.ts";
import { serviceOf } from "../../engine/service-of.ts";
import { wrapToolOutput } from "../../engine/tool-output-envelope.ts";
import { EXTENSION_SERVICE_ID_PATTERN } from "../../extensions/extension-service-id.ts";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { processEnvGet } from "../../platform/env-access.ts";
import type { PlatformPaths } from "../../platform/paths.ts";
import { extensionStageRootFor, sandboxCwdFor } from "../../platform/sandbox/sandbox-cwd.ts";
import {
  type AppContainerGrantRevoker,
  appContainerGrantRevokerFor,
} from "../../platform/sandbox/win32-grant-revoke.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { extractMcpToolText, MCP_TOOL_RESULT_MAX_BYTES } from "../_lib/mcp-tool-result.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { scanForGitEntry } from "../connector-writes/iac-git-scan.ts";
import {
  EMPTY_IAC_GRANTS,
  type IacGrants,
  type IacPathDeps,
} from "../connector-writes/iac-grants.ts";
import { CONNECTOR_WRITE_ROWS } from "../connector-writes/index.ts";
import type { K8sGrant } from "../connector-writes/k8s-grants.ts";
import type { ExtensionSyncRequest } from "../extension-sync/sync-response.ts";
import { resolveGithubBase } from "../github-api-base.ts";
import { discoverVaultsForWriteGrant } from "../obsidian-discovery.ts";
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
import {
  type CreateExtensionClient,
  defaultCreateExtensionClient,
  ExtensionSlots,
  extensionServerKey,
} from "./extension-slot.ts";
import type { ExtensionSlotSource } from "./extension-slot-source.ts";
import { manifestForFirstParty } from "./first-party-manifests.ts";
import {
  type IacHost,
  IacRunner,
  type IacRunnerDeps,
  iacProtectedRootsFor,
  routeIacTools,
} from "./iac-runner.ts";
import {
  EXT_MESH_PREFIX,
  extensionMeshKey,
  LAZY_MESH,
  USER_MESH_PREFIX,
  userMcpMeshKey,
} from "./keys.ts";
import {
  type DailyNoteGrantDeps,
  type DailyNoteSkip,
  dailyNotePattern,
  utcDay,
} from "./obsidian-daily-note-grant.ts";
import {
  fileObsidianGrantLedger,
  type ObsidianGrantLedgerStore,
  obsidianGrantLedgerFile,
} from "./obsidian-grant-ledger.ts";
import { type ObsidianGrantSkip, obsidianWriteGrantPaths } from "./obsidian-write-grant.ts";
import {
  phase3AddArgocdMcp,
  phase3AddAwsMcp,
  phase3AddAzureMcp,
  phase3AddBigeyeMcp,
  phase3AddBitriseMcp,
  phase3AddCodemagicMcp,
  phase3AddFirebaseMcp,
  phase3AddFlagsmithMcp,
  phase3AddFluxMcp,
  phase3AddGcpMcp,
  phase3AddIacMcp,
  phase3AddLaunchdarklyMcp,
  phase3AddLookerMcp,
  phase3AddMlflowMcp,
  phase3AddMonteCarloMcp,
  phase3AddNetlifyMcp,
  phase3AddPowerBiMcp,
  phase3AddSnowflakeMcp,
  phase3AddTableauMcp,
  phase3AddTestflightMcp,
  phase3AddVantageMcp,
  phase3AddVercelMcp,
} from "./phase3-config.ts";
import { isServiceCredentialConfigured } from "./service-credential.ts";
import type { LazyMcpSlot, MeshLogger, MeshSpawnContext, ServerSpec } from "./slot.ts";
import {
  type LazyMeshToolMap,
  listLazyMeshClientTools,
  mcpClientToolKey,
  mergeToolMapsOrThrow,
  meshServerForToolKey,
  serviceIdForToolKey,
} from "./tool-map.ts";
import { ensureUserMcpClient } from "./user-mcp.ts";
import { wrapServerSpec } from "./wrap-server-spec.ts";

type Phase3ServerAdder = (
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
) => Promise<void>;

/**
 * The phase-3 bundle services, each with the SPAWNER's own credential check: the `phase3Add*`
 * function registers the server only when the service's own vault secrets are present.
 */
const PHASE3_LISTING_ADDERS: Readonly<Record<string, Phase3ServerAdder>> = {
  snowflake: phase3AddSnowflakeMcp,
  tableau: phase3AddTableauMcp,
  looker: phase3AddLookerMcp,
  powerbi: phase3AddPowerBiMcp,
  montecarlo: phase3AddMonteCarloMcp,
  bigeye: phase3AddBigeyeMcp,
  vantage: phase3AddVantageMcp,
  argocd: phase3AddArgocdMcp,
  flux: phase3AddFluxMcp,
  launchdarkly: phase3AddLaunchdarklyMcp,
  flagsmith: phase3AddFlagsmithMcp,
  mlflow: phase3AddMlflowMcp,
  aws: phase3AddAwsMcp,
  azure: phase3AddAzureMcp,
  gcp: phase3AddGcpMcp,
  // D2: the iac server, LISTED in its no-network bundle slot so the model door can read the write
  // and prepare tools' schemas; the plan, show, apply and CloudFormation children run in their own
  // per-call profiles, never in this slot.
  iac: phase3AddIacMcp,
  // D3b: the deploy triggers and mobile release. Each adder is the SPAWNER's own credential check
  // (a token, or the TestFlight key trio, or the Firebase service account and app ids).
  vercel: phase3AddVercelMcp,
  netlify: phase3AddNetlifyMcp,
  bitrise: phase3AddBitriseMcp,
  codemagic: phase3AddCodemagicMcp,
  testflight: phase3AddTestflightMcp,
  firebase: phase3AddFirebaseMcp,
};

/**
 * The per-service slots (the name is historical: it began as the wave-2 services; C1 added
 * `onedrive` and `pagerduty`, and D1 `bitbucket`, `jenkins`, `circleci` and `github_actions`): the slot each one's server runs in and the mesh method that ensures
 * exactly that slot, in ONE row so the two cannot drift. Their credential check is
 * {@link isServiceCredentialConfigured} (per SERVICE, never per slot: the Google and Microsoft
 * bundles host siblings).
 */
const WAVE2_LISTING: Readonly<
  Record<string, { readonly slot: string; readonly ensure: keyof LazyConnectorMesh }>
> = {
  gmail: { slot: LAZY_MESH.googleBundle, ensure: "ensureGoogleDriveRunning" },
  google_drive: { slot: LAZY_MESH.googleBundle, ensure: "ensureGoogleDriveRunning" },
  outlook: { slot: LAZY_MESH.microsoftBundle, ensure: "ensureMicrosoftBundleRunning" },
  teams: { slot: LAZY_MESH.microsoftBundle, ensure: "ensureMicrosoftBundleRunning" },
  onedrive: { slot: LAZY_MESH.microsoftBundle, ensure: "ensureMicrosoftBundleRunning" },
  pagerduty: { slot: LAZY_MESH.pagerduty, ensure: "ensurePagerdutyRunning" },
  github: { slot: LAZY_MESH.github, ensure: "ensureGithubRunning" },
  gitlab: { slot: LAZY_MESH.gitlab, ensure: "ensureGitlabRunning" },
  // GitHub Actions is a second server in the github client: the same slot, the same PAT.
  github_actions: { slot: LAZY_MESH.github, ensure: "ensureGithubRunning" },
  bitbucket: { slot: LAZY_MESH.bitbucket, ensure: "ensureBitbucketRunning" },
  jenkins: { slot: LAZY_MESH.jenkins, ensure: "ensureJenkinsRunning" },
  circleci: { slot: LAZY_MESH.circleci, ensure: "ensureCircleciRunning" },
  slack: { slot: LAZY_MESH.slack, ensure: "ensureSlackRunning" },
  linear: { slot: LAZY_MESH.linear, ensure: "ensureLinearRunning" },
  jira: { slot: LAZY_MESH.jira, ensure: "ensureJiraRunning" },
  notion: { slot: LAZY_MESH.notion, ensure: "ensureNotionRunning" },
  confluence: { slot: LAZY_MESH.confluence, ensure: "ensureConfluenceRunning" },
  discord: { slot: LAZY_MESH.discord, ensure: "ensureDiscordRunning" },
  apple: { slot: LAZY_MESH.apple, ensure: "ensureAppleRunning" },
  obsidian: { slot: LAZY_MESH.obsidian, ensure: "ensureObsidianRunning" },
  // D3a: the listing slot (no network) only LISTS the nine k8s tools; the runner executes them.
  kubernetes: { slot: LAZY_MESH.kubernetes, ensure: "ensureKubernetesRunning" },
};

/** One {@link LazyConnectorMesh.listFirstPartyServerTools} entry: its slot, credential and ensure. */
interface FirstPartyListingEntry {
  readonly slot: string;
  /** The SERVICE's own credential is stored. Reads the Vault/context only: no refresh, no network. */
  configured(): Promise<boolean>;
  /** Ensures exactly {@link slot}; never another slot. */
  ensure(): Promise<void>;
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
  /**
   * Per-SLOT generation: bumped whenever that slot's client is set (spawned) or stopped. Unlike the
   * global {@link toolsEpoch}, unrelated activity (another slot spawning, idling out, an extension
   * slot) never changes a slot's generation, so the connector-write door can tell "this server
   * restarted since its tools were listed" from "something else moved".
   */
  private readonly slotGenerations = new Map<string, number>();
  /**
   * The first-party services the LATEST {@link listFirstPartyServerTools} call for them confirmed
   * mapped, configured and present in their slot's listing. {@link toolsGenerationFor} is
   * synchronous and must not read the Vault, so it answers `-1` for a service outside this set.
   */
  private readonly listedFirstParty = new Set<string>();
  private readonly firstPartyListing: Readonly<Record<string, FirstPartyListingEntry>>;
  private readonly spawnContext: MeshSpawnContext;
  private readonly iacRunner: IacRunner;
  private readonly iacPathDeps: IacPathDeps;
  private readonly paths: PlatformPaths;
  private readonly removeSandboxDir: (dir: string) => void;
  private readonly sandboxDirExists: (dir: string) => boolean;
  private readonly filesystemSpawnGate: Promise<void> | undefined;
  private readonly extensionSlots: ExtensionSlots;
  /** The configured `[[filesystem.roots]]` the Obsidian connector reads (each vault's daily note it may write). */
  private readonly obsidianRoots: readonly string[];
  private readonly obsidianGrantDeps: DailyNoteGrantDeps;
  private readonly obsidianNow: () => Date;
  /** The UTC date the live Obsidian client's daily-note grant is for; undefined without a grant. */
  private obsidianGrantDay: string | undefined;
  /** Windows only: the fail-closed revoke of the Obsidian profile's ACEs before each grant. */
  private readonly obsidianRevoker: AppContainerGrantRevoker;
  /** Windows only: every path ever handed a write grant and not yet revoked, persisted. */
  private readonly obsidianLedger: ObsidianGrantLedgerStore;
  private obsidianRevokeFailing = false;
  /** The GitHub Enterprise Server host the GitHub child was (or will next be) started with. */
  private githubInstanceHost: string | null = null;
  /** Bumped by every spawn record, so an older {@link primeGithubInstance} read cannot overwrite it. */
  private githubInstanceSeq = 0;
  /** Tail of the Obsidian spawn/restart queue (see {@link runObsidianSerial}). */
  private obsidianTail: Promise<void> = Promise.resolve();

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
    },
  ) {
    // Only stored here; `collectBuiltInToolMaps` and `listUserMcpTools` await it (undefined means
    // no gate).
    this.filesystemSpawnGate = options?.filesystemSpawnGate;
    this.paths = paths;
    this.removeSandboxDir =
      options?.removeSandboxDir ?? ((dir) => rmSync(dir, { recursive: true, force: true }));
    this.sandboxDirExists = options?.sandboxDirExists ?? existsSync;
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
          paths.sandboxDir,
        ),
      },
    });
    const platform = options?.platform ?? process.platform;
    this.obsidianRoots = options?.obsidianVaultPaths ?? [];
    this.obsidianNow = options?.now ?? (() => new Date());
    this.obsidianGrantDeps = options?.obsidianWriteGrantDeps ?? {
      now: () => this.obsidianNow(),
      discoverVaults: (roots) => discoverVaultsForWriteGrant(roots),
      realpath: (p) => realpathSync.native(p),
      homeDir: homedir(),
      // The extension-grant rule: Nimbus's data, config and sandbox dirs plus the extensions dir.
      protectedRoots: [...userMcpProtectedRootsFor(paths), paths.extensionsDir],
      platform,
    };
    this.obsidianRevoker =
      options?.obsidianGrantRevoker ??
      appContainerGrantRevokerFor(platform, manifestForFirstParty("obsidian").id);
    this.obsidianLedger =
      options?.obsidianGrantLedger ??
      fileObsidianGrantLedger(obsidianGrantLedgerFile(paths.configDir));
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
    this.iacPathDeps = {
      platform,
      realpath: (p) => realpathSync.native(p),
      isDirectory: (p) => {
        try {
          return statSync(p).isDirectory();
        } catch {
          return false;
        }
      },
      homeDir: homedir(),
      tmpDir: tmpdir(),
      // Nimbus's own folders: no approved Terraform directory may overlap them.
      protectedRoots: iacProtectedRootsFor(paths, platform, processEnvGet("XDG_RUNTIME_DIR")),
      gitScan: (dir) => scanForGitEntry(dir),
    };
    this.iacRunner = new IacRunner({
      paths,
      vault,
      platform,
      grants: options?.iacGrants ?? (() => EMPTY_IAC_GRANTS),
      ...(options?.k8sGrants === undefined ? {} : { k8sGrants: options.k8sGrants }),
      pathDeps: this.iacPathDeps,
      ...options?.iacRunnerDeps,
    });
    this.firstPartyListing = this.buildFirstPartyListing();
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

  getToolsEpoch(): number {
    return this.toolsEpoch;
  }

  private bumpToolsEpoch(): void {
    this.toolsEpoch += 1;
  }

  private bumpSlotGeneration(key: string): void {
    this.slotGenerations.set(key, (this.slotGenerations.get(key) ?? 0) + 1);
  }

  /**
   * The explicit listing map: the 15 phase-3 services on the phase-3 bundle (the 11 of C1 plus aws, azure and gcp, and iac for D2) (today's spawner probe)
   * and each per-service-slot service (`WAVE2_LISTING`) on its own slot. Each `ensure` calls the mesh's own `ensure*Running`
   * method at call time (a test seam), and names exactly that service's slot.
   */
  private buildFirstPartyListing(): Readonly<Record<string, FirstPartyListingEntry>> {
    const out: Record<string, FirstPartyListingEntry> = {};
    for (const [service, adder] of Object.entries(PHASE3_LISTING_ADDERS)) {
      out[service] = {
        slot: LAZY_MESH.phase3Bundle,
        configured: async () => {
          const probe: Record<string, ServerSpec> = {};
          await adder(this.vault, probe, this.spawnContext.sandboxCwd);
          return Object.hasOwn(probe, service);
        },
        ensure: () => this.ensurePhase3BundleRunning(),
      };
    }
    for (const [service, row] of Object.entries(WAVE2_LISTING)) {
      out[service] = {
        slot: row.slot,
        configured: () => isServiceCredentialConfigured(this.vault, service, this.spawnContext),
        // Looked up at call time (a test seam), not captured.
        ensure: () => (this[row.ensure] as () => Promise<void>)(),
      };
    }
    return out;
  }

  private firstPartyListingEntry(service: string): FirstPartyListingEntry | undefined {
    return Object.hasOwn(this.firstPartyListing, service)
      ? this.firstPartyListing[service]
      : undefined;
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
    this.bumpSlotGeneration(key);
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
      this.forgetExtensionSlot(key);
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
    let disconnected: Promise<void> | undefined;
    if (c !== undefined) {
      this.bumpToolsEpoch();
      this.bumpSlotGeneration(key);
      disconnected = c.disconnect().then(
        () => undefined,
        () => undefined,
      );
      // From the moment the client is cleared, a listing would start a new spawn. For an extension
      // that spawn must wait until THIS child's disconnect has finished (I43): the next run stages a
      // fresh copy in the same leaf, so the previous child must be disconnected and signalled before it is made. This
      // covers the un-awaited idle teardown too. Other slot kinds are unaffected.
      if (key.startsWith(EXT_MESH_PREFIX)) {
        this.extensionSlots.trackStopping(key.slice(EXT_MESH_PREFIX.length), disconnected);
      }
    }
    this.forgetExtensionSlot(key);
    if (slot.idleTimer === undefined) {
      this.lazySlots.delete(key);
    }
    if (disconnected !== undefined) await disconnected;
  }

  /** Drops the running record of the extension whose slot `key` names (no-op for any other key). */
  private forgetExtensionSlot(key: string): void {
    if (key.startsWith(EXT_MESH_PREFIX)) {
      this.extensionSlots.forgetService(key.slice(EXT_MESH_PREFIX.length));
    }
  }

  /**
   * Detach the slot `key` NOW: its client is cleared, the slot generation and the tools epoch are
   * bumped and the slot record is dropped (a new client gets a fresh drain tracker), so nothing new
   * reaches the old client. Its in-flight calls drain (at most 10 minutes) and it is disconnected in
   * the background; the returned promise settles then and never rejects.
   */
  private detachLazyClient(key: string): Promise<void> {
    this.clearLazyIdle(key);
    const slot = this.lazySlots.get(key);
    this.lazySlots.delete(key);
    const c = slot?.client;
    if (slot === undefined || c === undefined) return Promise.resolve();
    slot.client = undefined;
    this.bumpToolsEpoch();
    this.bumpSlotGeneration(key);
    const drained =
      slot.drain.count > 0
        ? Promise.race([
            slot.drain.awaitDrain(),
            new Promise<void>((r) => setTimeout(r, 10 * 60_000)),
          ])
        : Promise.resolve();
    return drained.then(() => disconnectQuietly(c));
  }

  private async stopUserMcpClient(serviceId: string): Promise<void> {
    await this.stopLazyClient(userMcpMeshKey(serviceId));
  }

  /** Directories no user MCP may be granted a read of: Nimbus's own data, config and sandbox root. */
  userMcpProtectedRoots(): readonly string[] {
    return userMcpProtectedRootsFor(this.paths);
  }

  /**
   * Stops a removed user MCP and deletes its sandbox leaf. Best-effort and NEVER throws: a Windows
   * child releases its cwd handle a moment after it exits, so the delete is tried up to three times
   * 100 ms apart, and a leaf that still will not go is logged, not raised — `connector.remove` must
   * not fail on a locked directory.
   */
  async removeUserMcpSandbox(serviceId: string): Promise<void> {
    try {
      await this.stopUserMcpClient(serviceId);
    } catch (err) {
      this.logger?.warn({ serviceId, err }, "user MCP client not stopped before sandbox removal");
    }
    const leaf = this.userMcpSandboxLeaf(serviceId);
    const lastErr = await this.deleteSandboxLeaf(leaf);
    if (lastErr !== undefined) {
      this.logger?.warn({ serviceId, err: lastErr }, "user MCP sandbox directory not removed");
    }
  }

  /** The deterministic sandbox leaf a user MCP server with this id spawns in. */
  userMcpSandboxLeaf(serviceId: string): string {
    return sandboxCwdFor(this.paths.sandboxDir, `user.${serviceId}`);
  }

  /**
   * Ensures no sandbox leaf is left over for `serviceId` before it is (re-)registered. The leaf is
   * deterministic and `removeUserMcpSandbox` is best-effort, so a removed registration whose leaf a
   * Windows lock kept alive would otherwise hand its files to the NEXT server registered under the
   * same id — the sandbox wrapper's recursive mkdir keeps whatever is there. Deletes a leftover leaf
   * with the same retry policy as removal; returns `false` when the leaf still exists afterwards,
   * and the caller must then refuse the registration. Never throws.
   */
  async ensureUserMcpSandboxClean(serviceId: string): Promise<boolean> {
    const leaf = this.userMcpSandboxLeaf(serviceId);
    if (!this.sandboxDirExists(leaf)) return true;
    const lastErr = await this.deleteSandboxLeaf(leaf);
    if (lastErr === undefined && !this.sandboxDirExists(leaf)) return true;
    this.logger?.warn(
      { serviceId, err: lastErr },
      "stale user MCP sandbox directory not cleared before registration",
    );
    return false;
  }

  /**
   * Deletes a sandbox leaf, tried up to three times 100 ms apart (a Windows child releases its cwd
   * handle a moment after it exits). Returns the last error when every attempt failed, else
   * `undefined`. Never throws.
   */
  private async deleteSandboxLeaf(leaf: string): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.removeSandboxDir(leaf);
        return undefined;
      } catch (err) {
        lastErr = err ?? new Error("sandbox directory delete failed");
        if (attempt < 3) await Bun.sleep(100); // NOSONAR S9382: a retry backoff is sequential by definition
      }
    }
    return lastErr;
  }

  /**
   * Stops an extension's client (disable, revoke, a failed startup verify). Keyed by the manifest
   * id the callers hold; the slot is found through the running record, which outlives the grant
   * row, so a stop after the grant is deleted still stops the child.
   */
  public async stopExtensionClient(extensionId: string): Promise<void> {
    // First, synchronously: a preparation already in flight for this extension must not connect.
    this.extensionSlots.markStopped(extensionId);
    await this.stopUserMcpClient(extensionId);
    await this.stopLazyClient(extensionId);
    const serviceId = this.extensionSlots.serviceIdFor(extensionId);
    if (serviceId !== undefined) {
      await this.stopLazyClient(extensionMeshKey(serviceId));
    }
  }

  /** True while the extension has a live client in its `mesh:ext:` slot. */
  isExtensionRunning(extensionId: string): boolean {
    return this.extensionSlots.isRunning(extensionId);
  }

  /**
   * Stops an extension's slot and deletes its stage root and its old sandbox leaf. Same best-effort,
   * never-throws, three-attempt contract as {@link removeUserMcpSandbox}.
   */
  async removeExtensionSandbox(serviceId: string): Promise<void> {
    try {
      await this.stopLazyClient(extensionMeshKey(serviceId));
    } catch (err) {
      this.logger?.warn({ serviceId, err }, "extension client not stopped before sandbox removal");
    }
    // Both: the stage root every spawn now runs in, and the `ext.<serviceId>` per-policy leaf that
    // earlier builds of this branch staged into (harmless when absent).
    // Two disjoint directories, each with its own never-throwing retry loop: deleted concurrently.
    const dirs = [
      extensionStageRootFor(this.paths.sandboxDir, serviceId),
      sandboxCwdFor(this.paths.sandboxDir, `ext.${serviceId}`),
    ];
    const lastErrs = await Promise.all(dirs.map((dir) => this.deleteSandboxLeaf(dir)));
    dirs.forEach((dir, i) => {
      const lastErr = lastErrs[i];
      if (lastErr !== undefined) {
        this.logger?.warn(
          { serviceId, dir, err: lastErr },
          "extension sandbox directory not removed",
        );
      }
    });
  }

  /**
   * The tools of ONE approved extension — its own slot only. `undefined` when no source is wired
   * or it does not list the id. A first listing (or the first after a stop / idle-out) re-verifies
   * and spawns through `prepareSpawn`; a refusal rejects with its `ExtensionRunGrantError`.
   */
  async listExtensionTools(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    return this.extensionSlots.listTools(serviceId);
  }

  /** {@link listExtensionTools}, drain-refcount wrapped like {@link listUserMcpToolsForDispatcher}. */
  async listExtensionToolsForDispatcher(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    return this.wrapSlotToolsWithDrain(
      extensionMeshKey(serviceId),
      await this.listExtensionTools(serviceId),
    );
  }

  /**
   * Calls an extension's reserved `__nimbus_sync` tool once and returns the parsed JSON body.
   * Takes the slot's UNFILTERED tool map and executes the tool directly, so the 4 MiB result cap is
   * enforced HERE — a direct execute bypasses the dispatcher's own cap. The slot's drain refcount
   * is held for the BOUNDED race, not for the underlying call: an idle-out or stop waits for the
   * call, but a call that outlives its timeout (an extension that ignores the abort) releases the
   * drain when the timeout rejects, so a stop never waits on an abandoned call. One `timeoutMs`
   * budget covers tool discovery (which may start the child) AND the call, so a slow start cannot
   * buy the call a second window. A timeout rejects; the child is left to the slot's normal
   * stop/idle path.
   */
  async callExtensionSyncTool(
    codeServerId: string,
    req: ExtensionSyncRequest,
    timeoutMs: number,
  ): Promise<unknown> {
    const key = extensionMeshKey(codeServerId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`${codeServerId} sync call exceeded ${String(timeoutMs)}ms`));
      }, timeoutMs);
    });
    let drain: { bump(): void; drop(): void } | undefined;
    let result: unknown;
    try {
      const tools = await Promise.race([
        this.extensionSlots.listToolsUnfiltered(codeServerId),
        timeout,
      ]);
      if (tools === undefined) {
        throw new Error(`${codeServerId} is not an approved extension`);
      }
      const toolKey = mcpClientToolKey(extensionServerKey(codeServerId), "__nimbus_sync");
      const tool = Object.hasOwn(tools, toolKey) ? tools[toolKey] : undefined;
      const execute = tool?.execute;
      if (execute === undefined) {
        throw new Error(`${codeServerId} does not expose the sync tool`);
      }
      // The same tracker `wrapSlotToolsWithDrain` would use, looked up the same way; held only
      // once discovery succeeded, so `finally` drops exactly what was bumped.
      drain = this.lazySlots.get(key)?.drain;
      drain?.bump();
      // try/finally rather than `.finally`: an execute that throws synchronously still drops.
      result = await Promise.race([execute(req, { abortSignal: abort.signal }), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      drain?.drop();
    }
    return JSON.parse(extractMcpToolText(result, MCP_TOOL_RESULT_MAX_BYTES));
  }

  /** One owner code server's tools: an extension (`ext_*`) or a user MCP server (anything else). */
  listOwnerCodeServerTools(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    return EXTENSION_SERVICE_ID_PATTERN.test(serviceId)
      ? this.listExtensionTools(serviceId)
      : this.listUserMcpTools(serviceId);
  }

  /** {@link listOwnerCodeServerTools} for the connector dispatcher (drain-refcount wrapped). */
  listOwnerCodeServerToolsForDispatcher(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    return EXTENSION_SERVICE_ID_PATTERN.test(serviceId)
      ? this.listExtensionToolsForDispatcher(serviceId)
      : this.listUserMcpToolsForDispatcher(serviceId);
  }

  /**
   * Nothing here awaits — `ensureUserMcpClient` is synchronous — but callers hold this as an
   * ensure-running hook and await it. `Promise.try` runs the body immediately and turns a throw
   * (from the row lookup or the client registration) into a rejection, as `async` did.
   */
  ensureUserMcpRunning(serviceId: string): Promise<void> {
    return Promise.try(() => {
      const rows = this.listUserMcpConnectors();
      const row = rows.find((r) => r.service_id === serviceId);
      if (row === undefined) {
        return;
      }
      ensureUserMcpClient(this.spawnContext, row);
    });
  }

  /**
   * The tools of ONE registered user MCP server — its own slot only, never the merged dispatcher
   * map, so `connector.userMcpTools` cannot be used to enumerate another server's (or a built-in
   * connector's) tools. `undefined` when no `user_mcp_connector` row names the id. Keys are as the
   * slot's `MCPClient` lists them: `<serviceId>_<tool>`.
   */
  async listUserMcpTools(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    const registered = this.listUserMcpConnectors().some((r) => r.service_id === serviceId);
    if (!registered) {
      return undefined;
    }
    // The same boot-revoke gate every merged listing waits on (`collectBuiltInToolMaps`): a user
    // MCP's first listing spawns it through the Windows helper, whose grants rewrite DACLs under
    // the directory the revoke is rewriting. The per-server dispatch path no longer goes through the
    // merged listing, so it waits here instead.
    await this.filesystemSpawnGate;
    await this.ensureUserMcpRunning(serviceId);
    return listLazyMeshClientTools(this.getLazyClient(userMcpMeshKey(serviceId)));
  }

  /**
   * ONE registered user-MCP server's tool DEFINITIONS for the agent door (AD5a), stripped to
   * `description` and `inputSchema`. {@link listUserMcpTools} returns callable tools; their
   * `execute` would call the sandboxed server outside the executor's HITL and egress chokepoint, so
   * it never leaves here (the shape {@link listFirstPartyServerTools} keeps for a first-party
   * server). `undefined` when no `user_mcp_connector` row names the id, or when the server lists
   * nothing (it cannot be started, or lists no tool: the MCP client swallows a failed start and
   * lists none). Keys are the slot's `<serviceId>_<tool>`; a key that does not start with
   * `<serviceId>_` is dropped, so a listing can never speak for another server. Only THIS server's
   * slot is ensured, and the call may start it: the caller is the door's definition check, reached
   * only for a tool the owner approved for agents by name. A throw is the listing's own.
   */
  async listUserMcpToolDefinitions(
    serviceId: string,
  ): Promise<Readonly<Record<string, { description: unknown; inputSchema: unknown }>> | undefined> {
    const tools = await this.listUserMcpTools(serviceId);
    if (tools === undefined) return undefined;
    const prefix = `${serviceId}_`;
    const out: Record<string, { description: unknown; inputSchema: unknown }> = {};
    for (const key of Object.keys(tools)) {
      if (!key.startsWith(prefix)) continue;
      const listed: unknown = tools[key];
      const rec =
        typeof listed === "object" && listed !== null ? (listed as Record<string, unknown>) : {};
      out[key] = { description: rec["description"], inputSchema: rec["inputSchema"] };
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }

  /**
   * {@link listUserMcpTools} for the connector dispatcher: the same ONE-slot listing, with each tool
   * wrapped in that slot's drain refcount exactly as {@link listToolsForDispatcher} wraps it, so a
   * slot stop still waits for an in-flight user-MCP call. Running a user-MCP action therefore
   * spawns only its own server, never every connector the merged listing would start.
   */
  async listUserMcpToolsForDispatcher(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    return this.wrapSlotToolsWithDrain(
      userMcpMeshKey(serviceId),
      await this.listUserMcpTools(serviceId),
    );
  }

  /** Wraps one slot's tool listing in that slot's drain refcount, so a stop waits for its calls. */
  private wrapSlotToolsWithDrain(
    key: string,
    tools: LazyMeshToolMap | undefined,
  ): LazyMeshToolMap | undefined {
    if (tools === undefined) {
      return undefined;
    }
    const drain = this.lazySlots.get(key)?.drain;
    const wrapped: LazyMeshToolMap = { ...tools };
    if (drain !== undefined) {
      this.wrapMergedToolsWithRefcount(
        wrapped,
        new Map(Object.keys(wrapped).map((key) => [key, drain])),
      );
    }
    return wrapped;
  }

  // `mesh:user:` slots only, here and in `collectUserMcpToolMap`: extension (`mesh:ext:`) tools are
  // not offered to the model until a later PR, so they never enter the merged dispatcher map, and
  // `buildSlotForToolMap` never lists an extension slot either.
  private async ensureUserMcpConnectorsRunning(): Promise<void> {
    const rows = this.listUserMcpConnectors();
    const active = new Set(rows.map((r) => r.service_id));
    // Stale slots are torn down concurrently: the stops are independent of one another, never
    // reject, and may each wait up to ten minutes for in-flight calls to drain — sequentially, one
    // draining slot held back every stop after it. The keys are snapshotted before any stop runs.
    const staleIds = Array.from(this.lazySlots.keys())
      .filter((key) => key.startsWith(USER_MESH_PREFIX))
      .map((key) => key.slice(USER_MESH_PREFIX.length))
      .filter((id) => !active.has(id));
    await Promise.all(staleIds.map((id) => this.stopUserMcpClient(id)));
    for (const row of rows) {
      ensureUserMcpClient(this.spawnContext, row);
    }
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

  /**
   * One at a time: every Obsidian spawn decision and every {@link restartObsidian}. A grant read
   * inside one step therefore never produces a client after a later restart's stop.
   */
  private runObsidianSerial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.obsidianTail.then(fn);
    this.obsidianTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * The paths a Windows revoke must cover: every ledger entry (each file some earlier spawn, in this
   * process or before a restart, was handed a write grant on) and `extra` (this spawn's files).
   * The ledger is written before any grant, so it names every file that can hold a write ACE; no
   * folder is ever granted write (the grant is one daily-note file per vault). Deduplicated.
   */
  private obsidianRevokePaths(
    ledger: readonly string[],
    extra: readonly string[],
  ): readonly string[] {
    return [...new Set([...ledger, ...extra])];
  }

  /**
   * At the start of every Obsidian spawn decision: a live client whose grant names an earlier UTC
   * day's daily note is detached (in-flight calls drain in the background), so this decision spawns
   * one for today. Without the restart the old child's appends to today's note would be refused by
   * the sandbox (it holds only yesterday's file): fail closed, but unusable until the slot idles out.
   */
  private refreshStaleObsidian(): void {
    const day = this.obsidianGrantDay;
    if (day === undefined || day === utcDay(this.obsidianNow())) return;
    this.obsidianGrantDay = undefined;
    void this.detachLazyClient(LAZY_MESH.obsidian);
  }

  /**
   * The Windows revoke of everything the ledger and the current tree name, then the ledger
   * replaced by `next`. Throws on a failed revoke or ledger write, leaving the ledger as it was.
   * With an empty ledger and nothing to grant it does nothing at all (no discovery, no helper run).
   */
  private async revokeObsidianGrants(next: readonly string[]): Promise<void> {
    const ledger = this.obsidianLedger.load();
    if (ledger.length === 0 && next.length === 0) return;
    await this.obsidianRevoker.revoke(this.obsidianRevokePaths(ledger, next));
    // Written BEFORE the spawn that grants `next`; an old entry leaves only after its revoke.
    this.obsidianLedger.save(next);
  }

  /**
   * The Obsidian pre-spawn hook. On Windows an ACE outlives its child and a grant merges rights, so
   * a spawn after a disable would keep writing: every earlier write ACE is revoked first, the new
   * write list is recorded in the ledger, and any failure refuses the spawn, logged once per failing
   * streak. Elsewhere a bind or a profile lives only as long as its child: nothing to do.
   */
  private async obsidianPreSpawn(plan: {
    readonly roots: readonly string[];
    readonly writePaths: readonly string[];
    readonly day?: string;
  }): Promise<void> {
    this.obsidianGrantDay = plan.writePaths.length > 0 ? plan.day : undefined;
    if (!this.obsidianRevoker.active) return;
    try {
      await this.revokeObsidianGrants(plan.writePaths);
    } catch (err) {
      if (!this.obsidianRevokeFailing) {
        this.logger?.warn(
          { err },
          "obsidian sandbox grants could not be revoked; the Obsidian connector is not started",
        );
      }
      this.obsidianRevokeFailing = true;
      throw err;
    }
    this.obsidianRevokeFailing = false;
  }

  /**
   * Retire the PagerDuty child so the next use respawns it with the credentials now in the Vault
   * (`PAGERDUTY_API_TOKEN` and `PAGERDUTY_FROM_EMAIL` are read at spawn only). Bumps the slot
   * generation, so a model write offered before the change refuses "ask again". Never rejects; an
   * in-flight call finishes on the old child first (the detach drain).
   */
  restartPagerduty(): void {
    void this.detachLazyClient(LAZY_MESH.pagerduty);
  }

  /**
   * Retire the Jira child so the next use respawns it with the credentials now in the Vault
   * (`JIRA_API_TOKEN`, `JIRA_EMAIL`, `JIRA_BASE_URL` and `JIRA_CLOUD_ID` are read at spawn only).
   * Called after EVERY successful `connector.auth jira`. Same contract as
   * {@link LazyConnectorMesh.restartPagerduty}.
   */
  restartJira(): void {
    void this.detachLazyClient(LAZY_MESH.jira);
  }

  /**
   * Called after EVERY `connector.auth github`, successful or not past validation. The child reads
   * `GITHUB_PAT` and `GITHUB_API_BASE_URL` at spawn only, so a changed PAT or a changed (or
   * removed) GitHub Enterprise Server base would otherwise keep serving the old credential and host
   * until an idle disconnect. Both children (`github`, `github_actions`) share this one slot.
   * Same contract as {@link LazyConnectorMesh.restartPagerduty}.
   */
  restartGithub(): void {
    void this.detachLazyClient(LAZY_MESH.github);
    // The next spawn reads the Vault again; show the same instance until then.
    void this.primeGithubInstance();
  }

  /** The GitHub Enterprise Server host[:port] the consent preview names; undefined for github.com. */
  githubInstance(): string | undefined {
    return this.githubInstanceHost ?? undefined;
  }

  /** Called by the GitHub spawn with the host it started the child with (`null`: github.com). */
  recordGithubInstance(host: string | null): void {
    this.githubInstanceSeq += 1;
    this.githubInstanceHost = host;
  }

  /**
   * Reads `github.api_base` once and snapshots its host, so a write previewed BEFORE the lazy child
   * first spawns still names the instance. A spawn's own record (above) wins over an older read that
   * finishes later; a read or validation failure shows no instance (never a raw value). Never rejects.
   */
  async primeGithubInstance(): Promise<void> {
    const seq = this.githubInstanceSeq;
    let host: string | null = null;
    try {
      const resolved = resolveGithubBase(
        await readConnectorSecret(this.vault, "github", "api_base"),
      );
      host = resolved.ok ? resolved.host : null;
    } catch {
      host = null;
    }
    if (seq === this.githubInstanceSeq) this.githubInstanceHost = host;
  }

  /**
   * Called after the owner's Obsidian opt-in changes (enable approved, or disable). Returns
   * promptly, never waiting on an in-flight call:
   *  1. the `mesh:obsidian` slot is DETACHED at once: its client is cleared and its generation and
   *     the tools epoch bumped, so no new call reaches the old child and the next call spawns under
   *     the new grant;
   *  2. on Windows the profile's write ACEs are revoked NOW, inside the same serial step, so a
   *     disable withdraws the write from the old child too (every child of the profile shares its
   *     SID) rather than after its drain;
   *  3. the old child's in-flight calls drain and it is disconnected in the background.
   * Never rejects; a failed revoke is logged, the ledger keeps its entries, and the next spawn
   * revokes again. Stated bound (Linux, macOS): an old child keeps the write it was spawned with
   * until its in-flight calls finish (at most the 10-minute drain), but no new call reaches it.
   */
  async restartObsidian(): Promise<void> {
    try {
      await this.runObsidianSerial(async () => {
        this.obsidianGrantDay = undefined;
        void this.detachLazyClient(LAZY_MESH.obsidian);
        if (this.obsidianRevoker.active) await this.revokeObsidianGrants([]);
      });
    } catch (err) {
      this.logger?.warn({ err }, "obsidian sandbox grants not revoked after the opt-in changed");
    }
  }

  /**
   * What approving the Obsidian append would let its sandbox write: the configured roots (as
   * configured), for each vault the grant keeps its daily-note file PATTERN
   * (`<vault>/<daily folder>/<format>.md`: one file a day, the date in UTC), and each vault, or
   * vault's note, that can never be granted, with the reason. For the `connector.writes.enable
   * obsidian` prompt; reads the filesystem, creates nothing, grants nothing.
   */
  obsidianWriteScope(): {
    readonly roots: readonly string[];
    readonly notes: readonly string[];
    readonly skipped: readonly {
      readonly path: string;
      readonly reason: ObsidianGrantSkip | DailyNoteSkip;
    }[];
  } {
    const g = obsidianWriteGrantPaths(this.obsidianRoots, this.obsidianGrantDeps);
    const notes: string[] = [];
    const skipped: { path: string; reason: ObsidianGrantSkip | DailyNoteSkip }[] = [...g.skipped];
    for (const vault of g.paths) {
      const r = dailyNotePattern(vault, this.obsidianGrantDeps.platform);
      if ("pattern" in r) notes.push(r.pattern);
      else skipped.push(r);
    }
    return { roots: [...this.obsidianRoots], notes, skipped };
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

  /**
   * Lists the user slots one at a time, in slot order, so a later slot still wins a shared tool
   * name. Unlike the refcount listing below, this walk stays sequential: a user slot's first
   * listing connects its `MCPClient`, which spawns the user-configured server through the sandbox
   * wrapper, and nothing caps how many user MCPs are registered. Listing them together would start
   * every one of those servers at once, and on Windows each confined spawn's helper rewrites the
   * DACL of the one shared sandbox cwd with an unlocked read-modify-write.
   */
  private async collectUserMcpToolMap(): Promise<LazyMeshToolMap> {
    let merged: LazyMeshToolMap = {};
    for (const [meshKey, slot] of this.lazySlots) {
      if (!meshKey.startsWith(USER_MESH_PREFIX) || slot.client === undefined) {
        continue;
      }
      const tools = await listLazyMeshClientTools(slot.client); // NOSONAR S9382: a user slot's first listing spawns its user-configured server; the user-MCP count is uncapped, so they start one at a time, not as a burst of sandboxed spawns
      merged = { ...merged, ...tools };
    }
    return merged;
  }

  /**
   * Lists every live slot concurrently, then maps each tool to the FIRST slot (in slot order)
   * that lists it — the same first-wins answer the one-slot-at-a-time walk gave. A slot whose
   * listing fails is skipped, as before.
   */
  private async buildSlotForToolMap(): Promise<Map<string, LazyDrainTracker>> {
    // `mesh:ext:` slots are skipped: their tools are never in the merged map, and a first-party
    // dispatch must not contact an extension's process.
    const liveSlots = Array.from(this.lazySlots.entries()).flatMap(([key, slot]) =>
      slot.client === undefined || key.startsWith(EXT_MESH_PREFIX)
        ? []
        : [{ client: slot.client, drain: slot.drain }],
    );
    const listings = await Promise.all(
      liveSlots.map(async ({ client, drain }) => {
        try {
          const tools = (await client.listTools()) as LazyMeshToolMap;
          return { drain, toolKeys: Object.keys(tools) };
        } catch {
          return undefined; // slot disappearing — skip
        }
      }),
    );
    const slotForTool = new Map<string, LazyDrainTracker>();
    for (const listing of listings) {
      if (listing === undefined) continue;
      for (const k of listing.toolKeys) {
        if (!slotForTool.has(k)) slotForTool.set(k, listing.drain);
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
    // The iac tools run in their own per-run children (D2), not in the listing slot.
    routeIacTools(merged, this.iacRunner);
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
 * Nimbus's own data, config and sandbox root — the set no user MCP (and, plus the extensions dir, no
 * extension run grant) may overlap. A function of the paths alone, so `platform/assemble.ts` can
 * build the extension runtime's grant env BEFORE the mesh it hands that runtime to exists.
 */
export function userMcpProtectedRootsFor(
  paths: Pick<PlatformPaths, "dataDir" | "configDir" | "sandboxDir">,
): readonly string[] {
  return [paths.dataDir, paths.configDir, paths.sandboxDir];
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

/** Disconnects a client; a failure is ignored (the slot is already detached). */
async function disconnectQuietly(client: { disconnect(): Promise<unknown> }): Promise<void> {
  try {
    await client.disconnect();
  } catch {
    // ignored: the client is gone either way
  }
}
