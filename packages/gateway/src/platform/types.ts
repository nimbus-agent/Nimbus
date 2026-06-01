import type { LazyConnectorMesh } from "../connectors/lazy-mesh/index.ts";
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
  disposeSidecars?: () => void;
}
