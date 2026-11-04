// packages/gateway/src/connectors/connector-writes/model-write-capability.ts
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import type { AI_V2_CAPABILITIES } from "../../policy/types.ts";

/** The `[policy.capabilities.ai_v2]` lock-off name for offering connector write tools to the model. */
export const CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY =
  "connector_write_model_access" as const satisfies (typeof AI_V2_CAPABILITIES)[number];

/**
 * Whether the model may currently be offered connector writes, per the RESOLVED org policy (I22 —
 * never raw policy TOML). FAIL-CLOSED on an absent accessor, like `isUserMcpModelAccessEnabled`:
 * "cannot tell" must never resolve to "allowed".
 */
export function isConnectorWriteModelAccessEnabled(
  enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined,
): boolean {
  if (enforced === undefined) return false;
  return !enforced.capabilitiesDisabled.has(CONNECTOR_WRITE_MODEL_ACCESS_CAPABILITY);
}
