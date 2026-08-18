// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
import type { LlmGenerateResult } from "../llm/types.ts";

export type AgentInvokeContext = {
  clientId: string;
  input: string;
  stream: boolean;
  sendChunk: (text: string) => void;
  sessionId?: string;
  agent?: string;
  /**
   * Devil's-advocate mode (`nimbus ask --devil`). Carried on the context rather than parsed
   * downstream, because TWO dispatchers reach this one handler — `agent.invoke` and
   * `engine.askStream` — and the flag has to survive both.
   */
  devil?: boolean;
};

export type AgentInvokeResult = {
  reply: string;
  modelMeta?: LlmGenerateResult;
};

export type AgentInvokeHandler = (ctx: AgentInvokeContext) => Promise<AgentInvokeResult>;
