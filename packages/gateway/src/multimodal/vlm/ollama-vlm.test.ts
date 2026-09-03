import { describe, expect, test } from "bun:test";
import { createOllamaVlm } from "./ollama-vlm.ts";

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("createOllamaVlm", () => {
  test("isLocal is DERIVED from the base URL, not the vendor id (I34)", () => {
    expect(createOllamaVlm({ baseUrl: "http://127.0.0.1:11434" }).isLocal).toBe(true);
    expect(createOllamaVlm({ baseUrl: "http://gpu-box.lan:11434" }).isLocal).toBe(false);
  });

  test("isAvailable is true when /api/show reports the vision capability", async () => {
    const calls: string[] = [];
    const vlm = createOllamaVlm({
      model: "qwen2.5vl:7b",
      fetchImpl: ((input: string | URL | Request) => {
        calls.push(String(input));
        return Promise.resolve(jsonResponse({ capabilities: ["completion", "vision"] }));
      }) as unknown as typeof fetch,
    });
    expect(await vlm.isAvailable()).toBe(true);
    expect(calls[0]).toContain("/api/show");
  });

  test("a pulled model WITHOUT the vision capability is unavailable", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: (() =>
        Promise.resolve(jsonResponse({ capabilities: ["completion"] }))) as unknown as typeof fetch,
    });
    expect(await vlm.isAvailable()).toBe(false);
  });

  test("legacy Ollama with no capabilities field falls back to the families check", async () => {
    const withClip = createOllamaVlm({
      fetchImpl: (() =>
        Promise.resolve(
          jsonResponse({ details: { families: ["llama", "clip"] } }),
        )) as unknown as typeof fetch,
    });
    expect(await withClip.isAvailable()).toBe(true);

    const textOnly = createOllamaVlm({
      fetchImpl: (() =>
        Promise.resolve(
          jsonResponse({ details: { families: ["llama"] } }),
        )) as unknown as typeof fetch,
    });
    expect(await textOnly.isAvailable()).toBe(false);
  });

  test("a 404 from /api/show — model not pulled — is unavailable, not a throw", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: (() =>
        Promise.resolve(new Response("not found", { status: 404 }))) as unknown as typeof fetch,
    });
    expect(await vlm.isAvailable()).toBe(false);
  });

  test("an unreachable daemon is unavailable, not a throw", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: (() => Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof fetch,
    });
    expect(await vlm.isAvailable()).toBe(false);
  });

  test("describe posts base64 image bytes to /api/generate and returns the response text", async () => {
    let body: unknown;
    const vlm = createOllamaVlm({
      model: "qwen2.5vl:7b",
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) => {
        body = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse({ response: "A slide titled Q3 roadmap." }));
      }) as unknown as typeof fetch,
    });
    const res = await vlm.describe({
      bytes: new Uint8Array([1, 2, 3]),
      prompt: "Describe this image.",
    });
    expect(res.text).toBe("A slide titled Q3 roadmap.");
    expect(body).toMatchObject({
      model: "qwen2.5vl:7b",
      prompt: "Describe this image.",
      stream: false,
      images: [Buffer.from([1, 2, 3]).toString("base64")],
    });
  });

  test("a non-200 from /api/generate throws, so the gate records transcribe_failed", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: (() =>
        Promise.resolve(new Response("boom", { status: 500 }))) as unknown as typeof fetch,
    });
    await expect(vlm.describe({ bytes: new Uint8Array([1]), prompt: "p" })).rejects.toThrow(/500/);
  });

  test("a malformed body throws rather than yielding an empty caption", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: (() =>
        Promise.resolve(jsonResponse({ unexpected: true }))) as unknown as typeof fetch,
    });
    await expect(vlm.describe({ bytes: new Uint8Array([1]), prompt: "p" })).rejects.toThrow();
  });
});
