import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GeminiProvider } from "./gemini-provider.ts";
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
  candidates: [{ content: { parts: [{ text: "hello" }] } }],
  usageMetadata: { promptTokenCount: 11, candidatesTokenCount: 7 },
};

describe("GeminiProvider", () => {
  test("is NOT local, even on a loopback base_url", () => {
    const p = new GeminiProvider({
      apiKey: async () => "g-key",
      modelName: "gemini-2.5-pro",
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(p.isLocal).toBe(false);
    expect(p.providerId).toBe("gemini");
  });

  test("puts the model in the PATH and the key in the QUERY, not a header", async () => {
    stubFetch(200, OK_BODY);
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "gemini-2.5-pro" });
    const r = await p.generate({ task: "reasoning", prompt: "hi", systemPrompt: "be terse" });

    expect(seen[0]?.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent?key=g-key",
    );
    // `systemInstruction` is its own top-level object -- not a message, and not a `system` string
    // as in Anthropic's shape.
    expect(seen[0]?.body).toMatchObject({
      systemInstruction: { parts: [{ text: "be terse" }] },
      contents: [{ role: "user", parts: [{ text: "hi" }] }],
    });
    expect(r).toMatchObject({
      text: "hello",
      tokensIn: 11,
      tokensOut: 7,
      isLocal: false,
      provider: "gemini",
    });
  });

  test("the model name is URL-encoded into the path", async () => {
    // Model ids can carry characters that would otherwise change the path's meaning.
    stubFetch(200, OK_BODY);
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "models/weird name" });
    await p.generate({ task: "reasoning", prompt: "hi" });
    expect(seen[0]?.url).toContain("models%2Fweird%20name:generateContent");
  });

  test("concatenates multiple parts in the reply", async () => {
    stubFetch(200, {
      candidates: [{ content: { parts: [{ text: "one " }, { text: "two" }] } }],
      usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 2 },
    });
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "m" });
    expect((await p.generate({ task: "reasoning", prompt: "hi" })).text).toBe("one two");
  });

  test("classifies status codes and never echoes the key", async () => {
    for (const [status, kind] of [
      [503, "transport"],
      [429, "transport"],
      [401, "auth"],
      [403, "auth"],
      [400, "request"],
    ] as const) {
      seen = [];
      stubFetch(status, { error: { message: "bad key g-SECRET" } });
      const p = new GeminiProvider({ apiKey: async () => "g-SECRET", modelName: "m" });
      const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
      expect((err as LlmProviderError).kind).toBe(kind);
      // Sharper here than for the other vendors: the key rides in the URL, so a message that
      // included the request URL would leak the credential.
      expect((err as Error).message).not.toContain("g-SECRET");
    }
  });

  test("a thrown fetch is transport-class and does not leak the URL", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("failed to fetch https://...key=g-SECRET");
    }) as unknown as typeof globalThis.fetch;
    const p = new GeminiProvider({ apiKey: async () => "g-SECRET", modelName: "m" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("transport");
    expect((err as Error).message).not.toContain("g-SECRET");
  });

  test("a missing key is auth-class and makes NO request", async () => {
    stubFetch(200, OK_BODY);
    const p = new GeminiProvider({ apiKey: async () => undefined, modelName: "m" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("auth");
    expect(seen).toHaveLength(0);
  });

  test("isAvailable and listModels are offline", async () => {
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "gemini-2.5-pro" });
    expect(await p.isAvailable()).toBe(true);
    expect(await p.listModels()).toEqual([{ provider: "gemini", modelName: "gemini-2.5-pro" }]);
    expect(seen).toHaveLength(0);
  });

  test("maxTokens and temperature ride generationConfig when supplied", async () => {
    stubFetch(200, OK_BODY);
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "m" });
    await p.generate({ task: "reasoning", prompt: "hi", maxTokens: 256, temperature: 0.2 });
    expect(seen[0]?.body).toMatchObject({
      generationConfig: { maxOutputTokens: 256, temperature: 0.2 },
    });
  });

  test("no generationConfig is sent when neither is supplied", async () => {
    stubFetch(200, OK_BODY);
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "m" });
    await p.generate({ task: "reasoning", prompt: "hi" });
    expect(seen[0]?.body).not.toHaveProperty("generationConfig");
  });

  test("a malformed response degrades to empty text and zero tokens", async () => {
    // External data: a vendor shape change must produce an honest empty answer, not a throw.
    stubFetch(200, {});
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "m" });
    expect(await p.generate({ task: "reasoning", prompt: "hi" })).toMatchObject({
      text: "",
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  test("non-string parts and non-numeric usage are ignored rather than trusted", async () => {
    stubFetch(200, {
      candidates: [{ content: { parts: [{ text: 42 }, { text: "kept" }] } }],
      usageMetadata: { promptTokenCount: "11", candidatesTokenCount: null },
    });
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "m" });
    expect(await p.generate({ task: "reasoning", prompt: "hi" })).toMatchObject({
      text: "kept",
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  test("a NON-Error thrown from fetch is still transport-class", async () => {
    globalThis.fetch = (async () => {
      throw "boom";
    }) as unknown as typeof globalThis.fetch;
    const p = new GeminiProvider({ apiKey: async () => "g-key", modelName: "m" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("transport");
    expect((err as Error).message).toContain("unknown");
  });

  test("base_url overrides the host, trailing slash and all", async () => {
    stubFetch(200, OK_BODY);
    const p = new GeminiProvider({
      apiKey: async () => "g-key",
      modelName: "m",
      baseUrl: "https://proxy.internal/",
    });
    await p.generate({ task: "reasoning", prompt: "hi" });
    expect(seen[0]?.url).toContain("https://proxy.internal/v1beta/models/m:generateContent");
  });
});
