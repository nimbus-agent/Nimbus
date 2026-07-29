import { afterEach, describe, expect, test } from "bun:test";

import type { AgentUnavailableReason } from "./gateway-agent-error.ts";
import { GatewayAgentUnavailableError } from "./gateway-agent-error.ts";
import { classifyIntent } from "./router.ts";

/** Status → reason mapping, identical for every provider. */
const HTTP_STATUS_REASONS: ReadonlyArray<readonly [number, string, AgentUnavailableReason]> = [
  [429, "Too Many Requests", "rate_limited"],
  [404, "Not Found", "model_not_found"],
  [500, "Internal Server Error", "provider_error"],
];

const BUN_NATIVE_FETCH = globalThis.fetch;
const ORIGINAL_ANTHROPIC = process.env["ANTHROPIC_API_KEY"];
const ORIGINAL_OPENAI = process.env["OPENAI_API_KEY"];
const ORIGINAL_CLASSIFIER_MODEL = process.env["NIMBUS_CLASSIFIER_MODEL"];

function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

afterEach(() => {
  globalThis.fetch = BUN_NATIVE_FETCH;
  setEnv("ANTHROPIC_API_KEY", ORIGINAL_ANTHROPIC);
  setEnv("OPENAI_API_KEY", ORIGINAL_OPENAI);
  setEnv("NIMBUS_CLASSIFIER_MODEL", ORIGINAL_CLASSIFIER_MODEL);
});

function stubFetch(impl: (input: string, init?: RequestInit) => Promise<Response>): void {
  globalThis.fetch = impl as typeof globalThis.fetch;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { "content-type": "text/plain" },
  });
}

function anthropicTextResponse(text: string): Response {
  return jsonResponse({ content: [{ type: "text", text }] });
}

function openaiChatResponse(content: string): Response {
  return jsonResponse({ choices: [{ message: { content } }] });
}

function useAnthropicOnly(): void {
  setEnv("ANTHROPIC_API_KEY", "sk-stub-anth");
  setEnv("OPENAI_API_KEY", undefined);
  setEnv("NIMBUS_CLASSIFIER_MODEL", undefined);
}

function useOpenAiOnly(): void {
  setEnv("ANTHROPIC_API_KEY", undefined);
  setEnv("OPENAI_API_KEY", "sk-stub-oai");
  setEnv("NIMBUS_CLASSIFIER_MODEL", undefined);
}

describe("classifyIntent — empty input", () => {
  test("empty string returns unknown,confidence 1 without calling fetch", async () => {
    useAnthropicOnly();
    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return jsonResponse({});
    });

    const result = await classifyIntent("");
    expect(result).toEqual({
      intent: "unknown",
      entities: {},
      requiresHITL: false,
      confidence: 1,
    });
    expect(fetchCalled).toBe(false);
  });

  test("whitespace-only string also short-circuits", async () => {
    useAnthropicOnly();
    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return jsonResponse({});
    });

    const result = await classifyIntent("   \n\t  ");
    expect(result.intent).toBe("unknown");
    expect(result.confidence).toBe(1);
    expect(fetchCalled).toBe(false);
  });
});

