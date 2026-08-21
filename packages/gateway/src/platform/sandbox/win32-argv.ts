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
