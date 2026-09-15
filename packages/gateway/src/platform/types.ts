import type { ChatopsBoot } from "../chatops/chatops-boot.ts";
import type { ConnectorWriteContext } from "../connectors/connector-write-transport.ts";
import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import type { EmbeddingReadiness } from "../embedding/embedding-readiness.ts";
import type { AskExplainRecorder } from "../engine/ask-explain-recorder.ts";
import type { ExecutorDelegationDep, ExecutorPolicyDep } from "../engine/executor.ts";
import type { FleetScheduler } from "../fleet/fleet-scheduler.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { IPCServer } from "../ipc/index.ts";
import type { LlmRegistry } from "../llm/registry.ts";
import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import type { SyncScheduler } from "../sync/scheduler.ts";
import type { ToolgenRegistry } from "../toolgen/toolgen-registry.ts";
import type { NimbusVault } from "../vault/index.ts";
import type { AgentVendor } from "./assemble.ts";
import type { HostActivity } from "./host-activity.ts";
import type { PlatformPaths } from "./paths.ts";
import type { SandboxRunner } from "./sandbox/sandbox-runner.ts";

export interface AutostartManager {
  isEnabled(): Promise<boolean>;
  enable(): Promise<void>;
  disable(): Promise<void>;
}

export interface NotificationService {
  show(title: string, body: string): Promise<void>;
}

export interface PlatformServices {
  vault: NimbusVault;
  ipc: IPCServer;
  paths: PlatformPaths;
  localIndex: LocalIndex;
  connectorMesh: LazyConnectorMesh;
  syncScheduler: SyncScheduler;
  autostart: AutostartManager;
  notifications: NotificationService;
  openUrl(url: string): Promise<void>;
  sessionMemoryStore?: SessionMemoryStore;
  llmRegistry: LlmRegistry;
  /**
   * The `[llm.remote.<vendor>]` vendor the Mastra engine agent talks to, or `undefined` when none
   * is enabled AND keyed — in which case `gateway-main.ts` does not construct the agent at all.
   * That absence is the point: `@mastra/core` resolves a vendor key from the ENVIRONMENT on its
   * own once an agent exists, so "constructed but refusing" would leave a hole exactly the size
   * of the default `nimbus ask`.
   */
  agentVendor?: AgentVendor;
  sandboxRunner: SandboxRunner;
  /** Host power/idle state, used by the fleet scheduler and by `[embedding] pause_on_battery`. */
  hostActivity: HostActivity;
  /**
   * S2 runtime tool generation (I39). Always constructed (like `sandboxRunner`) even when
   * `[tool_generation] enabled` is false — the registry itself has no on/off switch, only
   * `createGeneratedTool` refuses before anything is registered. `gateway-main.ts`'s shutdown
   * drains it (`revokeAll()`) alongside `removeAllToolScripts` — the in-memory half and the
   * on-disk half of "ephemeral means ephemeral."
   */
  toolgenRegistry: ToolgenRegistry;
  /**
   * The overnight agent fleet's 60-second tick. ABSENT — not a disabled instance — when `[fleet]
   * enabled` is false or no `[[fleet.job]]` is configured, which is the default on both counts, so
   * `undefined` here means nothing was constructed rather than something is idling.
   */
  fleetScheduler?: FleetScheduler;
  /** Credential-aware deps for the connector write dispatcher (warehouse/BI ∪ GitOps/ML; wrapped in index.ts). */
  connectorWriteDeps: ConnectorWriteContext;
  // Owner-side delegated HITL (Slice 2, I20). Present when federation is enabled: the executor gate
  // routes a HITL action's approval to an active in-scope delegate before the local owner prompt.
  executorDelegation?: ExecutorDelegationDep;
  // I22 — the tighten-only HITL overlay resolved from the signature-verified org policy.
  // Always present: a gateway with no org policy still gets an overlay that adds nothing,
  // so a consumer never has to decide what `undefined` means.
  policyHitl: ExecutorPolicyDep;
  // ChatOps (Slice 5). Present when [chatops].enabled: src/index.ts late-binds the engine read
  // path (bindAskEngine) once the engine agent exists.
  chatops?: ChatopsBoot;
  /**
   * Live warm-up state of the local embedding model (#928). Always present: the gateway binds
   * its IPC socket BEFORE the model is loaded, so the boot log and every client need a way to
   * tell "warming" from "disabled" from "fetch failed".
   */
  embeddingReadiness: () => EmbeddingReadiness;
  /**
   * `nimbus explain last` (spec §4). ONE recorder for the process's whole lifetime, shared by
   * every `runAsk` call site — both `gateway-main.ts` wires it to (`setAgentInvokeHandler` and
   * the ChatOps `bindAskEngine` path), so a ring bounded per-recorder (not per-caller) is what
   * "last" means. Always constructed, like `sandboxRunner` and `toolgenRegistry`: recording is
   * in-memory-only and has no on/off switch of its own.
   */
  askExplainRecorder: AskExplainRecorder;
  disposeSidecars?: () => void;
}
