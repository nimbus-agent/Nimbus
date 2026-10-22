// The fleet-job half of the pack-fragment check. `config/pack-settable.ts` is pure and cannot
// import `fleet/` or `ipc/`, so it takes this checker by injection.

import {
  FleetConfigError,
  type NimbusFleetJobToml,
  parseNimbusTomlFleetJobs,
} from "../config/fleet-toml.ts";
import type { PackJobChecker } from "../config/pack-settable.ts";
import { validateFleetSweepJobs } from "../fleet/fleet-sweep-support.ts";
import { resolveFleetAgentMethod } from "../ipc/agents-rpc.ts";

const FEDERATION_PARAMS = ["namespace", "namespaces"] as const;

function withoutFederation(job: NimbusFleetJobToml): NimbusFleetJobToml {
  const params = Object.fromEntries(
    Object.entries(job.params).filter(
      ([k]) => !(FEDERATION_PARAMS as readonly string[]).includes(k),
    ),
  );
  return { ...job, params };
}

function problemsForJob(job: NimbusFleetJobToml): string[] {
  const problems: string[] = [];
  if (FEDERATION_PARAMS.some((k) => Object.hasOwn(job.params, k))) {
    problems.push(`[[fleet.job]] ${job.name}: namespace/namespaces are not allowed in a pack job`);
  }
  if (resolveFleetAgentMethod(job.agent) === null) {
    problems.push(`[[fleet.job]] ${job.name}: agent "${job.agent}" is not fleet-eligible`);
    return problems;
  }
  try {
    validateFleetSweepJobs([withoutFederation(job)]);
  } catch (err) {
    if (!(err instanceof FleetConfigError)) throw err;
    problems.push(err.message);
  }
  return problems;
}

export const checkPackFleetJobs: PackJobChecker = (jobsText) => {
  let jobs: NimbusFleetJobToml[];
  try {
    jobs = parseNimbusTomlFleetJobs(jobsText);
  } catch (err) {
    if (err instanceof FleetConfigError) return [err.message];
    throw err;
  }
  return jobs.flatMap(problemsForJob);
};
