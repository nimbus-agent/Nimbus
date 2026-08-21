import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseNetworkEntry } from "../../extensions/permissions-validator.ts";
import { canonicalPath, canonicalPolicyPaths } from "./canonical-path.ts";
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
    // NOTE for whoever fixes the macOS SIGABRT: `sysctl-read` and literal grants for
    // /dev/urandom, /dev/random and /dev/null were added here on the theory that a runtime
    // cannot start without them, and REMOVED again when the next CI run failed identically.
    // They may still be necessary — they were demonstrably not sufficient — but widening a
    // security boundary on an unproven theory is not a trade worth making, and an unnecessary
    // grant that happens to sit next to a fix is the hardest kind to ever remove. The macOS CI
    // leg now dumps kernel sandbox denials on failure; add exactly what that log names, and
    // nothing else.
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
      // `/var` is a symlink to `/private/var`, so `mkdtempSync(tmpdir())` hands back a path the
      // kernel never sees. An SBPL `(subpath "/var/folders/…")` grant therefore matches nothing,
      // and the child is denied the scratch directory its own profile grants it. Canonicalise
      // the cwd and every policy path for the same reason. See canonical-path.ts.
      const sandboxDir = canonicalPath(mkdtempSync(join(tmpdir(), "nimbus-sandbox-")));
      const cwd = canonicalPath(opts.cwd);
      const profilePath = join(sandboxDir, "profile.sb");
      const profile = generateSbplProfile({
        cwd,
        tmpdir: sandboxDir,
        policy: canonicalPolicyPaths(opts.policy),
      });
      writeFileSync(profilePath, profile);
      // Absolute path to the SIP-protected system binary — never resolve via
      // PATH, which could be attacker-influenced (Sonar S4036 hardening).
      const child = spawn("/usr/bin/sandbox-exec", ["-f", profilePath, cmd, ...args], {
        env: opts.env,
        // The CANONICAL cwd, matching what the profile granted. Spawning into `opts.cwd` here
        // while granting `cwd` above would reintroduce the mismatch this whole change removes.
        cwd,
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
