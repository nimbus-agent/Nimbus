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

export type LlmTomlOverrides = {
  agentModel?: string;
  classifierModel?: string;
};

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

export function getEffectiveAgentModel(): string {
  return envOrUndefined("NIMBUS_AGENT_MODEL") ?? tomlAgentModel ?? HARDCODED_AGENT_MODEL_DEFAULT;
}

export function getEffectiveClassifierModel(): string {
  return (
    envOrUndefined("NIMBUS_CLASSIFIER_MODEL") ??
    tomlClassifierModel ??
    HARDCODED_CLASSIFIER_MODEL_DEFAULT
  );
}

export const Config = {
  openaiClassifierModel: processEnvGet("NIMBUS_OPENAI_CLASSIFIER_MODEL") ?? "gpt-4o-mini",
  oauthGoogleClientId: processEnvGet("NIMBUS_OAUTH_GOOGLE_CLIENT_ID") ?? "",
  oauthGoogleClientSecret: processEnvGet("NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET") ?? "",
  oauthMicrosoftClientId: processEnvGet("NIMBUS_OAUTH_MICROSOFT_CLIENT_ID") ?? "",
  oauthSlackClientId: processEnvGet("NIMBUS_OAUTH_SLACK_CLIENT_ID") ?? "",
  oauthNotionClientId: processEnvGet("NIMBUS_OAUTH_NOTION_CLIENT_ID") ?? "",
  oauthNotionClientSecret: processEnvGet("NIMBUS_OAUTH_NOTION_CLIENT_SECRET") ?? "",
  oauthZoomClientId: processEnvGet("NIMBUS_OAUTH_ZOOM_CLIENT_ID") ?? "",
  oauthZoomClientSecret: processEnvGet("NIMBUS_OAUTH_ZOOM_CLIENT_SECRET") ?? "",
  oauthHubspotClientId: processEnvGet("NIMBUS_OAUTH_HUBSPOT_CLIENT_ID") ?? "",
  oauthHubspotClientSecret: processEnvGet("NIMBUS_OAUTH_HUBSPOT_CLIENT_SECRET") ?? "",
  oauthMiroClientId: processEnvGet("NIMBUS_OAUTH_MIRO_CLIENT_ID") ?? "",
  oauthMiroClientSecret: processEnvGet("NIMBUS_OAUTH_MIRO_CLIENT_SECRET") ?? "",
  oauthCanvaClientId: processEnvGet("NIMBUS_OAUTH_CANVA_CLIENT_ID") ?? "",
  oauthCanvaClientSecret: processEnvGet("NIMBUS_OAUTH_CANVA_CLIENT_SECRET") ?? "",
  oauthFigmaClientId: processEnvGet("NIMBUS_OAUTH_FIGMA_CLIENT_ID") ?? "",
  oauthFigmaClientSecret: processEnvGet("NIMBUS_OAUTH_FIGMA_CLIENT_SECRET") ?? "",
  engineContextWindowItems: parseEngineContextWindowItems(),
  searchServicePriorityMap,
  conversationalAgentMaxSteps: parseConversationalAgentMaxSteps(),
  embeddingsEnabled: parseEmbeddingsEnabled(),
  maxAgentDepth: parseMaxAgentDepth(),
  maxToolCallsPerSession: parseMaxToolCallsPerSession(),
} as const;
