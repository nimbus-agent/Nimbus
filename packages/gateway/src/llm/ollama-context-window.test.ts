import { describe, expect, test } from "bun:test";

import { DEFAULT_LOCAL_CONTEXT_TOKENS, OllamaProvider } from "./ollama-provider.ts";

/**
 * F32 — the local provider never sent `num_ctx`, so every prompt was capped at Ollama's own
 * default (4096 tokens) no matter what the model supports; `llama3.2` handles 128k.
 *
 * That default has to hold the system prompt, up to twelve prior turns
 * (`loadRecentConversationHistory` asks for 12), the question, the indexed context, AND the
 * `num_predict: 2048` reserved for the answer. Eight context items at up to 900 preview chars
 * is already ~1800 tokens before titles and URLs, so a conversation with any history plausibly
 * overflows — and Ollama does not report that, it drops the overflow from the front of the
 * prompt.
 *
 * That makes it strictly worse than F14's truncation, which at least happens somewhere we can
 * see and now disclose. It also bounds F14's disclosure: "written from 8 indexed items" is a
 * statement about what Nimbus HANDED OVER, and it can only stay true if the prompt is not
 * silently trimmed underneath it.
 */

function capturingFetch(): {
  bodies: Array<Record<string, unknown>>;
  fetchFn: typeof globalThis.fetch;
} {
  const bodies: Array<Record<string, unknown>> = [];
  const fetchFn = (async (_url: unknown, init?: { body?: string }) => {
    bodies.push(JSON.parse(init?.body ?? "{}") as Record<string, unknown>);
    return new Response(JSON.stringify({ response: "ok", done: true }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { bodies, fetchFn };
}

function optionsOf(body: Record<string, unknown>): Record<string, unknown> {
  return (body["options"] ?? {}) as Record<string, unknown>;
}

describe("OllamaProvider sends an explicit context window (F32)", () => {
  test("a batch generate declares num_ctx rather than inheriting Ollama's default", async () => {
    const { bodies, fetchFn } = capturingFetch();
    const original = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await new OllamaProvider().generate({ task: "reasoning", prompt: "hello" });
    } finally {
      globalThis.fetch = original;
    }
    expect(optionsOf(bodies[0] ?? {})["num_ctx"]).toBe(DEFAULT_LOCAL_CONTEXT_TOKENS);
  });

  test("a streaming generate declares it too, since that is the interactive path", async () => {
    // `nimbus ask` streams. Setting the window on only the batch path would leave the surface a
    // human actually uses on the silent default.
    const { bodies, fetchFn } = capturingFetch();
    const original = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await new OllamaProvider().generate({ task: "reasoning", prompt: "hello", stream: true });
    } finally {
      globalThis.fetch = original;
    }
    expect(optionsOf(bodies[0] ?? {})["num_ctx"]).toBe(DEFAULT_LOCAL_CONTEXT_TOKENS);
  });

  test("the window is configurable, because the memory cost lands on the user's machine", async () => {
    const { bodies, fetchFn } = capturingFetch();
    const original = globalThis.fetch;
    globalThis.fetch = fetchFn;
    try {
      await new OllamaProvider("http://127.0.0.1:11434", "llama3.2", 16_384).generate({
        task: "reasoning",
        prompt: "hello",
      });
    } finally {
      globalThis.fetch = original;
    }
    expect(optionsOf(bodies[0] ?? {})["num_ctx"]).toBe(16_384);
  });

  test("the default leaves real room for input after num_predict reserves its output", () => {
    // The number is only meaningful relative to what else shares the window. A default that
    // did not clear `num_predict` plus a system prompt would be a different silent cap.
    expect(DEFAULT_LOCAL_CONTEXT_TOKENS).toBeGreaterThan(2048 * 2);
  });
});
