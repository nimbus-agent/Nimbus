import type { ChildProcess, SpawnOptions } from "node:child_process";
import { platform } from "node:os";
import type { ExtensionManifest } from "../../extensions/manifest.ts";

export interface SandboxSpawnOptions {
  /** Resolved manifest of the extension being spawned. Must carry an object-form `permissions`. */
  manifest: ExtensionManifest;
  /** Output of `extensionProcessEnv(...)` — inner env builder (I1). */
  env: Record<string, string>;
  /** Extension's working directory. Always FS-accessible inside the sandbox. */
  cwd: string;
  stdio?: SpawnOptions["stdio"];
}

export interface SandboxRunner {
  readonly platform: "linux" | "darwin" | "win32";
  spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess;
  /**
   * True iff the full sandbox is active. False on Windows when
   * `permissions.network` is non-empty (no per-host enforcement),
   * or on Linux when the helper binary is missing or lacks
   * `CAP_NET_ADMIN`. Reported in `nimbus diag --json`.
   */
  isFullyActive(): boolean;
  /** Reason for degraded posture, or `null` when fully active. */
  degradedReason(): string | null;
}

export async function createSandboxRunner(): Promise<SandboxRunner> {
  const p = platform();
  switch (p) {
    case "linux":
      return (await import("./linux.ts")).createLinuxSandboxRunner();
    case "darwin":
      return (await import("./darwin.ts")).createDarwinSandboxRunner();
    case "win32":
      return (await import("./win32.ts")).createWin32SandboxRunner();
    default:
      throw new Error(`Unsupported platform for sandbox: ${p}`);
  }
}
