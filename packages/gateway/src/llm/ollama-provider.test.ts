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

  // --- New tests for uncovered branches ---

  test("constructor strips trailing slash from baseUrl", () => {
    const p = new OllamaProvider("http://127.0.0.1:11434/", "llama3.2");
    // If trailing slash were preserved, URL would be malformed; verify generate still calls clean URL
    // We can verify by checking that fetch is called without double-slash
    const calls: string[] = [];
    globalThis.fetch = mock(async (url: string) => {
      calls.push(url);
      return new Response(JSON.stringify(FAKE_GENERATE_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;
    return p.generate({ task: "agent_step", prompt: "hi" }).then(() => {
      expect(calls[0]).toBe("http://127.0.0.1:11434/api/generate");
    });
  });

  test("isAvailable returns false when resp.ok is false (non-2xx)", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Service Unavailable", { status: 503 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    expect(await p.isAvailable()).toBe(false);
  });

  test("listModels throws on HTTP error", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Internal Server Error", { status: 500 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    await expect(p.listModels()).rejects.toThrow("Ollama listModels HTTP 500");
  });

  test("listModels returns [] when data.models is not an array", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ models: null }), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    const result = await p.listModels();
    expect(result).toEqual([]);
  });

  test("listModels skips models with missing/empty name", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          models: [
            { name: null, details: { parameter_size: "3B" }, size: 1000 },
            { name: "", details: { parameter_size: "3B" }, size: 1000 },
            { name: "valid:latest", details: {}, size: 500_000_000 },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    const models = await p.listModels();
    // Only the valid model should appear
    expect(models).toHaveLength(1);
    expect(models[0]?.modelName).toBe("valid:latest");
  });

  test("listModels handles models without parameter_size or size (no parameterCount/vramEstimateMb)", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          models: [{ name: "bare:model", details: {}, size: undefined }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    const models = await p.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.parameterCount).toBeUndefined();
    expect(models[0]?.vramEstimateMb).toBeUndefined();
  });

  test("listModels handles model with non-string quantization_level", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          models: [
            {
              name: "model:q",
              details: { parameter_size: "7B", quantization_level: 42 },
              size: 1_000_000_000,
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    const models = await p.listModels();
    expect(models).toHaveLength(1);
    // quantization_level is a number, not string → no quantization field
    expect(models[0]?.quantization).toBeUndefined();
  });

  test("listModels handles model with non-matching parameter_size pattern (e.g. '3.2GB')", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          models: [
            {
              name: "model:gb",
              details: { parameter_size: "3.2GB", quantization_level: "Q4" },
              size: 1_000_000,
            },
          ],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    const models = await p.listModels();
    expect(models).toHaveLength(1);
    // "3.2GB" doesn't match /^([\d.]+)B$/i → no parameterCount
    expect(models[0]?.parameterCount).toBeUndefined();
  });

  test("listModels handles model with non-finite size (Infinity → vramEstimateMb undefined)", async () => {
    // parseVramMb returns undefined for non-finite numbers
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({
          models: [{ name: "model:inf", details: {}, size: null }],
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    const models = await p.listModels();
    expect(models).toHaveLength(1);
    expect(models[0]?.vramEstimateMb).toBeUndefined();
  });

  test("generate (batch) throws on HTTP error", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Bad Gateway", { status: 502 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    await expect(p.generate({ task: "agent_step", prompt: "fail" })).rejects.toThrow(
      "Ollama generate HTTP 502",
    );
  });

  test("generate (batch) defaults text to '' when response field is not a string", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ response: 42, prompt_eval_count: 1, eval_count: 1 }), {
        status: 200,
      });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    const result = await p.generate({ task: "agent_step", prompt: "test" });
    expect(result.text).toBe("");
  });

  test("generate (batch) uses defaults for maxTokens and temperature when not provided", async () => {
    const capturedBodies: string[] = [];
    globalThis.fetch = mock(async (_url: string, opts?: RequestInit) => {
      if (typeof opts?.body === "string") capturedBodies.push(opts.body);
      return new Response(JSON.stringify(FAKE_GENERATE_RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    await p.generate({ task: "agent_step", prompt: "no defaults" });
    expect(capturedBodies).toHaveLength(1);
    const body = JSON.parse(capturedBodies[0] ?? "{}") as {
      options: { num_predict: number; temperature: number };
    };
    expect(body.options.num_predict).toBe(2048);
    expect(body.options.temperature).toBe(0.7);
  });

  test("BOTH generate paths send the complete expected request body", async () => {
    // Thinking tokens come out of the SAME `num_predict` budget as the answer, so a reasoning
    // model can spend the budget deliberating and return a truncated reply -- or, at the
    // classifier's 512-token cap, no parseable JSON at all. Measured on qwen3:14b: a summary
    // was cut off mid-sentence at 17,974 ms with thinking on, and complete at 1,497 ms with it
    // off. `think: false` is the fix, and missing it on EITHER path is the regression.
    //
    // Asserted as WHOLE-BODY equality rather than field-by-field, which is wider than the
    // change that prompted it: before this, `prompt` and `system` were asserted nowhere in
    // this file, so a change that dropped the system prompt passed the entire suite. Equality
    // also means a newly added field fails here and has to be acknowledged, rather than
    // arriving unnoticed on the wire.
    const bodies: string[] = [];
    const capture = (res: string) =>
      mock(async (_url: string, opts?: RequestInit) => {
        if (typeof opts?.body === "string") bodies.push(opts.body);
        return new Response(res, { status: 200 });
      }) as unknown as typeof fetch;

    const p = new OllamaProvider("http://127.0.0.1:11434");
    const call = {
      task: "classification",
      prompt: "find my notes",
      systemPrompt: "reply with JSON",
      maxTokens: 512,
      temperature: 0,
    } as const;

    globalThis.fetch = capture(JSON.stringify(FAKE_GENERATE_RESPONSE));
    await p.generate({ ...call });
    globalThis.fetch = capture(`${JSON.stringify({ response: "hi", done: true })}
`);
    await p.generate({ ...call, stream: true });

    expect(bodies).toHaveLength(2);
    const expected = (stream: boolean) => ({
      model: "llama3.2",
      prompt: "find my notes",
      system: "reply with JSON",
      stream,
      think: false,
      options: { num_ctx: 8192, num_predict: 512, temperature: 0 },
    });
    expect(JSON.parse(bodies[0] ?? "{}")).toEqual(expected(false));
    expect(JSON.parse(bodies[1] ?? "{}")).toEqual(expected(true));
  });

  test("generate (stream) throws on HTTP error", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Forbidden", { status: 403 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    await expect(
      p.generate({ task: "agent_step", prompt: "stream fail", stream: true }),
    ).rejects.toThrow("Ollama stream HTTP 403");
  });

  test("generate (stream) throws when resp.body is null", async () => {
    globalThis.fetch = mock(async () => {
      // Response with no body — body will be null
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    await expect(
      p.generate({ task: "agent_step", prompt: "no body", stream: true }),
    ).rejects.toThrow("No response body");
  });

  test("generate (stream) handles malformed JSON lines without throwing", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Line 1: valid token, Line 2: malformed JSON, Line 3: valid done
        controller.enqueue(encoder.encode('{"response":"hi","done":false}\n'));
        controller.enqueue(encoder.encode("NOT_JSON\n"));
        controller.enqueue(
          encoder.encode('{"response":"","done":true,"prompt_eval_count":3,"eval_count":1}\n'),
        );
        controller.close();
      },
    });
    globalThis.fetch = mock(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434", "llama3.2");
    const result = await p.generate({
      task: "agent_step",
      prompt: "test",
      stream: true,
    });
    // Malformed line is silently skipped; still gets "hi"
    expect(result.text).toBe("hi");
    expect(result.tokensIn).toBe(3);
    expect(result.tokensOut).toBe(1);
  });

  test("generate (stream) handles empty lines without crashing", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Empty line followed by valid line
        controller.enqueue(encoder.encode("\n\n"));
        controller.enqueue(
          encoder.encode('{"response":"ok","done":true,"prompt_eval_count":1,"eval_count":1}\n'),
        );
        controller.close();
      },
    });
    globalThis.fetch = mock(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434", "llama3.2");
    const result = await p.generate({
      task: "agent_step",
      prompt: "empty lines",
      stream: true,
    });
    expect(result.text).toBe("ok");
  });

  test("generate (stream) with done chunk missing counts defaults tokensIn/Out to 0", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // done=true but no prompt_eval_count / eval_count
        controller.enqueue(encoder.encode('{"response":"text","done":true}\n'));
        controller.close();
      },
    });
    globalThis.fetch = mock(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434", "llama3.2");
    const result = await p.generate({
      task: "agent_step",
      prompt: "no counts",
      stream: true,
    });
    expect(result.tokensIn).toBe(0);
    expect(result.tokensOut).toBe(0);
  });

  test("generate (stream) without onToken still accumulates text", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"response":"silent","done":true}\n'));
        controller.close();
      },
    });
    globalThis.fetch = mock(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434", "llama3.2");
    // No onToken callback supplied
    const result = await p.generate({
      task: "agent_step",
      prompt: "no onToken",
      stream: true,
    });
    expect(result.text).toBe("silent");
  });

  test("generate (stream) uses defaults for maxTokens and temperature when not provided", async () => {
    const capturedBodies: string[] = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"response":"","done":true}\n'));
        controller.close();
      },
    });
    globalThis.fetch = mock(async (_url: string, opts?: RequestInit) => {
      if (typeof opts?.body === "string") capturedBodies.push(opts.body);
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    await p.generate({ task: "agent_step", prompt: "stream defaults", stream: true });
    const body = JSON.parse(capturedBodies[0] ?? "{}") as {
      options: { num_predict: number; temperature: number };
    };
    expect(body.options.num_predict).toBe(2048);
    expect(body.options.temperature).toBe(0.7);
  });

  test("pullModel throws on HTTP error", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Not Found", { status: 404 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    await expect(p.pullModel("no-such-model")).rejects.toThrow("Ollama pullModel HTTP 404");
  });

  test("pullModel throws when resp.body is null", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    await expect(p.pullModel("some-model")).rejects.toThrow("No response body");
  });

  test("pullModel with signal option passes it to fetch", async () => {
    const capturedSignals: Array<AbortSignal | null | undefined> = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"status":"success"}\n'));
        controller.close();
      },
    });
    globalThis.fetch = mock(async (_url: string, opts?: RequestInit) => {
      capturedSignals.push(opts?.signal as AbortSignal | null | undefined);
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    const controller = new AbortController();
    await p.pullModel("llama3.2", { signal: controller.signal });
    expect(capturedSignals[0]).toBe(controller.signal);
  });

  test("pullModel with no signal passes null to fetch", async () => {
    const capturedSignals: Array<AbortSignal | null | undefined> = [];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"status":"done"}\n'));
        controller.close();
      },
    });
    globalThis.fetch = mock(async (_url: string, opts?: RequestInit) => {
      capturedSignals.push(opts?.signal as AbortSignal | null | undefined);
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    // no opts at all → opts.signal ?? null
    await p.pullModel("llama3.2");
    expect(capturedSignals[0]).toBeNull();
  });

  test("pullModel without onProgress doesn't crash on progress chunks", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('{"status":"pulling","completed":50,"total":100}\n'));
        controller.enqueue(encoder.encode('{"status":"success"}\n'));
        controller.close();
      },
    });
    globalThis.fetch = mock(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;
    const p = new OllamaProvider("http://127.0.0.1:11434");
    // No onProgress callback — optional chaining should guard it
    await expect(p.pullModel("llama3.2", {})).resolves.toBeUndefined();
  });

  test("pullModel skips empty lines and malformed JSON in stream", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        // Empty line, malformed JSON, then valid
        controller.enqueue(encoder.encode("\n"));
        controller.enqueue(encoder.encode("NOT_JSON\n"));
        controller.enqueue(encoder.encode('{"status":"done"}\n'));
        controller.close();
      },
    });
    globalThis.fetch = mock(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;
    const received: PullProgressChunk[] = [];
    const p = new OllamaProvider("http://127.0.0.1:11434");
    await p.pullModel("llama3.2", { onProgress: (c) => received.push(c) });
    // Only the valid chunk emitted
    expect(received).toHaveLength(1);
    expect(received[0]?.status).toBe("done");
  });

  test("pullModel handles chunk where completed/total are non-numbers (no completedBytes/totalBytes)", async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(
          encoder.encode('{"status":"pulling","completed":"half","total":null}\n'),
        );
        controller.enqueue(encoder.encode('{"status":"success"}\n'));
        controller.close();
      },
    });
    globalThis.fetch = mock(
      async () => new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;
    const received: PullProgressChunk[] = [];
    const p = new OllamaProvider("http://127.0.0.1:11434");
    await p.pullModel("llama3.2", { onProgress: (c) => received.push(c) });
    // First chunk has non-number completed/total so those fields are absent
    expect(received[0]?.completedBytes).toBeUndefined();
    expect(received[0]?.totalBytes).toBeUndefined();
    expect(received[0]?.status).toBe("pulling");
  });
});

describe("OllamaProvider.pullModel (real Bun server)", () => {
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
