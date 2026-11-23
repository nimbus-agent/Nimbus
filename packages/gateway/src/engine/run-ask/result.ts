import type { LlmGenerateResult } from "../../llm/types.ts";

/**
 * What `runAsk` returns. `asOfMs` is set only on a point-in-time turn that was honoured: the echo is how a
 * client tells a gateway that answered as of the instant from an older one that ignored `at`.
 */
export type RunAskResult = { reply: string; modelMeta?: LlmGenerateResult; asOfMs?: number };
