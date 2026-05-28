export type SandboxPlatformCapabilities = {
  network: "per_host" | "all_or_nothing";
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
  return `Network isolation: Degraded - all-or-nothing${reasonSuffix}`;
}
