// packages/gateway/src/connectors/connector-write-dispatch.ts
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { connectorWriteByActionType } from "./connector-write-registry.ts";
import { type ConnectorWriteContext, invokeConnectorWrite } from "./connector-write-transport.ts";
import { extractToolInput } from "./registry.ts";

/**
 * Wraps the base connector dispatcher: a connector write action.type (warehouse/BI ∪ GitOps/ML) is
 * routed to the credential-aware {@link invokeConnectorWrite} transport; everything else delegates to
 * `inner`. Installed in assemble.ts AROUND the executor's dispatcher, so the executor + registry stay
 * generic. Credential selection is config-driven via `deps.credentialFor` — never from the payload.
 * The HITL (I2) gate is upstream in the executor; this is reached only after `gate()` → "proceed".
 */
export function createConnectorWriteDispatcher(
  inner: ConnectorDispatcher,
  deps: ConnectorWriteContext,
): ConnectorDispatcher {
  return {
    dispatch(action: PlannedAction): Promise<unknown> {
      const write = connectorWriteByActionType(action.type);
      if (write === undefined) return inner.dispatch(action);
      return invokeConnectorWrite(deps, {
        service: write.service,
        writeToolId: write.toolId,
        args: extractToolInput(action),
      });
    },
  };
}
