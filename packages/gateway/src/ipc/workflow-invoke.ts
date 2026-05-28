export type WorkflowRunContext = {
  clientId: string;
  workflowName: string;
  triggeredBy: string;
  dryRun: boolean;
  stream: boolean;
  sendChunk: (text: string) => void;
  sessionId?: string;
  agent?: string;
  paramsOverride?: Readonly<Record<string, Record<string, unknown>>>;
};

export type WorkflowRunHandler = (ctx: WorkflowRunContext) => Promise<{
  runId: string;
  dryRun: boolean;
  stepResults: Array<{ label?: string; status: string; output?: string; error?: string }>;
}>;
