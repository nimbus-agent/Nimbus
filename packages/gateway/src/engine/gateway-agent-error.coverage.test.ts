/**
 * gateway-agent-error.coverage.test.ts — the arms of gateway-agent-error.ts the main suite leaves
 * open: the default (no-argument) error, the `provider_error` wording with and without a detail,
 * HTTP error bodies that are JSON but not an object, and `model_not_found` reached from a caught
 * error rather than an HTTP status.
 */
import { describe, expect, test } from "bun:test";

import {
  agentErrorFromCaughtError,
  agentErrorFromHttpResponse,
  GatewayAgentUnavailableError,
} from "./gateway-agent-error.ts";

describe("GatewayAgentUnavailableError", () => {
  test("constructed with no argument it is the generic 'unknown' error", () => {
    const e = new GatewayAgentUnavailableError();
    expect(e.reason).toBe("unknown");
    expect(e.provider).toBeUndefined();
    expect(e.name).toBe("GatewayAgentUnavailableError");
    expect(e.message).toBe("Agent unavailable. Check the gateway log for details.");
  });

  test("provider_error appends a non-empty detail and omits an empty or absent one", () => {
    expect(
      new GatewayAgentUnavailableError({
        reason: "provider_error",
        provider: "gemini",
        detail: "x",
      }).message,
    ).toBe("Gemini request failed. x");
    expect(
      new GatewayAgentUnavailableError({ reason: "provider_error", provider: "xai", detail: "" })
        .message,
    ).toBe("xAI request failed.");
    expect(new GatewayAgentUnavailableError({ reason: "provider_error" }).message).toBe(
      "the LLM provider request failed.",
    );
  });
});

describe("agentErrorFromHttpResponse — bodies that are JSON but not an object", () => {
  test.each([
    ["an array", "[1, 2]"],
    ["null", "null"],
    ["a number", "42"],
    ["a string", '"oops"'],
  ])("%s yields a plain provider_error naming only the status", (_label, body) => {
    const e = agentErrorFromHttpResponse("openai", 500, body);
    expect(e.reason).toBe("provider_error");
    expect(e.provider).toBe("openai");
    expect(e.message).toBe("OpenAI request failed. HTTP 500");
  });

  test("an object body's message is carried after the status", () => {
    const e = agentErrorFromHttpResponse("anthropic", 503, '{"error":{"message":"overloaded"}}');
    expect(e.message).toBe("Anthropic request failed. HTTP 503: overloaded");
  });
});

describe("agentErrorFromCaughtError — model_not_found", () => {
  test.each([
    ["a model_not_found code", new Error("error: model_not_found")],
    ["a 'does not exist' message", new Error("The model `gpt-9` does not exist")],
    ["a bare 404", new Error("request failed with status 404")],
  ])("%s maps to model_not_found", (_label, err) => {
    const e = agentErrorFromCaughtError(err, "xai");
    expect(e?.reason).toBe("model_not_found");
    expect(e?.provider).toBe("xai");
    expect(e?.message).toContain("xAI returned 404 for the configured model");
  });

  test("a non-Error value is classified by its string form", () => {
    expect(agentErrorFromCaughtError("Model does not exist")?.reason).toBe("model_not_found");
    expect(agentErrorFromCaughtError("something unrelated broke")).toBeNull();
  });
});
