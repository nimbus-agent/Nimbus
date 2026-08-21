import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

import type { SandboxPolicy } from "./sandbox-policy.ts";
import type { SandboxRunner, SandboxSpawnOptions } from "./sandbox-runner.ts";
import { buildHelperArgv } from "./win32-argv.ts";

export { profileNameFor } from "./win32-argv.ts";

function defaultHelperPath(): string {
  return join(dirname(process.execPath), "nimbus-sandbox-helper.exe");
}

export function helperPath(): string {
  return process.env["NIMBUS_SANDBOX_HELPER_PATH"] ?? defaultHelperPath();
}

interface HelperState {
  available: boolean;
  reason: string | null;
}

function probeHelper(path: string): HelperState {
  if (!existsSync(path)) {
    return { available: false, reason: `nimbus-sandbox-helper.exe not found at ${path}` };
  }
  try {
    const r = spawnSync(path, ["--check-caps"], { encoding: "utf8" });
    if (r.status === 0 && r.stdout.trim() === "OK") return { available: true, reason: null };
    const stderr = (r.stderr ?? "").trim();
    return {
      available: false,
      reason: `nimbus-sandbox-helper.exe cannot create an AppContainer profile: ${
        stderr === "" ? "<no stderr>" : stderr
      }`,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { available: false, reason: `nimbus-sandbox-helper.exe probe failed: ${msg}` };
  }
}

export function createWin32SandboxRunner(): SandboxRunner {
  const path = helperPath();
  const helper = probeHelper(path);

  return {
    platform: "win32",
    spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess {
      // I15 fail-closed: no helper means no enforceable confinement, so refuse rather than
      // spawn unconfined. This is the same posture the pre-implementation stub had; what
      // changes is that it is now conditional on a measured fact rather than permanent.
      if (!helper.available) {
        throw new Error(
          `refusing to spawn unsandboxed on Windows: ${helper.reason ?? "helper unavailable"}`,
        );
      }
      const argv = [...buildHelperArgv(opts.policy, { cwd: opts.cwd }), cmd, ...args];
      return spawn(path, argv, { env: opts.env, cwd: opts.cwd, stdio: opts.stdio });
    },
    isFullyActive(): boolean {
      return helper.available;
    },
    degradedReason(): string | null {
      if (!helper.available) return helper.reason;
      // Per-host network filtering would need a WFP callout driver with kernel-mode signing.
      // Documented and accepted; see docs/sandbox.md#platform-asymmetry.
      return "Windows: per-host network filtering is all-or-nothing (AppContainer internetClient); see docs/sandbox.md#platform-asymmetry";
    },
  };
}

export function capabilitiesForPolicy(policy: SandboxPolicy): string[] {
  return policy.permissions.network.length > 0 ? ["internetClient"] : [];
}
