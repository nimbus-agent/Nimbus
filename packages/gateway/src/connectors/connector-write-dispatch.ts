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
 * A string `payload.mcpToolId` must name the routed row (bare, or `<service>_<toolId>`); any other
 * id is refused (rejects) before anything is sent.
 */
export function createConnectorWriteDispatcher(
  inner: ConnectorDispatcher,
  deps: ConnectorWriteContext,
): ConnectorDispatcher {
  return {
    dispatch(action: PlannedAction): Promise<unknown> {
      const write = connectorWriteByActionType(action.type);
      if (write === undefined) return inner.dispatch(action);
      // The transport routes by TYPE; a named tool must be this row's own, so what runs is
      // always the tool the owner's preview showed (`findRow` in the preview reads the same id).
      const named = action.payload?.["mcpToolId"];
      if (
        typeof named === "string" &&
        named !== write.toolId &&
        named !== `${write.service}_${write.toolId}`
      ) {
        return Promise.reject(
          new Error(
            `connector write ${action.type}: mcpToolId does not name its tool; refused, nothing sent`,
          ),
        );
      }
      return invokeConnectorWrite(deps, {
        service: write.service,
        writeToolId: write.toolId,
        args: extractToolInput(action),
      });
    },
  };
}
