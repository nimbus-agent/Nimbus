import { isLocalProviderKind, type LlmRouter } from "../llm/router.ts";

export type DecisionLlm = {
  complete(prompt: string): Promise<string | null>;
};

export type ExtractionOutcome =
  | { readonly kind: "veto" }
  | {
      readonly kind: "decision";
      readonly statement: string;
      readonly rationale: string | null;
      readonly alternatives: readonly string[];
    };

export function buildExtractionPrompt(sentence: string, context: string): string {
  return [
    "You are analysing a message from an engineering team's internal discussion.",
    "Answer ONE question: is the sentence below recording a DECISION the team made?",
    "",
    "A decision commits the team to a course of action (technology, process, architecture).",
    "Casual plans about lunch, meetings or personal errands are NOT decisions.",
    "",
    `SENTENCE: ${sentence}`,
    `CONTEXT: ${context}`,
    "",
    "Reply with JSON only, no prose:",
    '{"is_decision": false}',
    "or",
    '{"is_decision": true, "statement": "<the decision, one line>",',
    ' "rationale": "<the because-clause, or null>",',
    ' "alternatives": ["<options considered and rejected>"]}',
  ].join("\n");
}

function extractJsonObject(raw: string): string {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/iu.exec(raw);
  const body = fenced?.[1] ?? raw;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) {
    throw new Error("no JSON object in model output");
  }
  return body.slice(start, end + 1);
}

export function parseExtraction(raw: string): ExtractionOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(raw));
  } catch {
    throw new Error("model output was not parseable JSON");
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error("model output was not a JSON object");
  }
  const o = parsed as {
    is_decision?: unknown;
    statement?: unknown;
    rationale?: unknown;
    alternatives?: unknown;
  };
  if (typeof o.is_decision !== "boolean") {
    throw new Error("model output had a non-boolean is_decision");
  }
  if (!o.is_decision) return { kind: "veto" };

  if (typeof o.statement !== "string" || o.statement.trim().length === 0) {
    throw new Error("model claimed a decision but gave no statement");
  }
  const alternatives = Array.isArray(o.alternatives)
    ? o.alternatives.filter((x): x is string => typeof x === "string")
    : [];
  return {
    kind: "decision",
    statement: o.statement.trim(),
    rationale:
      typeof o.rationale === "string" && o.rationale.trim().length > 0 ? o.rationale.trim() : null,
    alternatives,
  };
}

/**
 * Returns `null` when no local model is available (`complete` returned
 * `null`) — that is "no model → snippet", not a failure. `parseExtraction`
 * still throws on malformed non-null output; that distinction matters to the
 * caller: `null` falls back to the snippet path silently, while a throw is a
 * real failure that records an attempt and retries with backoff.
 */
export async function extractDecision(
  llm: DecisionLlm,
  sentence: string,
  context: string,
): Promise<ExtractionOutcome | null> {
  const raw = await llm.complete(buildExtractionPrompt(sentence, context));
  if (raw === null) return null;
  return parseExtraction(raw);
}

/**
 * Production `DecisionLlm` over the existing router — LOCAL PROVIDERS ONLY.
 * Mirrors `glossary/glossary-llm-adapter.ts` `createGlossaryLlm` exactly: a
 * local model may be absent at CALL time (not just at wire time), so `null`
 * means "no model available now" and the caller falls back to snippet
 * extraction rather than treating it as a failure. See that file's doc
 * comment for the full rationale (local-only gate, "summarisation" task,
 * direct `provider.generate` call, and the abort-signal limitation).
 */
export function createDecisionLlm(router: LlmRouter): DecisionLlm {
  return {
    async complete(prompt: string): Promise<string | null> {
      const provider = await router.selectProvider("summarisation", { preferLocal: true });
      if (provider === undefined) return null;
      if (!isLocalProviderKind(provider.providerId)) return null;
      const result = await provider.generate({
        task: "summarisation",
        prompt,
        temperature: 0,
      });
      return result.text;
    },
  };
}
