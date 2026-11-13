// Test support: the act door's destination refusal exactly as it ran before the agent door
// (Phase 28 AD3a-2a), for tests that drive the legacy basis with their own policy and KB accessors.
// Production builds this through `createAgentDoor(...).refusal` (static D49(a)).
import {
  actDoorRefusal,
  type TribalKbConfig,
} from "../connectors/connector-writes/model-write-refusals.ts";
import { proposableWriteTool } from "../connectors/proposable-actions.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";

export function createActionDestinationRefusal(
  enforcedPolicy: () => EnforcedPolicy | undefined,
  tribalKbConfig: () => TribalKbConfig | undefined,
): (actionType: string, input: Readonly<Record<string, unknown>>) => string | undefined {
  return (actionType, input) => {
    const tool = proposableWriteTool(actionType);
    if (tool === undefined) return undefined;
    let chatops: EnforcedPolicy["chatops"] | undefined;
    try {
      chatops = enforcedPolicy()?.chatops;
    } catch {
      chatops = undefined;
    }
    let kb: TribalKbConfig | undefined;
    let kbUnreadable = false;
    try {
      kb = tribalKbConfig();
    } catch {
      kbUnreadable = true;
    }
    return actDoorRefusal(tool, input, { chatops, kb, kbUnreadable });
  };
}
