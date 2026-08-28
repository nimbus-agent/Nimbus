import { LlmProviderError } from "../llm/provider-error.ts";
import type { LlmGenerateOptions, LlmGenerateResult } from "../llm/types.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { extractFirstMarkdownFenceBody } from "./json-fence.ts";

export type IntentClass = "file_search" | "file_organize" | "unknown";

export type ClassifiedIntent = {
  intent: IntentClass;
  entities: Record<string, string>;
  requiresHITL: boolean;
  confidence: number;
};

function extractJsonObject(text: string): string {
  const t = text.trim();
  const fenced = extractFirstMarkdownFenceBody(t);
  if (fenced !== undefined) {
    return fenced;
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) {
    return t.slice(start, end + 1);
  }
  return t;
}

function parseClassifierJsonObject(
  raw: string,
  parseErrorMessage: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error(parseErrorMessage);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Classifier JSON not an object");
  }
  return parsed as Record<string, unknown>;
}

function normalizeIntent(intentRaw: unknown): IntentClass {
  if (intentRaw === "file_search" || intentRaw === "file_organize" || intentRaw === "unknown") {
    return intentRaw;
  }
  return "unknown";
}

function normalizeConfidence(confidenceRaw: unknown): number {
  return typeof confidenceRaw === "number" && Number.isFinite(confidenceRaw)
    ? Math.min(1, Math.max(0, confidenceRaw))
    : 0;
}

function normalizeEntities(entitiesRaw: unknown): Record<string, string> {
  const entities: Record<string, string> = {};
  if (entitiesRaw !== null && typeof entitiesRaw === "object" && !Array.isArray(entitiesRaw)) {
    for (const [k, v] of Object.entries(entitiesRaw as Record<string, unknown>)) {
      if (typeof v === "string") {
        entities[k] = v;
      }
    }
  }
  return entities;
}

function classifiedFromObject(o: Record<string, unknown>): ClassifiedIntent {
  const intent = normalizeIntent(o["intent"]);
  const confidence = normalizeConfidence(o["confidence"]);
  const entities = normalizeEntities(o["entities"]);
  const requiresHITLRaw = o["requiresHITL"];
  const requiresHITL =
    typeof requiresHITLRaw === "boolean" ? requiresHITLRaw : intent === "file_organize";
  return { intent, entities, requiresHITL, confidence };
}

const CLASSIFIER_SYSTEM_PROMPT = `You classify user requests for a local-first assistant. Reply with a single JSON object only, no markdown:
{
  "intent": "file_search" | "file_organize" | "unknown",
  "entities": { string: string },
  "requiresHITL": boolean,
  "confidence": number
}
Rules:
- file_search: user wants to find/list/search files by name or pattern. Put glob or substring in entities.pattern; optional entities.path for root directory.
- file_organize: user wants to move or rename a file/dir. Put entities.source and entities.destination (full or relative paths under the allowed sandbox).
- unknown: chit-chat, unclear, or unsupported. Keep entities empty or minimal.
- requiresHITL: true for file_organize (destructive path change), false for file_search.
- confidence: 0–1.`;

/**
 * What this classifier is permitted to reach.
 *
 * REQUIRED, and deliberately not an optional parameter defaulting to permissive. A default would
 * make "forgot to pass the policy" indistinguishable from "policy says egress is fine", and the
 * first is the bug that shipped once already: `[llm] enforce_air_gap = true` did nothing here,
 * while the published FAQ said it "blocks all outbound HTTP for the duration of an `ask`
 * round-trip".
 *
 * `generate` is `LlmRouter.generate` bound to the gateway's router, and passing it is the whole
 * point of this type. Until 2026-08-28 this function held its OWN HTTP client: it read
 * `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` straight from the process environment and POSTed the
 * user's text to a vendor, making it the one path in the gateway that egressed without going
 * through `LlmRouter`. Two properties the rest of the gateway guarantees did not hold on it:
 *
 *  - **No egress row.** `nimbus prove` reported `0` for a query that had made a real outbound
 *    request carrying user text (I29's `model` class covers `LlmRouter` routes via
 *    `egress/model-egress.ts`, and this path was not one).
 *  - **No opt-in.** A user who enabled Gemini alone still egressed to Anthropic if a stale
 *    `ANTHROPIC_API_KEY` sat in their environment — precisely the shape slice 2b's per-vendor
 *    `[llm.remote.*]` opt-in exists to prevent, one path over.
 *
 * Routing through the router fixes both at once and buys a third thing: classification can now
 * run on a LOCAL model, which the hand-rolled client could never do.
 */
