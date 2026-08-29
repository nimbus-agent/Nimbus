import { describe, expect, test } from "bun:test";

import { createOpenAIEmbedder } from "./openai-embedder.ts";

describe("Embedder locality is declared, not inferred", () => {
  test("the OpenAI embedder is NOT local", async () => {
    // Hardcoded false, never derived from a base URL: the same rule I34 pins for cloud LLM
    // adapters. An embedder that claims to be local appends no ledger row, so a wrong `true`
    // is silent in exactly the direction that matters.
    const e = await createOpenAIEmbedder({ apiKey: "sk-test" });
    expect(e.isLocal).toBe(false);
  });
});
