export type DeploymentConclusion = "success" | "failure" | "cancelled" | "in_progress";

export type DeploymentProvider =
  | "github-actions"
  | "gitlab"
  | "jenkins"
  | "circleci"
  | "bitbucket"
  | "other";

export interface DeploymentAnnotateInput {
  readonly service: string;
  readonly provider: DeploymentProvider;
  readonly environment: string;
  readonly sha: string;
  readonly ref: string;
  readonly status: DeploymentConclusion;
  readonly started_at_ms: number;
  readonly finished_at_ms?: number;
  readonly workflow_url?: string;
  readonly run_id?: string;
  readonly job_id?: string;
}

export interface DeploymentAnnotateResult {
  readonly external_id: string;
  readonly service: string;
  readonly stored_at_ms: number;
  readonly is_new: boolean;
  readonly dora_eligible: boolean;
}
