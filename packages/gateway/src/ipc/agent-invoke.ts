import type { LlmGenerateResult } from "../llm/types.ts";

export type AgentInvokeContext = {
  clientId: string;
  input: string;
  stream: boolean;
  sendChunk: (text: string) => void;
  sessionId?: string;
  agent?: string;
};

export type AgentInvokeResult = {
  reply: string;
  modelMeta?: LlmGenerateResult;
};

export type AgentInvokeHandler = (ctx: AgentInvokeContext) => Promise<AgentInvokeResult>;
