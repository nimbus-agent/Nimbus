import type { QuorumRule } from "../config/nimbus-toml.ts";
import type { EnforcedPolicy } from "./policy-gate.ts";

/** The authoritative quorum rule for an action type, or undefined if none applies. */
export function resolveQuorumRule(
  enforced: EnforcedPolicy,
  actionType: string,
): QuorumRule | undefined {
  return enforced.quorum.get(actionType);
}

/** Whether policy/baseline forces HITL on this action type. */
export function isHitlRequiredByPolicy(enforced: EnforcedPolicy, actionType: string): boolean {
  return enforced.hitlRequired.has(actionType);
}
