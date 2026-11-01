import type { ChildProcess, SpawnOptions } from "node:child_process";
import { platform } from "node:os";
import type { SandboxPolicy } from "./sandbox-policy.ts";

export interface SandboxSpawnOptions {
  policy: SandboxPolicy;
  env: Record<string, string>;
  cwd: string;
  stdio?: SpawnOptions["stdio"];
  /**
   * Release this spawn's host-side grants when the child exits. Windows only; Linux and macOS leave
   * no host state behind (bwrap binds and SBPL profiles live and die with the process).
   *
   * Set it ONLY for a policy id that is new on every run — `exec-<id>`, `cu-terminal-<id>` — and
   * never for one that concurrent spawns can share (an extension id, `toolgen.<toolId>`). The
   * AppContainer SID is derived from the id, and the release removes EVERY explicit ACE that SID
   * holds, so releasing a shared id would strip a still-running sibling's read access to the
   * runtime it is executing from.
   */
  releaseGrantsOnExit?: boolean;
}

export interface SandboxRunner {
  readonly platform: "linux" | "darwin" | "win32";
  spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess;
  isFullyActive(): boolean;
  degradedReason(): string | null;
  /**
   * True when a network-declaring spawn is refused here, rather than let through unfiltered: Linux
   * with a helper present whose real start failed, or with no `bwrap`. Absent means it never is.
   */
  networkRefused?(): boolean;
  /**
   * How far a fully active runner limits a declared network, when that is less than per host: macOS
   * filters by port and cannot name a host; Windows's `internetClient` opens the whole network or
   * none of it. Absent means it filters per host when fully active.
   */
  networkScope?(): "per_port" | "all_or_nothing";
  /**
   * Can this runner enforce THIS policy in full? `null` if yes; otherwise the reason it cannot,
   * named precisely enough to act on.
   *
   * Distinct from {@link isFullyActive}, which asks a policy-independent question: "is every
   * mechanism this platform offers available?" That is the right question for a startup banner and
   * the wrong one for admitting a specific execution. On Linux the two diverge sharply — the
   * `nimbus-sandbox-helper` exists ONLY for per-host network filtering, so a
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

export type CreateSandboxRunnerOptions = {
  /**
   * Linux: run the network forwarder's one real start before returning, so `canConfine` and
   * `isFullyActive` can answer for a network policy. It awaits a child without blocking the event
   * loop, costs one nested `bwrap` start when a helper is present, and nothing otherwise. The
   * `__nimbus-sandbox` wrapper turns it off: it only spawns, and that spawn is itself a real start
   * that refuses if it fails, so a probe would add one extra start to every connector.
   */
  forwarderStartProbe?: boolean;
};

export async function createSandboxRunner(
  opts: CreateSandboxRunnerOptions = {},
): Promise<SandboxRunner> {
  const p = platform();
  switch (p) {
    case "linux": {
      const runner = (await import("./linux.ts")).createLinuxSandboxRunner();
      if (opts.forwarderStartProbe !== false) await runner.probeForwarderStart();
      return runner;
    }
    case "darwin":
      return (await import("./darwin.ts")).createDarwinSandboxRunner();
    case "win32":
      return (await import("./win32.ts")).createWin32SandboxRunner();
    default:
      throw new Error(`Unsupported platform for sandbox: ${p}`);
  }
}
