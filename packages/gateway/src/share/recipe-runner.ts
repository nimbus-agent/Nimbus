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
