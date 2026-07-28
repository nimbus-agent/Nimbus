export type AgentUnavailableReason =
  | "no_api_key"
  | "invalid_api_key"
  | "insufficient_quota"
  | "rate_limited"
  | "model_not_found"
  | "provider_error"
  | "network_error"
  | "unknown";

export type AgentProviderName = "anthropic" | "openai";

export type AgentUnavailableInit = {
  reason: AgentUnavailableReason;
  provider?: AgentProviderName;
  detail?: string;
};

const DEFAULT_AGENT_UNAVAILABLE_INIT: AgentUnavailableInit = { reason: "unknown" };

/**
 * Stable first line of the no-LLM message.
 *
 * Clients match on this to render the guidance cleanly instead of as a raw
 * error. It has to be a substring match rather than an error code because the
 * JSON-RPC transport in `@nimbus-dev/client` rejects with a plain Error
 * carrying only the message — the numeric code never reaches the client. Pinned
 * by a test; if this string changes, the CLI branch that keys on it must move
 * in the same commit.
 */
export const NO_LLM_SENTINEL = "Nimbus needs an LLM for this command.";

/**
 * The guidance itself lives here, not in any one client, so the CLI, the TUI,
 * and the VS Code extension all surface the same two routes. Naming BOTH the
 * local and the hosted route matters: "set an API key" alone reads as "this
 * tool costs money", which is the single most damaging thing the funnel can
 * say — indexing, `nimbus why`, and the agent briefs need no LLM at all.
 */
const NO_LLM_CONFIGURED_MESSAGE = [
  NO_LLM_SENTINEL,
  "",
  "  Local  — install Ollama, then in nimbus.toml:",
  "             [llm]",
  "             prefer_local = true",
  '             local_model  = "llama3.1"',
  "",
  "  Hosted — set ANTHROPIC_API_KEY or OPENAI_API_KEY in the gateway's environment,",
  "           then restart with: nimbus stop && nimbus start",
  "",
  "Indexing, `nimbus why`, and the agent briefs all work with no LLM configured.",
].join("\n");

export class GatewayAgentUnavailableError extends Error {
  override readonly name = "GatewayAgentUnavailableError";
  readonly reason: AgentUnavailableReason;
  readonly provider: AgentProviderName | undefined;

  constructor(init: AgentUnavailableInit = DEFAULT_AGENT_UNAVAILABLE_INIT) {
    super(buildAgentErrorMessage(init));
    this.reason = init.reason;
    this.provider = init.provider;
  }
}

function providerLabel(provider: AgentProviderName | undefined): string {
  if (provider === "anthropic") return "Anthropic";
  if (provider === "openai") return "OpenAI";
  return "the LLM provider";
}

function buildAgentErrorMessage(init: AgentUnavailableInit): string {
  const provider = providerLabel(init.provider);
  switch (init.reason) {
    case "no_api_key":
      return NO_LLM_CONFIGURED_MESSAGE;
    case "invalid_api_key":
      return `${provider} rejected the API key (HTTP 401). Verify the key is correct and not revoked, then restart the gateway.`;
    case "insufficient_quota":
      return `${provider} account has no credits remaining. Top up your billing balance and retry — no gateway restart needed.`;
    case "rate_limited":
      return `${provider} rate limit hit. Wait a moment and retry, or upgrade your usage tier.`;
    case "model_not_found":
      return `${provider} returned 404 for the configured model. Check NIMBUS_AGENT_MODEL / NIMBUS_CLASSIFIER_MODEL (or NIMBUS_OPENAI_CLASSIFIER_MODEL when using OpenAI) or your access tier.`;
    case "provider_error": {
      const detail = init.detail !== undefined && init.detail !== "" ? ` ${init.detail}` : "";
      return `${provider} request failed.${detail}`;
    }
    case "network_error":
      return `Could not reach ${provider}. Check your network connection.`;
    case "unknown":
      return "Agent unavailable. Check the gateway log for details.";
  }
}

const SAFE_DETAIL_MAX = 160;

function clipDetail(s: string): string {
  const trimmed = s.trim();
  if (trimmed.length <= SAFE_DETAIL_MAX) return trimmed;
  return `${trimmed.slice(0, SAFE_DETAIL_MAX - 1)}…`;
}

type ProviderErrorBody = {
  error?: { type?: string; code?: string; message?: string };
};

function parseProviderErrorBody(body: string): ProviderErrorBody {
  try {
    const parsed = JSON.parse(body) as unknown;
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    /* not JSON */
  }
  return {};
}

export function agentErrorFromHttpResponse(
  provider: AgentProviderName,
  status: number,
  body: string,
): GatewayAgentUnavailableError {
  const parsed = parseProviderErrorBody(body);
  const errInfo = parsed.error ?? {};
  const code = typeof errInfo.code === "string" ? errInfo.code : "";
  const type = typeof errInfo.type === "string" ? errInfo.type : "";
  const msg = typeof errInfo.message === "string" ? errInfo.message : "";
  const lowerMsg = msg.toLowerCase();

  if (status === 401 || code === "invalid_api_key" || type === "authentication_error") {
    return new GatewayAgentUnavailableError({ reason: "invalid_api_key", provider });
  }
  if (
    code === "insufficient_quota" ||
    type === "insufficient_quota" ||
    lowerMsg.includes("credit balance is too low") ||
    lowerMsg.includes("you exceeded your current quota") ||
    lowerMsg.includes("insufficient_quota")
  ) {
    return new GatewayAgentUnavailableError({ reason: "insufficient_quota", provider });
  }
  if (status === 429 || code === "rate_limit_exceeded" || type === "rate_limit_error") {
    return new GatewayAgentUnavailableError({ reason: "rate_limited", provider });
  }
  if (status === 404) {
    return new GatewayAgentUnavailableError({ reason: "model_not_found", provider });
  }
  return new GatewayAgentUnavailableError({
    reason: "provider_error",
    provider,
    detail: msg === "" ? `HTTP ${String(status)}` : `HTTP ${String(status)}: ${clipDetail(msg)}`,
  });
}

export function agentErrorFromCaughtError(
  e: unknown,
  provider?: AgentProviderName,
): GatewayAgentUnavailableError | null {
  const raw = e instanceof Error ? e.message : String(e);
  const msg = raw.toLowerCase();

  const init = (reason: AgentUnavailableReason): AgentUnavailableInit =>
    provider === undefined ? { reason } : { reason, provider };

  if (
    msg.includes("insufficient_quota") ||
    msg.includes("credit balance is too low") ||
    msg.includes("you exceeded your current quota")
  ) {
    return new GatewayAgentUnavailableError(init("insufficient_quota"));
  }
  if (
    msg.includes("invalid_api_key") ||
    msg.includes("incorrect api key") ||
    msg.includes("missing api key") ||
    msg.includes("401") ||
    msg.includes("unauthorized") ||
    msg.includes("authentication_error")
  ) {
    return new GatewayAgentUnavailableError(init("invalid_api_key"));
  }
  if (msg.includes("rate limit") || msg.includes("429") || msg.includes("rate_limit_error")) {
    return new GatewayAgentUnavailableError(init("rate_limited"));
  }
  if (msg.includes("model_not_found") || msg.includes("does not exist") || msg.includes("404")) {
    return new GatewayAgentUnavailableError(init("model_not_found"));
  }
  return null;
}
