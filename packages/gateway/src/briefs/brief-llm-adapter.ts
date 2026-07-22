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
 *
 * `preferLocal` is `[briefs].prefer_local` — source-text egress is the most privacy-sensitive
 * thing this feature does, so briefs honor their OWN prefer-local preference independently of
 * `[llm].prefer_local`, falling back to remote only when no local provider is available.
 */
export function createBriefLlm(router: LlmRouter, preferLocal: boolean): BriefSynthesizerLlm {
  return {
    async generateJson(prompt: string) {
      const provider = await router.selectProvider("reasoning", { preferLocal });
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
