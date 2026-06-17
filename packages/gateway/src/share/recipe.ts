// packages/gateway/src/share/recipe.ts
import type { Database } from "bun:sqlite";
import { readToolCallLog } from "../db/tool-call-log.ts";

/**
 * A declarative, LLM-free recipe reconstructed from a session's logged tool calls.
 * The ordered `steps` list (execution order, `called_at` ascending) is the authoritative
 * contract. `dependsOn` is an ADVISORY enrichment (Task 5) — Nimbus does not track parameter
 * lineage, so edges are inferred by a conservative value-matcher and may be incomplete; replay
 * (Slice 8c) executes steps in recorded order and never relies on `dependsOn`.
 */
export interface RecipeStep {
  readonly stepId: string;
  readonly tool: string;
  readonly service: string;
  readonly params: unknown;
  readonly status: string;
  readonly dependsOn: readonly string[];
}

export interface Recipe {
  readonly recipeVersion: 1;
  readonly sourceSessionId: string;
  readonly generatedAt: number;
  readonly steps: readonly RecipeStep[];
  /** Reserved (spec §7.1). No deterministic source today → always `[]`. */
  readonly graphTraversals: readonly unknown[];
}

export function buildRecipeFromSession(db: Database, sessionId: string, now: () => number): Recipe {
  const { toolCalls } = readToolCallLog(db, { sessionId, limit: 1000 });
  const steps: RecipeStep[] = toolCalls.map((tc, i) => ({
    stepId: `step-${i + 1}`,
    tool: tc.toolId,
    service: tc.service,
    params: tc.params ?? {},
    status: tc.status,
    dependsOn: [],
  }));
  return {
    recipeVersion: 1,
    sourceSessionId: sessionId,
    generatedAt: now(),
    steps,
    graphTraversals: [],
  };
}
