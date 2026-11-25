import type { Database } from "bun:sqlite";
import type { Logger } from "pino";
import type { AutoUpdateRpcDeps } from "../extensions/auto-update-rpc.ts";
import type { ConnectorRequirementStatusesFn } from "../extensions/connector-requirements.ts";
import type { ContinuityEntry } from "../extensions/continuity/continuity-table.ts";
import type { ExtensionEvidenceDeps } from "../extensions/extension-evidence.ts";
import type { ReachRunner } from "../extensions/extension-reach.ts";
import type { ExtensionRunGrantEnv } from "../extensions/extension-run-grants.ts";
import type { NimbusVault } from "../vault/index.ts";
import { EXTENSION_INSTALL_HANDLERS } from "./automation-rpc/extension-install.ts";
import { EXTENSION_LIFECYCLE_HANDLERS } from "./automation-rpc/extension-lifecycle.ts";
import { EXTENSION_READ_HANDLERS } from "./automation-rpc/extension-read.ts";
import { EXTENSION_RUN_HANDLERS } from "./automation-rpc/extension-run.ts";
import type {
  AutomationCtx,
  AutomationEvalDeps,
  AutomationHandler,
  AutomationOwnerGate,
  AutomationRpcExtensionMeshHandle,
  AutomationRpcExtensionSyncHandle,
  Hit,
} from "./automation-rpc/shared.ts";
import { WATCHER_HANDLERS } from "./automation-rpc/watcher.ts";
import { WORKFLOW_HANDLERS } from "./automation-rpc/workflow.ts";
import { asRecord } from "./connector-rpc-shared.ts";
import type { ClientKind } from "./server/client-kind.ts";

export { orphanedDependenciesOrNone } from "./automation-rpc/extension-lifecycle.ts";
export {
  type AutomationEvalDeps,
  type AutomationOwnerGate,
  AutomationRpcError,
  type AutomationRpcExtensionMeshHandle,
  type AutomationRpcExtensionSyncHandle,
} from "./automation-rpc/shared.ts";

/**
 * The handler table, one family per module under `automation-rpc/`. Each handler keeps its own
 * ordered checks (client-kind, owner gate, validation, approval) inside its module; this file only
 * composes the tables and builds the per-call context.
 */
const AUTOMATION_HANDLERS: Readonly<Record<string, AutomationHandler>> = {
  ...WATCHER_HANDLERS,
  ...EXTENSION_READ_HANDLERS,
  ...EXTENSION_INSTALL_HANDLERS,
  ...EXTENSION_RUN_HANDLERS,
  ...EXTENSION_LIFECYCLE_HANDLERS,
  ...WORKFLOW_HANDLERS,
};

export type AutomationRpcOptions = {
  method: string;
  params: unknown;
  db: Database;
  /** The connection's declared kind (`ctx.getClientKind(clientId)`); absent reads as `unknown`. */
  clientKind?: ClientKind;
  extensionsDir?: string;
  mesh?: AutomationRpcExtensionMeshHandle;
  vault?: NimbusVault;
  autoUpdate?: AutoUpdateRpcDeps;
  ownerGate?: AutomationOwnerGate;
  runGrantEnv?: ExtensionRunGrantEnv;
  sandboxRunner?: ReachRunner;
  evidence?: ExtensionEvidenceDeps;
  evalDeps?: AutomationEvalDeps;
  extensionsRuntimeEnabled?: boolean;
  extensionSync?: AutomationRpcExtensionSyncHandle;
  continuityTable?: readonly ContinuityEntry[];
  /** Test seam: stands in for `connectorRequirementStatuses`; production never passes it. */
  requirementStatuses?: ConnectorRequirementStatusesFn;
  /** Test seam: where an incomplete install rollback is warned; absent means this module's logger. */
  logger?: Pick<Logger, "warn">;
  observationDir?: string | undefined;
};

/** The extension half of the per-call context: each member only when the caller passed it. */
function extensionCtxOf(options: AutomationRpcOptions): Partial<AutomationCtx> {
  return {
    ...(options.extensionsDir !== undefined && { extensionsDir: options.extensionsDir }),
    ...(options.mesh !== undefined && { mesh: options.mesh }),
    ...(options.ownerGate !== undefined && { ownerGate: options.ownerGate }),
    ...(options.runGrantEnv !== undefined && { runGrantEnv: options.runGrantEnv }),
    ...(options.sandboxRunner !== undefined && { sandboxRunner: options.sandboxRunner }),
    ...(options.evidence !== undefined && { evidence: options.evidence }),
    ...(options.evalDeps !== undefined && { evalDeps: options.evalDeps }),
    ...(options.extensionsRuntimeEnabled !== undefined && {
      runtimeEnabled: options.extensionsRuntimeEnabled,
    }),
    ...(options.extensionSync !== undefined && { extensionSync: options.extensionSync }),
    ...(options.continuityTable !== undefined && { continuityTable: options.continuityTable }),
    ...(options.requirementStatuses !== undefined && {
      requirementStatuses: options.requirementStatuses,
    }),
  };
}

export async function dispatchAutomationRpc(
  options: AutomationRpcOptions,
): Promise<Hit | { kind: "miss" }> {
  const handler = AUTOMATION_HANDLERS[options.method];
  if (handler === undefined) {
    return { kind: "miss" };
  }
  const ctx: AutomationCtx = {
    db: options.db,
    ...(options.clientKind !== undefined && { clientKind: options.clientKind }),
    ...(options.vault !== undefined && { vault: options.vault }),
    ...(options.autoUpdate !== undefined && { autoUpdate: options.autoUpdate }),
    ...extensionCtxOf(options),
    ...(options.logger !== undefined && { logger: options.logger }),
    observationDir: options.observationDir,
  };
  return await handler(asRecord(options.params), ctx);
}
