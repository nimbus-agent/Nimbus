/**
 * Linux SandboxRunner (T2 PR 1).
 *
 * Wraps every extension/connector spawn in:
 *   1. `bwrap` (bubblewrap) — unshares pid/uts/ipc/user namespaces, mounts a
 *      read-only root, bind-mounts the cwd writable, and applies the default
 *      seccomp BPF filter (`seccomp-filter.ts`).
 *   2. `nimbus-sandbox-helper` (with CAP_NET_ADMIN) when the manifest declares
 *      non-empty `permissions.network` — opens per-host iptables rules in a
 *      new net namespace before exec'ing into bwrap.
 *
 * Modes (decided per spawn from manifest + helper-probe outcome):
 *   - `no-net`   — `permissions.network` is empty → `--unshare-net` (full
 *                   network namespace isolation, no traffic at all).
 *   - `per-host` — `permissions.network` non-empty AND helper available with
 *                   CAP_NET_ADMIN → route through helper; `--share-net`
 *                   inside bwrap, but the helper has already restricted the
 *                   host net namespace to the declared hosts.
 *   - `fallback` — `permissions.network` non-empty AND helper unavailable →
 *                   `--share-net` with no per-host gate. The runner is
 *                   reported as degraded; `isFullyActive()` returns `false`
 *                   and `degradedReason()` names the missing capability.
 *
 * The seccomp BPF filter is materialised once per runner instance to a
 * tmpfile under `os.tmpdir()`, then opened fresh per spawn as fd 3 (bwrap
 * reads `--seccomp <fd>` from the fd it inherits from the parent).
 */

import { type ChildProcess, type StdioOptions, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
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
}

const HELPER_PATH =
  process.env["NIMBUS_SANDBOX_HELPER_PATH"] ?? "/usr/lib/nimbus/bin/nimbus-sandbox-helper";

const log = pino({
  name: "sandbox-linux",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "warn",
});

/**
 * Decide which network mode to use for a given manifest, given whether the
 * helper binary is present and capability-bearing. Pure — exported for the
 * unit-test surface.
 */
export function decideNetworkMode(
  manifest: ExtensionManifest,
  helper: { helperAvailable: boolean },
): NetworkMode {
  const hosts = manifest.permissions.network;
  if (hosts.length === 0) return "no-net";
  return helper.helperAvailable ? "per-host" : "fallback";
}

/**
 * Build the bwrap argv (without the trailing `cmd args...` and without the
 * `--seccomp <fd>` pair — those are appended by the spawn path because the
 * fd is allocated per spawn). Pure — exported for the unit-test surface.
 */
export function buildBwrapArgv(manifest: ExtensionManifest, opts: BuildArgvOpts): string[] {
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
    "--ro-bind",
    "/lib",
    "/lib",
    "--proc",
    "/proc",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--bind",
    opts.cwd,
    opts.cwd,
  ];
  if (existsSync("/lib64")) {
    argv.push("--ro-bind", "/lib64", "/lib64");
  }
  for (const p of manifest.permissions.filesystem.read) {
    argv.push("--ro-bind", p, p);
  }
  for (const p of manifest.permissions.filesystem.write) {
    argv.push("--bind", p, p);
  }
  return argv;
}

function probeHelper(): HelperState {
  if (!existsSync(HELPER_PATH)) {
    return {
      available: false,
      reason: `nimbus-sandbox-helper not found at ${HELPER_PATH}`,
    };
  }
  try {
    const result = spawnSync(HELPER_PATH, ["--check-caps"], { encoding: "utf8" });
    if (result.status === 0 && result.stdout.trim() === "OK") {
      return { available: true, reason: null };
    }
    const stderr = (result.stderr ?? "").trim();
    return {
      available: false,
      reason: `nimbus-sandbox-helper lacks CAP_NET_ADMIN: ${stderr === "" ? "<no stderr>" : stderr}`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      available: false,
      reason: `nimbus-sandbox-helper probe failed: ${msg}`,
    };
  }
}

/**
 * Build a stdio array that preserves the caller-supplied stdin/stdout/stderr
 * settings and appends the seccomp fd at index 3 so bwrap can read it via
 * `--seccomp 3`. Defaults to `"pipe"` for the first three streams when the
 * caller did not provide a stdio array.
 */
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

export function createLinuxSandboxRunner(): SandboxRunner {
  const seccompProgram = buildDefaultSeccompFilter();
  // mkdtempSync atomically creates a uniquely-named directory with mode 0700
  // (owner-only). Writing the seccomp BPF inside that directory blocks the
  // standard /tmp symlink-race attack — an attacker cannot pre-create the
  // path (the random suffix is unpredictable) and cannot read or replace the
  // file (parent dir is owner-read-only). writeFileSync also pins the file
  // mode to 0600 so even a same-uid second process must open with our uid's
  // own permissions to swap the BPF program before bwrap reads fd 3.
  const seccompDir = mkdtempSync(join(tmpdir(), "nimbus-sandbox-"));
  const seccompPath = join(seccompDir, "seccomp.bpf");
  writeFileSync(seccompPath, seccompProgram, { mode: 0o600 });

  const helper = probeHelper();
  if (!helper.available) {
    log.warn({ helper: helper.reason }, "sandbox: degraded mode (no per-host network gating)");
  }

  return {
    platform: "linux",
    spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess {
      const mode = decideNetworkMode(opts.manifest, { helperAvailable: helper.available });
      const bwrapArgv = buildBwrapArgv(opts.manifest, { mode, cwd: opts.cwd });
      // The seccomp BPF lives on disk; bwrap reads it from fd 3, which we
      // open per-spawn and place at stdio[3] below.
      bwrapArgv.push("--seccomp", "3");
      bwrapArgv.push(cmd, ...args);

      let spawnCmd: string;
      let spawnArgs: string[];

      if (mode === "per-host") {
        // nimbus-sandbox-helper --allow <h1> --allow <h2> -- bwrap <bwrap argv>
        const helperArgs: string[] = [];
        for (const host of opts.manifest.permissions.network) {
          helperArgs.push("--allow", host);
        }
        helperArgs.push("--", "bwrap", ...bwrapArgv);
        spawnCmd = HELPER_PATH;
        spawnArgs = helperArgs;
      } else {
        spawnCmd = "bwrap";
        spawnArgs = bwrapArgv;
      }

      // Open the seccomp file fresh per spawn. The child closes its copy
      // when bwrap is done parsing it; we close ours immediately after
      // spawn() returns because Node has already inherited it into the
      // child via the stdio[3] entry.
      const seccompFd = openSync(seccompPath, "r");
      try {
        const stdio = buildStdioWithSeccomp(opts.stdio, seccompFd);
        return spawn(spawnCmd, spawnArgs, {
          env: opts.env,
          stdio,
        });
      } finally {
        // Best-effort close in the parent — the fd has been duplicated into
        // the child by Node's spawn machinery.
        try {
          closeSync(seccompFd);
        } catch {
          /* ignore */
        }
      }
    },
    isFullyActive(): boolean {
      return helper.available;
    },
    degradedReason(): string | null {
      return helper.reason;
    },
  };
}
