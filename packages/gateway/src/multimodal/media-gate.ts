/**
 * THE chokepoint: the only path from media bytes to a model (spec § 3.2, § 3.4).
 *
 * The ORDER below is the invariant, exactly as in I33 and I35. It ships in PR 1 with only its
 * local arm — before there is any remote path to gate — because retrofitting a chokepoint onto
 * code that already reaches the resource is how a bypass gets built. PR 4 adds an ARM here; it
 * does not introduce a gate.
 *
 * In this PR step 3 is structurally unreachable: every registered understander is local, so
 * `isLocal === false` cannot occur. It is implemented anyway, and tested with a deliberately
 * non-local fake, so the refusal exists before the thing it refuses does.
 */
import type {
  MediaCandidate,
  MediaModality,
  SkipReason,
  UnderstandOutcome,
} from "./media-types.ts";

export interface LocalUnderstander {
  /** DERIVED by the provider (I34). The gate READS it; it never accepts it from a caller. */
  readonly isLocal: boolean;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  understand(path: string): Promise<string>;
}

/**
 * Well inside `GpuArbiter`'s 30s idle bound, so a slow tick can never let the lease look stale.
 */
const GPU_HEARTBEAT_MS = 10_000;

export interface MediaGateDeps {
  /** `[multimodal] enabled`, default off. */
  readonly enabled: boolean;
  /** Resolved org policy (I22) disabling the capability. Checked BEFORE any model work. */
  readonly capabilityDisabled: boolean;
  readonly sttFor: (modality: MediaModality) => LocalUnderstander | undefined;
  /**
   * `touch` is REQUIRED, not optional: a production wiring that forgets it would compile and
   * silently lose the heartbeat — exactly the multi-minute-eviction failure this file exists to
   * prevent. Structural enforcement over prose; a caller with no real `GpuArbiter.touch` yet must
   * pass an explicit no-op, never rely on a default this gate supplies.
   */
  readonly gpu: { acquire(id: string): Promise<() => void>; touch: () => void };
  /**
   * Heartbeat period. Injectable ONLY so a test can observe ticks without sleeping ten seconds;
   * production leaves it unset and gets {@link GPU_HEARTBEAT_MS}.
   */
  readonly heartbeatMs?: number;
}

export type GateResult =
  | { readonly ok: true; readonly outcome: UnderstandOutcome }
  | { readonly ok: false; readonly reason: SkipReason };

export async function understandArtifact(
  candidate: MediaCandidate,
  path: string,
  deps: MediaGateDeps,
): Promise<GateResult> {
  // 0. Disabled by local config or org policy — refuse BEFORE resolving anything, so a disabled
  //    capability never announces itself by doing work.
  if (!deps.enabled || deps.capabilityDisabled) {
    return { ok: false, reason: "no_local_model" };
  }

  // 1. Resolve the provider for this modality. Absent means SKIP, never a default: guessing the
  //    modality means handing bytes to the wrong model.
  const provider = deps.sttFor(candidate.modality);
  if (provider === undefined) {
    return { ok: false, reason: "unresolvable_modality" };
  }

  // 2. Locality is DERIVED from the provider (I34), never supplied.
  // 3. Non-local requires a per-artifact grant. There is no grant store until PR 4, so a non-local
  //    provider is refused outright here — never silently allowed, never prompted from inside a
  //    pass (spec § 6.3).
  if (!provider.isLocal) {
    return { ok: false, reason: "no_remote_grant" };
  }

  // 4. A local provider that is unavailable REFUSES. It does not degrade to remote — the same
  //    fail-closed posture as `enforce_air_gap`.
  if (!(await provider.isAvailable())) {
    return { ok: false, reason: "no_local_model" };
  }

  // 5. Only now is the model contacted.
  //
  //    The GPU lease is per CALL — but for AV, ONE call is the whole file, which is minutes. That
  //    is long enough to matter: `GpuArbiter`'s 30s bound is an IDLE timer over `lastActivityAt`,
  //    evaluated lazily whenever some other caller reaches `acquire()`. So an interactive
  //    `nimbus ask` arriving mid-transcription sees a stale timestamp and calls `forceRelease()`,
  //    which does `this.queue.length = 0` — discarding every queued waiter as a promise that never
  //    settles. The pass would not merely lose the GPU; it would strand unrelated callers.
  //
  //    The heartbeat is the fix, and it is honest rather than a workaround: `touch()` means "still
  //    working", which is exactly true while the subprocess runs. `clearInterval` in the `finally`
  //    is load-bearing — an outstanding interval keeps `bun test` alive past the last assertion,
  //    which presents as a hanging suite rather than a failing one.
  const release = await deps.gpu.acquire(`multimodal:${candidate.modality}`);
  const heartbeat = setInterval(() => {
    deps.gpu.touch();
  }, deps.heartbeatMs ?? GPU_HEARTBEAT_MS);
  try {
    const text = await provider.understand(path);
    return { ok: true, outcome: { text, model: provider.model, isLocal: provider.isLocal } };
  } catch {
    return { ok: false, reason: "transcribe_failed" };
  } finally {
    clearInterval(heartbeat);
    release();
  }
}
