import { type ChildProcess, type StdioOptions, spawn, spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import {
  forwarderPathRefusal,
  helperOverrideRefusal,
  innerResolvBind,
  openForwarderSession,
  type RootLookup,
  renderHostsFile,
  resolvConfTarget,
  resolveHelperPath,
  rootDirFlags,
  runForwarderStartProbe,
} from "./linux-forwarder.ts";
import { planForwardEntries } from "./net-forward-host.ts";
import { declaresNetwork, type SandboxPolicy } from "./sandbox-policy.ts";
import type { SandboxRunner, SandboxSpawnOptions } from "./sandbox-runner.ts";
import { buildDefaultSeccompFilter } from "./seccomp-filter.ts";

export type NetworkMode = "no-net" | "per-host" | "fallback";

interface HelperState {
  available: boolean;
  reason: string | null;
}

interface BuildArgvOpts {
  mode: NetworkMode;
  cwd: string;
  /**
   * From {@link resolverFileToBind}. Bound only in `fallback`, where the child resolves on the host's
   * network. In `per-host` the file a child reads is the generated one, so it never gets this.
   */
  resolverFile?: string | null;
  /** Overrides for {@link rootDirFlags}, for tests. */
  rootLookup?: RootLookup;
}

const HELPER_PATH = resolveHelperPath(process.execPath, process.env, existsSync);
/** Set when the operator named a helper that is not there: a refusal, never a fallback. */
const HELPER_OVERRIDE_REFUSAL = helperOverrideRefusal(process.env, existsSync);

// MUST log to STDERR: this module also runs inside sandbox-wrapper.ts, whose stdout IS the
// connector's MCP stdio channel — any stdout line corrupts the JSON-RPC stream and the client
// drops the connection (found by the chatops e2e: the "degraded mode" warn killed every spawn).
const log = pino(
  {
    name: "sandbox-linux",
    level: process.env["NIMBUS_LOG_LEVEL"] ?? "warn",
  },
  pino.destination(2),
);

export function decideNetworkMode(
  policy: SandboxPolicy,
  helper: { helperAvailable: boolean },
): NetworkMode {
  if (!declaresNetwork(policy)) return "no-net";
  return helper.helperAvailable ? "per-host" : "fallback";
}

/**
 * The file `/etc/resolv.conf` really is, when binding `/etc` alone would leave it dangling.
 *
 * On Ubuntu it is a symlink to `/run/systemd/resolve/stub-resolv.conf`, and `/run` is not bound, so
 * glibc found no resolver and every lookup failed. Only that one file is bound, not its directory,
 * which also holds systemd-resolved's control socket. Null when there is nothing to add: the target
 * is under a tree already bound, or the file cannot be resolved.
 */
export function resolverFileToBind(
  realpath: (path: string) => string = realpathSync,
): string | null {
  try {
    const target = realpath("/etc/resolv.conf");
    return target.startsWith("/etc/") || target.startsWith("/usr/") ? null : target;
  } catch {
    return null;
  }
}

export function buildBwrapArgv(policy: SandboxPolicy, opts: BuildArgvOpts): string[] {
  const argv: string[] = [
    "--unshare-pid",
    "--unshare-uts",
    "--unshare-ipc",
    "--unshare-user",
    "--new-session",
    "--die-with-parent",
    opts.mode === "no-net" ? "--unshare-net" : "--share-net",
    "--ro-bind",
    "/usr",
    "/usr",
    "--ro-bind",
    "/etc",
    "/etc",
    ...rootDirFlags(opts.rootLookup),
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    opts.cwd,
    opts.cwd,
    // Without it bwrap tries the PARENT's cwd, which is not bound inside, and falls back to
    // `$HOME` — so the child ran outside the directory it was given, unlike darwin and win32,
    // which both spawn into `opts.cwd`. The cwd is bound above at its own path, so this resolves.
    "--chdir",
    opts.cwd,
  ];
  if (opts.mode === "fallback" && opts.resolverFile !== undefined && opts.resolverFile !== null) {
    argv.push("--ro-bind", opts.resolverFile, opts.resolverFile);
  }
  for (const p of policy.permissions.filesystem.read) {
    argv.push("--ro-bind", p, p);
  }
  for (const p of policy.permissions.filesystem.write) {
    argv.push("--bind", p, p);
  }
  return argv;
}

/**
 * Where `bwrap` is looked for, and why it is not looked up on `PATH`.
 *
 * Distinct from the helper probe below: `bwrap` IS the confinement on Linux, while the helper only
 * adds per-host network filtering — so a missing helper degrades one feature, while a missing or
 * substituted `bwrap` means no confinement at all.
 *
 * Both the probe and the real spawn use the SAME resolved absolute path, and it is resolved once at
 * construction. That gives three things: `canConfine` can answer BEFORE the owner is asked to
 * approve (without it a no-network policy reported "confinable", the owner approved, and only then
 * did the spawn fail); nothing can substitute the sandbox binary by prepending a writable directory
 * to `PATH`; and the binary that was checked is the binary that runs.
 *
 * The candidates are fixed, non-writable locations, plus an explicit override for unusual prefixes
 * (Nix, a source build, a container image) — deliberately not a `PATH` scan, which would put the
 * choice back in the hands of whatever can write to a directory on it.
 */
const BWRAP_CANDIDATES = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"] as const;

function resolveBwrapPath(): string | null {
  const override = process.env["NIMBUS_BWRAP_PATH"];
  if (override !== undefined && override !== "") {
    return existsSync(override) ? override : null;
  }
  return BWRAP_CANDIDATES.find((p) => existsSync(p)) ?? null;
}

const BWRAP_START_PROBE_TIMEOUT_MS = 5000;

/**
 * The namespaces every spawn asks for. `--version` passes on a machine where bwrap cannot create
 * them: Ubuntu 23.10 and later deny it through `kernel.apparmor_restrict_unprivileged_userns`
 * unless an AppArmor profile allows it, and then `canConfine` said yes, the owner approved, and
 * only the spawn failed.
 */
const BWRAP_START_PROBE_ARGV = [
  "--unshare-user",
  "--unshare-net",
  "--new-session",
  "--ro-bind",
  "/usr",
  "/usr",
  "--ro-bind",
  "/lib",
  "/lib",
  "--ro-bind-try",
  "/lib64",
  "/lib64",
  "--proc",
  "/proc",
  "--dev",
  "/dev",
  "/usr/bin/true",
] as const;

export function probeBwrap(
  bwrapPath: string | null,
  run: typeof spawnSync = spawnSync,
): string | null {
  if (bwrapPath === null) {
    return `bwrap not found at ${BWRAP_CANDIDATES.join(", ")} (set NIMBUS_BWRAP_PATH to override)`;
  }
  // Absolute path, no shell: nothing to inject into and nothing for PATH to redirect.
  // windows-console-ok: `sandbox/linux.ts` runs only on Linux, where the flag is ignored.
  const version = run(bwrapPath, ["--version"], { encoding: "utf8" });
  if (version.error !== undefined || version.status !== 0) {
    return `bwrap at ${bwrapPath} is not executable`;
  }
  // windows-console-ok: Linux-only module.
  const start = run(bwrapPath, [...BWRAP_START_PROBE_ARGV], {
    encoding: "utf8",
    timeout: BWRAP_START_PROBE_TIMEOUT_MS,
  });
  if (start.error === undefined && start.status === 0) return null;
  const stderr = String(start.stderr ?? "").trim();
  const why = stderr === "" ? (start.error?.message ?? `exit ${String(start.status)}`) : stderr;
  return `bwrap at ${bwrapPath} cannot start a sandbox: ${why} (run \`nimbus doctor\` for the fix)`;
}

const HELPER_CHECK_TIMEOUT_MS = 5000;

function probeHelper(): HelperState {
  if (HELPER_OVERRIDE_REFUSAL !== null)
    return { available: false, reason: HELPER_OVERRIDE_REFUSAL };
  if (HELPER_PATH === null) {
    return {
      available: false,
      reason:
        "nimbus-sandbox-helper not found (set NIMBUS_SANDBOX_HELPER_PATH, or install it beside the gateway or at /usr/lib/nimbus/bin)",
    };
  }
  try {
    // windows-console-ok: Linux-only module.
    const result = spawnSync(HELPER_PATH, ["--check"], {
      encoding: "utf8",
      timeout: HELPER_CHECK_TIMEOUT_MS,
    });
    if (result.status === 0 && result.stdout.trim() === "OK") {
      return { available: true, reason: null };
    }
    const stderr = (result.stderr ?? "").trim();
    const said = stderr === "" ? (result.error?.message ?? "<no stderr>") : stderr;
    return { available: false, reason: `nimbus-sandbox-helper --check failed: ${said}` };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      available: false,
      reason: `nimbus-sandbox-helper probe failed: ${msg}`,
    };
  }
}

