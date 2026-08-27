import type { LlmRouter } from "../llm/router.ts";
import type { ConsolidatorLlm } from "./glossary-consolidate.ts";

/**
 * Production `ConsolidatorLlm` over the existing router — LOCAL PROVIDERS ONLY.
 *
 * Unlike `briefs/brief-llm-adapter.ts` there is no `preferLocal` parameter and
 * no remote arm. `[briefs]` is default-off and documents source-text egress as
 * its most privacy-sensitive act; `[glossary]` is default-ON and spec §7
 * justifies that with "local-only, no egress". `selectProvider` only expresses
 * a PREFERENCE — it returns the remote provider when no local one answers — so
 * the kind is checked here, before any prompt is dispatched. Checking
 * `LlmGenerateResult.isLocal` instead would report egress that already
 * happened.
 *
 * Task is "summarisation", not "reasoning": `meetsCapabilityFloor` applies
 * `minReasoningParams` only to reasoning/agent_step, and consolidation (read a
 * few snippets, emit small JSON) does not need a large model. Gating it behind
 * the reasoning floor would exclude exactly the small local models that make a
 * local-only guarantee viable on a laptop.
 *
 * `provider.generate` is called directly rather than `router.generate`, whose
 * `fitPromptOrFallback` can route an oversized prompt to a remote provider.
 * The glossary prompt is bounded (<=5 sources x ~512 chars) so no truncation
 * path is needed.
 *
 * LIMIT — `signal` bounds the WAIT, not the request. `LlmGenerateOptions` has
 * no signal field and both providers hardcode `AbortSignal.timeout(120_000)`
 * on their own fetch, so an aborted pass stops waiting while the model keeps
 * generating until the provider's timeout or process exit. Reachable at most
 * once per process today: the refresher builds ONE AbortController and
 * `stop()` is terminal, so the single abort happens at shutdown, immediately
 * before the socket closes. Whoever adds a `signal` field to
 * `LlmGenerateOptions` should thread it through here via `AbortSignal.any`;
 * whoever adds a per-pass controller (a `--force` cancel) MUST do that first,
 * because per-pass cancellation is what makes repeated aborts reachable.
 */
export function createGlossaryLlm(router: LlmRouter): ConsolidatorLlm {
  return {
    async generateJson(prompt: string, signal?: AbortSignal): Promise<string | null> {
      if (signal?.aborted === true) return null;
      const provider = await router.selectProvider("summarisation", { preferLocal: true });
      if (provider === undefined) return null;
      if (!provider.isLocal) return null;
      const result = await provider.generate({
        task: "summarisation",
        prompt,
        temperature: 0,
      });
      return result.text;
    },
  };
}
