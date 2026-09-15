import type { NimbusToolGenerationToml } from "../config/nimbus-toml.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { isToolgenCapabilityEnabled } from "./toolgen-capability.ts";
import type { GeneratedToolHandle } from "./toolgen-client.ts";
import type { ToolgenRegistry } from "./toolgen-registry.ts";
import {
  ERR_TOOLGEN_INPUT_INVALID,
  ERR_TOOLGEN_INVOKE_DISABLED,
  ERR_TOOLGEN_INVOKE_POLICY_DISABLED,
  ERR_TOOLGEN_NOT_SAVED,
  ToolgenError,
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
  /**
   * Spawns the saved tool identified by `toolId` and returns its live handle. Bound to
   * `spawnSavedTool` (`toolgen-saved-spawn.ts`) plus its `SavedSpawnDeps` in production; injected
   * here so a test can drive spawn/call/close without launching a real subprocess. Throws
   * `ToolgenError` when the on-disk signature check fails at spawn time (I40) — that is a REFUSAL,
   * not an execution failure, and `invokeSavedTool` must tell the two apart.
   */
  readonly spawn: (toolId: string) => Promise<GeneratedToolHandle>;
  readonly audit: (outcome: ToolgenInvokeOutcome) => void;
  readonly now: () => number;
}

/**
 * Invokes a saved (persisted, signed) generated tool. Refusals happen before any spawn:
 * capability disabled, tool not found, ephemeral tool, invalid input. Past that point the tool is
 * spawned, called with `input`, and its handle is closed in a `finally` regardless of outcome.
 * Invocations of the SAME tool id are serialised (spec §4.2); different tool ids run concurrently.
 *
 * Spec §4, §4.1, §4.2, §4.3, §4.5, §3.3.
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

  return await serialise(toolId, async () => {
    const startedAt = deps.now();
    let handle: GeneratedToolHandle | undefined;
    try {
      handle = await deps.spawn(toolId);
      const result = await handle.call(input);
      return succeed(deps, toolId, result, deps.now() - startedAt);
    } catch (e) {
      // A ToolgenError from spawnSavedTool is a pre-execution REFUSAL, not a tool failure. The
      // signature-invalid path (`toolgen-saved-spawn.ts:206`) is the one that matters: reporting a
      // tampered artifact as `failed` would give exit 1 and an audit `outcome: "failed"`, making an
      // I40 refusal read as a bug in the tool.
      if (e instanceof ToolgenError) {
        return refuse(deps, toolId, e.code, e.message);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return fail(deps, toolId, msg, deps.now() - startedAt);
    } finally {
      // Close must not mask the outcome: a close failure is not the caller's problem.
      try {
        await handle?.close();
      } catch {
        /* best-effort */
      }
    }
  });
}

/**
 * Per-tool-id serialisation, keyed by an in-process promise-chain map — the same shape I35 uses
 * for concurrent `computer.act` on one lane. `spawnSavedTool` re-emits `saved/<id>/index.ts` from
 * the verified body on EVERY spawn (I40's "never read index.ts back and trust it"), so two
 * overlapping spawns of the SAME tool id write the same path while another child may hold it open
 * — a transient `EBUSY` on Windows. Different tool ids are never chained against each other.
 */
const chains = new Map<string, Promise<unknown>>();

/**
 * Test-only accessor for the size of the chains map. Exists solely so the cleanup of per-tool-id
 * chain entries can be asserted without reaching into module internals.
 */
export function __chainsSizeForTest(): number {
  return chains.size;
}

function serialise<T>(toolId: string, run: () => Promise<T>): Promise<T> {
  const prev = chains.get(toolId) ?? Promise.resolve();
  const next = prev.then(run, run);
  // The stored tail is a settled-either-way derivation of `next`, so a rejected predecessor can
  // never poison a later caller's chain. Keep exactly ONE reference to it: the cleanup below
  // compares identity, and a second `.catch()` would build a different object that could never
  // match. The previous comparison was against `undefined`, which `set` makes unreachable — the
  // entry was never dropped at all.
  const tail = next.catch(() => undefined);
  chains.set(toolId, tail);
  void tail.finally(() => {
    // Drop the entry only when nothing has queued behind us: the map still holding OUR tail means
    // we are the last link. If a later call has already chained on, it has replaced the value and
    // will do its own cleanup.
    if (chains.get(toolId) === tail) chains.delete(toolId);
  });
  return next;
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
 * Builds an executed outcome and writes the audit row.
 */
function succeed(
  deps: ToolgenInvokeDeps,
  toolId: string,
  result: unknown,
  durationMs: number,
): ToolgenInvokeOutcome {
  const outcome: ToolgenInvokeOutcome = { status: "executed", toolId, result, durationMs };
  deps.audit(outcome);
  return outcome;
}

/**
 * Builds a failed outcome and writes the audit row. Distinct from `refuse`: the tool DID run and
 * threw, rather than being refused before it was ever spawned (spec §3.1).
 */
function fail(
  deps: ToolgenInvokeDeps,
  toolId: string,
  error: string,
  durationMs: number,
): ToolgenInvokeOutcome {
  const outcome: ToolgenInvokeOutcome = { status: "failed", toolId, error, durationMs };
  deps.audit(outcome);
  return outcome;
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
