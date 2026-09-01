import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * The terminal lane's SHELL REGISTRY — the exact counterpart of `exec/exec-runtimes.ts`'s
 * `ExecRuntime` registry, and for the same reason: a caller names an ID and the registry decides
 * what actually spawns. A caller-supplied argv would put the choice of interpreter, and every flag
 * it carries, in the hands of whoever composed the request.
 */
export class CuShellError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CuShellError";
  }
}

/**
 * How a shell's presence is probed. Injectable for the reason `chromium-path.ts` splits
 * `chromiumCandidates(platform, env)` out as a PURE function: the interesting branch here is
 * "present / absent", and on any given runner exactly one arm is reachable — `/bin/sh` always
 * exists on POSIX and never on Windows. Left un-injected, half of this file's branches could only
 * ever be covered by the OTHER platform's CI leg, which is precisely the blind spot
 * `audit:coverage-gate-pal` exists to flag.
 */
export type PathExists = (path: string) => boolean;

export interface CuShell {
  readonly id: string;
  /** Absolute path to the shell, or null when it is not present on this machine. */
  detect(exists?: PathExists): string | null;
  /** Every flag, in order, minus the executable. Spawned VERBATIM by `openTerminalLane`. */
  argv(): readonly string[];
  /**
   * Merged into `extensionProcessEnv()` at spawn (I1). Everything here exists to make the shell
   * NON-INTERACTIVE, HISTORY-FREE and RC-FILE-FREE — the shell must not read or write anything in
   * the owner's home directory, and must not execute a startup file the owner never approved.
   */
  envOverlay(): Readonly<Record<string, string>>;
}

/**
 * History and startup-file suppression, shared by every POSIX shell entry.
 *
 * `HISTFILE=""` + `HISTSIZE=0` is the "no history file" requirement of spec § 3.5, stated as a
 * property of the ENVIRONMENT rather than trusted to the shell happening to be non-interactive.
 * `ENV` and `BASH_ENV` are the two variables a NON-interactive POSIX shell will still source a
 * file from, so blanking them is what actually closes the startup-file path; leaving them would
 * let a file in the owner's home run code inside the lane on every session — code no owner ever
 * approved, in a lane whose entire premise is that nothing runs without approval.
 */
const POSIX_QUIET_ENV: Readonly<Record<string, string>> = {
  HISTFILE: "",
  HISTSIZE: "0",
  ENV: "",
  BASH_ENV: "",
  PROMPT_COMMAND: "",
};

/**
 * Where a POSIX shell is looked for, IN ORDER — and the order is load-bearing for a reason that
 * only a real sandbox reveals.
 *
 * `/usr/bin/sh` comes FIRST because the resolved path has to exist INSIDE the confinement, not
 * merely on the host. Linux's bwrap binds `/usr`, `/etc`, `/lib` and `/lib64` into the container
 * and does NOT bind `/bin`; on a usrmerge distribution `/bin` is a symlink to `/usr/bin` that the
 * container never recreates, so a shell resolved as `/bin/sh` exists for `existsSync` on the host
 * and then fails inside with `bwrap: execvp /bin/sh: No such file or directory`. Probing the host
 * is the only thing `detect()` can do; ordering the candidates is how that probe's answer is made
 * true on the other side of the boundary.
 *
 * `/bin/sh` stays as the fallback because macOS has no `/usr/bin/sh` at all, and its SBPL profile
 * grants `/bin` explicitly. Same candidate-list shape as `chromium-path.ts`, for a similar reason:
 * where an executable lives differs per platform, and the list is what keeps that knowledge in one
 * auditable place instead of a `process.platform` branch.
 */
const SH_CANDIDATES = ["/usr/bin/sh", "/bin/sh"] as const;

const SH_SHELL: CuShell = {
  id: "sh",
  detect: (exists = existsSync) => SH_CANDIDATES.find((p) => exists(p)) ?? null,
  // `-s` = read commands from standard input. Deliberately NOT `-i`: an interactive shell would
  // enable job control and history, which is exactly what this lane refuses to offer.
  argv: () => ["-s"],
  envOverlay: () => POSIX_QUIET_ENV,
};

const CMD_SHELL: CuShell = {
  id: "cmd",
  detect: (exists = existsSync) => {
    const p = join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "cmd.exe");
    return exists(p) ? p : null;
  },
  /**
   * `/Q` disables command echo. `/D` is the load-bearing one: it suppresses execution of the
   * `HKCU\Software\Microsoft\Command Processor\AutoRun` value, which otherwise runs an
   * owner-configured (or attacker-configured) command line at every shell start — inside the lane,
   * before anything the owner approved. `/K` keeps the shell alive to read further commands.
   */
  argv: () => ["/Q", "/D", "/K"],
  // `cmd.exe` has no history file and sources no startup script, so the POSIX overlay would be
  // inert noise here. An empty overlay is the honest answer for it.
  envOverlay: () => ({}),
};

const REGISTRY: ReadonlyMap<string, CuShell> = new Map([
  [SH_SHELL.id, SH_SHELL],
  [CMD_SHELL.id, CMD_SHELL],
]);

export const DEFAULT_SHELL_ID = process.platform === "win32" ? "cmd" : "sh";

/**
 * An unmapped id is REJECTED rather than defaulted to the platform's shell — the caller asked for
 * something specific, and quietly substituting a different interpreter changes what runs.
 */
export function resolveShellById(id: string): CuShell {
  const shell = REGISTRY.get(id.trim().toLowerCase());
  if (shell === undefined) {
    throw new CuShellError("ERR_CU_UNKNOWN_SHELL", `unknown shell: ${id}`);
  }
  return shell;
}

/**
 * Fail BEFORE consent when a registered shell is not installed. The owner must never be asked to
 * approve a session that could not have started. Mirrors `exec-runtimes.ts`'s `requireInstalled`.
 */
export function requireShellInstalled(shell: CuShell, exists?: PathExists): string {
  const bin = shell.detect(exists);
  if (bin === null) {
    throw new CuShellError(
      "ERR_CU_SHELL_NOT_INSTALLED",
      `shell "${shell.id}" is registered but not present on this machine`,
    );
  }
  return bin;
}