function buildStdioWithSeccomp(
  callerStdio: SandboxSpawnOptions["stdio"],
  fd: number,
): StdioOptions {
  if (Array.isArray(callerStdio)) {
    const base: unknown[] = callerStdio.slice(0, 3);
    while (base.length < 3) base.push("pipe");
    return [base[0], base[1], base[2], fd] as StdioOptions;
  }
  if (typeof callerStdio === "string") {
    return [callerStdio, callerStdio, callerStdio, fd] as StdioOptions;
  }
  return ["pipe", "pipe", "pipe", fd] as StdioOptions;
}

/** The inner `bwrap`'s flags behind the forwarder: today's flags, as the owner's real uid. */
export function buildForwarderInnerFlags(policy: SandboxPolicy, cwd: string): string[] {
  return [
    "--uid",
    String(process.getuid?.() ?? 0),
    "--gid",
    String(process.getgid?.() ?? 0),
    // Otherwise the child's bounding set keeps what the launcher held. With every other set at 0
    // and no-new-privileges that grants nothing, but nothing needs it there either.
    "--cap-drop",
    "ALL",
    ...buildBwrapArgv(policy, { mode: "per-host", cwd }),
  ];
}

function wildcardRefusal(policy: SandboxPolicy): string | null {
  const hasWildcards = (policy.firstPartyWildcardHosts?.length ?? 0) > 0;
  return hasWildcards && policy.firstPartyPolicy !== true
    ? "a policy with wildcard hosts must be a first-party policy"
    : null;
}

