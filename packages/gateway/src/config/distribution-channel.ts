/**
 * Channels a Nimbus binary can be distributed through. When Nimbus runs from a
 * package-manager install, the self-updater steps aside so the package manager
 * owns updates (see installer design spec §6.1).
 */
export type DistributionChannel = "homebrew" | "scoop" | "winget" | "apt" | "yum" | "msi" | "pkg";

const KNOWN_CHANNELS: ReadonlySet<DistributionChannel> = new Set([
  "homebrew",
  "scoop",
  "winget",
  "apt",
  "yum",
  "msi",
  "pkg",
]);

export interface ResolveChannelOptions {
  /** Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Defaults to `process.execPath`. */
  execPath?: string;
}

function fromEnv(env: Record<string, string | undefined>): DistributionChannel | null {
  const raw = env["NIMBUS_DISTRIBUTION_CHANNEL"];
  if (raw && KNOWN_CHANNELS.has(raw as DistributionChannel)) {
    return raw as DistributionChannel;
  }
  return null;
}

function fromPath(execPath: string): DistributionChannel | null {
  // Normalize backslashes so Windows + POSIX paths match the same substrings.
  const p = execPath.replace(/\\/g, "/").toLowerCase();
  // Homebrew: macOS `/opt/homebrew/Cellar/...` or `/usr/local/Cellar/...`,
  // Linuxbrew `/home/linuxbrew/.linuxbrew/...`.
  if (p.includes("/cellar/") || p.includes("/.linuxbrew/")) {
    return "homebrew";
  }
  // Scoop: `~/scoop/apps/<app>/...`.
  if (p.includes("/scoop/apps/")) {
    return "scoop";
  }
  return null;
}

/**
 * Resolve the distribution channel this binary was installed through, or `null`
 * for a plain/direct-download install (where the self-updater stays enabled).
 * An explicit `NIMBUS_DISTRIBUTION_CHANNEL` env marker takes precedence over
 * path heuristics; an unknown marker value is ignored.
 */
export function resolveDistributionChannel(
  opts: ResolveChannelOptions = {},
): DistributionChannel | null {
  const env = opts.env ?? process.env;
  const execPath = opts.execPath ?? process.execPath;
  return fromEnv(env) ?? fromPath(execPath);
}

/** Human-facing upgrade hint per channel, used by `nimbus update`. */
export function channelUpgradeHint(channel: DistributionChannel): string {
  switch (channel) {
    case "homebrew":
      return "Installed via Homebrew — run 'brew upgrade nimbus' to update.";
    case "scoop":
      return "Installed via Scoop — run 'scoop update nimbus' to update.";
    case "winget":
      return "Installed via winget — run 'winget upgrade nimbus' to update.";
    case "apt":
      return "Installed via apt — run 'sudo apt update && sudo apt upgrade nimbus' to update.";
    case "yum":
      return "Installed via dnf/yum — run 'sudo dnf upgrade nimbus' to update.";
    case "msi":
      return "Installed via the Windows installer — download the latest .msi from the releases page.";
    case "pkg":
      return "Installed via the macOS installer — download the latest .pkg from the releases page.";
  }
}
