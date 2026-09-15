import type { NimbusToolGenerationToml } from "../config/nimbus-toml.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { isToolgenCapabilityEnabled } from "./toolgen-capability.ts";
import type { ToolgenRegistry } from "./toolgen-registry.ts";
import {
  ERR_TOOLGEN_INPUT_INVALID,
  ERR_TOOLGEN_INVOKE_DISABLED,
  ERR_TOOLGEN_INVOKE_POLICY_DISABLED,
  ERR_TOOLGEN_NOT_SAVED,
  type ToolInputSchema,
} from "./toolgen-types.ts";

/**
 * The outcome of `invokeSavedTool`, which can refuse before spawning, fail during execution,
 * or complete successfully. Only `executed` and `failed` may involve a subprocess; `refused`
 * guarantees no spawn occurred.
 */
export type ToolgenInvokeOutcome =
  | {
      readonly status: "executed";
      readonly toolId: string;
      readonly result: unknown;
      readonly durationMs: number;
    }
  | {
      readonly status: "failed";
      readonly toolId: string;
      readonly error: string;
      readonly durationMs: number;
    }
  | {
      readonly status: "refused";
      readonly toolId: string;
      readonly code: string;
      readonly reason?: string;
    };

/**
 * Dependencies for `invokeSavedTool`. Passed as an object to enable partial mocking in tests
 * and dependency injection patterns in production.
 */
export interface ToolgenInvokeDeps {
  readonly config: Pick<NimbusToolGenerationToml, "enabled">;
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
  readonly registry: Pick<ToolgenRegistry, "savedTools">;
  readonly spawn: (
    scriptPath: string,
    input: Record<string, unknown>,
    timeoutMs: number,
  ) => Promise<unknown>;
  readonly audit: (outcome: ToolgenInvokeOutcome) => void;
  readonly now: () => number;
}

/**
 * Invokes a saved (persisted, signed) generated tool. Refusals happen before any spawn:
 * capability disabled, tool not found, ephemeral tool, invalid input. Later steps (Task 2+)
 * handle process spawning and execution.
 *
 * Spec §4, §4.5, §3.3.
 */
export async function invokeSavedTool(
  req: {
    readonly toolId: string;
    readonly input?: Record<string, unknown>;
    readonly sessionId?: string;
  },
  deps: ToolgenInvokeDeps,
): Promise<ToolgenInvokeOutcome> {
  const { toolId } = req;

  // Check config first: a user who turned the feature off locally should not be told their org
  // policy forbids it. This check lets the two error codes stay distinguishable.
  if (!deps.config.enabled) {
    return refuse(deps, toolId, ERR_TOOLGEN_INVOKE_DISABLED);
  }

  // Check org policy (fail-closed on absent accessor: "cannot tell" must never resolve to "allowed"
  // for a standing, unattended execution capability).
  if (!isToolgenCapabilityEnabled({ config: deps.config, enforced: deps.enforced })) {
    return refuse(deps, toolId, ERR_TOOLGEN_INVOKE_POLICY_DISABLED);
  }

  // Look up the saved tool. MUST use `savedTools()`, NOT `findArtifact()`. `findArtifact` reads the
  // EPHEMERAL collection first (`registry.ts:78`: `#byId.get(id)?.envelope.artifact ?? #saved.get(id)?
  // .artifact`), so using it here would let a created-but-unsaved tool pass this check and then fail
  // obscurely inside `spawnSavedTool` — defeating spec §3.5's saved-only bound at the very line meant
  // to enforce it.
  const saved = deps.registry.savedTools().find((s) => s.toolId === toolId);
  if (saved === undefined) {
    return refuse(deps, toolId, ERR_TOOLGEN_NOT_SAVED);
  }

  const artifact = saved.artifact;

  // Validate input: presence only (shape + required keys). NOT schema conformance (spec §3.3).
  const input = req.input ?? {};
  const inputError = validateInput(input, artifact.inputSchema);
  if (inputError !== undefined) {
    return refuse(deps, toolId, ERR_TOOLGEN_INPUT_INVALID, inputError);
  }

  // Spawn + call land in Task 2.
  throw new Error("not implemented");
}

/**
 * Validates that input is a JSON object with all required keys present.
 * Does NOT validate type conformance, array length, number bounds, etc. (spec §3.3).
 *
 * @returns undefined if valid; error message string if invalid.
 */
function validateInput(input: unknown, schema: ToolInputSchema): string | undefined {
  // Must be an object (not null, not array, not primitive).
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "input must be a JSON object";
  }

  // All required keys must be present (no validation of their values).
  const seen = input as Record<string, unknown>;
  for (const key of schema.required ?? []) {
    if (!(key in seen)) {
      return `missing required input "${key}"`;
    }
  }

  return undefined;
}

/**
 * Builds a refused outcome and writes the audit row.
 */
function refuse(
  deps: ToolgenInvokeDeps,
  toolId: string,
  code: string,
  reason?: string,
): ToolgenInvokeOutcome {
  const outcome: ToolgenInvokeOutcome = {
    status: "refused",
    toolId,
    code,
    ...(reason !== undefined && { reason }),
  };
  deps.audit(outcome);
  return outcome;
}
