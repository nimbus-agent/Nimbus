import type { ChildProcess } from "node:child_process";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { PreflightCommandConfig } from "../config/nimbus-toml.ts";
import {
  createSandboxRunner,
  type SandboxPolicy,
  type SandboxRunner,
} from "../platform/sandbox/index.ts";

export interface PreflightRunParams {
  readonly ref: string;
  readonly changedSurface: readonly string[];
}
export interface PreflightRunResult {
  readonly passed: boolean;
  readonly summary: string;
  readonly durationMs: number;
}
export interface PreflightRunnerDeps {
  /** DI seam — defaults to the real per-OS sandbox runner. */
  readonly createRunner?: () => Promise<SandboxRunner>;
  readonly now?: () => number;
}

/** Minimal policy that grants the sandbox ONLY the configured cwd (no network, no other roots). */
function preflightPolicy(cwd: string): SandboxPolicy {
  return {
    id: "nimbus.preflight",
    permissions: { network: [], filesystem: { read: [cwd], write: [cwd] } },
  };
}

function awaitExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<{ code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill();
      resolve({ code: null, timedOut: true });
    }, timeoutMs);
    timer.unref?.();
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 0, timedOut: false });
    });
  });
}

/**
 * I24 data plane: run the LOCALLY-configured command in the per-OS sandbox with the validated
 * params as env vars (never shell-interpolated, never as paths). Hard timeout kills the process.
 */
export async function runPreflightCommand(
  cfg: PreflightCommandConfig,
  params: PreflightRunParams,
  deps: PreflightRunnerDeps = {},
): Promise<PreflightRunResult> {
  const now = deps.now ?? Date.now;
  const start = now();
  const elapsed = () => now() - start;
  try {
    const runner = await (deps.createRunner ?? createSandboxRunner)();
    // cwd is OWNER-controlled local config (never caller-supplied), so this is a foot-gun guard,
    // not a caller boundary: normalize to an absolute path so the sandbox policy grants a
    // concrete root, never the gateway process's incidental cwd or a surprising relative path.
    const cwd = isAbsolute(cfg.cwd) ? cfg.cwd : resolvePath(cfg.cwd);
    const env: Record<string, string> = {
      NIMBUS_PREFLIGHT_REF: params.ref,
      NIMBUS_PREFLIGHT_SURFACE: params.changedSurface.join(","),
    };
    const child = runner.spawn(cfg.command, [...cfg.args], {
      policy: preflightPolicy(cwd),
      env,
      cwd,
      stdio: "ignore",
    });
    const { code, timedOut } = await awaitExit(child, cfg.timeoutSeconds * 1000);
    if (timedOut) {
      return {
        passed: false,
        summary: `timed out after ${cfg.timeoutSeconds}s`,
        durationMs: elapsed(),
      };
    }
    return {
      passed: code === 0,
      summary: code === 0 ? "passed" : `failed (exit ${code})`,
      durationMs: elapsed(),
    };
  } catch {
    return { passed: false, summary: "preflight could not run", durationMs: elapsed() };
  }
}
