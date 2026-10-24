import type { FleetJobChecker } from "../config/fleet-toml.ts";
import { resolveFleetAgentMethod } from "../ipc/agents-rpc.ts";
import { fleetSweepProblem } from "./fleet-sweep-support.ts";

/**
 * The semantic half of a `[[fleet.job]]` check, which `config/` cannot do itself: agent
 * eligibility and sweep support. `loadFleet` hands it to the loader, so a job it refuses is dropped
 * on its own rather than disabling the fleet. The invoker still refuses an ineligible agent at run
 * time (defence in depth).
 */
export const checkFleetJob: FleetJobChecker = (job) => {
  if (resolveFleetAgentMethod(job.agent) === null) {
    return `[[fleet.job]] ${job.name} agent "${job.agent}" is not fleet-eligible`;
  }
  return fleetSweepProblem(job);
};
