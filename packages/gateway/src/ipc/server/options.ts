import type { ProfileManager } from "../../config/profiles.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import type { AutoUpdateRuntimeBag } from "../../extensions/auto-update-init.ts";
import type { PublisherKeyFetcher } from "../../extensions/registry-client.ts";
import type { DiscoveryProvider } from "../../federation/discovery.ts";
import type { PeerPairing } from "../../federation/peer-pairing.ts";
import type { IdentityStore } from "../../identity/identity-store.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { LlmRegistry } from "../../llm/registry.ts";
import type { SessionMemoryStore } from "../../memory/session-memory-store.ts";
import type { SandboxRunner } from "../../platform/sandbox/sandbox-runner.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import type { Updater } from "../../updater/updater.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { VoiceService } from "../../voice/service.ts";
import type { StatusReaders } from "../admin-status-rpc.ts";
import type { AgentInvokeHandler } from "../agent-invoke.ts";
import type { BoxKeypair } from "../lan-crypto.ts";
import type { PairingWindow } from "../lan-pairing.ts";
import type { LanServer } from "../lan-server.ts";
import type { PolicyRpcCtx } from "../policy-rpc.ts";
import type { ClientSession } from "../session.ts";
import type { WorkflowRunHandler } from "../workflow-invoke.ts";

export type BunSessionData = { session: ClientSession };

export type CreateIpcServerOptions = {
  listenPath: string;
  vault: NimbusVault;
  version: string;
  localIndex?: LocalIndex;
  extensionsDir?: string;
  openUrl?: (url: string) => Promise<void>;
  syncScheduler?: SyncScheduler;
  connectorMesh?: LazyConnectorMesh;
  getEmbeddingStatus?: () => Record<string, unknown>;
  // Observability snapshot (Task 15). The per-field readers behind `admin.status`. Present only when
  // assembled at boot; the admin dispatcher skips cleanly (method-not-found) when unset.
  statusReaders?: StatusReaders;
  startedAtMs?: number;
  agentInvoke?: AgentInvokeHandler;
  workflowRun?: WorkflowRunHandler;
  sessionMemoryStore?: SessionMemoryStore;
  dataDir?: string;
  configDir?: string;
  onClientConnected?: (clientId: string) => void;
  llmRegistry?: LlmRegistry;
  voiceService?: VoiceService;
  updater?: Updater;
  lanServer?: LanServer;
  lanPairingWindow?: PairingWindow;
  profileManager?: ProfileManager;
  sandboxRunner?: SandboxRunner;
  extensionsPublisherKeyFetcher?: PublisherKeyFetcher;
  extensionsEnforceAirGap?: boolean;
  extensionsAutoUpdate?: AutoUpdateRuntimeBag;
  extensionsAutoUpdateDiag?: {
    cachedUpdatesCount: () => number;
    intervalHours: number;
    airGapBlocked: boolean;
  };
  // Federation (Phase 6 Slice 1). Constructed at gateway boot (deferred to Task 15); the
  // dispatcher skips cleanly when these are unset.
  federationConsentTimeoutSeconds?: number;
  federationDiscovery?: DiscoveryProvider;
  federationPairing?: PeerPairing;
  federationIdentity?: BoxKeypair;
  // Identity (Phase 6 Slice 3). Present only when [identity].enabled; dispatcher skips cleanly when unset.
  identityStore?: IdentityStore;
  identityIssuer?: string;
  identityGraceSeconds?: number;
  identityStartLogin?: () => { jobId: string };
  identityVault?: NimbusVault; // for scim.setToken
  // Team Vault (Phase 6 Slice 2). The anchor's invoke backing: per-action quorum lookup + the
  // credential-injecting runTool. Present only when [federation].enabled; the federation dispatcher
  // throws ERR_TEAMVAULT_UNAVAILABLE when unset, and teamvault.*/hitl.* dispatch skips cleanly.
  teamVault?: {
    quorumFor: (toolId: string) => { approvers: number; windowSeconds: number } | undefined;
    runTool: (input: {
      entry: string;
      service: string;
      toolId: string;
      args: unknown;
    }) => Promise<unknown>;
  };
  // Policy / admin / GDPR-purge (Phase 6 Slice 4). The dependency seam behind the policy.* + team.purge
  // IPC namespace (Lanes A–G). Present only when assembled at boot; the dispatcher skips cleanly when unset.
  policyRpcCtx?: PolicyRpcCtx;
};
