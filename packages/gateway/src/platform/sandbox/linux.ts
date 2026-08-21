import { type ChildProcess, type StdioOptions, spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdtempSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import type { SandboxPolicy } from "./sandbox-policy.ts";
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
  const hosts = policy.permissions.network;
  if (hosts.length === 0) return "no-net";
  return helper.helperAvailable ? "per-host" : "fallback";
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
  for (const p of policy.permissions.filesystem.read) {
    argv.push("--ro-bind", p, p);
  }
  for (const p of policy.permissions.filesystem.write) {
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
      const mode = decideNetworkMode(opts.policy, { helperAvailable: helper.available });
      const bwrapArgv = buildBwrapArgv(opts.policy, { mode, cwd: opts.cwd });
      bwrapArgv.push("--seccomp", "3", cmd, ...args);

      let spawnCmd: string;
      let spawnArgs: string[];

      if (mode === "per-host") {
        const helperArgs: string[] = [];
        for (const host of opts.policy.permissions.network) {
          helperArgs.push("--allow", host);
        }
        helperArgs.push("--", "bwrap", ...bwrapArgv);
        spawnCmd = HELPER_PATH;
        spawnArgs = helperArgs;
      } else {
        spawnCmd = "bwrap";
        spawnArgs = bwrapArgv;
      }

      const seccompFd = openSync(seccompPath, "r");
      try {
        const stdio = buildStdioWithSeccomp(opts.stdio, seccompFd);
        return spawn(spawnCmd, spawnArgs, {
          env: opts.env,
          stdio,
        });
      } finally {
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
