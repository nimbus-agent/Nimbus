import type { AgentInvokeHandler } from "../agent-invoke.ts";
import type { ConsentCoordinatorImpl } from "../consent.ts";
import type { StreamRegistry } from "../engine-ask-stream.ts";
import type { WorkflowRunHandler } from "../workflow-invoke.ts";
import type { ClientKind } from "./client-kind.ts";
import type { CreateIpcServerOptions } from "./options.ts";

export interface ServerCtx {
  readonly options: CreateIpcServerOptions;
  readonly consentImpl: ConsentCoordinatorImpl;
  readonly startedAtMs: number;
  readonly streamRegistry: StreamRegistry;
  broadcastNotification(method: string, params: Record<string, unknown>): void;
  getAgentInvokeHandler(): AgentInvokeHandler | undefined;
  getWorkflowRunHandler(): WorkflowRunHandler | undefined;
  getClientKind(clientId: string): ClientKind;
}

export const connectorRpcSkipped: unique symbol = Symbol("connectorRpcSkipped");
export const peopleRpcSkipped: unique symbol = Symbol("peopleRpcSkipped");
export const sessionRpcSkipped: unique symbol = Symbol("sessionRpcSkipped");
export const automationRpcSkipped: unique symbol = Symbol("automationRpcSkipped");
export const phase4RpcSkipped: unique symbol = Symbol("phase4RpcSkipped");
export const diagnosticsRpcSkipped: unique symbol = Symbol("diagnosticsRpcSkipped");
export const metricsRpcSkipped: unique symbol = Symbol("metricsRpcSkipped");
export const preflightRpcSkipped: unique symbol = Symbol("preflightRpcSkipped");
export const deploymentRpcSkipped: unique symbol = Symbol("deployment-rpc-skipped");
