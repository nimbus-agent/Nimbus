// packages/gateway/src/share/recipe-runner.ts
import type { RecipeStep } from "./recipe.ts";
import type { ShareFile } from "./share-format.ts";

/** Outcome of attempting one tool locally during replay (produced by the executor, Task 6). */
export type ToolRunOutcome =
  | { readonly kind: "unavailable" } // connector/tool not installed locally
  | { readonly kind: "ran"; readonly ok: boolean } // executed; ok = resolved without throwing
  | { readonly kind: "threw"; readonly message: string }; // execution raised

export type ReplayStepStatus =
  | "match"
  | "diverged"
  | "missing-connector"
  | "skipped-non-read"
  | "skipped-invalid-params"
  | "error";

export interface ReplayStepResult {
  readonly stepId: string;
  readonly tool: string;
  readonly service: string;
  readonly status: ReplayStepStatus;
  /** The status recorded in the shared artifact (`ok`/`error`). */
  readonly originalStatus: string;
  /** Human note: the connector name for `missing-connector`, the error message for `error`, etc. */
  readonly detail?: string;
}

export interface ReplaySummary {
  readonly total: number;
  readonly match: number;
  readonly diverged: number;
  readonly missingConnector: number;
  readonly skippedNonRead: number;
  /** Steps whose params failed the shape guard and were NOT executed. Reported, never silent. */
  readonly skippedInvalidParams: number;
  readonly error: number;
  /** Steps beyond {@link MAX_REPLAY_STEPS} that were NOT executed. Reported, never silent. */
  readonly capped: number;
}

/**
 * Hard ceiling on steps executed per replay.
 *
 * A share file is untrusted input and its step array is unbounded, so without a cap a single file
 * drives unlimited outbound calls against the owner's credentials — quota burn and provider-side
 * security alerting attributed to the owner's org. The excess is reported in
 * {@link ReplaySummary.capped} rather than dropped, because a truncated replay that looks complete
 * is its own reporting defect.
 */
export const MAX_REPLAY_STEPS = 256;

/**
 * Own-property names that must never appear in replay params. A share file's params are
 * `JSON.parse`d, and `JSON.parse` creates `__proto__` as an OWN property (an object literal does
 * not), so an untrusted file can smuggle one into any connector that merges params into an object.
 */
const FORBIDDEN_PARAM_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

/**
 * Shape guard for an untrusted recipe step's params, applied BEFORE the tool executes.
 *
 * Params arrive as attacker-controlled `unknown` from a share file and are handed straight to a
 * mesh tool's `execute`. This is defence in depth, NOT an authorization control: the real bounds on
 * replay are the positive read-only allowlist ({@link isReadOnlyToolId}), signature verification in
 * share-rpc, and {@link MAX_REPLAY_STEPS}. A schema-valid but hostile VALUE (someone else's file id)
 * is not something this can detect — only a per-tool `inputSchema` check could narrow that, and the
 * mesh tool map does not currently expose schemas.
 *
 * Accepts `undefined` (a no-argument tool) or a plain object, recursively free of
 * {@link FORBIDDEN_PARAM_KEYS}. Rejects arrays, primitives and `null`, none of which any MCP tool
 * declares as its input.
 */
export function hasSafeParamsShape(params: unknown): boolean {
  if (params === undefined) return true;
  // The ROOT must be a plain object. Checked here rather than inside the recursive walk, which
  // deliberately permits primitives and arrays as nested VALUES.
  if (params === null || typeof params !== "object" || Array.isArray(params)) return false;
  return isSafeParamValue(params, 0);
}

/** Depth ceiling: a deeply nested params tree is itself a red flag, and bounds the walk. */
const MAX_PARAM_DEPTH = 32;

/** Recursive value check. Primitives and arrays are legal here — only the ROOT is constrained. */
function isSafeParamValue(v: unknown, depth: number): boolean {
  if (depth > MAX_PARAM_DEPTH) return false;
  if (v === null) return true;
  if (typeof v === "function") return false;
  if (typeof v !== "object") return true;
  if (Array.isArray(v)) return v.every((el) => isSafeParamValue(el, depth + 1));
  for (const key of Object.getOwnPropertyNames(v)) {
    if (FORBIDDEN_PARAM_KEYS.has(key)) return false;
    if (!isSafeParamValue((v as Record<string, unknown>)[key], depth + 1)) return false;
  }
  return true;
}

export interface ReplayReport {
  readonly sourceSessionId: string;
  readonly steps: readonly ReplayStepResult[];
  readonly summary: ReplaySummary;
}

export interface RecipeRunnerDeps {
  /** Positive read-only classifier (Task 1's `isReadOnlyToolId` in production). */
  readonly isReadOnly: (toolId: string) => boolean;
  /** Execute one read-only tool locally and report the outcome (mesh-backed in production, Task 6). */
  readonly run: (toolId: string, params: unknown) => Promise<ToolRunOutcome>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object";
}

