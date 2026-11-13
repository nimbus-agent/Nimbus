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
   * `nimbus ask --at` (Phase 10 IC1): the instant, parsed and bounds-checked by `dispatchAgentInvoke`
   * (`-32602` for a bad or future value). The turn answers as the index stood then, with no live read and
   * no write. Absent on `engine.askStream`, which does not read `at` (a stated bound).
   */
  pointInTimeMs?: number;
  /**
   * Whether this turn may be offered the owner-registered user-MCP tools (`connector add --mcp
   * --model`, I42). Decided ONCE at the IPC entry from the live session's server-held
   * `ClientKind` (`USER_MCP_OFFER_BY_KIND` in `ipc/server/inline-handlers.ts`) — never from a
   * request param, and never re-derived downstream: `runAsk` has a non-IPC caller (ChatOps) whose
   * clientId is not a registered kind at all and would read as `unknown`.
   */
  offerUserMcpTools?: boolean;
  /**
   * Whether this turn may be offered the model's connector-write door (Phase 9.7). Decided ONCE at
   * the IPC entry from the session's server-held `ClientKind` (`CONNECTOR_WRITE_OFFER_BY_KIND` in
   * `ipc/server/inline-handlers.ts`: `cli` and `ui` only) — never from a request param.
   */
  offerConnectorWriteTools?: boolean;
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
  /** Echo of the honoured `at` instant; absent when the request had none (and from an older gateway). */
  asOfMs?: number;
};

export type AgentInvokeHandler = (ctx: AgentInvokeContext) => Promise<AgentInvokeResult>;
