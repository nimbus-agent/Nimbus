import type { SandboxRunner } from "./sandbox-runner.ts";

export type SandboxNetworkPosture = "per_host" | "per_port" | "all_or_nothing" | "refusing";

/**
 * What this machine's sandbox does with a declared network, read live from the runner: a fully
 * active runner reports its own scope (per host unless it says narrower); a degraded one either
 * refuses a network-declaring spawn or lets the child through with the whole network.
 */
export function sandboxNetworkPosture(
  runner: Pick<SandboxRunner, "isFullyActive" | "networkScope" | "networkRefused">,
): SandboxNetworkPosture {
  if (runner.isFullyActive()) return runner.networkScope?.() ?? "per_host";
  return runner.networkRefused?.() === true ? "refusing" : "all_or_nothing";
}
