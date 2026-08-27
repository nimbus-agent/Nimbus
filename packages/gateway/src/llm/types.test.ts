import { describe, expect, test } from "bun:test";
import { LlamaCppProvider } from "./llamacpp-provider.ts";
import { OllamaProvider } from "./ollama-provider.ts";
import type { LlmProvider } from "./types.ts";

describe("LlmProvider.isLocal", () => {
  test("both shipped providers declare themselves local", () => {
    const providers: LlmProvider[] = [new OllamaProvider(), new LlamaCppProvider()];
    for (const p of providers) {
      expect(p.isLocal).toBe(true);
    }
  });

  test("a provider that omits isLocal does not satisfy the interface", () => {
    // Compile-time proof, asserted at runtime so the test is not vacuous: an object
    // literal missing `isLocal` is not assignable to LlmProvider. If this ever
    // compiles without the field, the interface has been weakened back to optional.
    const withoutIsLocal = {
      providerId: "fake",
      isAvailable: async () => true,
      listModels: async () => [],
      generate: async () => ({
        text: "",
        tokensIn: 0,
        tokensOut: 0,
        modelUsed: "fake",
        isLocal: false,
        provider: "fake",
      }),
    };
    // @ts-expect-error isLocal is required on LlmProvider
    const bad: LlmProvider = withoutIsLocal;
    expect(bad.isLocal).toBeUndefined();
  });
});
