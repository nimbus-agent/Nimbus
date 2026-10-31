export type SandboxPlatformCapabilities = {
  network: "per_host" | "per_port" | "all_or_nothing" | "refusing";
  reason: string | null;
};

export function formatNetworkIsolationLine(cap: SandboxPlatformCapabilities | null): string {
  if (cap === null) {
    return "Network isolation: (sandbox posture unavailable)";
  }
  if (cap.network === "per_host") {
    return "Network isolation: per-host";
  }
  const reasonSuffix = cap.reason !== null && cap.reason !== "" ? ` (${cap.reason})` : "";
  if (cap.network === "per_port") {
    return `Network isolation: per-port, any host on a declared port${reasonSuffix}`;
  }
  if (cap.network === "refusing") {
    return `Network isolation: refusing network-declaring extensions${reasonSuffix}`;
  }
  return `Network isolation: Degraded - all-or-nothing${reasonSuffix}`;
}
