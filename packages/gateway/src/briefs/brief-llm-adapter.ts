import type { LlmRouter } from "../llm/router.ts";
import type { BriefSynthesizerLlm } from "./brief-synthesis.ts";

/**
 * Production `BriefSynthesizerLlm` over the existing router — the first place
 * an LLM is wired into a built-in gateway agent surface (`AgentsRpcContext.llm`
 * has always been left undefined in production, so every other brief is
 * deterministic Markdown).
 *
 * `remote` comes from the provider's own `isLocal`, not from config intent, so
 * the disclosure reflects what actually happened rather than what was preferred.
 */
export function createBriefLlm(router: LlmRouter): BriefSynthesizerLlm {
  return {
    async generateJson(prompt: string) {
      const provider = await router.selectProvider("reasoning");
      if (provider === undefined) return null;
      const result = await provider.generate({
        task: "reasoning",
        prompt,
        temperature: 0,
      });
      return { text: result.text, model: result.modelUsed, remote: !result.isLocal };
    },
  };
}