/** Validate one untrusted recipe-step object into a `RecipeStep` (or `null` if malformed). */
function parseStep(v: unknown, index: number): RecipeStep | null {
  if (!isRecord(v)) return null;
  const tool = v["tool"];
  const service = v["service"];
  if (typeof tool !== "string" || typeof service !== "string") return null;
  const stepId = typeof v["stepId"] === "string" ? v["stepId"] : `step-${index + 1}`;
  const status = typeof v["status"] === "string" ? v["status"] : "ok";
  const dependsOn = Array.isArray(v["dependsOn"])
    ? v["dependsOn"].filter((d): d is string => typeof d === "string")
    : [];
  return { stepId, tool, service, params: v["params"], status, dependsOn };
}

/**
 * Normalize a share into ordered replay steps. A recipe share uses `body.recipe.steps`; a transcript
 * share synthesizes steps from `body.toolCalls` (recorded order). Both are untrusted external input,
 * so every field is validated — anything malformed yields zero steps (fail-safe). Replay executes in
 * this order and never consults `dependsOn`.
 */
export function stepsFromShare(share: ShareFile): {
  readonly sourceSessionId: string;
  readonly steps: readonly RecipeStep[];
} {
  const sourceSessionId = share.body.sessionId;
  if (share.body.kind === "recipe") {
    const recipe = share.body.recipe;
    const rawSteps = isRecord(recipe) && Array.isArray(recipe["steps"]) ? recipe["steps"] : [];
    const steps = rawSteps
      .map((s, i) => parseStep(s, i))
      .filter((s): s is RecipeStep => s !== null);
    return { sourceSessionId, steps };
  }
  const rawCalls: unknown[] = Array.isArray(share.body.toolCalls) ? share.body.toolCalls : [];
  const steps: RecipeStep[] = [];
  for (const el of rawCalls) {
    if (!isRecord(el) || typeof el["toolId"] !== "string" || typeof el["service"] !== "string")
      continue;
    const toolId = el["toolId"];
    const service = el["service"];
    steps.push({
      stepId: `step-${steps.length + 1}`,
      tool: toolId,
      service,
      params: el["params"],
      status: typeof el["status"] === "string" ? el["status"] : "ok",
      dependsOn: [],
    });
  }
  return { sourceSessionId, steps };
}

/**
 * Replay a recipe's steps locally, in recorded order, classifying each against the shared original.
 * Deterministic and read-only: the executor is invoked ONLY for positively-classified read tools
 * (spec §8.1). Never consults `dependsOn`; never re-invokes the LLM; never runs a write action.
 */
export async function replayRecipe(
  sourceSessionId: string,
  steps: readonly RecipeStep[],
  deps: RecipeRunnerDeps,
): Promise<ReplayReport> {
  const results: ReplayStepResult[] = [];
  const executable = steps.slice(0, MAX_REPLAY_STEPS);
  const capped = steps.length - executable.length;
  for (const s of executable) {
    const base = { stepId: s.stepId, tool: s.tool, service: s.service, originalStatus: s.status };
    if (!deps.isReadOnly(s.tool)) {
      results.push({ ...base, status: "skipped-non-read" });
      continue;
    }
    // Shape-guard untrusted params BEFORE handing them to a mesh tool's `execute`.
    if (!hasSafeParamsShape(s.params)) {
      results.push({ ...base, status: "skipped-invalid-params" });
      continue;
    }
    const outcome = await deps.run(s.tool, s.params);
    if (outcome.kind === "unavailable") {
      results.push({ ...base, status: "missing-connector", detail: s.service });
    } else if (outcome.kind === "threw") {
      results.push({ ...base, status: "error", detail: outcome.message });
    } else {
      const replayStatus = outcome.ok ? "ok" : "error";
      results.push({ ...base, status: replayStatus === s.status ? "match" : "diverged" });
    }
  }
  const summary: ReplaySummary = {
    total: results.length,
    match: results.filter((r) => r.status === "match").length,
    diverged: results.filter((r) => r.status === "diverged").length,
    missingConnector: results.filter((r) => r.status === "missing-connector").length,
    skippedNonRead: results.filter((r) => r.status === "skipped-non-read").length,
    skippedInvalidParams: results.filter((r) => r.status === "skipped-invalid-params").length,
    error: results.filter((r) => r.status === "error").length,
    capped,
  };
  return { sourceSessionId, steps: results, summary };
}

/** Replay a whole share (recipe or transcript). The single entry point for the `share.replay` RPC. */
export async function replayShare(share: ShareFile, deps: RecipeRunnerDeps): Promise<ReplayReport> {
  const { sourceSessionId, steps } = stepsFromShare(share);
  return replayRecipe(sourceSessionId, steps, deps);
}
