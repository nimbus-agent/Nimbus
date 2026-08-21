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
    // ── What a process needs merely to START ────────────────────────────────
    // Under `(deny default)` these are denied, and the failure is silent and total: the child
    // dies with SIGABRT (exit 134 through the wrapper's signal translation) having written
    // nothing to stdout OR stderr, because it never got far enough to have a working stderr.
    // That is what the first real macOS spawn through this profile did — every case in
    // sandbox-wrapper-spawn.test.ts, including the trivial "print one line" one.
    //
    // `sysctl-read`: every runtime queries CPU count / page size / OS version at startup
    // (`hw.ncpu`, `hw.memsize`, `kern.osversion`). It reads system SHAPE, never user data.
    //
    // `/dev/urandom` + `/dev/random`: the RNG seed. A runtime that cannot seed does not
    // degrade, it aborts.
    //
    // `/dev/null`: the standard sink; a child whose stdio setup writes to it fails at startup.
    //
    // These are LITERALS, not `(subpath "/dev")` — the wider grant would hand the sandbox the
    // whole device tree (`/dev/disk*` raw block devices among them) to fix a three-node problem.
    "(allow sysctl-read)",
    '(allow file-read* (literal "/dev/urandom") (literal "/dev/random") (literal "/dev/null"))',
    '(allow file-write-data (literal "/dev/null"))',
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
