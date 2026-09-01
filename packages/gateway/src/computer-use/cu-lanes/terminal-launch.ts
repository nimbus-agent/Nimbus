import { isAbsolute } from "node:path";
import type { SandboxRunner } from "../../platform/sandbox/sandbox-runner.ts";
import type { CuTerminalLaunchPolicy } from "../cu-types.ts";
import type { CuShell } from "./terminal-shells.ts";

export class CuLaunchPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CuLaunchPolicyError";
  }
}

/**
 * The single grants-to-policy derivation for a terminal lane (spec § 3.5 / § 6.2; invariant I35).
 *
 * `permissions.network` is empty BY CONSTRUCTION, not by a caller remembering to omit it, and a
 * caller that asks for network is refused OUTRIGHT rather than having the request dropped. That
 * distinction is the whole of § 6.2's zero-egress claim: dropping would let a caller believe it had
 * been granted something, and would make "this lane adds no egress class" a convention instead of a
 * property. Relaxing this without landing an appender first is a named I35 anti-pattern.
 *
 * An empty network set is what drives `--unshare-net` on Linux, the absent `(allow network*)` block
 * on macOS, and the withheld `internetClient` capability on Windows — and therefore what makes "no
 * network" include LOOPBACK, which is the half that matters: the interesting target is not the
 * internet but the gateway's own IPC socket and 127.0.0.1 HTTP API.
 *
 * `cwd` is the ONLY filesystem grant. That is not a minimalism flourish, it is measured: every
 * platform already admits ENOUGH of its own system tree for a shell to run — Linux bwrap binds
 * /usr, /etc, /lib and /lib64 but NOT /bin, which is exactly why `SH_CANDIDATES` prefers
 * /usr/bin/sh; macOS's SBPL profile grants /bin, /usr/bin, /usr/lib and /System; and Windows
 * AppContainer carries default ALL APPLICATION PACKAGES access. And on Windows granting %SystemRoot%
 * additionally FAILS — the helper writes an ACE per granted path and `SetNamedSecurityInfoW` on it
 * returns 5. So a system-tree grant is unnecessary on two platforms and fatal on the third.
 */
export function buildTerminalLaunchPolicy(opts: {
  readonly sessionId: string;
  readonly shell: CuShell;
  readonly shellPath: string;
  readonly cwd: string;
  /** Present ONLY so a request for network can be REJECTED rather than ignored. */
  readonly network?: readonly string[];
}): CuTerminalLaunchPolicy {
  if (opts.network !== undefined && opts.network.length > 0) {
    throw new CuLaunchPolicyError(
      "ERR_CU_TERMINAL_NETWORK_UNSUPPORTED",
      "network access is not available to the computer-use terminal lane",
    );
  }
  if (!isAbsolute(opts.cwd)) {
    // Deliberately NOT resolved here. The gateway's cwd is not the caller's, so resolving would
    // grant a real directory that is not the one the caller named -- wrong, and invisible from this
    // side. Same reasoning as `exec-policy.ts`'s `requireAbsolute`.
    throw new CuLaunchPolicyError(
      "ERR_CU_TERMINAL_RELATIVE_CWD",
      `the terminal lane's working directory must be an absolute path: ${opts.cwd}`,
    );
  }
  if (!isAbsolute(opts.shellPath)) {
    // A bare name would be resolved through PATH at spawn time, putting the choice of interpreter
    // in the hands of whatever can write to a directory on it.
    throw new CuLaunchPolicyError(
      "ERR_CU_TERMINAL_RELATIVE_SHELL",
      `the shell path must be absolute: ${opts.shellPath}`,
    );
  }
  return {
    shellId: opts.shell.id,
    shellPath: opts.shellPath,
    // Copied: a caller that mutates its own array afterwards must not be able to change the argv
    // the owner's session spawns with.
    argv: [...opts.shell.argv()],
    cwd: opts.cwd,
    envOverlay: { ...opts.shell.envOverlay() },
    policy: {
      id: `cu-terminal-${opts.sessionId}`,
      permissions: {
        network: [],
        filesystem: { read: [opts.cwd], write: [opts.cwd] },
      },
    },
  };
}

/**
 * The pre-consent confinement assertion (spec § 3.3 step 4; invariant I35).
 *
 * `canConfine(policy)` and NEVER `degradedReason()` or `isFullyActive()`, for the reasons I33
 * records: `degradedReason() === null` is wrong on Windows, where it is non-null even when the
 * runner is fully active, and `isFullyActive()` is wrong on Linux, where it reports a helper used
 * solely for per-host network filtering that a no-network policy never touches and that CI does not
 * install.
 *
 * Unlike the browser lane — which cannot route through `SandboxRunner` at all, because no PAL
 * runner can carry a CDP control channel — this assertion is REAL here: the policy handed to
 * `canConfine` is the very object `openTerminalLane` spawns with. `ERR_CU_SANDBOX_DEGRADED`,
 * removed from the CLI's refusal map when the browser lane dropped its placeholder assertion,
 * becomes reachable again with this lane.
 */
export function assertTerminalLaunchable(
  runner: SandboxRunner,
): (p: CuTerminalLaunchPolicy) => string | null {
  return (p) => runner.canConfine(p.policy);
}
