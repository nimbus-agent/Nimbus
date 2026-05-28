import { processEnvGet } from "./platform/env-access.ts";

export function parseSearchPriorityJson(): ReadonlyMap<string, number> {
  const raw = processEnvGet("NIMBUS_SEARCH_PRIORITY_JSON");
  if (raw === undefined || raw.trim() === "") {
    return new Map();
  }
  try {
    const p: unknown = JSON.parse(raw);
    if (p === null || typeof p !== "object" || Array.isArray(p)) {
      return new Map();
    }
    const m = new Map<string, number>();
    for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
      if (typeof v === "number" && Number.isFinite(v)) {
        m.set(k, Math.min(1, Math.max(0, v)));
      }
    }
    return m;
  } catch {
    return new Map();
  }
}

export function parseEngineContextWindowItems(): number {
  const raw = processEnvGet("NIMBUS_ENGINE_CONTEXT_WINDOW_ITEMS");
  if (raw === undefined || raw === "") {
    return 20;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= 200 ? n : 20;
}

export function parseConversationalAgentMaxSteps(): number {
  const raw = processEnvGet("NIMBUS_ASK_MAX_STEPS");
  if (raw === undefined || raw === "") {
    return 20;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= 64 ? n : 20;
}

export function parseMaxAgentDepth(): number {
  const raw = processEnvGet("NIMBUS_MAX_AGENT_DEPTH");
  if (raw === undefined || raw === "") {
    return 3;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= 10 ? n : 3;
}

export function parseMaxToolCallsPerSession(): number {
  const raw = processEnvGet("NIMBUS_MAX_TOOL_CALLS_PER_SESSION");
  if (raw === undefined || raw === "") {
    return 20;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 && n <= 200 ? n : 20;
}

export function parseEmbeddingsEnabled(): boolean {
  const raw = processEnvGet("NIMBUS_EMBEDDINGS");
  if (raw === "0" || raw === "false") {
    return false;
  }
  return true;
}

const searchServicePriorityMap: ReadonlyMap<string, number> = parseSearchPriorityJson();

const HARDCODED_AGENT_MODEL_DEFAULT = "claude-sonnet-4-6";
const HARDCODED_CLASSIFIER_MODEL_DEFAULT = "claude-haiku-4-5-20251001";

let tomlAgentModel: string | undefined;
let tomlClassifierModel: string | undefined;

/**
 * TOML-side overrides for the engine's agent and classifier models. Sourced
 * from `[llm]` in `nimbus.toml` (`remote_model`, `classifier_model`) and
 * applied at gateway assembly time.
 *
 * Resolution priority: env var > TOML > hardcoded default.
 */
export type LlmTomlOverrides = {
  agentModel?: string;
  classifierModel?: string;
};

/**
 * Apply `[llm]` overrides loaded from `nimbus.toml`. Idempotent — calling
 * again replaces the previous overrides. Env vars always win regardless of
 * TOML, so this only takes effect when `NIMBUS_AGENT_MODEL` /
 * `NIMBUS_CLASSIFIER_MODEL` are unset.
 */
export function applyLlmTomlOverrides(overrides: LlmTomlOverrides): void {
  tomlAgentModel =
    typeof overrides.agentModel === "string" && overrides.agentModel !== ""
      ? overrides.agentModel
      : undefined;
  tomlClassifierModel =
    typeof overrides.classifierModel === "string" && overrides.classifierModel !== ""
      ? overrides.classifierModel
      : undefined;
}

function envOrUndefined(name: string): string | undefined {
  const v = processEnvGet(name);
  return v !== undefined && v !== "" ? v : undefined;
}

/** Resolve the effective agent (Mastra) model, honoring env > TOML > default. */
export function getEffectiveAgentModel(): string {
  return envOrUndefined("NIMBUS_AGENT_MODEL") ?? tomlAgentModel ?? HARDCODED_AGENT_MODEL_DEFAULT;
}

/** Resolve the effective Anthropic classifier model, honoring env > TOML > default. */
export function getEffectiveClassifierModel(): string {
  return (
    envOrUndefined("NIMBUS_CLASSIFIER_MODEL") ??
    tomlClassifierModel ??
    HARDCODED_CLASSIFIER_MODEL_DEFAULT
  );
}

/**
 * Central env-driven config. Never hardcode provider model ids in call sites.
 *
 * Note: agent and Anthropic-classifier model ids are not on this object —
 * use {@link getEffectiveAgentModel} / {@link getEffectiveClassifierModel}
 * so TOML overrides are honored.
 */
export const Config = {
  /** Used when only `OPENAI_API_KEY` is set (Anthropic model ids are invalid on OpenAI). */
  openaiClassifierModel: processEnvGet("NIMBUS_OPENAI_CLASSIFIER_MODEL") ?? "gpt-4o-mini",
  /**
   * Public OAuth client ids (PKCE). Set in the environment until bundled desktop ids ship.
   * Phase 4 A.3: each Google/Microsoft service now also stores a per-service vault key
   * (e.g. `google.drive.oauth`) in addition to the shared provider key.
   */
  oauthGoogleClientId: processEnvGet("NIMBUS_OAUTH_GOOGLE_CLIENT_ID") ?? "",
  /**
   * Only for Google **Web application** OAuth clients (confidential). Desktop clients use PKCE without a secret.
   */
  oauthGoogleClientSecret: processEnvGet("NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET") ?? "",
  oauthMicrosoftClientId: processEnvGet("NIMBUS_OAUTH_MICROSOFT_CLIENT_ID") ?? "",
  oauthSlackClientId: processEnvGet("NIMBUS_OAUTH_SLACK_CLIENT_ID") ?? "",
  /** Notion public integration (token endpoint requires Basic auth with secret). */
  oauthNotionClientId: processEnvGet("NIMBUS_OAUTH_NOTION_CLIENT_ID") ?? "",
  oauthNotionClientSecret: processEnvGet("NIMBUS_OAUTH_NOTION_CLIENT_SECRET") ?? "",
  /** Zoom app (token endpoint requires HTTP Basic auth with the secret). */
  oauthZoomClientId: processEnvGet("NIMBUS_OAUTH_ZOOM_CLIENT_ID") ?? "",
  oauthZoomClientSecret: processEnvGet("NIMBUS_OAUTH_ZOOM_CLIENT_SECRET") ?? "",
  /**
   * Q2 §7.0 — top-N items passed in full to the agent after ranked search; override with `NIMBUS_ENGINE_CONTEXT_WINDOW_ITEMS` (1–200).
   * Future: `engine.context_window_items` in nimbus.toml.
   */
  engineContextWindowItems: parseEngineContextWindowItems(),
  /** Q2 §7.2 — per-service weights (0–1); JSON object env `NIMBUS_SEARCH_PRIORITY_JSON` e.g. `{"github":0.8,"slack":0.7}`. */
  searchServicePriorityMap,
  /** Mastra tool loop depth for conversational `nimbus ask` (`NIMBUS_ASK_MAX_STEPS`, 1–64). */
  conversationalAgentMaxSteps: parseConversationalAgentMaxSteps(),
  /**
   * Phase 3 — background local embeddings after index upserts (`NIMBUS_EMBEDDINGS=false` to disable).
   */
  embeddingsEnabled: parseEmbeddingsEnabled(),
  /**
   * Phase 4 WS1 — multi-agent loop guards.
   * `maxAgentDepth`: maximum sub-agent recursion depth (`NIMBUS_MAX_AGENT_DEPTH`, 1–10; default 3).
   * `maxToolCallsPerSession`: hard cap on total tool calls per session (`NIMBUS_MAX_TOOL_CALLS_PER_SESSION`, 1–200; default 20).
   * Exceeding either fires `agent.gasLimitReached` and halts new decomposition.
   */
  maxAgentDepth: parseMaxAgentDepth(),
  maxToolCallsPerSession: parseMaxToolCallsPerSession(),
} as const;
