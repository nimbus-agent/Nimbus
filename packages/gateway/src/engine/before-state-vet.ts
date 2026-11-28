// packages/gateway/src/engine/before-state-vet.ts
// The incident undo's fresh-state check (owner ruling 2026-11-27): an undo of a conditionally reversible row (the
// Unleash toggle) must not trust the before-state recorded when the action ran. The remediation executor's
// before-state runner is wrapped so that, after the row's FRESH read and before any prompt, a vet sees what the
// read captured (or `undefined` when nothing was captured: an unavailable read fails closed) and may refuse the
// write with its reason. A refusal is the runner's own `refused` outcome, which `gate()` turns into a rejection
// before the prompt: nothing is asked for and nothing is dispatched. The wrapper never names the runner's builder
// (static D40(b)); `run-ask.ts` hands it the one it builds.
import type {
  BeforeStateOutcome,
  BeforeStateRunner,
  BeforeStateRunnerOptions,
} from "./before-state.ts";
import type { PlannedAction } from "./types.ts";

type Captured = Readonly<Record<string, string>>;
type CaptureObserver = NonNullable<BeforeStateRunnerOptions["onCaptured"]>;

/** A refusal reason for `action`'s write, from what its fresh read captured; `undefined` lets it proceed. */
export type CaptureVet = (
  action: PlannedAction,
  captured: Captured | undefined,
) => string | undefined;

/** The refusal when a vet itself throws: fail closed. */
export const VET_FAILED_REASON = "the current state could not be checked, so nothing was run";

/**
 * The runner `make` builds, told `onCaptured`; with a `vet`, every read's capture is also checked by it after the
 * read and before the result goes back to the executor. Without one, exactly the runner `make` builds.
 */
export function vettedBeforeStateRunner(
  make: (onCaptured: CaptureObserver) => BeforeStateRunner,
  onCaptured: CaptureObserver,
  vet: CaptureVet | undefined,
): BeforeStateRunner {
  if (vet === undefined) return make(onCaptured);
  const seen = new Map<PlannedAction, Captured>();
  const runner = make((action, captured) => {
    seen.set(action, captured);
    onCaptured(action, captured);
  });
  return {
    rows: runner.rows,
    async read(action, ops, opts): Promise<BeforeStateOutcome | undefined> {
      seen.delete(action);
      const out = await runner.read(action, ops, opts);
      const captured = seen.get(action);
      seen.delete(action);
      if (out?.status === "refused") return out;
      let reason: string | undefined;
      try {
        reason = vet(action, captured);
      } catch {
        reason = VET_FAILED_REASON;
      }
      return reason === undefined ? out : { status: "refused", reason };
    },
  };
}
