import { Config, getEffectiveClassifierModel } from "../config.ts";
import { processEnvGet } from "../platform/env-access.ts";
import { agentErrorFromHttpResponse, GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
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

function resolveAnthropicModelId(configured: string): string {
  const s = configured.trim();
  if (s.startsWith("anthropic/")) {
    return s.slice("anthropic/".length);
  }
  return s;
}

const SAFE_MODEL_NAME_RE = /^[A-Za-z0-9._/:-]{1,128}$/;

function assertSafeModelName(model: string): string {
  if (!SAFE_MODEL_NAME_RE.test(model)) {
    throw new Error(
      `Refusing to call provider API with malformed model name (got ${model.length} chars; expected /^[A-Za-z0-9._/:-]{1,128}$/). Check nimbus.toml [llm].classifier_model or NIMBUS_CLASSIFIER_MODEL.`,
    );
  }
  return model;
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

const CLASSIFIER_SYSTEM_PROMPT_ANTHROPIC = `You classify user requests for a local-first assistant. Reply with a single JSON object only, no markdown:
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

const CLASSIFIER_SYSTEM_PROMPT_OPENAI = `Classify the user message. Return JSON only:
{"intent":"file_search"|"file_organize"|"unknown","entities":{},"requiresHITL":bool,"confidence":0-1}
file_search: finding files — put pattern in entities.pattern, optional entities.path.
file_organize: move/rename — entities.source and entities.destination.
unknown: else.`;

type LlmClassifyProvider = "anthropic" | "openai";

async function llmClassify(
  provider: LlmClassifyProvider,
  userText: string,
  model: string,
  apiKey: string,
): Promise<ClassifiedIntent> {
  const trimmed = userText.slice(0, 8000);
  if (provider === "anthropic") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: assertSafeModelName(resolveAnthropicModelId(model)),
        max_tokens: 512,
        system: CLASSIFIER_SYSTEM_PROMPT_ANTHROPIC,
        messages: [{ role: "user", content: trimmed }],
      }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      throw agentErrorFromHttpResponse("anthropic", res.status, errBody);
    }
    const body = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
    };
    const block = body.content?.find((c) => c.type === "text");
    const text = block?.text ?? "";
    const raw = extractJsonObject(text);
    const o = parseClassifierJsonObject(raw, "Classifier returned non-JSON");
    return classifiedFromObject(o);
  }

  const m = assertSafeModelName(model.replace(/^openai\//, ""));
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: m,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: CLASSIFIER_SYSTEM_PROMPT_OPENAI },
        { role: "user", content: trimmed },
      ],
    }),
  });
  if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw agentErrorFromHttpResponse("openai", res.status, errBody);
  }
  const body = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  const text = body.choices?.[0]?.message?.content ?? "";
  const raw = extractJsonObject(text);
  const o = parseClassifierJsonObject(raw, "Classifier returned non-JSON");
  return classifiedFromObject(o);
}

/**
 * What this classifier is permitted to reach.
 *
 * REQUIRED, and deliberately not an optional parameter defaulting to permissive. This function
 * reads `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` straight from the process environment and POSTs the
 * user's text to a vendor — it is the one path in the gateway that egresses without going through
 * `LlmRouter`, which has honoured `enforceAirGap` all along. A default would make "forgot to pass
 * the policy" indistinguishable from "policy says egress is fine", and the first is the bug that
 * shipped: `[llm] enforce_air_gap = true` did nothing here, while the published FAQ said it
 * "blocks all outbound HTTP for the duration of an `ask` round-trip".
 *
 * Required means a new caller is a COMPILE error rather than a silent hole.
 */
export type ClassifierEgressPolicy = {
  /** `[llm] enforce_air_gap`. True refuses the call outright — see {@link LlmRouter.enforcesAirGap}. */
  readonly enforceAirGap: boolean;
};

export async function classifyIntent(
  userText: string,
  policy: ClassifierEgressPolicy,
): Promise<ClassifiedIntent> {
  const trimmed = userText.trim();
  if (trimmed.length === 0) {
    return {
      intent: "unknown",
      entities: {},
      requiresHITL: false,
      confidence: 1,
    };
  }

  // BEFORE the environment is read, not after. Reading the key first and refusing later would
  // still be correct, but this ordering makes the refusal impossible to get wrong when a future
  // provider arm is added below: a new arm added under this guard cannot egress, and one added
  // above it would have to step over the guard visibly.
  if (policy.enforceAirGap) {
    throw new GatewayAgentUnavailableError({ reason: "air_gap" });
  }

  const anthropicKey = processEnvGet("ANTHROPIC_API_KEY");
  const openAiKey = processEnvGet("OPENAI_API_KEY");

  if (anthropicKey !== undefined && anthropicKey.length > 0) {
    try {
      return await llmClassify("anthropic", trimmed, getEffectiveClassifierModel(), anthropicKey);
    } catch (e) {
      if (e instanceof GatewayAgentUnavailableError) {
        throw e;
      }
      throw new GatewayAgentUnavailableError({ reason: "network_error", provider: "anthropic" });
    }
  }

  if (openAiKey !== undefined && openAiKey.length > 0) {
    try {
      return await llmClassify("openai", trimmed, Config.openaiClassifierModel, openAiKey);
    } catch (e) {
      if (e instanceof GatewayAgentUnavailableError) {
        throw e;
      }
      throw new GatewayAgentUnavailableError({ reason: "network_error", provider: "openai" });
    }
  }

  throw new GatewayAgentUnavailableError({ reason: "no_api_key" });
}
