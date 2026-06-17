// packages/gateway/src/share/recipe-runner.ts
import type { RecipeStep } from "./recipe.ts";
import type { ShareFile, ShareToolCall } from "./share-format.ts";

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
  const toolCalls: readonly ShareToolCall[] = share.body.toolCalls ?? [];
  const steps: RecipeStep[] = toolCalls.map((tc, i) => ({
    stepId: `step-${i + 1}`,
    tool: tc.toolId,
    service: tc.service,
    params: tc.params,
    status: tc.status,
    dependsOn: [],
  }));
  return { sourceSessionId, steps };
}
