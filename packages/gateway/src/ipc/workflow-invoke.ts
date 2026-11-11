// Type-only module: NO executable runtime logic. It is exact-path-excluded from the coverage floor
// in scripts/coverage-floor/exclusions.ts (a type-only file emits no SF: lcov record). Adding runtime
// logic here would silently bypass the floor — put runtime logic in a separate, covered module.
import type { WorkflowResume } from "../automation/workflow-runner.ts";
import type { WorkflowTrigger } from "../engine/types.ts";

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
  /**
   * How the run started, derived by the dispatcher from the connection's declared client kind
   * (`cli` -> owner_cli, `ui` -> owner_ui); absent for any other kind. Never taken from params.
   */
  trigger?: WorkflowTrigger;
  /** Set only by `workflow.resume` (SA4), after the dispatcher validated the blocked run. */
  resume?: WorkflowResume;
};

export type WorkflowRunHandler = (ctx: WorkflowRunContext) => Promise<{
  runId: string;
  status: string;
  dryRun: boolean;
  stepResults: Array<{ label?: string; status: string; output?: string; error?: string }>;
}>;
