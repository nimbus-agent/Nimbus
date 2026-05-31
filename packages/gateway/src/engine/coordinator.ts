import { Config } from "../config.ts";

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

export class AgentCoordinator {
  readonly #ctx: CoordinatorContext;

  constructor(ctx: CoordinatorContext) {
    this.#ctx = ctx;
  }

  async run(tasks: SubTask[]): Promise<SubTaskResult[]> {
    if (this.#ctx.depth > Config.maxAgentDepth) {
      throw new Error(
        `Agent depth limit reached: depth ${this.#ctx.depth} exceeds max ${Config.maxAgentDepth}`,
      );
    }

    if (this.#ctx.toolCallCount.value + tasks.length > Config.maxToolCallsPerSession) {
      throw new Error(
        `Tool call limit reached: ${tasks.length} new tasks would exceed cap ${Config.maxToolCallsPerSession}`,
      );
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
