// packages/gateway/src/standing/standing-rule-capability.ts
// The org-policy lock-off for standing approvals and the dependency bundle the workflow write
// executor hands the I55 check (Phase 10 SA3). Policy is read from the RESOLVED enforced policy
// (I22), never raw TOML, and an absent accessor reads as "locked off" (fail closed).
import type { Database } from "bun:sqlite";

import {
  CHATOPS_CHANNEL_REFUSAL,
  isChatopsDestinationRow,
  modelWriteRefusal,
  type TribalKbConfig,
} from "../connectors/connector-writes/model-write-refusals.ts";
import type { StandingRuleDeps } from "../engine/standing-rule-step.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { AI_V2_CAPABILITIES } from "../policy/types.ts";

/** The `[policy.capabilities.ai_v2]` lock-off name for standing approvals. */
export const STANDING_APPROVALS_CAPABILITY =
  "standing_approvals" as const satisfies (typeof AI_V2_CAPABILITIES)[number];

/** The fixed text when org policy has locked standing approvals off. */
export const STANDING_APPROVALS_DISABLED_MESSAGE =
  "standing approvals are turned off by your organization's policy";

/**
 * Whether standing approvals are on, per the resolved org policy. FAIL-CLOSED on an absent
 * accessor or an absent enforced policy: "cannot tell" must never resolve to "allowed".
 */
export function isStandingApprovalsEnabled(
  enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined,
): boolean {
  if (enforced === undefined) return false;
  return !enforced.capabilitiesDisabled.has(STANDING_APPROVALS_CAPABILITY);
}

/** What the executor-side dependencies are built from. */
export interface StandingRuleDepsSource {
  readonly db: Database;
  /** The LIVE enforced policy accessor (read per call). Absent = locked off. */
  readonly enforcedPolicy?: (() => EnforcedPolicy | undefined) | undefined;
  readonly getTribalKbConfig: () => TribalKbConfig | undefined;
  readonly now?: () => number;
}

/** Reads the enforced policy; a throw reads as "cannot tell" (`undefined`). */
function readEnforced(src: StandingRuleDepsSource): EnforcedPolicy | undefined {
  try {
    return src.enforcedPolicy?.();
  } catch {
    return undefined;
  }
}

/**
 * The dependencies of the I55 check for the workflow write executor. The door refusal is the SAME
 * `modelWriteRefusal` the model door runs (ChatOps channel, broadcast mention, remote content,
 * knowledge base, null optional field, calendar zone), over the ChatOps bindings of the live
 * policy: a policy that cannot be read refuses a ChatOps-platform post.
 */
export function createStandingRuleDeps(src: StandingRuleDepsSource): StandingRuleDeps {
  return {
    db: src.db,
    policyAllows: () => isStandingApprovalsEnabled(readEnforced(src)),
    refusal: (toolId, input) => {
      const enforced = readEnforced(src);
      if (enforced === undefined && isChatopsDestinationRow(toolId)) return CHATOPS_CHANNEL_REFUSAL;
      return modelWriteRefusal(toolId, input, {
        chatops: enforced?.chatops,
        kb: src.getTribalKbConfig(),
      });
    },
    ...(src.now === undefined ? {} : { now: src.now }),
  };
}
