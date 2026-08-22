import type { ChildProcess, SpawnOptions } from "node:child_process";
import { platform } from "node:os";
import type { SandboxPolicy } from "./sandbox-policy.ts";

export interface SandboxSpawnOptions {
  policy: SandboxPolicy;
  env: Record<string, string>;
  cwd: string;
  stdio?: SpawnOptions["stdio"];
}

export interface SandboxRunner {
  readonly platform: "linux" | "darwin" | "win32";
  spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess;
  isFullyActive(): boolean;
  degradedReason(): string | null;
  /**
   * Can this runner enforce THIS policy in full? `null` if yes; otherwise the reason it cannot,
   * named precisely enough to act on.
   *
   * Distinct from {@link isFullyActive}, which asks a policy-independent question: "is every
   * mechanism this platform offers available?" That is the right question for a startup banner and
   * the wrong one for admitting a specific execution. On Linux the two diverge sharply — the
   * `nimbus-sandbox-helper` exists ONLY for per-host network filtering (`CAP_NET_ADMIN`), so a
   * policy with an empty network set is confined completely without it by `--unshare-net` plus
   * bwrap's filesystem binds and seccomp. Gating such a policy on `isFullyActive()` would refuse
   * every execution on any Linux box lacking a helper the policy never uses — including CI, which
   * installs bubblewrap but not the helper.
   *
   * Each platform answers for its own mechanism, so this knowledge stays in the PAL rather than
   * leaking a `process.platform` branch into a gate.
   */
  canConfine(policy: SandboxPolicy): string | null;
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
