export type AgentInvokeContext = {
  clientId: string;
  input: string;
  stream: boolean;
  sendChunk: (text: string) => void;
  sessionId?: string;
  agent?: string;
};

export type AgentInvokeHandler = (ctx: AgentInvokeContext) => Promise<{ reply: string }>;
