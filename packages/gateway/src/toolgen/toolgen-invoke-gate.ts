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
  /**
   * The `generated_tool` row's `disabled_reason` for `toolId`, or `null` when there is no row or
   * the row is healthy. Bound to `getSavedTool(db, toolId)?.disabledReason ?? null` in production.
   *
   * Exists only to DISAMBIGUATE `ERR_TOOLGEN_NOT_SAVED`, which otherwise conflates two facts with
   * opposite fixes: the tool was never saved (fix: `nimbus tool save`), and the tool IS saved but
   * was skipped at load because its signature no longer verifies (fix: investigate, then
   * `nimbus tool save` again to repair). The second reads as a flat contradiction of
   * `nimbus tool list`, which shows that tool present with a `disabledReason`.
   *
   * It is NOT an authority and never widens what may run: the registry remains the only thing that
   * makes a tool invocable, and this accessor is consulted ONLY on the refusal path, to write a
   * better `reason` onto a decision already made.
   */
  readonly disabledReasonFor: (toolId: string) => string | null;
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
    // Absence from the registry has two causes with opposite fixes -- see `disabledReasonFor`'s
    // docstring. A durable row that exists but is DISABLED says so in the reason; a tool that was
    // never saved gets no reason at all, so "disabled" language never appears in front of one.
    const disabledReason = deps.disabledReasonFor(toolId);
    return refuse(
      deps,
      toolId,
      ERR_TOOLGEN_NOT_SAVED,
      disabledReason === null ? undefined : `saved, but disabled: ${disabledReason}`,
      req.sessionId,
    );
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
    // ONE mutable slot, assigned by whichever arm runs, read by the single audit write below.
    // This is deliberately NOT "each arm writes its own row": the audit call used to sit INSIDE
    // the `try`, so a throwing `deps.audit` on the success path was caught by the `catch` beneath
    // it, seen as a plain `Error`, routed to `fail()` and audited a SECOND time — permanently
    // recording `outcome: "failed"` for an execution that succeeded (a transient `SQLITE_BUSY`),
    // or propagating with ZERO rows written (a deterministic failure, e.g. the DB closed at
    // shutdown). The repo's I35 lesson, one hop on: state a single `finally` must write exactly
    // once belongs in ONE record passed to the arms, never in each arm's own closure.
    let outcome: ToolgenInvokeOutcome;
    try {
      handle = await deps.spawn(toolId);
      const result = await handle.call(input);
      outcome = { status: "executed", toolId, result, durationMs: deps.now() - startedAt };
    } catch (e) {
      // A ToolgenError from spawnSavedTool is a pre-execution REFUSAL, not a tool failure. The
      // signature-invalid path (`toolgen-saved-spawn.ts:206`) is the one that matters: reporting a
      // tampered artifact as `failed` would give exit 1 and an audit `outcome: "failed"`, making an
      // I40 refusal read as a bug in the tool.
      outcome =
        e instanceof ToolgenError
          ? buildRefused(toolId, e.code, e.message)
          : {
              status: "failed",
              toolId,
              error: e instanceof Error ? e.message : String(e),
              durationMs: deps.now() - startedAt,
            };
    } finally {
      // Close must not mask the outcome: a close failure is not the caller's problem. It also runs
      // BEFORE the audit write below, so a throwing sink can never strand a live child process.
      try {
        await handle?.close();
      } catch {
        /* best-effort */
      }
    }
    // Exactly one row per invocation, unconditionally, from a projection DERIVED from the assigned
    // outcome — structurally outside the `catch` that could otherwise re-enter it. A failure here
    // propagates to the caller rather than being swallowed: the audit trail is the point of the
    // gate, and silently returning `executed` on a row that was never written would be the same
    // false claim in the other direction.
    writeInvokeAudit(deps, req.sessionId, auditFieldsFor(outcome));
    return outcome;
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
 * The shape of a `tool.invoke` audit row's `action_json`, BEFORE the error cap is applied.
 * Deliberately has no `input` and no `result` member: the omission is structural, not a discipline
 * a caller has to remember (spec §5), so adding either is a compile error rather than a review
 * catch.
 */
interface InvokeAuditFields {
  readonly outcome: "executed" | "failed" | "refused";
  readonly toolId: string;
  readonly durationMs?: number;
  readonly code?: string;
  readonly error?: string;
}

/**
 * The ONE projection from an outcome to its audit row's fields, shared by the pre-spawn refusal
 * path and the post-execution write. Pure: it reads the outcome and nothing else, which is what
 * lets `invokeSavedTool` assign the outcome in one place and write the row in another without the
 * two being able to disagree about what happened.
 *
 * A refusal carries no `durationMs` (nothing ran) and its `reason` is stored under `error` — both
 * preserved verbatim from the per-arm builders this replaced, key ORDER included, since
 * `action_json` is a stringified record that tests and auditors read back.
 */
function auditFieldsFor(outcome: ToolgenInvokeOutcome): InvokeAuditFields {
  switch (outcome.status) {
    case "executed":
      return { outcome: "executed", toolId: outcome.toolId, durationMs: outcome.durationMs };
    case "failed":
      return {
        outcome: "failed",
        toolId: outcome.toolId,
        durationMs: outcome.durationMs,
        error: outcome.error,
      };
    case "refused":
      return {
        outcome: "refused",
        toolId: outcome.toolId,
        code: outcome.code,
        ...(outcome.reason === undefined ? {} : { error: outcome.reason }),
      };
  }
}

/**
 * Hands an ALREADY-PROJECTED row — never the outcome itself — to `deps.audit`. I39's
 * `recordToolEgress` precedent applies here too: the tool's REGISTRATION was approved, not each
 * request, hence `hitlStatus: "not_required"`.
 */
function writeInvokeAudit(
  deps: ToolgenInvokeDeps,
  sessionId: string | undefined,
  fields: InvokeAuditFields,
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

/** Builds a refused outcome. PURE — writes nothing; see `refuse` for the audited form. */
function buildRefused(toolId: string, code: string, reason?: string): ToolgenInvokeOutcome {
  return {
    status: "refused",
    toolId,
    code,
    ...(reason !== undefined && { reason }),
  };
}

/**
 * Builds a refused outcome and writes its audit row — the form used by every refusal decided
 * BEFORE `serialise` is reached. Inside the serialised body the outcome is assigned and the row is
 * written once at the end instead (see `invokeSavedTool`), so the two never both fire.
 */
function refuse(
  deps: ToolgenInvokeDeps,
  toolId: string,
  code: string,
  reason?: string,
  sessionId?: string,
): ToolgenInvokeOutcome {
  const outcome = buildRefused(toolId, code, reason);
  writeInvokeAudit(deps, sessionId, auditFieldsFor(outcome));
  return outcome;
}
