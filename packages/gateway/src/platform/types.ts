import type { ChatopsBoot } from "../chatops/chatops-boot.ts";
import type { ConnectorWriteContext } from "../connectors/connector-write-transport.ts";
import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
import type { EmbeddingReadiness } from "../embedding/embedding-readiness.ts";
import type { ExecutorDelegationDep } from "../engine/executor.ts";
import type { LocalIndex } from "../index/local-index.ts";
import type { IPCServer } from "../ipc/index.ts";
import type { LlmRegistry } from "../llm/registry.ts";
import type { SessionMemoryStore } from "../memory/session-memory-store.ts";
import type { SyncScheduler } from "../sync/scheduler.ts";
import type { NimbusVault } from "../vault/index.ts";
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
  sandboxRunner: SandboxRunner;
  /** Credential-aware deps for the connector write dispatcher (warehouse/BI ∪ GitOps/ML; wrapped in index.ts). */
  connectorWriteDeps: ConnectorWriteContext;
  // Owner-side delegated HITL (Slice 2, I20). Present when federation is enabled: the executor gate
  // routes a HITL action's approval to an active in-scope delegate before the local owner prompt.
  executorDelegation?: ExecutorDelegationDep;
  // ChatOps (Slice 5). Present when [chatops].enabled: src/index.ts late-binds the engine read
  // path (bindAskEngine) once the engine agent exists.
  chatops?: ChatopsBoot;
  /**
   * Live warm-up state of the local embedding model (#928). Always present: the gateway binds
   * its IPC socket BEFORE the model is loaded, so the boot log and every client need a way to
   * tell "warming" from "disabled" from "fetch failed".
   */
  embeddingReadiness: () => EmbeddingReadiness;
  disposeSidecars?: () => void;
}
