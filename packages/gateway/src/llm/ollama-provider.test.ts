import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { OllamaProvider } from "./ollama-provider.ts";
import type { PullProgressChunk } from "./types.ts";

const _realFetch = globalThis.fetch;

const FAKE_TAGS_RESPONSE = {
  models: [
    {
      name: "llama3.2:latest",
      details: { parameter_size: "3.2B", quantization_level: "Q4_K_M" },
      size: 2_000_000_000,
    },
    {
      name: "llama3.1:8b",
      details: { parameter_size: "8B", quantization_level: "Q8_0" },
      size: 8_500_000_000,
    },
  ],
};

const FAKE_GENERATE_RESPONSE = {
  response: "Hello from Ollama",
  prompt_eval_count: 12,
  eval_count: 5,
  done: true,
};

describe("OllamaProvider", () => {
  let fetchMock: ReturnType<typeof mock>;

  beforeEach(() => {
    fetchMock = mock(async (url: string, _opts?: RequestInit) => {
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify(FAKE_TAGS_RESPONSE), { status: 200 });
      }
      if (url.endsWith("/api/generate")) {
        return new Response(JSON.stringify(FAKE_GENERATE_RESPONSE), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = _realFetch;
  });

  test("providerId is 'ollama'", () => {
    expect(new OllamaProvider().providerId).toBe("ollama");
  });

  test("isAvailable returns true when /api/tags responds 200", async () => {
    const p = new OllamaProvider("http://127.0.0.1:11434");
    expect(await p.isAvailable()).toBe(true);
  });

  test("isAvailable returns false on network error", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    expect(await p.isAvailable()).toBe(false);
  });

  test("listModels parses model list correctly", async () => {
    const p = new OllamaProvider("http://127.0.0.1:11434");
    const models = await p.listModels();
    expect(models).toHaveLength(2);
    expect(models[0]?.modelName).toBe("llama3.2:latest");
    expect(models[0]?.provider).toBe("ollama");
    expect(models[0]?.quantization).toBe("Q4_K_M");
    expect(models[1]?.modelName).toBe("llama3.1:8b");
  });

  test("generate returns result with correct metadata", async () => {
    const p = new OllamaProvider("http://127.0.0.1:11434");
    const result = await p.generate({
      task: "agent_step",
      prompt: "Say hello",
      maxTokens: 128,
    });
    expect(result.text).toBe("Hello from Ollama");
    expect(result.isLocal).toBe(true);
    expect(result.provider).toBe("ollama");
    expect(result.tokensIn).toBe(12);
    expect(result.tokensOut).toBe(5);
  });

  test("generate uses the configured local model name", async () => {
    const p = new OllamaProvider("http://127.0.0.1:11434", "llama3.2");
    await p.generate({ task: "classification", prompt: "classify this" });
    const calls = fetchMock.mock.calls as Array<[string, RequestInit]>;
    const generateCall = calls.find(([url]) => url.endsWith("/api/generate"));
    expect(generateCall).toBeDefined();
    const body = JSON.parse(generateCall?.[1].body as string) as { model: string };
    expect(body.model).toBe("llama3.2");
  });

  test("generate with stream calls onToken for each token", async () => {
    const chunks = [
      { response: "Hello", done: false },
      { response: " world", done: false },
      { response: "", done: true, prompt_eval_count: 5, eval_count: 2 },
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const chunk of chunks) {
          controller.enqueue(encoder.encode(`${JSON.stringify(chunk)}\n`));
        }
        controller.close();
      },
    });
    globalThis.fetch = mock(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;

    const tokens: string[] = [];
    const p = new OllamaProvider("http://127.0.0.1:11434", "llama3.2");
    const result = await p.generate({
      task: "agent_step",
      prompt: "say hello",
      stream: true,
      onToken: (t) => tokens.push(t),
    });
    expect(tokens).toEqual(["Hello", " world"]);
    expect(result.text).toBe("Hello world");
    expect(result.tokensOut).toBe(2);
  });
});

describe("OllamaProvider.pullModel", () => {
  beforeEach(() => {
    globalThis.fetch = _realFetch;
  });

  afterEach(() => {
    globalThis.fetch = _realFetch;
  });

  test("pullModel streams progress chunks and resolves on done", async () => {
    const chunks = [
      '{"status":"pulling manifest"}\n',
      '{"status":"downloading","completed":100,"total":1000}\n',
      '{"status":"downloading","completed":1000,"total":1000}\n',
      '{"status":"success"}\n',
    ];
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        if (new URL(req.url).pathname !== "/api/pull") return new Response(null, { status: 404 });
        const body = new ReadableStream({
          start(controller) {
            for (const c of chunks) controller.enqueue(new TextEncoder().encode(c));
            controller.close();
          },
        });
        return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
      },
    });
    const p = new OllamaProvider(`http://127.0.0.1:${server.port}`);
    const received: PullProgressChunk[] = [];
    await p.pullModel("llama3.2:1b", { onProgress: (c) => received.push(c) });
    server.stop();
    expect(received.at(-1)?.status).toBe("success");
    expect(received.some((c) => c.completedBytes === 1000)).toBe(true);
  });
});
