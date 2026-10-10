export type PlatformTarget = "darwin-x86_64" | "darwin-aarch64" | "linux-x86_64" | "windows-x86_64";

export interface PlatformAsset {
  url: string;
  sha256: string;
  signature: string;
}

export interface UpdateManifest {
  version: string;
  pub_date: string;
  notes?: string;
  platforms: Record<PlatformTarget, PlatformAsset>;
}

export type UpdaterStateName =
  | "idle"
  | "checking"
  | "downloading"
  | "verifying"
  | "applying"
  | "rolled_back"
  | "failed";

/** The cached result of the most recent SUCCESSFUL `checkNow` (a failed check keeps it). */
export interface UpdaterLastCheck {
  latestVersion: string;
  updateAvailable: boolean;
  notes?: string;
  checkedAt: string;
}

export interface UpdaterStatus {
  state: UpdaterStateName;
  currentVersion: string;
  configUrl: string;
  lastCheckAt?: string;
  lastError?: string;
  lastCheck?: UpdaterLastCheck;
}
