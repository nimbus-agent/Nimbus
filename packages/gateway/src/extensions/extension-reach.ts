import { declaredNetworkPorts, type SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";
import { sandboxNetworkPosture } from "../platform/sandbox/sandbox-posture.ts";
import type { SandboxRunner } from "../platform/sandbox/sandbox-runner.ts";
import { oneLine } from "./install-plan-text.ts";

/** The slice of a sandbox runner the reach statement reads. */
export type ReachRunner = Pick<
  SandboxRunner,
  "platform" | "isFullyActive" | "degradedReason" | "networkRefused" | "networkScope" | "canConfine"
>;

export type NetworkReachKind =
  | "none"
  | "hosts"
  | "ports"
  | "any-internet"
  | "whole-network"
  | "refused"
  | "unknown";

export type NetworkReach = { readonly kind: NetworkReachKind; readonly text: string };

const UNKNOWN: NetworkReach = {
  kind: "unknown",
  text: "not known here (the sandbox is not available to ask)",
};
const NONE: NetworkReach = { kind: "none", text: "no network access" };

/** An empty policy: what a no-network extension would be confined under. */
const PROBE_POLICY: SandboxPolicy = {
  id: "reach-probe",
  permissions: { network: [], filesystem: { read: [], write: [] } },
};

function refused(reason: string | null): NetworkReach {
  return {
    kind: "refused",
    text: `will not start here: ${oneLine(reason ?? "reason not reported")}`,
  };
}

function reachWithHosts(runner: ReachRunner, hosts: readonly string[]): NetworkReach {
  const list = hosts.map(oneLine).join(", ");
  switch (sandboxNetworkPosture(runner)) {
    case "per_host":
      return { kind: "hosts", text: `network access to ${list}` };
    case "per_port": {
      const ports = declaredNetworkPorts(hosts);
      const noun = ports.length === 1 ? "port" : "ports";
      return {
        kind: "ports",
        text: `network access to any host on ${noun} ${ports.join(", ")}, including this machine and the local network (macOS cannot limit this to ${list})`,
      };
    }
    case "all_or_nothing":
      if (runner.platform === "win32") {
        return {
          kind: "any-internet",
          text: `any internet host, and a private-network host may fail (Windows cannot limit this to ${list})`,
        };
      }
      return {
        kind: "whole-network",
        text: `the whole network (this machine cannot limit it to ${list}: ${oneLine(runner.degradedReason() ?? "reason not reported")})`,
      };
    case "refusing":
      return refused(runner.degradedReason());
  }
}

/**
 * What the sandbox on THIS machine does with an extension's declared network hosts, from the
 * runner's live posture. With no hosts it asks `canConfine` for an empty policy instead (a Linux
 * runner without bwrap, a Windows runner without its helper, cannot start even that child). With
 * hosts it does not: on Linux with no helper `canConfine` returns a reason while `spawn` lets the
 * child through with the whole network, so the posture is the truth there.
 */
export function describeNetworkReach(
  runner: ReachRunner | undefined,
  hosts: readonly string[],
): NetworkReach {
  if (runner === undefined) return UNKNOWN;
  try {
    if (hosts.length === 0) {
      const reason = runner.canConfine(PROBE_POLICY);
      return reason === null ? NONE : refused(reason);
    }
    return reachWithHosts(runner, hosts);
  } catch {
    return UNKNOWN;
  }
}
