import type { NimbusToolGenerationToml } from "../config/nimbus-toml.ts";
import type { AppendAuditEntryFields } from "../db/audit-chain.ts";
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
 * Cap on the `error` text stored in a `tool.invoke` audit row. The row is meant to carry neither
 * the tool's input nor its result, and the deliberate fields enforce that by type — but a thrown
 * message is free text the TOOL composes, so a tool that echoes its own arguments into its error
 * can put them here. The cap bounds that rather than eliminating it (see the design doc's § 5
 * bound). The FULL message still reaches the caller on the returned outcome, which is where an
 * operator actually reads it; this limit applies only to what is written to disk.
 *
 * Counted in CODE POINTS, not bytes: slicing UTF-8 by byte can split a character and write
 * mojibake into the row.
 */
const AUDIT_ERROR_MAX_CHARS = 512;

/** Truncates an audit error string to `AUDIT_ERROR_MAX_CHARS`, marking it when it cuts. */
function capAuditError(message: string): string {
  const points = [...message];
  if (points.length <= AUDIT_ERROR_MAX_CHARS) return message;
  return `${points.slice(0, AUDIT_ERROR_MAX_CHARS).join("")}… [truncated]`;
}

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
  /**
   * Sink for the one `tool.invoke` audit row this invocation writes. Takes an ALREADY-PROJECTED
   * row, never the outcome: `ToolgenInvokeOutcome.executed` carries the tool's `result`, and a
   * sink handed the outcome could stringify the tool's output into `action_json` (spec §5 forbids
   * exactly that). Bound to `appendAuditEntry(db, row)` in production (Task 4).
   */
  readonly audit: (row: AppendAuditEntryFields) => void;
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
    return refuse(deps, toolId, ERR_TOOLGEN_INVOKE_DISABLED, undefined, req.sessionId);
  }

  // Check org policy (fail-closed on absent accessor: "cannot tell" must never resolve to "allowed"
  // for a standing, unattended execution capability).
  if (!isToolgenCapabilityEnabled({ config: deps.config, enforced: deps.enforced })) {
    return refuse(deps, toolId, ERR_TOOLGEN_INVOKE_POLICY_DISABLED, undefined, req.sessionId);
  }

  // Look up the saved tool. MUST use `savedTools()`, NOT `findArtifact()`. `findArtifact` reads the
  // EPHEMERAL collection first (`registry.ts:78`: `#byId.get(id)?.envelope.artifact ?? #saved.get(id)?
  // .artifact`), so using it here would let a created-but-unsaved tool pass this check and then fail
  // obscurely inside `spawnSavedTool` — defeating spec §3.5's saved-only bound at the very line meant
  // to enforce it.
  const saved = deps.registry.savedTools().find((s) => s.toolId === toolId);
  if (saved === undefined) {
    return refuse(deps, toolId, ERR_TOOLGEN_NOT_SAVED, undefined, req.sessionId);
  }

  const artifact = saved.artifact;

  // Validate input: presence only (shape + required keys). NOT schema conformance (spec §3.3).
  const input = req.input ?? {};
  const inputError = validateInput(input, artifact.inputSchema);
  if (inputError !== undefined) {
    return refuse(deps, toolId, ERR_TOOLGEN_INPUT_INVALID, inputError, req.sessionId);
  }

  return await serialise(toolId, async () => {
    const startedAt = deps.now();
    let handle: GeneratedToolHandle | undefined;
    try {
      handle = await deps.spawn(toolId);
      const result = await handle.call(input);
      return succeed(deps, toolId, result, deps.now() - startedAt, req.sessionId);
    } catch (e) {
      // A ToolgenError from spawnSavedTool is a pre-execution REFUSAL, not a tool failure. The
      // signature-invalid path (`toolgen-saved-spawn.ts:206`) is the one that matters: reporting a
      // tampered artifact as `failed` would give exit 1 and an audit `outcome: "failed"`, making an
      // I40 refusal read as a bug in the tool.
      if (e instanceof ToolgenError) {
        return refuse(deps, toolId, e.code, e.message, req.sessionId);
      }
      const msg = e instanceof Error ? e.message : String(e);
      return fail(deps, toolId, msg, deps.now() - startedAt, req.sessionId);
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
 * Projects an invocation outcome onto the one `tool.invoke` audit row it writes, and hands the
 * projection — never the outcome itself — to `deps.audit`. `fields` deliberately has no `input`
 * and no `result` member: the omission is structural, not a discipline the caller has to
 * remember (spec §5). I39's `recordToolEgress` precedent applies here too: the tool's
 * REGISTRATION was approved, not each request, hence `hitlStatus: "not_required"`.
 */
function writeInvokeAudit(
  deps: ToolgenInvokeDeps,
  sessionId: string | undefined,
  fields: {
    readonly outcome: "executed" | "failed" | "refused";
    readonly toolId: string;
    readonly durationMs?: number;
    readonly code?: string;
    readonly error?: string;
  },
): void {
  // Cap the error text for the stored row only, never the returned outcome (which keeps the full message).
  // Use a spread to conditionally include the capped error, respecting exactOptionalPropertyTypes.
  const cappedFields = {
    ...fields,
    ...(fields.error === undefined ? {} : { error: capAuditError(fields.error) }),
  };
  deps.audit({
    actionType: "tool.invoke",
    hitlStatus: "not_required",
    actionJson: JSON.stringify(cappedFields),
    timestamp: deps.now(),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

/**
 * Builds an executed outcome and writes the audit row.
 */
function succeed(
  deps: ToolgenInvokeDeps,
  toolId: string,
  result: unknown,
  durationMs: number,
  sessionId?: string,
): ToolgenInvokeOutcome {
  const outcome: ToolgenInvokeOutcome = { status: "executed", toolId, result, durationMs };
  writeInvokeAudit(deps, sessionId, { outcome: "executed", toolId, durationMs });
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
  sessionId?: string,
): ToolgenInvokeOutcome {
  const outcome: ToolgenInvokeOutcome = { status: "failed", toolId, error, durationMs };
  writeInvokeAudit(deps, sessionId, { outcome: "failed", toolId, durationMs, error });
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
  sessionId?: string,
): ToolgenInvokeOutcome {
  const outcome: ToolgenInvokeOutcome = {
    status: "refused",
    toolId,
    code,
    ...(reason !== undefined && { reason }),
  };
  writeInvokeAudit(deps, sessionId, {
    outcome: "refused",
    toolId,
    code,
    ...(reason === undefined ? {} : { error: reason }),
  });
  return outcome;
}
