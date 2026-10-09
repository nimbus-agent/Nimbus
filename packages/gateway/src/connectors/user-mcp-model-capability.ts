import type { Database } from "bun:sqlite";

import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { listModelAccessibleUserMcpIds } from "./user-mcp-store.ts";

/**
 * The `[policy.capabilities.ai_v2]` lock-off name for offering user-MCP (`--model`) tools to the
 * engine agent. A member of `AI_V2_CAPABILITIES` (`policy/types.ts`), so the policy parser keeps it.
 */
export const USER_MCP_MODEL_ACCESS_CAPABILITY = "user_mcp_model_access";

/**
 * Whether the model may currently be offered user-MCP `--model` tools, per the RESOLVED org policy
 * (I22 — never raw policy TOML).
 *
 * FAIL-CLOSED on an absent accessor, the same posture as `toolgen/toolgen-capability.ts`'s
 * `isToolgenCapabilityEnabled` and `media.understand`: a missing accessor means the gateway cannot
 * tell whether an org policy forbids this capability, and "cannot tell" must never resolve to
 * "allowed" for model access to owner-registered code.
 */
export function isUserMcpModelAccessEnabled(
  enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined,
): boolean {
  if (enforced === undefined) return false;
  return !enforced.capabilitiesDisabled.has(USER_MCP_MODEL_ACCESS_CAPABILITY);
}

/**
 * The model's user-MCP tool SOURCE (`gateway-main.ts`'s `userMcp.listModelAccessibleIds`): the
 * `--model` service ids, or NOTHING when the org-policy lock-off is in force or the policy accessor
 * is absent. Enforcing here — rather than at each offer site — means no `--model` server is ever
 * listed, so the model is offered nothing on any path. Called per turn with a LIVE policy read, so
 * a policy applied after boot takes effect on the next turn.
 *
 * Deliberately NOT consulted by `nimbus connector call` / `connector tools`: those are
 * owner-initiated invocations, not model access.
 */
export function listPolicyGatedModelAccessibleUserMcpIds(
  db: Database,
  enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined,
): string[] {
  if (!isUserMcpModelAccessEnabled(enforced)) return [];
  return listModelAccessibleUserMcpIds(db);
}
