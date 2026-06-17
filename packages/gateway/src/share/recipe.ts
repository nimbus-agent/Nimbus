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

/** Max tool calls reconstructed into one recipe (deliberate cap; sessions beyond this are truncated). */
const MAX_RECIPE_TOOL_CALLS = 1000;

const LOW_ENTROPY = new Set(["true", "false", "null", ""]);

/** Identifier-shaped scalar test (spec §7.1): entity IDs / paths / URLs/URNs / mixed-alnum ≥ 8. */
function isIdentifierValue(v: unknown): v is string {
  if (typeof v !== "string") return false;
  if (v.length < 4 || LOW_ENTROPY.has(v)) return false;
  if (/[/\\]/.test(v) || /^[a-z][a-z0-9+.-]*:\/\//i.test(v) || /^urn:/i.test(v)) return true; // path / URL / URN
  if (/^[A-Za-z]+[-_][A-Za-z0-9]{4,}$/.test(v)) return true; // prefixed entity id, e.g. issue-9f2a8c71
  return v.length >= 8 && /[A-Za-z]/.test(v) && /\d/.test(v); // mixed alphanumeric ≥ 8
}

/** Collect identifier-shaped leaf scalars from an arbitrary value tree. */
function collectIdentifierLeaves(value: unknown, out: Set<string>): void {
  if (isIdentifierValue(value)) {
    out.add(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) collectIdentifierLeaves(v, out);
  } else if (value !== null && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>))
      collectIdentifierLeaves(v, out);
  }
}

export function buildRecipeFromSession(db: Database, sessionId: string, now: () => number): Recipe {
  const { toolCalls } = readToolCallLog(db, { sessionId, limit: MAX_RECIPE_TOOL_CALLS });
  // For each prior step, the identifier set produced by its (string) result envelope.
  const priorResults: Array<{ stepId: string; envelope: string }> = [];
  const steps: RecipeStep[] = toolCalls.map((tc, i) => {
    const stepId = `step-${i + 1}`;
    const params = tc.params ?? {};
    const ids = new Set<string>();
    collectIdentifierLeaves(params, ids);
    const dependsOn: string[] = [];
    // Substring match against the prior result envelope. A coincidental substring collision (an
    // identifier appearing inside an unrelated longer value) can yield a spurious edge — ACCEPTABLE:
    // `dependsOn` is explicitly advisory (spec §7.1) and never load-bearing (replay runs steps in
    // recorded order, not by dependency). Word-boundary / structured-JSON-value matching is a
    // deferred enrichment, not built here.
    for (const prior of priorResults) {
      if ([...ids].some((id) => prior.envelope.includes(id))) dependsOn.push(prior.stepId);
    }
    priorResults.push({ stepId, envelope: tc.resultEnvelope });
    return { stepId, tool: tc.toolId, service: tc.service, params, status: tc.status, dependsOn };
  });
  return {
    recipeVersion: 1,
    sourceSessionId: sessionId,
    generatedAt: now(),
    steps,
    graphTraversals: [],
  };
}
