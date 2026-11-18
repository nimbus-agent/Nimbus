import type { Updater } from "../updater/updater.ts";
import type { AgentInvokeHandler } from "./agent-invoke.ts";
import type { ConsentCoordinator } from "./consent.ts";
import type { WorkflowRunHandler } from "./workflow-invoke.ts";

export interface IPCServer {
  readonly listenPath: string;
  readonly consent: ConsentCoordinator;
  start(): Promise<void>;
  stop(): Promise<void>;
  setAgentInvokeHandler(handler: AgentInvokeHandler | undefined): void;
  setWorkflowRunHandler(handler: WorkflowRunHandler | undefined): void;
  setUpdater(updater: Updater): void;
  broadcast(method: string, params: Record<string, unknown>): void;
  /**
   * Write one notification to ONE live connection (the computer-use prompts, I35 OR-MCU-2). `false`
   * when that connection is not live: nothing is sent to anyone else instead.
   */
  notify(clientId: string, method: string, params: Record<string, unknown>): boolean;
}
