// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
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
  /** Client-supplied correlation id, echoed on every agent.chunk for this run. */
  streamId?: string;
  /** Aborted by workflow.cancel; honoured at the next step boundary. */
  signal?: AbortSignal;
};

export type WorkflowRunHandler = (ctx: WorkflowRunContext) => Promise<{
  runId: string;
  status: string;
  dryRun: boolean;
  stepResults: Array<{ label?: string; status: string; output?: string; error?: string }>;
}>;