describe("classifyIntent — Anthropic happy paths", () => {
  test("parses plain JSON body, returns file_search intent", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "file_search",
          entities: { pattern: "*.md" },
          requiresHITL: false,
          confidence: 0.9,
        }),
      ),
    );

    const result = await classifyIntent("find markdown files");
    expect(result.intent).toBe("file_search");
    expect(result.entities).toEqual({ pattern: "*.md" });
    expect(result.requiresHITL).toBe(false);
    expect(result.confidence).toBeCloseTo(0.9, 5);
  });

  test("calls Anthropic endpoint with x-api-key header and anthropic-version header", async () => {
    useAnthropicOnly();
    let capturedReq: Request | undefined;
    stubFetch(async (input, init) => {
      capturedReq = new Request(input, init);
      return anthropicTextResponse(
        JSON.stringify({ intent: "unknown", entities: {}, requiresHITL: false, confidence: 0.5 }),
      );
    });

    await classifyIntent("hi");
    expect(capturedReq).toBeDefined();
    expect(capturedReq?.url).toBe("https://api.anthropic.com/v1/messages");
    expect(capturedReq?.method).toBe("POST");
    expect(capturedReq?.headers.get("x-api-key")).toBe("sk-stub-anth");
    expect(capturedReq?.headers.get("anthropic-version")).toBe("2023-06-01");
    expect(capturedReq?.headers.get("content-type")).toBe("application/json");
  });

  test("parses markdown-fenced JSON body (```json...```)", async () => {
    useAnthropicOnly();
    const fenced =
      '```json\n{"intent":"file_organize","entities":{"source":"a","destination":"b"},"requiresHITL":true,"confidence":0.7}\n```';
    stubFetch(async () => anthropicTextResponse(fenced));

    const result = await classifyIntent("move a to b");
    expect(result.intent).toBe("file_organize");
    expect(result.entities).toEqual({ source: "a", destination: "b" });
    expect(result.requiresHITL).toBe(true);
  });

  test("parses bare-fenced JSON body (```...```)", async () => {
    useAnthropicOnly();
    const fenced =
      '```\n{"intent":"file_search","entities":{"pattern":"x"},"requiresHITL":false,"confidence":0.5}\n```';
    stubFetch(async () => anthropicTextResponse(fenced));

    const result = await classifyIntent("find x");
    expect(result.intent).toBe("file_search");
    expect(result.entities).toEqual({ pattern: "x" });
  });

  test("extracts JSON object embedded in surrounding prose", async () => {
    useAnthropicOnly();
    const prose =
      'Sure, here is the classification: {"intent":"unknown","entities":{},"requiresHITL":false,"confidence":0.3} hope this helps.';
    stubFetch(async () => anthropicTextResponse(prose));

    const result = await classifyIntent("?");
    expect(result.intent).toBe("unknown");
    expect(result.confidence).toBeCloseTo(0.3, 5);
  });

  test("file_organize defaults requiresHITL=true when the field is absent", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "file_organize",
          entities: { source: "x", destination: "y" },
          confidence: 0.8,
        }),
      ),
    );

    const result = await classifyIntent("move x to y");
    expect(result.intent).toBe("file_organize");
    expect(result.requiresHITL).toBe(true);
  });

  test("file_search defaults requiresHITL=false when the field is absent", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "file_search",
          entities: { pattern: "foo" },
          confidence: 0.8,
        }),
      ),
    );

    const result = await classifyIntent("find foo");
    expect(result.requiresHITL).toBe(false);
  });

  test("clamps numeric confidence below 0 to 0", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "unknown",
          entities: {},
          requiresHITL: false,
          confidence: -0.5,
        }),
      ),
    );

    const result = await classifyIntent("hi");
    expect(result.confidence).toBe(0);
  });

  test("clamps numeric confidence above 1 to 1", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "unknown",
          entities: {},
          requiresHITL: false,
          confidence: 5,
        }),
      ),
    );

    const result = await classifyIntent("hi");
    expect(result.confidence).toBe(1);
  });

  test("non-finite confidence (NaN) is coerced to 0", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "unknown",
          entities: {},
          requiresHITL: false,
          confidence: "not a number",
        }),
      ),
    );

    const result = await classifyIntent("hi");
    expect(result.confidence).toBe(0);
  });

  test("non-string entity values are dropped", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "file_search",
          entities: { pattern: "foo", count: 5, nested: { a: 1 }, ok: "yes" },
          requiresHITL: false,
          confidence: 0.5,
        }),
      ),
    );

    const result = await classifyIntent("find foo");
    expect(result.entities).toEqual({ pattern: "foo", ok: "yes" });
  });

  test("non-object entities payload yields empty entities", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "file_search",
          entities: "oops",
          requiresHITL: false,
          confidence: 0.5,
        }),
      ),
    );

    const result = await classifyIntent("find foo");
    expect(result.entities).toEqual({});
  });

  test("array entities payload yields empty entities (Array.isArray guard)", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "file_search",
          entities: ["nope"],
          requiresHITL: false,
          confidence: 0.5,
        }),
      ),
    );

    const result = await classifyIntent("find foo");
    expect(result.entities).toEqual({});
  });

  test("unknown intent values are normalised to 'unknown'", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse(
        JSON.stringify({
          intent: "delete_everything",
          entities: {},
          requiresHITL: true,
          confidence: 0.9,
        }),
      ),
    );

    const result = await classifyIntent("?");
    expect(result.intent).toBe("unknown");
  });

  test("strips anthropic/ prefix from configured Anthropic model id", async () => {
    useAnthropicOnly();
    setEnv("NIMBUS_CLASSIFIER_MODEL", "anthropic/claude-haiku-4-5");
    let capturedBody = "";
    stubFetch(async (input, init) => {
      const req = new Request(input, init);
      capturedBody = await req.text();
      return anthropicTextResponse(
        JSON.stringify({ intent: "unknown", entities: {}, requiresHITL: false, confidence: 0.5 }),
      );
    });

    await classifyIntent("hi");
    const body = JSON.parse(capturedBody) as { model: string };
    expect(body.model).toBe("claude-haiku-4-5");
  });

  test("trims very long input to 8000 chars before sending", async () => {
    useAnthropicOnly();
    let capturedBody = "";
    stubFetch(async (input, init) => {
      const req = new Request(input, init);
      capturedBody = await req.text();
      return anthropicTextResponse(
        JSON.stringify({ intent: "unknown", entities: {}, requiresHITL: false, confidence: 0.5 }),
      );
    });

    const longInput = "x".repeat(10_000);
    await classifyIntent(longInput);
    const body = JSON.parse(capturedBody) as { messages: Array<{ content: string }> };
    expect(body.messages[0]?.content).toHaveLength(8000);
  });
});

