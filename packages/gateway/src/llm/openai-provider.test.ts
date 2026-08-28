import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenAiProvider } from "./openai-provider.ts";
import { LlmProviderError } from "./provider-error.ts";
import { XaiProvider } from "./xai-provider.ts";

// NO TEST IN THIS FILE MAY REACH THE NETWORK. `fetch` is stubbed per test and restored in
// `afterEach`; a test that issued a real vendor request would be a defect, not a slow test.
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
  choices: [{ message: { content: "hello" } }],
  usage: { prompt_tokens: 11, completion_tokens: 7 },
};

describe("OpenAiProvider", () => {
  test("is NOT local, even on a loopback base_url", () => {
    // I34, and the INVERSE of slice 1's rule for local runtimes. A LiteLLM-style proxy on
    // 127.0.0.1 forwards to OpenAI, so the traffic is not local; deriving locality from the URL
    // here would hand back the exact air-gap bypass slice 1 closed, through the opposite door.
    const p = new OpenAiProvider({
      apiKey: async () => "sk-test",
      modelName: "gpt-5",
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(p.isLocal).toBe(false);
    expect(p.providerId).toBe("openai");
  });

  test("isAvailable is answered OFFLINE and makes no request", async () => {
    // A vendor /models probe on every `nimbus llm status` would be real, un-ledgered egress to
    // four vendors BEFORE the user ever opted into sending a prompt, and would leak Nimbus usage
    // to each of them.
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    expect(await p.isAvailable()).toBe(true);
    expect(seen).toHaveLength(0);
  });

  test("isAvailable is false when no key resolves", async () => {
    const p = new OpenAiProvider({ apiKey: async () => undefined, modelName: "gpt-5" });
    expect(await p.isAvailable()).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test("listModels returns the configured model statically, with no request", async () => {
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    expect(await p.listModels()).toEqual([{ provider: "openai", modelName: "gpt-5" }]);
    expect(seen).toHaveLength(0);
  });

  test("generate posts the chat-completions shape and maps the reply", async () => {
    stubFetch(200, OK_BODY);
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    const r = await p.generate({ task: "reasoning", prompt: "hi", systemPrompt: "be terse" });

    expect(r).toMatchObject({
      text: "hello",
      tokensIn: 11,
      tokensOut: 7,
      modelUsed: "gpt-5",
      isLocal: false,
      provider: "openai",
    });
    expect(seen[0]?.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(seen[0]?.headers["Authorization"]).toBe("Bearer sk-test");
    expect(seen[0]?.body).toMatchObject({
      model: "gpt-5",
      messages: [
        { role: "system", content: "be terse" },
        { role: "user", content: "hi" },
      ],
    });
  });

  test("the key is resolved PER CALL, so a key added after boot works with no restart", async () => {
    stubFetch(200, OK_BODY);
    let key: string | undefined;
    const p = new OpenAiProvider({ apiKey: async () => key, modelName: "gpt-5" });

    await expect(p.generate({ task: "reasoning", prompt: "hi" })).rejects.toBeInstanceOf(
      LlmProviderError,
    );
    key = "sk-added-later";
    expect((await p.generate({ task: "reasoning", prompt: "hi" })).text).toBe("hello");
  });

  test("a missing key is auth-class and makes NO request", async () => {
    stubFetch(200, OK_BODY);
    const p = new OpenAiProvider({ apiKey: async () => undefined, modelName: "gpt-5" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LlmProviderError);
    expect((err as LlmProviderError).kind).toBe("auth");
    expect(seen).toHaveLength(0);
  });

  test("classifies status codes onto the retry decision", async () => {
    for (const [status, kind] of [
      [503, "transport"],
      [429, "transport"],
      [401, "auth"],
      [400, "request"],
    ] as const) {
      seen = [];
      stubFetch(status, { error: { message: "nope" } });
      const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
      const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
      expect((err as LlmProviderError).kind).toBe(kind);
      expect((err as LlmProviderError).status).toBe(status);
    }
  });

  test("a thrown fetch (DNS, refused, timeout) is transport-class", async () => {
    // `as unknown as` here, unlike `stubFetch` above: a zero-arg thunk does not overlap
    // `typeof fetch` enough for a direct assertion (it lacks `preconnect`).
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof globalThis.fetch;
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("transport");
  });

  test("the error message never contains the api key", async () => {
    // The message reaches `SynthesisAttempt.detail`, which travels to the user on `briefReady`.
    // OpenAI 401 bodies have been observed quoting the submitted key back.
    stubFetch(401, { error: { message: "invalid api key sk-test-SECRET" } });
    const p = new OpenAiProvider({ apiKey: async () => "sk-test-SECRET", modelName: "gpt-5" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain("sk-test-SECRET");
  });

  test("base_url overrides the host but keeps the path", async () => {
    stubFetch(200, OK_BODY);
    const p = new OpenAiProvider({
      apiKey: async () => "sk-test",
      modelName: "gpt-5",
      baseUrl: "https://proxy.internal",
    });
    await p.generate({ task: "reasoning", prompt: "hi" });
    expect(seen[0]?.url).toBe("https://proxy.internal/v1/chat/completions");
  });

  test("a trailing slash on base_url does not double up", async () => {
    stubFetch(200, OK_BODY);
    const p = new OpenAiProvider({
      apiKey: async () => "sk-test",
      modelName: "gpt-5",
      baseUrl: "https://proxy.internal/",
    });
    await p.generate({ task: "reasoning", prompt: "hi" });
    expect(seen[0]?.url).toBe("https://proxy.internal/v1/chat/completions");
  });

  test("maxTokens and temperature are forwarded when supplied", async () => {
    stubFetch(200, OK_BODY);
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    await p.generate({ task: "reasoning", prompt: "hi", maxTokens: 256, temperature: 0.2 });
    expect(seen[0]?.body).toMatchObject({ max_tokens: 256, temperature: 0.2 });
  });

  test("a response missing choices and usage degrades to empty text and zero tokens", async () => {
    // The vendor contract is external data: a shape change must not throw here, it must produce
    // an honest empty answer the caller can see.
    stubFetch(200, {});
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    expect(await p.generate({ task: "reasoning", prompt: "hi" })).toMatchObject({
      text: "",
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  test("a non-string content and non-numeric usage are ignored rather than trusted", async () => {
    stubFetch(200, {
      choices: [{ message: { content: { unexpected: true } } }],
      usage: { prompt_tokens: "11", completion_tokens: null },
    });
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    expect(await p.generate({ task: "reasoning", prompt: "hi" })).toMatchObject({
      text: "",
      tokensIn: 0,
      tokensOut: 0,
    });
  });

  test("a NON-Error thrown from fetch is still transport-class", async () => {
    // `err instanceof Error` has two arms; a string throw takes the other one.
    globalThis.fetch = (async () => {
      throw "boom";
    }) as unknown as typeof globalThis.fetch;
    const p = new OpenAiProvider({ apiKey: async () => "sk-test", modelName: "gpt-5" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("transport");
    expect((err as Error).message).toContain("unknown");
  });
});

describe("XaiProvider", () => {
  test("posts to the xAI host using the OpenAI wire format", async () => {
    // Delegation proven rather than assumed: same mapping, different host and provider id.
    stubFetch(200, OK_BODY);
    const p = new XaiProvider({ apiKey: async () => "xai-test", modelName: "grok-4" });
    const r = await p.generate({ task: "reasoning", prompt: "hi" });
    expect(seen[0]?.url).toBe("https://api.x.ai/v1/chat/completions");
    expect(seen[0]?.headers["Authorization"]).toBe("Bearer xai-test");
    expect(r.provider).toBe("xai");
  });

  test("is NOT local, even on a loopback base_url", () => {
    const p = new XaiProvider({
      apiKey: async () => "k",
      modelName: "grok-4",
      baseUrl: "http://127.0.0.1:4000",
    });
    expect(p.isLocal).toBe(false);
    expect(p.providerId).toBe("xai");
  });

  test("a missing key is auth-class and makes NO request", async () => {
    stubFetch(200, OK_BODY);
    const p = new XaiProvider({ apiKey: async () => undefined, modelName: "grok-4" });
    const err = await p.generate({ task: "reasoning", prompt: "hi" }).catch((e: unknown) => e);
    expect((err as LlmProviderError).kind).toBe("auth");
    expect(seen).toHaveLength(0);
  });

  test("isAvailable and listModels are offline", async () => {
    const p = new XaiProvider({ apiKey: async () => "xai-test", modelName: "grok-4" });
    expect(await p.isAvailable()).toBe(true);
    expect(await p.listModels()).toEqual([{ provider: "xai", modelName: "grok-4" }]);
    expect(seen).toHaveLength(0);
  });

  test("isAvailable is false when no key resolves, and when it is blank", async () => {
    expect(
      await new XaiProvider({ apiKey: async () => undefined, modelName: "grok-4" }).isAvailable(),
    ).toBe(false);
    expect(
      await new XaiProvider({ apiKey: async () => "   ", modelName: "grok-4" }).isAvailable(),
    ).toBe(false);
    expect(seen).toHaveLength(0);
  });

  test("base_url overrides the xAI host", async () => {
    stubFetch(200, OK_BODY);
    const p = new XaiProvider({
      apiKey: async () => "xai-test",
      modelName: "grok-4",
      baseUrl: "https://proxy.internal/",
    });
    await p.generate({ task: "reasoning", prompt: "hi" });
    expect(seen[0]?.url).toBe("https://proxy.internal/v1/chat/completions");
  });
});
