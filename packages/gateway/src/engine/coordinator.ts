import { getAgentLimits } from "./agent-limits.ts";

export type SubTaskType = "classification" | "reasoning" | "summarisation" | "agent_step";

export type SubTaskResult = {
  taskIndex: number;
  taskType: SubTaskType;
  status: "done" | "error" | "rejected";
  text?: string;
  errorText?: string;
  tokensIn?: number;
  tokensOut?: number;
  modelUsed?: string;
};

export type SubTaskExecuteResult = {
  text: string;
  tokensIn: number;
  tokensOut: number;
  modelUsed?: string;
};

export type SubTask = {
  taskType: SubTaskType;
  prompt: string;
  execute: () => Promise<SubTaskExecuteResult>;
};

export type CoordinatorContext = {
  sessionId: string;
  parentId: string;
  depth: number;
  toolCallCount: { value: number };
};

/** Stable string code for a coordinator cap refusal; leads every `AgentLimitError` message. */
export const ERR_AGENT_LIMIT_REACHED = "ERR_AGENT_LIMIT_REACHED";

/**
 * A coordinator cap refused the fan-out. Typed so a caller can branch on `limit` instead of
 * matching message text. Built-in briefs run their coordinator inside `emitBriefWithSynthesis`'s
 * fire-and-forget task, so this reaches a client as the `error` string of `<agent>.briefError`
 * — hence the stable `ERR_AGENT_LIMIT_REACHED:` message prefix. No notification is sent: the
 * brief fails, and that failure is the signal.
 */
export class AgentLimitError extends Error {
  readonly code = ERR_AGENT_LIMIT_REACHED;
  readonly limit: "depth" | "tool_calls";
  readonly cap: number;
  /** The depth this coordinator ran at, or the sub-task count the batch would have reached. */
  readonly attempted: number;

  constructor(limit: "depth" | "tool_calls", cap: number, attempted: number) {
    super(
      limit === "depth"
        ? `${ERR_AGENT_LIMIT_REACHED}: Agent depth limit reached: depth ${String(attempted)} exceeds max ${String(cap)}`
        : `${ERR_AGENT_LIMIT_REACHED}: Tool call limit reached: ${String(attempted)} sub-tasks would exceed cap ${String(cap)}`,
    );
    this.name = "AgentLimitError";
    this.limit = limit;
    this.cap = cap;
    this.attempted = attempted;
  }
}

export class AgentCoordinator {
  readonly #ctx: CoordinatorContext;

  constructor(ctx: CoordinatorContext) {
    this.#ctx = ctx;
  }

  async run(tasks: SubTask[]): Promise<SubTaskResult[]> {
    const limits = getAgentLimits();
    if (this.#ctx.depth > limits.maxAgentDepth) {
      throw new AgentLimitError("depth", limits.maxAgentDepth, this.#ctx.depth);
    }

    const attempted = this.#ctx.toolCallCount.value + tasks.length;
    if (attempted > limits.maxToolCallsPerSession) {
      throw new AgentLimitError("tool_calls", limits.maxToolCallsPerSession, attempted);
    }
    this.#ctx.toolCallCount.value += tasks.length;

    return Promise.all(
      tasks.map(async (task, i): Promise<SubTaskResult> => {
        try {
          const outcome = await task.execute();
          return {
            taskIndex: i,
            taskType: task.taskType,
            status: "done",
            text: outcome.text,
            tokensIn: outcome.tokensIn,
            tokensOut: outcome.tokensOut,
            ...(outcome.modelUsed === undefined ? {} : { modelUsed: outcome.modelUsed }),
          };
        } catch (err) {
          return {
            taskIndex: i,
            taskType: task.taskType,
            status: "error",
            errorText: err instanceof Error ? err.message : String(err),
          };
        }
      }),
    );
  }
}
