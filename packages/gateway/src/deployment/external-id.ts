import type { DeploymentAnnotateInput } from "./types.ts";

export function computeDeploymentExternalId(input: DeploymentAnnotateInput): string {
  if (
    input.run_id !== undefined &&
    input.run_id !== "" &&
    input.job_id !== undefined &&
    input.job_id !== ""
  ) {
    return `${input.provider}:run-${input.run_id}:job-${input.job_id}`;
  }
  if (input.run_id !== undefined && input.run_id !== "") {
    return `${input.provider}:run-${input.run_id}`;
  }
  return `${input.service}:${input.environment}:${input.sha}`;
}