/** Why this network policy cannot run behind the forwarder whatever the machine can do, or null. */
function forwarderPolicyRefusal(policy: SandboxPolicy): string | null {
  try {
    // The same two steps a spawn takes, so this cannot pass what the spawn refuses.
    renderHostsFile(planForwardEntries(policy));
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return forwarderPathRefusal(policy);
}

function spawnWithSeccomp(
  seccompPath: string,
  command: string,
  args: string[],
  opts: SandboxSpawnOptions,
): ChildProcess {
  const seccompFd = openSync(seccompPath, "r");
  try {
    const stdio = buildStdioWithSeccomp(opts.stdio, seccompFd);
    // windows-console-ok: Linux-only module.
    return spawn(command, args, { env: opts.env, stdio });
  } finally {
    try {
      closeSync(seccompFd);
    } catch {
      /* ignore */
    }
  }
}

type ForwarderSpawn = { bwrapPath: string; helperPath: string; seccompPath: string };

/** The per-host path. Any step that throws refuses the spawn, and leaves nothing behind. */
function spawnBehindForwarder(
  paths: ForwarderSpawn,
  cmd: string,
  args: string[],
  opts: SandboxSpawnOptions,
): ChildProcess {
  const target = resolvConfTarget();
  const session = openForwarderSession({
    policy: opts.policy,
    cwd: opts.cwd,
    helperPath: paths.helperPath,
    entries: planForwardEntries(opts.policy),
    resolvConfTarget: target,
    innerArgv: [
      paths.bwrapPath,
      ...buildForwarderInnerFlags(opts.policy, opts.cwd),
      ...innerResolvBind(target),
      "--seccomp",
      "3",
      cmd,
      ...args,
    ],
  });
  try {
    const child = spawnWithSeccomp(paths.seccompPath, paths.bwrapPath, session.argv, opts);
    child.once("exit", session.close);
    child.once("error", session.close);
    return child;
  } catch (e) {
    session.close();
    throw e;
  }
}

let sharedSeccompPath: string | null = null;

/**
 * One file per process: the program never changes, so a runner per caller gains nothing, and each
 * left a `nimbus-sandbox-*` directory behind for good. Goes when the process does, on the same paths
 * as the forwarder's directory: `process.exit`, which the wrapper's signal handlers call too.
 */
function seccompFile(): string {
  if (sharedSeccompPath !== null) return sharedSeccompPath;
  const dir = mkdtempSync(join(tmpdir(), "nimbus-sandbox-"));
  const path = join(dir, "seccomp.bpf");
  writeFileSync(path, buildDefaultSeccompFilter(), { mode: 0o600 });
  process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  sharedSeccompPath = path;
  return path;
}

export type LinuxSandboxRunnerOptions = {
  /** Overrides the start probe's bound, for tests. */
  startProbeTimeoutMs?: number;
};

export type LinuxSandboxRunner = SandboxRunner & {
  /**
   * The forwarder's one real start. Until it has run, a network policy is refused by `canConfine`,
   * since no check has shown this machine can start one. Runs once however often it is called,
   * except that a start that merely timed out is asked again, see `reprobeAfterTimeout`.
   */
  probeForwarderStart(): Promise<void>;
};

const START_PROBE_NOT_RUN = "the network forwarder's start probe has not run";

export function createLinuxSandboxRunner(
  options: LinuxSandboxRunnerOptions = {},
): LinuxSandboxRunner {
  const seccompPath = seccompFile();

  const bwrapPath = resolveBwrapPath();
  const bwrapMissing = probeBwrap(bwrapPath);
  const helper = probeHelper();
  if (!helper.available) {
    log.warn({ helper: helper.reason }, "sandbox: degraded mode (no per-host network gating)");
  }

  let startFailure: string | null = START_PROBE_NOT_RUN;
  let startTimedOut = false;
  let probing: Promise<void> | null = null;

  /** One at a time, each bounded by the probe's own timeout. */
  const startProbe = (): Promise<void> => {
    if (bwrapPath === null || HELPER_PATH === null || !helper.available) return Promise.resolve();
    const helperPath = HELPER_PATH;
    probing ??= runForwarderStartProbe({
      bwrapPath,
      helperPath,
      seccompPath,
      buildInnerFlags: buildForwarderInnerFlags,
      ...(options.startProbeTimeoutMs === undefined
        ? {}
        : { timeoutMs: options.startProbeTimeoutMs }),
    }).then((result) => {
      startFailure =
        result.failure === null
          ? null
          : `the network forwarder cannot start here: ${result.failure}`;
      startTimedOut = result.timedOut;
      probing = null;
    });
    return probing;
  };

  /**
   * A timeout says the machine was busy, not that it cannot do this, so it is not kept: whoever asks
   * still gets the refusal, and starts another try in the background for the next one to read.
   */
  const reprobeAfterTimeout = (): void => {
    if (startTimedOut) void startProbe();
  };

  return {
    platform: "linux",
    spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess {
      // Fail closed rather than falling back to a bare `"bwrap"`, which would reintroduce the PATH
      // lookup this resolution exists to remove -- and would spawn UNCONFINED-ish through whatever
      // PATH found, at the one point where being wrong means no sandbox. The exec gate never gets
      // here (canConfine refuses first); a connector spawn can, and should stop too.
      if (bwrapPath === null) {
        throw new Error(`refusing to spawn: ${bwrapMissing ?? "bwrap unavailable"}`);
      }
      const refusal = wildcardRefusal(opts.policy);
      if (refusal !== null) throw new Error(`refusing to spawn: ${refusal}`);
      // Only a helper that is not there at all takes the documented fallback. One that is there and
      // fails its check, or a start the probe saw fail, refuses: it never reaches the host network.
      const mode = decideNetworkMode(opts.policy, { helperAvailable: HELPER_PATH !== null });
      // A helper the operator named that is not there is not "no helper": the fallback would hand
      // the child the whole network, which is what asking for a specific helper was meant to stop.
      if (mode !== "no-net" && HELPER_OVERRIDE_REFUSAL !== null) {
        throw new Error(`refusing to spawn: ${HELPER_OVERRIDE_REFUSAL}`);
      }
      if (mode === "per-host" && HELPER_PATH !== null) {
        reprobeAfterTimeout();
        const failure =
          helper.reason ?? (startFailure === START_PROBE_NOT_RUN ? null : startFailure);
        if (failure !== null) throw new Error(`refusing to spawn: ${failure}`);
        return spawnBehindForwarder(
          { bwrapPath, helperPath: HELPER_PATH, seccompPath },
          cmd,
          args,
          opts,
        );
      }
      const bwrapArgv = buildBwrapArgv(opts.policy, {
        mode,
        cwd: opts.cwd,
        resolverFile: resolverFileToBind(),
      });
      bwrapArgv.push("--seccomp", "3", cmd, ...args);
      return spawnWithSeccomp(seccompPath, bwrapPath, bwrapArgv, opts);
    },
    probeForwarderStart(): Promise<void> {
      return startFailure === START_PROBE_NOT_RUN || startTimedOut
        ? startProbe()
        : Promise.resolve();
    },
    isFullyActive(): boolean {
      reprobeAfterTimeout();
      return helper.available && startFailure === null;
    },
    networkRefused(): boolean {
      return (
        bwrapPath === null ||
        HELPER_OVERRIDE_REFUSAL !== null ||
        (HELPER_PATH !== null && !this.isFullyActive())
      );
    },
    degradedReason(): string | null {
      return bwrapMissing ?? helper.reason ?? startFailure;
    },
    canConfine(policy): string | null {
      // bwrap first: without it NOTHING is confinable here, network-bearing or not.
      if (bwrapMissing !== null) return bwrapMissing;
      // The helper is needed ONLY for per-host network filtering. With no declared network the
      // runner passes `--unshare-net`, giving the child its own network namespace — no helper
      // involved — while bwrap's filesystem binds and the seccomp filter apply regardless. So a
      // no-network policy is fully confined on a box with no helper at all, which is the common
      // case: CI installs bubblewrap, not the helper.
      if (!declaresNetwork(policy)) return null;
      const refusal = wildcardRefusal(policy);
      if (refusal !== null) return refusal;
      if (!helper.available) return helper.reason;
      reprobeAfterTimeout();
      return forwarderPolicyRefusal(policy) ?? startFailure;
    },
  };
}
