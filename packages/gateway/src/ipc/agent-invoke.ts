// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
import type { NotifyGasLimit } from "../engine/step-budget.ts";
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
  /**
   * Whether this turn may be offered the owner-registered user-MCP tools (`connector add --mcp
   * --model`, I42). Decided ONCE at the IPC entry from the live session's server-held
   * `ClientKind` (`USER_MCP_OFFER_BY_KIND` in `ipc/server/inline-handlers.ts`) — never from a
   * request param, and never re-derived downstream: `runAsk` has a non-IPC caller (ChatOps) whose
   * clientId is not a registered kind at all and would read as `unknown`.
   */
  offerUserMcpTools?: boolean;
  /**
   * Set by `agent.invoke` only: writes a UNICAST `agent.gasLimitReached` to the session that
   * made the call when the agent step budget cut the turn short (`engine/step-budget.ts`). Never
   * a broadcast — the event describes one caller's turn.
   */
  notifyGasLimit?: NotifyGasLimit;
};

export type AgentInvokeResult = {
  reply: string;
  modelMeta?: LlmGenerateResult;
};

export type AgentInvokeHandler = (ctx: AgentInvokeContext) => Promise<AgentInvokeResult>;