export type ClassifierEgressPolicy = {
  /**
   * `[llm] enforce_air_gap`. Used ONLY to word the failure — the router itself already refuses
   * every non-local route under air-gap ({@link LlmRouter.enforcesAirGap}), so a local route
   * still classifies, which is the behaviour the `air_gap` message promises when it tells the
   * owner to "configure a local model ... to answer without leaving the machine".
   */
  readonly enforceAirGap: boolean;
  /**
   * `LlmRouter.generate`, bound. `undefined` when no router exists at all, which is refused the
   * same way an empty route table is: fail-closed, never a fallback client.
   */
  readonly generate: ((opts: LlmGenerateOptions) => Promise<LlmGenerateResult>) | undefined;
};

const CLASSIFIER_MAX_TOKENS = 512;
/** Low, not zero: the reply is a fixed JSON shape, so sampling buys nothing but drift. */
const CLASSIFIER_TEMPERATURE = 0;
/** Matches the pre-router client's cap, so a long `ask` classifies the same way it always did. */
const CLASSIFIER_INPUT_MAX_CHARS = 8000;

const EMPTY_INTENT: ClassifiedIntent = {
  intent: "unknown",
  entities: {},
  requiresHITL: false,
  confidence: 1,
};

/**
 * Turns a router failure into the reason the owner can act on.
 *
 * `LlmRouter.generate` throws a bare `Error` when the priority walk found NOTHING eligible, which
 * is the common case here and means one of two very different things: air-gap held every remote
 * route back, or no vendor is enabled at all. Only the caller knows which, hence the policy flag.
 */
function classifierFailure(e: unknown, enforceAirGap: boolean): GatewayAgentUnavailableError {
  if (e instanceof GatewayAgentUnavailableError) return e;
  if (e instanceof LlmProviderError) {
    if (e.kind === "auth") return new GatewayAgentUnavailableError({ reason: "invalid_api_key" });
    if (e.kind === "transport") {
      return new GatewayAgentUnavailableError({ reason: "network_error" });
    }
    return new GatewayAgentUnavailableError({ reason: "provider_error", detail: e.message });
  }
  return new GatewayAgentUnavailableError({
    reason: enforceAirGap ? "air_gap" : "no_api_key",
  });
}

export async function classifyIntent(
  userText: string,
  policy: ClassifierEgressPolicy,
): Promise<ClassifiedIntent> {
  const trimmed = userText.trim();
  if (trimmed.length === 0) {
    return EMPTY_INTENT;
  }

  // No router, no classification. The deleted client's env-var fallback lived exactly here, and
  // reinstating any form of it would reopen both holes described on ClassifierEgressPolicy.
  if (policy.generate === undefined) {
    throw new GatewayAgentUnavailableError({
      reason: policy.enforceAirGap ? "air_gap" : "no_api_key",
    });
  }

  let result: LlmGenerateResult;
  try {
    result = await policy.generate({
      task: "classification",
      prompt: trimmed.slice(0, CLASSIFIER_INPUT_MAX_CHARS),
      systemPrompt: CLASSIFIER_SYSTEM_PROMPT,
      maxTokens: CLASSIFIER_MAX_TOKENS,
      temperature: CLASSIFIER_TEMPERATURE,
      // Names THIS call in `egress_ledger` rather than the generic `llm.generate.classification`,
      // so `nimbus prove` can say an `ask` round-trip sent the question text for classification
      // as distinct from sending it for an answer.
      egressMethod: "engine.ask.classify",
    });
  } catch (e) {
    throw classifierFailure(e, policy.enforceAirGap);
  }

  // A reply that arrived but is not the requested shape is a CLASSIFICATION outcome, not a
  // failure: "unknown" is exactly what the prompt asks for when the model cannot place the
  // request, and the caller answers conversationally from there. Throwing here used to be
  // tolerable because only two frontier models ever answered; routing through `LlmRouter` puts
  // small LOCAL models on this path, and those return prose instead of JSON often enough that a
  // throw would abort the `ask` on a routine event. Transport and auth failures still throw
  // above -- those are real failures, and the owner has to see them.
  const raw = extractJsonObject(result.text);
  let o: Record<string, unknown>;
  try {
    o = parseClassifierJsonObject(raw, "Classifier returned non-JSON");
  } catch {
    return { ...EMPTY_INTENT, confidence: 0 };
  }
  return classifiedFromObject(o);
}
