import { describe, expect, test } from "bun:test";

import {
  agentErrorFromCaughtError,
  agentErrorFromHttpResponse,
  GatewayAgentUnavailableError,
  NO_LLM_SENTINEL,
} from "./gateway-agent-error.ts";

describe("GatewayAgentUnavailableError messages", () => {
  test("no_api_key tells the user how to set one and restart", () => {
    const e = new GatewayAgentUnavailableError({ reason: "no_api_key" });
    expect(e.message).toContain("ANTHROPIC_API_KEY");
    expect(e.message).toContain("OPENAI_API_KEY");
    expect(e.message).toContain("nimbus stop");
  });

  test("no_api_key offers the LOCAL route too, not only a paid key", () => {
    // "set an API key" alone reads as "this tool costs money" — the single most
    // damaging thing the onboarding funnel can say, and untrue: only `ask` and
    // prose synthesis need an LLM at all.
    const e = new GatewayAgentUnavailableError({ reason: "no_api_key" });
    expect(e.message).toContain("Ollama");
    expect(e.message).toContain("prefer_local = true");
    expect(e.message).toContain("work with no LLM configured");
  });

  test("no_api_key message starts with the sentinel clients key on", () => {
    // The CLI cannot import this module and the JSON-RPC transport in
    // @nimbus-dev/client drops the numeric error code, so `nimbus ask` matches
    // this substring to render guidance instead of a raw error. Changing the
    // sentinel MUST move packages/cli/src/commands/ask.ts in the same commit.
    expect(NO_LLM_SENTINEL).toBe("Nimbus needs an LLM for this command.");
    const e = new GatewayAgentUnavailableError({ reason: "no_api_key" });
    expect(e.message.startsWith(NO_LLM_SENTINEL)).toBe(true);
  });

  test("insufficient_quota names the provider and explains topping up", () => {
    const e = new GatewayAgentUnavailableError({
      reason: "insufficient_quota",
      provider: "openai",
    });
    expect(e.message).toContain("OpenAI");
    expect(e.message).toContain("no credits remaining");
    expect(e.message).toContain("no gateway restart needed");
  });

  test("invalid_api_key names the provider and 401", () => {
    const e = new GatewayAgentUnavailableError({
      reason: "invalid_api_key",
      provider: "anthropic",
    });
    expect(e.message).toContain("Anthropic");
    expect(e.message).toContain("401");
  });

  test("network_error names the provider and asks about connection", () => {
    const e = new GatewayAgentUnavailableError({
      reason: "network_error",
      provider: "openai",
    });
    expect(e.message).toContain("OpenAI");
    expect(e.message).toContain("network");
  });

  test("provider_error appends the safe detail without leaking", () => {
    const e = new GatewayAgentUnavailableError({
      reason: "provider_error",
      provider: "openai",
      detail: "HTTP 500: upstream broke",
    });
    expect(e.message).toContain("OpenAI");
    expect(e.message).toContain("HTTP 500");
    expect(e.message).toContain("upstream broke");
  });
});

describe("agentErrorFromHttpResponse", () => {
  test("OpenAI 429 with insufficient_quota → insufficient_quota", () => {
    const body = JSON.stringify({
      error: {
        message: "You exceeded your current quota, please check your plan and billing details.",
        type: "insufficient_quota",
        code: "insufficient_quota",
      },
    });
    const e = agentErrorFromHttpResponse("openai", 429, body);
    expect(e.reason).toBe("insufficient_quota");
    expect(e.provider).toBe("openai");
  });

  test("OpenAI 429 with rate_limit_exceeded → rate_limited", () => {
    const body = JSON.stringify({
      error: { message: "Rate limit", type: "rate_limit_exceeded", code: "rate_limit_exceeded" },
    });
    const e = agentErrorFromHttpResponse("openai", 429, body);
    expect(e.reason).toBe("rate_limited");
  });

  test("OpenAI 401 with invalid_api_key → invalid_api_key", () => {
    const body = JSON.stringify({
      error: { message: "Incorrect API key provided.", code: "invalid_api_key" },
    });
    const e = agentErrorFromHttpResponse("openai", 401, body);
    expect(e.reason).toBe("invalid_api_key");
  });

  test("Anthropic 400 with credit balance message → insufficient_quota", () => {
    const body = JSON.stringify({
      error: { type: "invalid_request_error", message: "Your credit balance is too low" },
    });
    const e = agentErrorFromHttpResponse("anthropic", 400, body);
    expect(e.reason).toBe("insufficient_quota");
    expect(e.provider).toBe("anthropic");
  });

  test("Anthropic 401 authentication_error → invalid_api_key", () => {
    const body = JSON.stringify({
      error: { type: "authentication_error", message: "x-api-key header invalid" },
    });
    const e = agentErrorFromHttpResponse("anthropic", 401, body);
    expect(e.reason).toBe("invalid_api_key");
  });

  test("404 → model_not_found", () => {
    const e = agentErrorFromHttpResponse("openai", 404, "{}");
    expect(e.reason).toBe("model_not_found");
  });

  test("unrecognized 5xx → provider_error with sanitized HTTP detail", () => {
    const body = JSON.stringify({ error: { message: "internal server error" } });
    const e = agentErrorFromHttpResponse("openai", 503, body);
    expect(e.reason).toBe("provider_error");
    expect(e.message).toContain("HTTP 503");
    expect(e.message).toContain("internal server error");
  });

  test("non-JSON body still classifies by status code", () => {
    const e = agentErrorFromHttpResponse("openai", 401, "<html>nginx</html>");
    expect(e.reason).toBe("invalid_api_key");
  });

  test("provider_error truncates very long detail messages", () => {
    const longMsg = "x".repeat(500);
    const body = JSON.stringify({ error: { message: longMsg } });
    const e = agentErrorFromHttpResponse("openai", 503, body);
    expect(e.message.length).toBeLessThan(longMsg.length + 100);
    expect(e.message).toContain("…");
  });
});

describe("agentErrorFromCaughtError", () => {
  test("missing API key → invalid_api_key", () => {
    const e = agentErrorFromCaughtError(new Error("missing API key"));
    expect(e?.reason).toBe("invalid_api_key");
  });

  test("OpenAI insufficient_quota wrapped by Mastra → insufficient_quota", () => {
    const e = agentErrorFromCaughtError(
      new Error("upstream: 429 insufficient_quota — billing limit reached"),
    );
    expect(e?.reason).toBe("insufficient_quota");
  });

  test("rate_limit_error → rate_limited", () => {
    const e = agentErrorFromCaughtError(new Error("hit rate limit, please slow down"));
    expect(e?.reason).toBe("rate_limited");
  });

  test("non-LLM error → null", () => {
    const e = agentErrorFromCaughtError(new Error("disk full"));
    expect(e).toBeNull();
  });

  test("preserves provider when supplied", () => {
    const e = agentErrorFromCaughtError(new Error("401 Unauthorized"), "openai");
    expect(e?.provider).toBe("openai");
  });
});
