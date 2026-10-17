import type { Database } from "bun:sqlite";

import { signatureDisabledRegistry } from "../extensions/hard-disable.ts";
import { listModelAccessibleExtensionGrants } from "../extensions/run-grant-store.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { AI_V2_CAPABILITIES } from "../policy/types.ts";
import { listModelAccessibleUserMcpIds } from "./user-mcp-store.ts";

/**
 * The `[policy.capabilities.ai_v2]` lock-off name for offering owner code to the engine agent: user
 * MCP servers registered with `--model` AND extensions approved with `--model` (one shared switch,
 * by owner decision — a separate extension name could be added later and would only narrow). A
 * member of `AI_V2_CAPABILITIES` (`policy/types.ts`), so the policy parser keeps it.
 */
export const USER_MCP_MODEL_ACCESS_CAPABILITY =
  "user_mcp_model_access" as const satisfies (typeof AI_V2_CAPABILITIES)[number];

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
 * The user-MCP half of the model's tool source (the engine agent reads both halves through
 * {@link listPolicyGatedModelAccessibleOwnerCodeServerIds}): the `--model` service ids, or NOTHING when the org-policy lock-off is in force or the policy accessor
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

/**
 * The engine agent's whole owner-code tool SOURCE (`gateway-main.ts`'s
 * `userMcp.listModelAccessibleIds`): `--model` user MCP service ids, then `--model` extension
 * service ids — or NOTHING when the lock-off is in force or the policy accessor is absent. The
 * predicate runs ONCE, before either read. An extension the startup signature pass disabled (I16)
 * is dropped even if `extension.enable` turned it back on, so it is not re-spawned and refused on
 * every turn; the spawn path would refuse it regardless.
 */
export function listPolicyGatedModelAccessibleOwnerCodeServerIds(
  db: Database,
  enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined,
  isSignatureDisabled: (extensionId: string) => boolean = (id) =>
    signatureDisabledRegistry.reasonFor(id) !== undefined,
): string[] {
  if (!isUserMcpModelAccessEnabled(enforced)) return [];
  return [
    ...listModelAccessibleUserMcpIds(db),
    ...listModelAccessibleExtensionGrants(db)
      .filter((g) => !isSignatureDisabled(g.extensionId))
      .map((g) => g.serviceId),
  ];
}
