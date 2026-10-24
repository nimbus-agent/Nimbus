// The fleet-job half of the pack-fragment check. `config/pack-settable.ts` is pure and cannot
// import `fleet/` or `ipc/`, so it takes this checker by injection.

import {
  FleetConfigError,
  type NimbusFleetJobToml,
  parseNimbusTomlFleetJobs,
} from "../config/fleet-toml.ts";
import type { PackJobChecker } from "../config/pack-settable.ts";
import { FEDERATION_PARAMS, validateFleetSweepJobs } from "../fleet/fleet-sweep-support.ts";
import { resolveFleetAgentMethod } from "../ipc/agents-rpc.ts";

function withoutFederation(job: NimbusFleetJobToml): NimbusFleetJobToml {
  const params = Object.fromEntries(
    Object.entries(job.params).filter(([k]) => !FEDERATION_PARAMS.includes(k)),
  );
  return { ...job, params };
}

/** The fleet functions the check reads; injectable so a test can reach the rethrow paths. */
export type PackJobCheckDeps = {
  readonly parseJobs: (text: string) => NimbusFleetJobToml[];
  readonly validateSweeps: (jobs: readonly NimbusFleetJobToml[]) => void;
  readonly resolveAgent: (agent: string) => string | null;
};

const DEFAULT_DEPS: PackJobCheckDeps = {
  parseJobs: parseNimbusTomlFleetJobs,
  validateSweeps: validateFleetSweepJobs,
  resolveAgent: resolveFleetAgentMethod,
};

/** A `FleetConfigError` becomes a problem; anything else is a bug and propagates. */
function configProblem(err: unknown): string {
  if (err instanceof FleetConfigError) return err.message;
  throw err;
}

function problemsForJob(job: NimbusFleetJobToml, deps: PackJobCheckDeps): string[] {
  const problems: string[] = [];
  if (FEDERATION_PARAMS.some((k) => Object.hasOwn(job.params, k))) {
    problems.push(`[[fleet.job]] ${job.name}: namespace/namespaces are not allowed in a pack job`);
  }
  if (deps.resolveAgent(job.agent) === null) {
    problems.push(`[[fleet.job]] ${job.name}: agent "${job.agent}" is not fleet-eligible`);
    return problems;
  }
  try {
    deps.validateSweeps([withoutFederation(job)]);
  } catch (err) {
    problems.push(configProblem(err));
  }
  return problems;
}

/**
 * Uses the STRICT job parser: a pack ships whole jobs, so a disabling stub (`enabled = false` with
 * no agent or interval) is refused here, while a full pack job with `enabled = false` is checked
 * like any other.
 */
export function createPackFleetJobCheck(deps: PackJobCheckDeps = DEFAULT_DEPS): PackJobChecker {
  return (jobsText) => {
    let jobs: NimbusFleetJobToml[];
    try {
      jobs = deps.parseJobs(jobsText);
    } catch (err) {
      return [configProblem(err)];
    }
    return jobs.flatMap((job) => problemsForJob(job, deps));
  };
}

export const checkPackFleetJobs: PackJobChecker = createPackFleetJobCheck();
