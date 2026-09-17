import type { SandboxPolicy } from "./sandbox-policy.ts";

/**
 * AppContainer profile name for a policy. The `nimbus-ext-` prefix is what the reaper matches on
 * (`orphan-reap.ts`'s `PREFIX`); the bare `nimbus-` namespace is only what `--delete-profile`
 * refuses to delete outside of.
 */
export function profileNameFor(policy: { id: string }): string {
  return `nimbus-ext-${policy.id}`;
}

/**
 * Helper argv for one spawn. Pure derivation — no OS calls — so it is testable on every platform
 * and stays visible to the CI-Linux coverage run.
 *
 * Trailing `--` is load-bearing: without it a child argument beginning with `--grant-read` would
 * be parsed by the helper as a flag.
 */
export function buildHelperArgv(policy: SandboxPolicy, opts: { cwd: string }): string[] {
  const argv: string[] = ["--profile", profileNameFor(policy), "--cwd", opts.cwd];
  if (policy.permissions.network.length > 0) {
    argv.push("--capability", "internetClient");
  }
  for (const p of policy.permissions.filesystem.read) {
    argv.push("--grant-read", p);
  }
  for (const p of policy.permissions.filesystem.write) {
    argv.push("--grant-write", p);
  }
  argv.push("--");
  return argv;
}

/**
 * Helper argv that releases what {@link buildHelperArgv} granted for the same policy and cwd.
 *
 * Every path the spawn granted — the cwd, then each read and write path — named once. The helper's
 * `REVOKE_ACCESS` removes all of the SID's explicit ACEs on a path in one rewrite, so a path the
 * policy grants both read and write (the terminal lane's cwd) needs one pass, not three.
 */
export function buildRevokeGrantsArgv(policy: SandboxPolicy, opts: { cwd: string }): string[] {
  const argv: string[] = ["--revoke-grants", "--profile", profileNameFor(policy)];
  const seen = new Set<string>();
  for (const p of [
    opts.cwd,
    ...policy.permissions.filesystem.read,
    ...policy.permissions.filesystem.write,
  ]) {
    if (seen.has(p)) continue;
    seen.add(p);
    argv.push("--path", p);
  }
  return argv;
}

/** Helper argv for the boot-time sweep of orphaned app-container ACEs over `paths`. */
export function buildSweepArgv(paths: readonly string[]): string[] {
  return ["--sweep-orphaned-aces", ...paths];
}
