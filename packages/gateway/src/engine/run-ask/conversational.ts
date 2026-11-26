import type { Database } from "bun:sqlite";
import { earliestHistoryMs, type PointInTimeFacts } from "../../index/item-history-at.ts";
import { gatewayZone } from "../../util/zoned-time.ts";
import { resolveAskStyle } from "../personalization.ts";
import type { RunAskParams } from "../run-ask.ts";
import type {
  RunConversationalAgentParams,
  runConversationalAgent,
} from "../run-conversational-agent.ts";
import { conversationalExplainRoute, type ExplainPartial } from "./explain.ts";
import type { LocalIndexedContext } from "./local-context.ts";

/** What the retrieval phase of a conversational turn produced, for the agent's input. */
export interface ConversationalTurnContext {
  readonly priorTurns: NonNullable<RunConversationalAgentParams["priorTurns"]>;
  readonly localContext: LocalIndexedContext | undefined;
  readonly memoryBlock: string | undefined;
  readonly countLine: string | undefined;
  readonly atMs: number | undefined;
  readonly searchedFacts: readonly PointInTimeFacts[];
  readonly countDb: Database | undefined;
}

/** The agent's input for one conversational turn (one place, so the two doors cannot drift). */
export function conversationalAgentParams(
  p: RunAskParams,
  c: ConversationalTurnContext,
): RunConversationalAgentParams {
  return {
    input: p.input,
    stream: p.stream,
    sendChunk: p.sendChunk,
    priorTurns: c.priorTurns,
    ...(p.conversationalAgent === undefined ? {} : { agent: p.conversationalAgent }),
    ...(p.llmRouter === undefined ? {} : { llmRouter: p.llmRouter }),
    ...(c.localContext === undefined
      ? {}
      : { localContext: c.localContext.text, localContextTruncation: c.localContext.truncation }),
    ...(c.memoryBlock === undefined ? {} : { episodicRecall: c.memoryBlock }),
    ...(c.countLine === undefined ? {} : { indexCountLine: c.countLine }),
    ...(p.devil === true ? { devil: true } : {}),
    ...(c.atMs === undefined
      ? {}
      : {
          pointInTime: {
            atMs: c.atMs,
            zone: gatewayZone(),
            searched: c.searchedFacts,
            fallbackHistoryStartMs: c.countDb === undefined ? null : earliestHistoryMs(c.countDb),
          },
        }),
    // Per turn (D3): `[persona]` with `[personalization]` tone, plus its verbosity sentence.
    ...resolveAskStyle(p.paths.configDir),
    ...(p.notifyGasLimit === undefined ? {} : { notifyGasLimit: p.notifyGasLimit }),
  };
}

/** Records what the agent turn did on the explain record (fallback, step budget, model, route). */
export function noteConversationalOutcome(
  partial: ExplainPartial,
  result: Awaited<ReturnType<typeof runConversationalAgent>>,
  localContext: LocalIndexedContext | undefined,
): void {
  if (result.fallbackFromLocalRouter !== undefined) {
    partial.fallbackFromLocalRouter = result.fallbackFromLocalRouter;
  }
  if (result.stepBudgetExhausted !== undefined) {
    partial.stepBudgetExhausted = result.stepBudgetExhausted;
  }
  if (result.modelMeta !== undefined) {
    partial.modelRoute = {
      provider: result.modelMeta.provider,
      model: result.modelMeta.modelUsed,
      isLocal: result.modelMeta.isLocal,
    };
  }
  partial.route = conversationalExplainRoute(result.toolless, localContext);
}
