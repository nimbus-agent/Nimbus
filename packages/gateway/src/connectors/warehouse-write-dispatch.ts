// packages/gateway/src/connectors/warehouse-write-dispatch.ts
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { type ConnectorWriteContext, invokeConnectorWrite } from "./connector-write-transport.ts";
import { extractToolInput } from "./registry.ts";
import { warehouseWriteByActionType } from "./warehouse-write-tools.ts";

/**
 * Wraps the base connector dispatcher: a warehouse/BI write action.type is routed to the
 * credential-aware {@link invokeConnectorWrite} transport; everything else delegates to `inner`.
 * Installed in assemble.ts AROUND the executor's dispatcher, so the executor + registry stay generic.
 * Credential selection is config-driven via `deps.credentialFor` — never from the action payload.
 */
export function createWarehouseWriteDispatcher(
  inner: ConnectorDispatcher,
  deps: ConnectorWriteContext,
): ConnectorDispatcher {
  return {
    dispatch(action: PlannedAction): Promise<unknown> {
      const write = warehouseWriteByActionType(action.type);
      if (write === undefined) return inner.dispatch(action);
      return invokeConnectorWrite(deps, {
        service: write.service,
        writeToolId: write.toolId,
        args: extractToolInput(action),
      });
    },
  };
}
