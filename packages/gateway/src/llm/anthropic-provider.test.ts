import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AnthropicProvider } from "./anthropic-provider.ts";
import type { LlmProviderError } from "./provider-error.ts";

// NO TEST IN THIS FILE MAY REACH THE NETWORK.
const realFetch = globalThis.fetch;
let seen: Array<{ url: string; headers: Record<string, string>; body: unknown }>;

function stubFetch(status: number, payload: unknown): void {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    seen.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: JSON.parse(String(init?.body ?? "{}")) as unknown,
    });
    return new Response(JSON.stringify(payload), { status });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  seen = [];
});
afterEach(() => {
  globalThis.fetch = realFetch;
});

const OK_BODY = {
  content: [{ type: "text", text: "hello" }],
  usage: { input_tokens: 11, output_tokens: 7 },
};

describe("AnthropicProvider", () => {
  test("is NOT local, even on a loopback base_url", () => {
    // I34. A LiteLLM-style proxy on 127.0.0.1 forwards to Anthropic, so the traffic is not local.
    const p = new AnthropicProvider({
      apiKey: async () => "sk-ant",
      modelName: "claude-sonnet-4-6",
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(p.isLocal).toBe(false);
    expect(p.providerId).toBe("anthropic");
  });

  test("generate posts the messages shape with the anthropic headers", async () => {
    stubFetch(200, OK_BODY);
    const p = new AnthropicProvider({
      apiKey: async () => "sk-ant",
      modelName: "claude-sonnet-4-6",
    });
    const r = await p.generate({ task: "reasoning", prompt: "hi", systemPrompt: "be terse" });

    expect(seen[0]?.url).toBe("https://api.anthropic.com/v1/messages");
    // Anthropic authenticates with `x-api-key`, NOT `Authorization: Bearer`, and requires an
    // explicit API version header. Getting either wrong is a 401 that looks like a bad key.
    expect(seen[0]?.headers["x-api-key"]).toBe("sk-ant");
    expect(seen[0]?.headers["anthropic-version"]).toBe("2023-06-01");
    // `system` is a TOP-LEVEL field here, not a message with role "system" as in OpenAI's shape.
    expect(seen[0]?.body).toMatchObject({
      model: "claude-sonnet-4-6",
      system: "be terse",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(r).toMatchObject({
      text: "hello",
      tokensIn: 11,
      tokensOut: 7,
      isLocal: false,
      provider: "anthropic",
    });
  });

  test("max_tokens is always sent, because the API rejects a request without it", async () => {
    // A caller that omits `maxTokens` must still produce a VALID request, rather than a 400 that
    // reads like a malformed prompt.
    stubFetch(200, OK_BODY);
    const p = new AnthropicProvider({ apiKey: async () => "sk-ant", modelName: "m" });
    await p.generate({ task: "reasoning", prompt: "hi" });
    // Narrow to `| undefined` and access optionally: casting through `?.` and then reading a
    // property would throw a TypeError if no request was recorded, masking the real failure.
    const body = seen[0]?.body as { max_tokens?: number } | undefined;
    expect(body?.max_tokens).toBeGreaterThan(0);
  });

  test("concatenates multiple text blocks in the reply", async () => {
    // The content array can hold several blocks; taking only [0] would silently truncate.
    stubFetch(200, {
      content: [
        { type: "text", text: "one " },
        { type: "text", text: "two" },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const p = new AnthropicProvider({ apiKey: async () => "sk-ant", modelName: "m" });
    expect((await p.generate({ task: "reasoning", prompt: "hi" })).text).toBe("one two");
  });

  test("ignores non-text blocks rather than rendering them", async () => {
    stubFetch(200, {
      content: [
        { type: "thinking", thinking: "internal" },
        { type: "text", text: "visible" },
      ],
      usage: { input_tokens: 1, output_tokens: 2 },
    });
    const p = new AnthropicProvider({ apiKey: async () => "sk-ant", modelName: "m" });
    expect((await p.generate({ task: "reasoning", prompt: "hi" })).text).toBe("visible");
  });

  test("classifies status codes and never echoes the key", async () => {
    for (const [status, kind] of [
      [503, "transport"],
      [429, "transport"],
      [401, "auth"],
      [400, "request"],
    ] as const) {
      seen = [];
      stubFetch(status, { error: { message: "bad key sk-ant-SECRET" } });
      const p = new AnthropicProvider({ apiKey: async () => "sk-ant-SECRET", modelName: "m" });
      const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
      expect((err as LlmProviderError).kind).toBe(kind);
      expect((err as Error).message).not.toContain("sk-ant-SECRET");
    }
  });

  test("a thrown fetch is transport-class", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const p = new AnthropicProvider({ apiKey: async () => "sk-ant", modelName: "m" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("transport");
  });

  test("a missing key is auth-class and makes NO request", async () => {
    stubFetch(200, OK_BODY);
    const p = new AnthropicProvider({ apiKey: async () => undefined, modelName: "m" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("auth");
    expect(seen).toHaveLength(0);
  });

  test("isAvailable and listModels are offline", async () => {
    const p = new AnthropicProvider({
      apiKey: async () => "sk-ant",
      modelName: "claude-sonnet-4-6",
    });
    expect(await p.isAvailable()).toBe(true);
    expect(await p.listModels()).toEqual([
      { provider: "anthropic", modelName: "claude-sonnet-4-6" },
    ]);
    expect(seen).toHaveLength(0);
  });
});
