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
      fetchImpl: (input) => {
        calls.push(String(input));
        return Promise.resolve(jsonResponse({ capabilities: ["completion", "vision"] }));
      },
    });
    expect(await vlm.isAvailable()).toBe(true);
    expect(calls[0]).toContain("/api/show");
  });

  test("a pulled model WITHOUT the vision capability is unavailable", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: () => Promise.resolve(jsonResponse({ capabilities: ["completion"] })),
    });
    expect(await vlm.isAvailable()).toBe(false);
  });

  test("an EMPTY capabilities array is unavailable and must NOT fall through to the families heuristic", async () => {
    // Load-bearing precedence case: an empty `capabilities` array is still a REAL answer ("no
    // vision"), authoritative over the legacy `details.families` fallback below. `details.families`
    // is deliberately populated with a vision-looking family here too: a regression like
    // `Array.isArray(caps) && caps.length > 0` would treat `[]` as "field absent" and fall through
    // to this families heuristic, which would then wrongly report available. Without a
    // vision-looking family present, that regression would coincidentally still return `false`
    // (nothing to fall through TO) and this test would pass for the wrong reason.
    const vlm = createOllamaVlm({
      fetchImpl: () =>
        Promise.resolve(jsonResponse({ capabilities: [], details: { families: ["clip"] } })),
    });
    expect(await vlm.isAvailable()).toBe(false);
  });

  test("legacy Ollama with no capabilities field falls back to the families check", async () => {
    const withClip = createOllamaVlm({
      fetchImpl: () => Promise.resolve(jsonResponse({ details: { families: ["llama", "clip"] } })),
    });
    expect(await withClip.isAvailable()).toBe(true);

    const textOnly = createOllamaVlm({
      fetchImpl: () => Promise.resolve(jsonResponse({ details: { families: ["llama"] } })),
    });
    expect(await textOnly.isAvailable()).toBe(false);
  });

  test("a 404 from /api/show — model not pulled — is unavailable, not a throw", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: () => Promise.resolve(new Response("not found", { status: 404 })),
    });
    expect(await vlm.isAvailable()).toBe(false);
  });

  test("an unreachable daemon is unavailable, not a throw", async () => {
    const vlm = createOllamaVlm({ fetchImpl: () => Promise.reject(new Error("ECONNREFUSED")) });
    expect(await vlm.isAvailable()).toBe(false);
  });

  test("describe posts base64 image bytes to /api/generate and returns the response text", async () => {
    let body: unknown;
    const vlm = createOllamaVlm({
      model: "qwen2.5vl:7b",
      fetchImpl: (_input, init) => {
        body = JSON.parse(String(init?.body));
        return Promise.resolve(jsonResponse({ response: "A slide titled Q3 roadmap." }));
      },
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
      fetchImpl: () => Promise.resolve(new Response("boom", { status: 500 })),
    });
    await expect(vlm.describe({ bytes: new Uint8Array([1]), prompt: "p" })).rejects.toThrow(/500/);
  });

  test("a malformed body throws rather than yielding an empty caption", async () => {
    const vlm = createOllamaVlm({
      fetchImpl: () => Promise.resolve(jsonResponse({ unexpected: true })),
    });
    await expect(vlm.describe({ bytes: new Uint8Array([1]), prompt: "p" })).rejects.toThrow();
  });
});
