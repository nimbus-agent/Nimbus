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

// `[llm] remote_model` / `NIMBUS_AGENT_MODEL` and their `getEffectiveAgentModel()` accessor were
// REMOVED on 2026-08-28. Slice 2b moved the engine agent onto `[llm.remote.<vendor>] model` and
// left this chain dead-ended: nothing called the accessor, so setting either key changed nothing
// while `nimbus config list` still listed the key and `cli-reference.md` still documented
// `nimbus config set llm.remote_model` as THE way to choose a cloud model. With four vendors the
// key is also no longer well defined -- a bare `claude-sonnet-4-6` says nothing about which of
// them is enabled -- which is why it is removed rather than rewired.

export const Config = {
  oauthGoogleClientId: processEnvGet("NIMBUS_OAUTH_GOOGLE_CLIENT_ID") ?? "",
  oauthGoogleClientSecret: processEnvGet("NIMBUS_OAUTH_GOOGLE_CLIENT_SECRET") ?? "",
  oauthMicrosoftClientId: processEnvGet("NIMBUS_OAUTH_MICROSOFT_CLIENT_ID") ?? "",
  oauthSlackClientId: processEnvGet("NIMBUS_OAUTH_SLACK_CLIENT_ID") ?? "",
  oauthNotionClientId: processEnvGet("NIMBUS_OAUTH_NOTION_CLIENT_ID") ?? "",
  oauthNotionClientSecret: processEnvGet("NIMBUS_OAUTH_NOTION_CLIENT_SECRET") ?? "",
  oauthZoomClientId: processEnvGet("NIMBUS_OAUTH_ZOOM_CLIENT_ID") ?? "",
  oauthZoomClientSecret: processEnvGet("NIMBUS_OAUTH_ZOOM_CLIENT_SECRET") ?? "",
  oauthMendeleyClientId: processEnvGet("NIMBUS_OAUTH_MENDELEY_CLIENT_ID") ?? "",
  oauthMendeleyClientSecret: processEnvGet("NIMBUS_OAUTH_MENDELEY_CLIENT_SECRET") ?? "",
  oauthWorkdayClientId: processEnvGet("NIMBUS_OAUTH_WORKDAY_CLIENT_ID") ?? "",
  oauthWorkdayClientSecret: processEnvGet("NIMBUS_OAUTH_WORKDAY_CLIENT_SECRET") ?? "",
  workdayTenantHost: processEnvGet("NIMBUS_WORKDAY_TENANT_HOST") ?? "",
  workdayTenant: processEnvGet("NIMBUS_WORKDAY_TENANT") ?? "",
  oauthHubspotClientId: processEnvGet("NIMBUS_OAUTH_HUBSPOT_CLIENT_ID") ?? "",
  oauthHubspotClientSecret: processEnvGet("NIMBUS_OAUTH_HUBSPOT_CLIENT_SECRET") ?? "",
  oauthMiroClientId: processEnvGet("NIMBUS_OAUTH_MIRO_CLIENT_ID") ?? "",
  oauthMiroClientSecret: processEnvGet("NIMBUS_OAUTH_MIRO_CLIENT_SECRET") ?? "",
  oauthCanvaClientId: processEnvGet("NIMBUS_OAUTH_CANVA_CLIENT_ID") ?? "",
  oauthCanvaClientSecret: processEnvGet("NIMBUS_OAUTH_CANVA_CLIENT_SECRET") ?? "",
  oauthFigmaClientId: processEnvGet("NIMBUS_OAUTH_FIGMA_CLIENT_ID") ?? "",
  oauthFigmaClientSecret: processEnvGet("NIMBUS_OAUTH_FIGMA_CLIENT_SECRET") ?? "",
  oauthSalesforceClientId: processEnvGet("NIMBUS_OAUTH_SALESFORCE_CLIENT_ID") ?? "",
  oauthSalesforceClientSecret: processEnvGet("NIMBUS_OAUTH_SALESFORCE_CLIENT_SECRET") ?? "",
  engineContextWindowItems: parseEngineContextWindowItems(),
  searchServicePriorityMap,
  conversationalAgentMaxSteps: parseConversationalAgentMaxSteps(),
  embeddingsEnabled: parseEmbeddingsEnabled(),
  maxAgentDepth: parseMaxAgentDepth(),
  maxToolCallsPerSession: parseMaxToolCallsPerSession(),
} as const;