describe("classifyIntent — Anthropic error paths", () => {
  test("HTTP 401 → invalid_api_key", async () => {
    useAnthropicOnly();
    stubFetch(async () => textResponse("Unauthorized", 401));

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("invalid_api_key");
    expect((caught as GatewayAgentUnavailableError).provider).toBe("anthropic");
  });

  test.each(HTTP_STATUS_REASONS)("HTTP %s → %s", async (status, body, reason) => {
    useAnthropicOnly();
    stubFetch(async () => textResponse(body, status));

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe(reason);
  });

  test("fetch throws (network exception) → network_error", async () => {
    useAnthropicOnly();
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("network_error");
    expect((caught as GatewayAgentUnavailableError).provider).toBe("anthropic");
  });

  test("HTTP 200 with non-JSON text body → wrapped as network_error", async () => {
    useAnthropicOnly();
    stubFetch(async () =>
      anthropicTextResponse("definitely not JSON, just chatty text from the model."),
    );

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("network_error");
  });

  test("HTTP 200 with JSON that isn't an object (array) → wrapped as network_error", async () => {
    useAnthropicOnly();
    stubFetch(async () => anthropicTextResponse(JSON.stringify([1, 2, 3])));

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("network_error");
  });

  test("HTTP 200 with JSON null → wrapped as network_error", async () => {
    useAnthropicOnly();
    stubFetch(async () => anthropicTextResponse("null"));

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("network_error");
  });

  test("malformed model name (newline char) → assertSafeModelName throws → wrapped as network_error", async () => {
    useAnthropicOnly();
    setEnv("NIMBUS_CLASSIFIER_MODEL", "claude-haiku\n-evil");
    stubFetch(async () => {
      throw new Error("fetch should not be reached when the model name is rejected first");
    });

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("network_error");
  });

  test("response with no text-content block falls through to non-JSON error path", async () => {
    useAnthropicOnly();
    stubFetch(async () => jsonResponse({ content: [{ type: "tool_use", text: "" }] }));

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("network_error");
  });
});

