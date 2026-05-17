/**
 * T2 PR 1 Task 20 — "Network isolation:" line for `nimbus extension info`.
 *
 * Pure rendering helpers kept in their own module so the unit tests can
 * import them without dragging in `@nimbus-dev/client` (which is workspace-
 * resolved and not present in the test runtime when only the CLI is built).
 */

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
