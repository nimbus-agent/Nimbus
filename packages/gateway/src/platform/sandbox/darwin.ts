/**
 * macOS SandboxRunner (T2 PR 1).
 *
 * Wraps every extension/connector spawn in `sandbox-exec` with a generated
 * SBPL (Sandbox Profile Language) profile that:
 *   - Defaults to `(deny default)`.
 *   - Allows `process-fork` / `process-exec` so the child can spawn helpers.
 *   - Allows `file-read*` under the cwd, a scoped temp dir, and the system
 *     read paths required for a working dynamic-linker (`/usr/lib`, `/usr/bin`,
 *     `/System`, `/private/etc`), plus the manifest-declared
 *     `permissions.filesystem.read` subpaths.
 *   - Allows `file-write*` under the cwd, the scoped temp dir, and the
 *     manifest-declared `permissions.filesystem.write` subpaths.
 *   - Allows `network*` only when `permissions.network` is non-empty, scoped
 *     per host on tcp:443, plus DNS via udp:53.
 *
 * Spike status: this is the spike-pass implementation. If the macOS 14/15
 * compatibility spike (see Task 9 script) ultimately fails, this file is
 * replaced wholesale with an EndpointSecurity-based stub in a follow-up.
 *
 * SBPL injection note: hostnames are validated by `permissions-validator.ts`
 * (RFC 1123 regex — no `"` or `)`), and filesystem paths are checked for `..`
 * components. The generated profile string is therefore safe from injection
 * by manifest content.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionManifest } from "../../extensions/manifest.ts";
import type { SandboxRunner, SandboxSpawnOptions } from "./sandbox-runner.ts";

interface SbplOpts {
  cwd: string;
  tmpdir: string;
  manifest: ExtensionManifest;
}

/**
 * Generate an SBPL (Sandbox Profile Language) profile for `sandbox-exec`.
 * Pure — exported for the unit-test surface.
 */
export function generateSbplProfile(opts: SbplOpts): string {
  const hosts = opts.manifest.permissions.network;
  const fsRead = opts.manifest.permissions.filesystem.read;
  const fsWrite = opts.manifest.permissions.filesystem.write;

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    "(allow process-fork process-exec)",
    "(allow signal (target self))",
    "(allow mach-lookup)",
    "(allow iokit-open)",
    "(allow file-read*",
    `  (subpath "${opts.cwd}")`,
    `  (subpath "${opts.tmpdir}")`,
    `  (subpath "/usr/lib")`,
    `  (subpath "/usr/bin")`,
    `  (subpath "/System")`,
    `  (subpath "/private/etc")`,
    ...fsRead.map((p) => `  (subpath "${p}")`),
    ")",
    "(allow file-write*",
    `  (subpath "${opts.cwd}")`,
    `  (subpath "${opts.tmpdir}")`,
    ...fsWrite.map((p) => `  (subpath "${p}")`),
    ")",
  ];
  if (hosts.length > 0) {
    lines.push(
      "(allow network*",
      ...hosts.map((h) => `  (remote tcp "*:443" (host "${h}"))`),
      `  (remote udp "*:53")`,
      ")",
    );
  }
  return lines.join("\n");
}

export function createDarwinSandboxRunner(): SandboxRunner {
  return {
    platform: "darwin",
    spawn(cmd: string, args: string[], opts: SandboxSpawnOptions): ChildProcess {
      const sandboxDir = mkdtempSync(join(tmpdir(), "nimbus-sandbox-"));
      const profilePath = join(sandboxDir, "profile.sb");
      const profile = generateSbplProfile({
        cwd: opts.cwd,
        tmpdir: sandboxDir,
        manifest: opts.manifest,
      });
      writeFileSync(profilePath, profile);
      const child = spawn("sandbox-exec", ["-f", profilePath, cmd, ...args], {
        env: opts.env,
        cwd: opts.cwd,
        stdio: opts.stdio,
      });
      child.once("exit", () => {
        rmSync(sandboxDir, { recursive: true, force: true });
      });
      return child;
    },
    isFullyActive: () => true,
    degradedReason: () => null,
  };
}
