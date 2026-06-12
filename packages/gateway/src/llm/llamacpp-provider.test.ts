import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { LlamaCppProvider } from "./llamacpp-provider.ts";

const _realFetch = globalThis.fetch;

const FAKE_COMPLETION_RESPONSE = {
  content: "Response from llama.cpp",
  timings: { prompt_n: 8, predicted_n: 7 },
};

describe("LlamaCppProvider", () => {
  beforeEach(() => {
    globalThis.fetch = mock(async (url: string) => {
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      if (url.endsWith("/completion")) {
        return new Response(JSON.stringify(FAKE_COMPLETION_RESPONSE), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _realFetch;
  });

  test("providerId is 'llamacpp'", () => {
    expect(new LlamaCppProvider().providerId).toBe("llamacpp");
  });

  test("isAvailable returns true when /health responds ok", async () => {
    const p = new LlamaCppProvider("http://127.0.0.1:8080");
    expect(await p.isAvailable()).toBe(true);
  });

  test("isAvailable returns false when server is not reachable", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const p = new LlamaCppProvider("http://127.0.0.1:8080");
    expect(await p.isAvailable()).toBe(false);
  });

  test("listModels returns the configured GGUF model name", async () => {
    const p = new LlamaCppProvider("http://127.0.0.1:8080", "mistral-7b.gguf");
    const models = await p.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.modelName).toBe("mistral-7b.gguf");
    expect(models[0]?.provider).toBe("llamacpp");
  });

  test("generate calls /completion and returns correct result", async () => {
    const p = new LlamaCppProvider("http://127.0.0.1:8080", "mistral-7b.gguf");
    const result = await p.generate({ task: "reasoning", prompt: "Explain this." });
    expect(result.text).toBe("Response from llama.cpp");
    expect(result.isLocal).toBe(true);
    expect(result.provider).toBe("llamacpp");
    expect(result.tokensIn).toBe(8);
    expect(result.tokensOut).toBe(7);
  });

  test("generate throws on non-200 response", async () => {
    globalThis.fetch = mock(
      async () => new Response("error", { status: 503 }),
    ) as unknown as typeof fetch;
    const p = new LlamaCppProvider("http://127.0.0.1:8080");
    await expect(p.generate({ task: "classification", prompt: "test" })).rejects.toThrow("503");
  });

  test("isAvailable returns false when /health responds with non-ok status", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ status: "error" }), { status: 500 }),
    ) as unknown as typeof fetch;
    const p = new LlamaCppProvider("http://127.0.0.1:8080");
    expect(await p.isAvailable()).toBe(false);
  });

  test("generate includes systemPrompt in the prompt body when provided", async () => {
    let capturedBody: unknown;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/completion")) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(FAKE_COMPLETION_RESPONSE), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const p = new LlamaCppProvider("http://127.0.0.1:8080", "mistral-7b.gguf");
    await p.generate({
      task: "reasoning",
      prompt: "user question",
      systemPrompt: "You are helpful.",
    });
    const body = capturedBody as Record<string, unknown>;
    expect(typeof body["prompt"]).toBe("string");
    expect((body["prompt"] as string).startsWith("You are helpful.")).toBe(true);
    expect((body["prompt"] as string).includes("user question")).toBe(true);
  });

  test("generate uses provided maxTokens and temperature", async () => {
    let capturedBody: unknown;
    globalThis.fetch = mock(async (url: string, init?: RequestInit) => {
      if (typeof url === "string" && url.endsWith("/completion")) {
        capturedBody = JSON.parse(init?.body as string);
        return new Response(JSON.stringify(FAKE_COMPLETION_RESPONSE), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    const p = new LlamaCppProvider("http://127.0.0.1:8080");
    await p.generate({ task: "reasoning", prompt: "test", maxTokens: 512, temperature: 0.2 });
    const body = capturedBody as Record<string, unknown>;
    expect(body["n_predict"]).toBe(512);
    expect(body["temperature"]).toBe(0.2);
  });

  test("generate falls back to empty string when content is not a string", async () => {
    const noContentResp = { timings: { prompt_n: 3, predicted_n: 5 } };
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(noContentResp), { status: 200 }),
    ) as unknown as typeof fetch;
    const p = new LlamaCppProvider("http://127.0.0.1:8080");
    const result = await p.generate({ task: "classification", prompt: "test" });
    expect(result.text).toBe("");
    expect(result.tokensIn).toBe(3);
    expect(result.tokensOut).toBe(5);
  });

  test("generate falls back to 0 tokens when timings are absent", async () => {
    const noTimingsResp = { content: "hello" };
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(noTimingsResp), { status: 200 }),
    ) as unknown as typeof fetch;
    const p = new LlamaCppProvider("http://127.0.0.1:8080");
    const result = await p.generate({ task: "classification", prompt: "test" });
    expect(result.text).toBe("hello");
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });

  test("generate falls back to 0 tokens when prompt_n and predicted_n are absent from timings", async () => {
    const partialTimingsResp = { content: "partial", timings: {} };
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify(partialTimingsResp), { status: 200 }),
    ) as unknown as typeof fetch;
    const p = new LlamaCppProvider("http://127.0.0.1:8080");
    const result = await p.generate({ task: "classification", prompt: "test" });
    expect(result.text).toBe("partial");
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });

  test("constructor strips trailing slash from baseUrl", async () => {
    let capturedUrl: string | undefined;
    globalThis.fetch = mock(async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new LlamaCppProvider("http://127.0.0.1:8080/");
    await p.isAvailable();
    expect(capturedUrl).toBe("http://127.0.0.1:8080/health");
  });

  test("constructor uses default baseUrl and modelName when not provided", async () => {
    const p = new LlamaCppProvider();
    const models = await p.listModels();
    expect(models[0]?.modelName).toBe("model.gguf");
    expect(models[0]?.provider).toBe("llamacpp");
  });

  test("generate returns correct modelUsed from constructor modelName", async () => {
    const p = new LlamaCppProvider("http://127.0.0.1:8080", "custom-model.gguf");
    const result = await p.generate({ task: "reasoning", prompt: "test" });
    expect(result.modelUsed).toBe("custom-model.gguf");
  });
});
