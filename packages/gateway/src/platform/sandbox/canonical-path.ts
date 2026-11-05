import { realpathSync } from "node:fs";

import type { SandboxPolicy } from "./sandbox-policy.ts";

/**
 * The path as the KERNEL will see it, which is not always the path the caller typed.
 *
 * A sandbox is a comparison between two strings: the one written into the policy and the one the
 * confined process resolves at runtime. When those disagree the sandbox does not fail open, it
 * fails in the most confusing possible way — the child is denied a path its policy plainly grants.
 * Both platforms had a live instance of this:
 *
 *  * Windows 8.3 short names. A GitHub runner's `TEMP` is
 *    `C:\Users\RUNNER~1\AppData\Local\Temp` because `runneradmin` exceeds eight characters. The
 *    ACL grant lands correctly (the short name resolves to the same directory), but the CHILD
 *    then has to expand `RUNNER~1` back to `runneradmin`, and that requires listing
 *    `C:\Users` — an ancestor the shipped leaf-only grant policy deliberately does not open.
 *    PowerShell reported `Access to the path '...' is denied` while `exit 7` succeeded, because
 *    only the cases that touched the filesystem ever resolved the name. Reproduced exactly by
 *    pointing `TEMP` at an 8.3 alias on a developer machine.
 *
 *  * macOS `/var` → `/private/var`. `/var` is a symlink, so an SBPL `(subpath "/var/folders/…")`
 *    grant never matches the `/private/var/folders/…` the kernel checks against.
 *
 * `realpathSync.native` is the one that fixes both: the plain `realpathSync` resolves symlinks
 * but leaves an 8.3 name untouched (measured — `realpathSync("C:\\PROGRA~1")` returns it
 * unchanged, `.native` returns `C:\Program Files`).
 *
 * Falls back to the input when the path cannot be resolved. A policy may legitimately name a
 * directory that does not exist yet, and refusing to spawn over that would be a worse failure
 * than granting the unresolved form — which is exactly what happened before this existed.
 */
export function canonicalPath(p: string): string {
  try {
    return realpathSync.native(p);
  } catch {
    return p;
  }
}

/**
 * The same policy with every filesystem path canonicalised.
 *
 * Applied together with the cwd at each runner's spawn site, so a grant and the child's view of
 * the granted directory are always the same string. `network` and `id` are carried through
 * untouched — neither is a path.
 *
 * A path the gateway already canonicalised (`canonicalWritePaths`) or declared a single file
 * (`canonicalWriteFiles`, I15, the Obsidian daily notes) must canonicalise to ITSELF here: a
 * different answer means it was swapped for a link after the gateway (and the wrapper) checked it,
 * and this THROWS, so the runner refuses the spawn. Otherwise the declared file would silently stop
 * matching its declaration and fall back to a folder grant (a macOS `subpath`, an inheritable
 * Windows ACE). The declarations are carried through with the same mapping.
 */
export function canonicalPolicyPaths(
  policy: SandboxPolicy,
  canonical: (p: string) => string = canonicalPath,
): SandboxPolicy {
  for (const p of [...(policy.canonicalWritePaths ?? []), ...(policy.canonicalWriteFiles ?? [])]) {
    if (canonical(p) !== p) {
      throw new Error(
        `refusing to spawn: the write grant ${p} changed since the gateway decided it`,
      );
    }
  }
  return {
    ...policy,
    permissions: {
      ...policy.permissions,
      filesystem: {
        read: policy.permissions.filesystem.read.map(canonical),
        write: policy.permissions.filesystem.write.map(canonical),
      },
    },
    ...(policy.canonicalWritePaths === undefined
      ? {}
      : { canonicalWritePaths: policy.canonicalWritePaths.map(canonical) }),
    ...(policy.canonicalWriteFiles === undefined
      ? {}
      : { canonicalWriteFiles: policy.canonicalWriteFiles.map(canonical) }),
  };
}

/**
 * The declared single-file write grants (`canonicalWriteFiles`), each of which MUST be in the final
 * write list. A declared file missing from it THROWS (the runner refuses the spawn): a write path
 * that was declared a file never falls back to a folder grant.
 */
export function declaredWriteFiles(policy: SandboxPolicy): ReadonlySet<string> {
  const write = new Set(policy.permissions.filesystem.write);
  for (const p of policy.canonicalWriteFiles ?? []) {
    if (!write.has(p)) {
      throw new Error(`refusing to spawn: the declared file grant ${p} is not in the write list`);
    }
  }
  return new Set(policy.canonicalWriteFiles ?? []);
}
