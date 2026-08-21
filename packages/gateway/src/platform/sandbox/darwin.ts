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
    // Everything from here to the `file-read*` block is what a POSIX RUNTIME needs merely to
    // reach `main()`. It is not policy — the policy is the `fsRead`/`fsWrite`/`hosts` entries
    // below, which are still exactly what the extension declared.
    //
    // This profile had never launched a process. `darwin.test.ts` asserts on the generated TEXT
    // and never spawns; the one suite that does a real spawn could not reach macOS, because the
    // job's earlier unit step failed first and skipped it. So the grants below were written by
    // inspection and never executed: the first real spawn aborted with SIGABRT and an empty
    // stderr, which is what a runtime looks like when it dies before it can open a stream.
    //
    // A previous attempt added `sysctl-read` and the `/dev` literals alone, saw the next run fail
    // identically, and reverted them rather than leave an unproven widening in place. That was the
    // right call and the conclusion drawn from it — "these are not it" — was too strong: they were
    // demonstrably not SUFFICIENT, which says nothing about whether they are NECESSARY. The set
    // below is the full startup set rather than one guess at a time, with a reason on each, so
    // whatever is unnecessary can be identified and removed against a green baseline instead of a
    // red one.
    //
    // `file-read-metadata` unscoped is the one that carries the most weight and the least risk:
    // dyld and libc `stat()` every ANCESTOR of a path they open, so a grant on a leaf still fails
    // when `/Users` or `/private/var/folders` cannot be stat-ed. It exposes existence and mode —
    // never content, which stays governed by the `file-read*` block below.
    "(allow file-read-metadata)",
    // `hw.ncpu`, `hw.memsize`, `kern.osversion` — read during allocator and thread-pool setup,
    // before any user code runs.
    "(allow sysctl-read)",
    // `proc_pidinfo` against itself; denied, this aborts rather than degrades.
    "(allow process-info* (target self))",
    // JSC seeds its RNG from `/dev/urandom` at init. `/dev/null` needs write, not just read —
    // it is the redirect target for a closed stdio slot.
    '(allow file-read* (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom"))',
    '(allow file-write-data (literal "/dev/null"))',
    "(allow file-read*",
    `  (subpath "${opts.cwd}")`,
    `  (subpath "${opts.tmpdir}")`,
    `  (subpath "/usr/lib")`,
    `  (subpath "/usr/bin")`,
    `  (subpath "/System")`,
    `  (subpath "/private/etc")`,
    // Symmetry with `/usr/bin`, which was already granted: system executables live in both, and
    // a child resolved out of `/bin` was unreachable while the identical one in `/usr/bin` was not.
    `  (subpath "/bin")`,
    // dyld closures on the macOS versions that keep them outside `/System`.
    `  (subpath "/private/var/db/dyld")`,
    // `zoneinfo` and ICU data — read by any runtime that can format a date.
    `  (subpath "/usr/share")`,
    // The rest of the SYSTEM tree, and the reason it is broad. The Linux runner binds `/usr`,
    // `/etc`, `/lib`, `/lib64` and `/dev` WHOLESALE (`buildBwrapArgv`); macOS was granting a
    // hand-picked subset of the same territory and denying the remainder, which is not a
    // stricter policy so much as an inconsistent one. A bisect showed no SINGLE added path fixes
    // the startup abort while `(subpath "/")` does — the child needs several of these at once,
    // which is exactly what an additive search cannot report.
    //
    // What stays narrow is the part that carries user data: `/private/var` keeps only its
    // `db/dyld` grant plus the sandbox scratch dir, and `/Users` is reachable only through the
    // policy paths an extension declared. Those two are what the "refuses a path the policy does
    // not grant" test actually exercises, and granting either broadly would make it vacuous.
    `  (subpath "/Library")`,
    `  (subpath "/dev")`,
    `  (subpath "/sbin")`,
    `  (subpath "/opt")`,
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
        // TMPDIR is redirected into `sandboxDir`, which the profile already grants read AND
        // write. A runtime writes to its temp directory during startup, and on macOS that is
        // the per-user `/private/var/folders/<hash>/T` -- a tree this profile deliberately does
        // not grant, since it holds every other application's scratch files too. Granting it
        // would be the obvious fix and the wrong one; pointing the child at a directory it may
        // already use is strictly tighter, and matches what the Linux runner gets for free from
        // its private tmpfs `/tmp` bind.
        //
        // All three spellings, because which one is honoured is libc- and runtime-dependent and
        // leaving one pointing at the denied tree defeats the other two.
        env: { ...opts.env, TMPDIR: sandboxDir, TMP: sandboxDir, TEMP: sandboxDir },
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
