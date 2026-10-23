import { type ChildProcess, type SpawnOptions, spawn } from "node:child_process";
import { closeSync, fstatSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";
import { resolveCliActiveProfileWithSource } from "./active-profile.ts";
import { type GatewayLaunchPlan, resolveGatewayLaunch } from "./resolve-gateway-launch.ts";

function gatewayLogBasename(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `gateway-${String(y)}-${m}-${day}.log`;
}

const BUN_INSPECTOR_ENV_KEYS: readonly string[] = [
  "BUN_INSPECT",
  "BUN_INSPECT_BRK",
  "BUN_INSPECT_NOTIFY",
  "BUN_INSPECT_PRELOAD",
  "BUN_INSPECT_CONNECT_TO",
  "BUN_INSPECT_DISABLE",
  "NODE_INSPECT_RESUME_ON_START",
  "NODE_OPTIONS",
];

export function stripInspectorEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env };
  for (const k of BUN_INSPECTOR_ENV_KEYS) {
    delete out[k];
  }
  return out;
}

export type SpawnGatewayOptions = {
  readonly extraEnv?: Readonly<Record<string, string>>;
};

type SpawnedGateway = { pid: number; logPath: string; logStartOffset: number };

/**
 * The outside world `spawnGateway` reaches, injectable for its tests alone — production callers
 * pass nothing and get the real launch resolver, `node:child_process`'s `spawn` and the host
 * platform. A real spawn cannot show a test the env, stdio and flags the child was given, cannot
 * be made to report no pid on demand, and takes only the host's side of the `win32` branch.
 */
export type SpawnGatewayDeps = {
  readonly resolveLaunch: () => GatewayLaunchPlan;
  readonly spawn: (
    command: string,
    args: readonly string[],
    options: SpawnOptions,
  ) => Pick<ChildProcess, "pid" | "unref">;
  readonly platform: NodeJS.Platform;
};

const DEFAULT_SPAWN_GATEWAY_DEPS: SpawnGatewayDeps = {
  resolveLaunch: () => resolveGatewayLaunch(process.execPath, import.meta.url),
  spawn,
  platform: process.platform,
};

/**
 * Launches the gateway detached, its stdout/stderr appended to today's log. All of the work is
 * synchronous; `Promise.try` keeps the contract an `async` function had — the spawn still happens
 * at call time, and a launch failure REJECTS rather than throwing at the caller.
 */
export function spawnGateway(
  paths: CliPlatformPaths,
  opts: SpawnGatewayOptions = {},
  deps: SpawnGatewayDeps = DEFAULT_SPAWN_GATEWAY_DEPS,
): Promise<SpawnedGateway> {
  return Promise.try(() => launchGateway(paths, opts, deps));
}

function launchGateway(
  paths: CliPlatformPaths,
  opts: SpawnGatewayOptions,
  deps: SpawnGatewayDeps,
): SpawnedGateway {
  const launch = deps.resolveLaunch();
  if (!launch.ok) {
    throw new Error(launch.message);
  }

  // The gateway's own order (NIMBUS_PROFILE, then the marker), validated here so a bad name is
  // refused with its source before anything is spawned.
  const profile = resolveCliActiveProfileWithSource(paths.configDir);

  const logPath = join(paths.logDir, gatewayLogBasename());
  const executable = launch.cmd[0];
  if (executable === undefined || executable === "") {
    throw new Error("Gateway launch command is empty");
  }
  const spawnArgs = launch.cmd.slice(1);
  const logFd = openSync(logPath, "a");
  const logStartOffset = fstatSync(logFd).size;
  let pid: number;
  try {
    writeSync(
      logFd,
      `\n--- ${new Date().toISOString()} nimbus: spawning gateway (${launch.cmd.join(" ")}) ---\n`,
    );
    const childEnv: NodeJS.ProcessEnv = stripInspectorEnv(process.env);
    childEnv["NIMBUS_GATEWAY_LOG_PATH"] = logPath;
    // Only a profile chosen by NIMBUS_PROFILE travels in the env. A marker/default profile must
    // NOT: the gateway would then record source "env", and doctor / `config explain` could never
    // say that a later `nimbus profile switch` needs a restart. It reads the marker itself.
    if (profile.source === "env") {
      childEnv["NIMBUS_PROFILE"] = profile.name;
    } else {
      delete childEnv["NIMBUS_PROFILE"];
    }
    if (opts.extraEnv !== undefined) {
      for (const [k, v] of Object.entries(opts.extraEnv)) {
        childEnv[k] = v;
      }
    }
    const spawnOpts: SpawnOptions = {
      cwd: launch.cwd,
      stdio: ["ignore", logFd, logFd],
      windowsHide: true,
      env: childEnv,
    };
    if (deps.platform === "win32") {
      spawnOpts.detached = true;
    }
    const child = deps.spawn(executable, spawnArgs, spawnOpts);
    const p = child.pid;
    if (p === undefined) {
      throw new Error("Gateway spawn did not return a process id");
    }
    pid = p;
    child.unref();
  } finally {
    closeSync(logFd);
  }

  return { pid, logPath, logStartOffset };
}
