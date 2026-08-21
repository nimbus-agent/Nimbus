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
 */
export function canonicalPolicyPaths(policy: SandboxPolicy): SandboxPolicy {
  return {
    ...policy,
    permissions: {
      ...policy.permissions,
      filesystem: {
        read: policy.permissions.filesystem.read.map(canonicalPath),
        write: policy.permissions.filesystem.write.map(canonicalPath),
      },
    },
  };
}
