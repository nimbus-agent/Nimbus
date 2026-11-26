import { agentDoorRow } from "../connectors/connector-writes/agent-door.ts";
import type {
  ConnectorWriteRow,
  PreviewCredentialResolver,
} from "../connectors/connector-writes/types.ts";
import { userMcpToolKeyForActionType } from "../connectors/user-mcp-store.ts";
import { serviceOf } from "../engine/service-of.ts";
import type { ActExecuteOutcome } from "../mcp-sink/capture-types.ts";

/** Small phase steps of the act door's `execute` (`capture-rpc.ts` `buildActDeps`). */

/** The fixed text when the write's credential instance cannot be established (echoes no stored value). */
const CREDENTIAL_UNVERIFIED_REASON = "the credential the write would use could not be verified";

export interface ActRoute {
  readonly row: ConnectorWriteRow | undefined;
  readonly toolId: string;
}

/**
 * The tool is ALWAYS gateway-chosen: the write row for a first-party type, the canonical
 * `<serviceId>_<tool>` key for a user-MCP type (the exact pair `connector.userMcpCall` builds,
 * and the only key the dispatcher's I42 pairing accepts for that type). The second lookup
 * returns undefined for anything that is not an `mcp_*` type. Routed by the PRODUCTION write
 * table (the `beforeStateRows` seam only changes what the preview and the before-state are built
 * from). What may reach here is decided by the gate's verdict at submit and at approval (the
 * agent door), never by routing.
 */
export function actRoute(actionType: string): ActRoute {
  const row = agentDoorRow(actionType);
  const toolId = row?.toolId ?? userMcpToolKeyForActionType(actionType);
  if (toolId === undefined) {
    // Never dispatch a first-party write by its type (spec § 6.3): no routing row, no call.
    // This exact message is what classifyActionError maps to ERR_ACTION_TOOL_NOT_FOUND.
    throw new Error("Tool not found");
  }
  return { row, toolId };
}

/**
 * The prompt must name the instance the write WILL run against, read fresh from the Vault the
 * write uses (as the executor does on every other door). A credential whose instance cannot be
 * established (a present but invalid base) is rejected here: no prompt, no dispatch, a fixed
 * outcome that echoes no stored value.
 */
export async function refreshCredentialOrReject(
  previewCredentialFor: PreviewCredentialResolver | undefined,
  actionType: string,
): Promise<ActExecuteOutcome | undefined> {
  try {
    await previewCredentialFor?.refresh?.(serviceOf(actionType));
  } catch {
    return {
      status: "rejected",
      reason: CREDENTIAL_UNVERIFIED_REASON,
      code: "ERR_ACTION_CREDENTIAL_UNVERIFIED",
    };
  }
  return undefined;
}
