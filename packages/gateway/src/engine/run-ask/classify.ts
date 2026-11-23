import type { LlmRouter } from "../../llm/router.ts";
import { GatewayAgentUnavailableError } from "../gateway-agent-error.ts";
import { type ClassifiedIntent, type ClassifierEgressPolicy, classifyIntent } from "../router.ts";
import { runAskLog } from "./log.ts";

/** The `RunAskParams` fields the classification step reads (structural: `RunAskParams` is assignable). */
export type ClassifyParams = {
  readonly input: string;
  readonly llmRouter?: LlmRouter | undefined;
  readonly classify?: ((input: string) => Promise<ClassifiedIntent>) | undefined;
};

async function classifyIntentForAsk(
  input: string,
  policy: ClassifierEgressPolicy,
): Promise<ClassifiedIntent> {
  try {
    return await classifyIntent(input, policy);
  } catch (e) {
    if (e instanceof GatewayAgentUnavailableError) {
      throw e;
    }
    throw new GatewayAgentUnavailableError({ reason: "unknown" });
  }
}

/**
 * `classified` plus what the explain recorder needs to know about the classifier call itself
 * (spec §4.3): `classifierDestination` names where the classifying prompt actually went, and is
 * set ONLY from inside a successful `router.generate` round-trip — never guessed — so its
 * absence means "no destination was ever resolved" (no router, an injected `p.classify` double,
 * or a caught fallback below), not "resolved to nothing". `classifierSkipReason` is set only on
 * the graceful local-fallback arm, where the classifier never produced an answer to report.
 */
export type ClassifyForAskResult = {
  readonly classified: ClassifiedIntent;
  readonly classifierDestination?: string;
  readonly classifierSkipReason?: string;
};

export async function classifyIntentForAskWithLocalFallback(
  p: ClassifyParams,
): Promise<ClassifyForAskResult> {
  // Resolved from the router, which owns `[llm]` AND is now the classifier's only way out of the
  // machine: `generate` is what carries the per-vendor `[llm.remote.*]` opt-in and appends the
  // I29 `model` row. Absent a router there is no configuration to read and no ledger to append
  // to, so `generate` is undefined and the classifier refuses — fail-closed, where it used to
  // fall back to its own env-keyed HTTP client. Every production path builds a router
  // (`platform/assemble.ts`).
  const router = p.llmRouter;
  // Captured by wrapping the closure `classifyIntent` already receives (spec §4.3), rather than
  // widening `classifyIntent`'s own exported return type, which has its own tests and is not
  // this function's to change.
  let classifierDestination: string | undefined;
  const policy: ClassifierEgressPolicy = {
    enforceAirGap: router?.enforcesAirGap() ?? false,
    generate:
      router === undefined
        ? undefined
        : async (opts) => {
            const res = await router.generate(opts);
            classifierDestination = res.provider;
            return res;
          },
  };
  try {
    const classified = await (p.classify ?? ((input) => classifyIntentForAsk(input, policy)))(
      p.input,
    );
    return {
      classified,
      ...(classifierDestination === undefined ? {} : { classifierDestination }),
    };
  } catch (e) {
    if (
      p.llmRouter === undefined ||
      !p.llmRouter.prefersLocal() ||
      !(e instanceof GatewayAgentUnavailableError)
    ) {
      throw e;
    }
    // `air_gap` joins the two key-shaped reasons: all three mean "no remote classification is
    // going to happen", and the caller's recovery is identical — answer from the local index.
    // Without it, turning air-gap ON would turn a working local ask into a hard error.
    if (e.reason !== "no_api_key" && e.reason !== "invalid_api_key" && e.reason !== "air_gap") {
      throw e;
    }
    runAskLog.warn(
      { reason: e.reason, provider: e.provider },
      "remote intent classifier unavailable; falling back to local indexed-context answer",
    );
    return {
      classified: {
        intent: "unknown",
        entities: {},
        requiresHITL: false,
        confidence: 0,
      },
      classifierSkipReason: `remote classifier unavailable: ${e.reason}`,
    };
  }
}
