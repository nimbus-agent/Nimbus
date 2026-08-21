import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseNetworkEntry } from "../../extensions/permissions-validator.ts";
import type { SandboxPolicy } from "./sandbox-policy.ts";
import type { SandboxRunner, SandboxSpawnOptions } from "./sandbox-runner.ts";

interface SbplOpts {
  cwd: string;
  tmpdir: string;
  policy: SandboxPolicy;
}

export function generateSbplProfile(opts: SbplOpts): string {
  const hosts = opts.policy.permissions.network;
  const fsRead = opts.policy.permissions.filesystem.read;
  const fsWrite = opts.policy.permissions.filesystem.write;

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
      ...hosts.map((h) => {
        const { host, port } = parseNetworkEntry(h);
        return `  (remote tcp "*:${port}" (host "${host}"))`;
      }),
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
        policy: opts.policy,
      });
      writeFileSync(profilePath, profile);
      // Absolute path to the SIP-protected system binary — never resolve via
      // PATH, which could be attacker-influenced (Sonar S4036 hardening).
      const child = spawn("/usr/bin/sandbox-exec", ["-f", profilePath, cmd, ...args], {
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
