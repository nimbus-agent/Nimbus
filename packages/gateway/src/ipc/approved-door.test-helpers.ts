// Test support for the agent door after AD3b: what a door with every write row approved would say,
// so tests of the destination refusals and the prompts need not stand up the owner's list. The
// production versions are `createAgentDoor(...).verdict` and `.refusal` (static D49(a)); these
// reproduce only their routing and refusal rule, over the same write table.
import { agentDoorRow } from "../connectors/connector-writes/agent-door.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { MODEL_NEVER_OFFERED_TOOL_IDS } from "../connectors/connector-writes/model-offerable.ts";
import {
  CHATOPS_CHANNEL_REFUSAL,
  isChatopsDestinationRow,
  modelWriteRefusal,
  type TribalKbConfig,
} from "../connectors/connector-writes/model-write-refusals.ts";
import { mcpClientToolKey } from "../connectors/lazy-mesh/tool-map.ts";
import { serviceOf } from "../engine/service-of.ts";
import type { ActionVerdict } from "../mcp-sink/capture-types.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { AgentDoorActWiring } from "./capture-rpc.ts";

/** Every reader and prepare tool of `service` as a connector would list it (so a before-read can run). */
export function readerListing(service: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const r of CONNECTOR_WRITE_ROWS) {
    if (serviceOf(r.actionType) !== service) continue;
    const support = [
      r.before?.tool,
      r.before?.also?.tool,
      r.bound?.prepare.tool,
      r.bound?.prepare.settleTool,
    ];
    for (const t of support) {
      if (t !== undefined)
        out[mcpClientToolKey(service, t)] = { description: "r", inputSchema: {} };
    }
  }
  return out;
}

/** A wired door that vouches for everything and lists every reader: for a test not about the door's checks. */
export const PERMISSIVE_DOOR: AgentDoorActWiring = {
  listServerTools: async (service) => readerListing(service),
  verifyDefinition: async () => ({ ok: true }),
};

/** The verdict of a door with every row approved: proposable on the approved basis unless never offered. */
export function classifyViaApprovedDoor(actionType: string): ActionVerdict {
  const row = agentDoorRow(actionType);
  if (row === undefined) return { kind: "unknown" };
  if (MODEL_NEVER_OFFERED_TOOL_IDS.has(row.toolId)) {
    return { kind: "denied", class: "agent_never_offered" };
  }
  return row.bound === undefined
    ? { kind: "proposable", basis: "approved" }
    : { kind: "proposable", basis: "approved", boundInput: true };
}

/** The destination refusal an approved proposal gets (the door's `refusal`), over the given accessors. */
export function createActionDestinationRefusal(
  enforcedPolicy: () => EnforcedPolicy | undefined,
  tribalKbConfig: () => TribalKbConfig | undefined,
): (actionType: string, input: Readonly<Record<string, unknown>>) => string | undefined {
  return (actionType, input) => {
    const row = agentDoorRow(actionType);
    if (row === undefined) return undefined;
    let chatops: EnforcedPolicy["chatops"] | undefined;
    try {
      chatops = enforcedPolicy()?.chatops;
    } catch (err) {
      if (isChatopsDestinationRow(row.toolId)) return CHATOPS_CHANNEL_REFUSAL;
      throw err;
    }
    return modelWriteRefusal(row.toolId, input, { chatops, kb: tribalKbConfig() });
  };
}
