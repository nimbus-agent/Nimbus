// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.

import type { PairingWindowController } from "../../clips/pairing-window.ts";
import type { ProfileManager } from "../../config/profiles.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import type { DecisionRefresher } from "../../decisions/decision-refresh.ts";
import type { EmbeddingReadiness } from "../../embedding/embedding-readiness.ts";
import type { ConnectorDispatcher } from "../../engine/types.ts";
import type { AutoUpdateRuntimeBag } from "../../extensions/auto-update-init.ts";
import type { PublisherKeyFetcher } from "../../extensions/registry-client.ts";
import type { DiscoveryProvider } from "../../federation/discovery.ts";
import type { PeerPairing } from "../../federation/peer-pairing.ts";
import type { GlossaryRefresher } from "../../glossary/glossary-refresh.ts";
import type { IdentityStore } from "../../identity/identity-store.ts";
import type { LocalIndex } from "../../index/local-index.ts";
import type { LlmRegistry } from "../../llm/registry.ts";
import type { SessionMemoryStore } from "../../memory/session-memory-store.ts";
import type { SandboxRunner } from "../../platform/sandbox/sandbox-runner.ts";
import type { ShareFile } from "../../share/share-format.ts";
import type { ForwardShareDeps, ReceiveShareDeps } from "../../share/share-forward.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import type { Updater } from "../../updater/updater.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { VoiceService } from "../../voice/service.ts";
import type { StatusReaders } from "../admin-status-rpc.ts";
import type { AgentInvokeHandler } from "../agent-invoke.ts";
import type { ChatopsRpcCtx } from "../chatops-rpc.ts";
import type { EgressRpcCtx } from "../egress-rpc.ts";
import type { BoxKeypair } from "../lan-crypto.ts";
import type { PairingWindow } from "../lan-pairing.ts";
import type { LanServer } from "../lan-server.ts";
import type { PolicyRpcCtx } from "../policy-rpc.ts";
import type { ClientSession } from "../session.ts";
import type { ShareRpcCtx } from "../share-rpc.ts";
import type { TribalRpcCtx } from "../tribal-rpc.ts";
import type { WorkflowRunHandler } from "../workflow-invoke.ts";
import type { ClientKindStore } from "./client-kind.ts";

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
  // #928 — live warm-up state for the local embedding model. Read by `gateway.ping` (so a
  // client can show real download progress) and by `index.searchRanked` (so a semantic query
  // returns the typed warming condition instead of a lexical-only result that looks complete).
  embeddingReadiness?: () => EmbeddingReadiness;
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
  // Per-connection client-kind store (Task 2, S1 agents-as-MCP-tools). Optional DI seam: when
  // omitted, `createIpcServer` constructs its own. Tests inject their own instance so they can
  // observe `declare()`/`forget()` firing from the real wiring (attachSession's disconnect
  // callback, dispatchMethod's `session.declareKind` arm) without reaching into server.ts internals
  // or calling the store's mutators directly from the test.
  clientKinds?: ClientKindStore;
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
  // ChatOps (Phase 6 Slice 5). The dependency seam behind the chatops.* IPC namespace (status,
  // start, stop, test). Present only when [chatops].enabled at boot; the dispatcher skips when unset.
  chatopsRpcCtx?: ChatopsRpcCtx;
  // Tribal-knowledge extraction (Phase 6 Slice 6c). The dependency seam behind the tribal.* IPC
  // namespace (status, start, stop, list, dismiss, scan; capture added with the write path).
  // Present only when [tribal].enabled at boot; the dispatcher skips when unset. LAN-forbidden.
  tribalRpcCtx?: TribalRpcCtx;
  // Connector dispatch seam for the I25 tribal capture write (the KB-append tools). The capture
  // executor is built PER-CALL in the dispatcher with the initiating client's consent; this
  // provides the MCP dispatch target. Present only when [tribal].enabled at boot.
  tribalConnectorDispatcher?: ConnectorDispatcher;
  // Share & Virality (Phase 6 Slice 8). The dependency seam behind the share.* IPC namespace.
  // share.create gates through the owner consent broker (I27, fail-closed on timeout/deny); the four
  // reads + share.approvalRespond are pure. Present only when assembled at boot; the dispatcher skips
  // cleanly when unset. share.create/share.prune are LAN-forbidden (I5); only share.get/list/pubkey/
  // verify are Tauri-exposed (I7).
  shareRpcCtx?: ShareRpcCtx;
  // Egress Ledger. The dependency seam behind the egress.* IPC namespace (list, verify, head,
  // proveWindow, prune). egress.prune gates through requestPruneApproval (owner HITL, I2, fail-closed).
  // Present only when assembled at boot; the dispatcher skips cleanly when unset. egress.prune is
  // NOT Tauri-exposed (I7 — mutation/RCE-class surface); only the 4 read verbs are renderer-callable.
  egressRpcCtx?: EgressRpcCtx;
  // Glossary (S1 Local Brain). The dependency seam behind the glossary.* IPC namespace
  // (refresh, rebuild — both long-running jobs, see ipc/glossary-rpc.ts). Always present
  // once assembled at boot; when [glossary].enabled is false, the refresher reports
  // ERR_GLOSSARY_DISABLED on startPass, ensuring an explicit error instead of method
  // not found. Both methods are LAN-forbidden (I5) — refresh spends the owner's local
  // model, rebuild truncates both glossary tables. Not Tauri-exposed (I7 — no desktop
  // glossary surface).
  glossaryRefresher?: GlossaryRefresher;
  // Decisions (S1 Local Brain). The dependency seam behind the decisions.* IPC namespace
  // (refresh, rebuild — both long-running jobs backed by the post-sync debounced extraction
  // pass, see ipc/decisions-rpc.ts + decisions/decision-refresh.ts). Unlike glossaryRefresher,
  // construction itself is gated on `[decisions].enabled`: absent when decisions are disabled,
  // rather than always-present-but-internally-gated — so an absent refresher yields "Method not
  // found" rather than an explicit ERR_DECISIONS_DISABLED. Not Tauri-exposed (I7 — no desktop
  // decisions maintenance surface; the read-only agents.decisions covers that).
  decisionsRefresher?: DecisionRefresher;
  // Share forwarding — asker-side (Slice 8d, I27 second chokepoint). Present only when federation is
  // enabled; the federation dispatcher fails closed (ERR_SHARE_FORWARD_UNAVAILABLE) when unset.
  // `federation.shareForward` is local-only (FORBIDDEN_OVER_LAN, I5).
  federationForwardShareDeps?: ForwardShareDeps;
  // Resolve a peerId or raw b64 pubkey to a b64 pubkey; undefined when the peer is unknown.
  federationResolvePeerPubkey?: (peerIdOrPubkey: string) => string | undefined;
  // Share receiving — answerer-side (Slice 8d). Wired into the LAN server's FederationRpcContext so
  // inbound `federation.shareReceive` calls can persist the share; absent → fails closed.
  federationReceiveShareDeps?: ReceiveShareDeps;
  // 8d origin emit: deliver an already-approved (createShare-HITL'd) share to a peer over the wire
  // (resolve peerId→pubkey→reachable peer→federation.shareReceive). Present only when federation is
  // enabled; share.create --to-peer reports delivered:false when unset/unreachable (share stays local).
  shareDeliverToPeer?: (share: ShareFile, peerId: string) => Promise<boolean>;
  // Web-clipper clip.* IPC namespace (Task 7). The SINGLETON PairingWindowController shared with
  // the read-only HTTP server's /v1/clips/pair/confirm route (Task 6). Present only when assembled
  // at boot; the clip.* dispatcher skips cleanly when unset.
  clipPairingController?: PairingWindowController;
  // The gateway's loopback HTTP origin (e.g. `http://127.0.0.1:7474`), set at boot from
  // NIMBUS_HTTP_PORT. Echoed by `clip.pair` so the CLI can print the exact URL to pair against.
  // Absent when the gateway runs without the HTTP sidecar (then the clip surface is unreachable).
  clipHttpBaseUrl?: string;
  // Research briefs (Spine S1) enable-state, echoed by `clip.status` so `nimbus clip status` can
  // tell a paired user whether their first brief will 404 (default-off — see [briefs] in
  // nimbus.toml). Always set at boot (not gated on the briefs seam being wired), so it is never
  // left undefined by omission.
  briefsEnabled?: boolean;
};
