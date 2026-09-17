import type { SandboxPolicy } from "./sandbox-policy.ts";
import { buildRevokeGrantsArgv, profileNameFor } from "./win32-argv.ts";

/** Runs the Windows sandbox helper with `argv`; rejects on a non-zero exit. Injected for tests. */
export type HelperRun = (argv: string[]) => Promise<void>;

/**
 * Release the ACEs a per-run spawn granted, then delete its AppContainer profile.
 *
 * The helper's `grant_path` only ever ADDS an ACE and deleting a profile does not remove one, so a
 * policy id that is new on every run (`exec-<id>`, `cu-terminal-<id>`) otherwise left one more
 * unresolvable ACE per run on every path that outlives it — the runtime bin dir above all — until
 * the DACL hit its size limit and every confined spawn on the machine refused.
 *
 * Best-effort and NEVER rejects: this runs after the child has already exited, from an event
 * listener, where a rejection would be an unhandled one and nobody could act on it. A revoke that
 * fails still attempts the delete; whatever survives is what the boot-time sweep exists for.
 */
export async function releaseGrantsFor(
  run: HelperRun,
  policy: SandboxPolicy,
  opts: { cwd: string },
): Promise<void> {
  try {
    await run(buildRevokeGrantsArgv(policy, opts));
  } catch {
    /* best-effort; see docstring */
  }
  try {
    await run(["--delete-profile", profileNameFor(policy)]);
  } catch {
    /* best-effort; see docstring */
  }
}

/** The one piece of a spawned child this needs: its lifecycle events. */
interface ChildLifecycle {
  once(event: "exit" | "error", listener: (...args: unknown[]) => void): unknown;
}

/**
 * Run `release` exactly once, when `child` is done — on `exit`, or on `error` for a helper that
 * could not be launched at all (Node emits `error` and never `exit` then).
 *
 * Driven from the GATEWAY's view of the helper process rather than from inside the helper after it
 * waits on its child, because the gateway ends terminal sessions and timed-out executions by
 * killing the helper — `TerminateProcess` on Windows — so nothing the helper would run after its
 * wait happens on those paths. The `exit` event fires for all of them.
 */
export function attachGrantRelease(child: ChildLifecycle, release: () => Promise<void>): void {
  attachGrantReleaseIf(true, child, release);
}

/**
 * {@link attachGrantRelease} when `requested` is exactly `true`, otherwise nothing. The runner passes
 * `SandboxSpawnOptions.releaseGrantsOnExit` straight through, so the decision lives here — where it
 * is tested on every platform — rather than in a spawn path only a Windows box with the helper
 * installed can reach.
 */
export function attachGrantReleaseIf(
  requested: boolean | undefined,
  child: ChildLifecycle,
  release: () => Promise<void>,
): void {
  if (requested !== true) return;
  let done = false;
  const fire = (): void => {
    if (done) return;
    done = true;
    void release();
  };
  child.once("exit", fire);
  child.once("error", fire);
}