describe("classifyIntent — OpenAI happy paths", () => {
  test("parses plain JSON body from OpenAI choices[0].message.content", async () => {
    useOpenAiOnly();
    stubFetch(async () =>
      openaiChatResponse(
        JSON.stringify({
          intent: "file_search",
          entities: { pattern: "*.ts" },
          requiresHITL: false,
          confidence: 0.85,
        }),
      ),
    );

    const result = await classifyIntent("find ts files");
    expect(result.intent).toBe("file_search");
    expect(result.entities).toEqual({ pattern: "*.ts" });
    expect(result.confidence).toBeCloseTo(0.85, 5);
  });

  test("calls OpenAI chat-completions endpoint with Bearer Authorization header", async () => {
    useOpenAiOnly();
    let capturedReq: Request | undefined;
    let capturedBody = "";
    stubFetch(async (input, init) => {
      capturedReq = new Request(input, init);
      capturedBody = await capturedReq.text();
      return openaiChatResponse(
        JSON.stringify({ intent: "unknown", entities: {}, requiresHITL: false, confidence: 0.5 }),
      );
    });

    await classifyIntent("hi");
    expect(capturedReq).toBeDefined();
    expect(capturedReq?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(capturedReq?.method).toBe("POST");
    expect(capturedReq?.headers.get("authorization")).toBe("Bearer sk-stub-oai");
    expect(capturedReq?.headers.get("content-type")).toBe("application/json");

    const body = JSON.parse(capturedBody) as {
      model: string;
      temperature: number;
      response_format: { type: string };
      messages: Array<{ role: string }>;
    };
    expect(body.temperature).toBe(0);
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.model).not.toMatch(/^openai\//);
    expect(body.messages).toHaveLength(2);
    expect(body.messages[0]?.role).toBe("system");
    expect(body.messages[1]?.role).toBe("user");
  });

  test("parses markdown-fenced JSON body from OpenAI", async () => {
    useOpenAiOnly();
    const fenced =
      '```json\n{"intent":"file_organize","entities":{"source":"a","destination":"b"},"requiresHITL":true,"confidence":0.6}\n```';
    stubFetch(async () => openaiChatResponse(fenced));

    const result = await classifyIntent("move a to b");
    expect(result.intent).toBe("file_organize");
    expect(result.requiresHITL).toBe(true);
  });
});

describe("classifyIntent — OpenAI error paths", () => {
  test("HTTP 401 → invalid_api_key", async () => {
    useOpenAiOnly();
    stubFetch(async () => textResponse("Unauthorized", 401));

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("invalid_api_key");
    expect((caught as GatewayAgentUnavailableError).provider).toBe("openai");
  });

  test.each(HTTP_STATUS_REASONS)("HTTP %s → %s", async (status, body, reason) => {
    useOpenAiOnly();
    stubFetch(async () => textResponse(body, status));

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe(reason);
  });

  test("fetch throws → network_error with openai provider", async () => {
    useOpenAiOnly();
    stubFetch(async () => {
      throw new Error("DNS lookup failed");
    });

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("network_error");
    expect((caught as GatewayAgentUnavailableError).provider).toBe("openai");
  });

  test("HTTP 200 with non-JSON content body → wrapped as network_error", async () => {
    useOpenAiOnly();
    stubFetch(async () => openaiChatResponse("not json at all"));

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("network_error");
  });

  test("HTTP 200 with JSON that isn't an object → wrapped as network_error", async () => {
    useOpenAiOnly();
    stubFetch(async () => openaiChatResponse(JSON.stringify([1, 2, 3])));

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("network_error");
  });

  test("response with no choices → wrapped as network_error", async () => {
    useOpenAiOnly();
    stubFetch(async () => jsonResponse({ choices: [] }));

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("network_error");
  });
});

describe("classifyIntent — provider selection", () => {
  test("prefers Anthropic when both ANTHROPIC_API_KEY and OPENAI_API_KEY are set", async () => {
    setEnv("ANTHROPIC_API_KEY", "sk-stub-anth");
    setEnv("OPENAI_API_KEY", "sk-stub-oai");

    let capturedUrl = "";
    stubFetch(async (input, init) => {
      capturedUrl = new Request(input, init).url;
      return anthropicTextResponse(
        JSON.stringify({ intent: "unknown", entities: {}, requiresHITL: false, confidence: 0.5 }),
      );
    });

    await classifyIntent("hi");
    expect(capturedUrl).toBe("https://api.anthropic.com/v1/messages");
  });

  test("falls through to OpenAI when ANTHROPIC_API_KEY is empty string", async () => {
    setEnv("ANTHROPIC_API_KEY", "");
    setEnv("OPENAI_API_KEY", "sk-stub-oai");

    let capturedUrl = "";
    stubFetch(async (input, init) => {
      capturedUrl = new Request(input, init).url;
      return openaiChatResponse(
        JSON.stringify({ intent: "unknown", entities: {}, requiresHITL: false, confidence: 0.5 }),
      );
    });

    await classifyIntent("hi");
    expect(capturedUrl).toBe("https://api.openai.com/v1/chat/completions");
  });
});

describe("classifyIntent — no API key", () => {
  test("throws GatewayAgentUnavailableError(no_api_key) when neither key is set", async () => {
    setEnv("ANTHROPIC_API_KEY", undefined);
    setEnv("OPENAI_API_KEY", undefined);
    stubFetch(async () => {
      throw new Error("fetch must not be called when no API key is set");
    });

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("no_api_key");
  });

  test("treats empty-string keys as no_api_key", async () => {
    setEnv("ANTHROPIC_API_KEY", "");
    setEnv("OPENAI_API_KEY", "");

    let caught: unknown;
    try {
      await classifyIntent("hi");
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(GatewayAgentUnavailableError);
    expect((caught as GatewayAgentUnavailableError).reason).toBe("no_api_key");
  });
});
