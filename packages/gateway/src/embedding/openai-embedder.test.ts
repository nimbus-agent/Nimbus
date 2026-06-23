import { afterEach, describe, expect, test } from "bun:test";
import { requestUrl } from "../../test/helpers/request-url.ts";
import { createOpenAIEmbedder } from "./openai-embedder.ts";

const ORIG_FETCH = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = ORIG_FETCH;
});

type FetchCall = {
  url: string;
  method: string | undefined;
  headers: Record<string, string>;
  body: unknown;
};

function captureFetch(response: Response | (() => Response)): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = requestUrl(input);
    const headers: Record<string, string> = {};
    if (init?.headers !== undefined) {
      const h = new Headers(init.headers);
      h.forEach((v, k) => {
        headers[k] = v;
      });
    }
    const bodyRaw = typeof init?.body === "string" ? init.body : undefined;
    calls.push({
      url,
      method: init?.method,
      headers,
      body: bodyRaw === undefined ? undefined : JSON.parse(bodyRaw),
    });
    return typeof response === "function" ? response() : response;
  }) as typeof fetch;
  return { calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("createOpenAIEmbedder", () => {
  test("returns model tag with `openai:` prefix and configured dims", async () => {
    const embedder = await createOpenAIEmbedder({ apiKey: "k" });
    expect(embedder.model).toBe("openai:text-embedding-3-small");
    expect(embedder.dims).toBe(384);
  });

  test("custom model + dimensions flow through to tag, dims, and request body", async () => {
    const { calls } = captureFetch(
      jsonResponse({ data: [{ index: 0, embedding: Array.from({ length: 1536 }, () => 0.1) }] }),
    );
    const embedder = await createOpenAIEmbedder({
      apiKey: "k",
      model: "text-embedding-3-large",
      dimensions: 1536,
    });
    expect(embedder.model).toBe("openai:text-embedding-3-large");
    expect(embedder.dims).toBe(1536);
    await embedder.embed(["hello"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.body).toEqual({
      model: "text-embedding-3-large",
      input: ["hello"],
      dimensions: 1536,
    });
  });

  test("empty input short-circuits without calling fetch", async () => {
    const { calls } = captureFetch(jsonResponse({ data: [] }));
    const embedder = await createOpenAIEmbedder({ apiKey: "k" });
    const out = await embedder.embed([]);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  test("sends Authorization bearer + Content-Type JSON to /v1/embeddings", async () => {
    const { calls } = captureFetch(
      jsonResponse({ data: [{ index: 0, embedding: new Array(384).fill(0.5) }] }),
    );
    const embedder = await createOpenAIEmbedder({ apiKey: "secret-123" });
    await embedder.embed(["x"]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.openai.com/v1/embeddings");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers["authorization"]).toBe("Bearer secret-123");
    expect(calls[0]?.headers["content-type"]).toBe("application/json");
  });

  test("returns Float32Arrays in input order even when response is out-of-order", async () => {
    const v0 = new Array(384).fill(0).map((_, i) => i / 384);
    const v1 = new Array(384).fill(0).map((_, i) => (i + 1000) / 384);
    const v2 = new Array(384).fill(0).map((_, i) => (i + 2000) / 384);
    captureFetch(
      jsonResponse({
        data: [
          { index: 2, embedding: v2 },
          { index: 0, embedding: v0 },
          { index: 1, embedding: v1 },
        ],
      }),
    );
    const embedder = await createOpenAIEmbedder({ apiKey: "k" });
    const out = await embedder.embed(["a", "b", "c"]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0]?.[0]).toBeCloseTo(v0[0] ?? 0);
    expect(out[1]?.[0]).toBeCloseTo(v1[0] ?? 0);
    expect(out[2]?.[0]).toBeCloseTo(v2[0] ?? 0);
  });

  test("rows missing an `index` field sort as index 0 (defensive default)", async () => {
    captureFetch(
      jsonResponse({
        data: [
          { embedding: new Array(384).fill(0.25) },
          { index: 1, embedding: new Array(384).fill(0.75) },
        ],
      }),
    );
    const embedder = await createOpenAIEmbedder({ apiKey: "k" });
    const out = await embedder.embed(["a", "b"]);
    expect(out).toHaveLength(2);
    expect(out[0]?.[0]).toBeCloseTo(0.25);
    expect(out[1]?.[0]).toBeCloseTo(0.75);
  });

  test("non-ok response throws with status code and body slice (≤200 chars)", async () => {
    const longBody = "x".repeat(500);
    captureFetch(new Response(longBody, { status: 429, statusText: "Too Many Requests" }));
    const embedder = await createOpenAIEmbedder({ apiKey: "k" });
    await expect(embedder.embed(["hello"])).rejects.toThrow(/OpenAI embeddings failed \(429\)/);
    await expect(embedder.embed(["hello"])).rejects.toThrow(/^[\s\S]{0,260}$/);
  });

  test("embedding with wrong dimensionality throws", async () => {
    captureFetch(jsonResponse({ data: [{ index: 0, embedding: new Array(100).fill(0) }] }));
    const embedder = await createOpenAIEmbedder({ apiKey: "k" });
    await expect(embedder.embed(["hello"])).rejects.toThrow(/unexpected embedding shape/);
  });

  test("missing `embedding` field on a row throws", async () => {
    captureFetch(jsonResponse({ data: [{ index: 0 }] }));
    const embedder = await createOpenAIEmbedder({ apiKey: "k" });
    await expect(embedder.embed(["hello"])).rejects.toThrow(/unexpected embedding shape/);
  });

  test("missing `data` array on response returns no rows -> count mismatch", async () => {
    captureFetch(jsonResponse({}));
    const embedder = await createOpenAIEmbedder({ apiKey: "k" });
    await expect(embedder.embed(["hello"])).rejects.toThrow(/returned 0 embeddings for 1 inputs/);
  });

  test("row count mismatch throws with both counts", async () => {
    captureFetch(
      jsonResponse({
        data: [{ index: 0, embedding: new Array(384).fill(0.1) }],
      }),
    );
    const embedder = await createOpenAIEmbedder({ apiKey: "k" });
    await expect(embedder.embed(["a", "b", "c"])).rejects.toThrow(
      /returned 1 embeddings for 3 inputs/,
    );
  });

  test("numeric coercion: stringified numbers in embedding still produce a Float32Array", async () => {
    const embedding = Array.from({ length: 384 }, (_, i) => String(i / 384));
    captureFetch(jsonResponse({ data: [{ index: 0, embedding }] }));
    const embedder = await createOpenAIEmbedder({ apiKey: "k" });
    const out = await embedder.embed(["x"]);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0]).toHaveLength(384);
    expect(out[0]?.[383]).toBeCloseTo(383 / 384);
  });
});
