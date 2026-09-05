/**
 * THE chokepoint: the only path from media bytes to a model (spec § 3.2, § 3.4).
 *
 * The ORDER below is the invariant, exactly as in I33 and I35. It ships in PR 1 with only its
 * local arm — before there is any remote path to gate — because retrofitting a chokepoint onto
 * code that already reaches the resource is how a bypass gets built. PR 4 adds an ARM here; it
 * does not introduce a gate.
 *
 * As of Task 9, `remoteFor` is a real seam but no remote provider exists yet (Task 10 builds the
 * adapters) — production's `remoteFor` returns `undefined` unconditionally, so step 3's refusal
 * remains the path every non-local `understanderFor` result takes, exercised only by tests using a
 * deliberately non-local fake. Once Task 10 lands, a granted artifact reaches step 3 with
 * `chosen === remote`, and the refusal there guards only a provider that arrived WITHOUT going
 * through `remoteFor` — the structural backstop this gate has carried since PR 1.
 */
import type {
  MediaCandidate,
  MediaModality,
  MediaSource,
  SkipReason,
  UnderstandDetail,
  UnderstandOutcome,
} from "./media-types.ts";
import { UnsupportedImageFormatError } from "./media-types.ts";

/**
 * Renamed from `LocalUnderstander` in PR 4 (§ 19.A). The old name asserted a security property
 * this type no longer carries — a remote provider is returned through it now — and a type whose
 * name claims a guarantee it does not enforce is worse than the churn of renaming it. Locality is
 * read from `isLocal` (I34), which is the only thing that ever decided it.
 */
export interface Understander {
  /** DERIVED by the provider (I34). The gate READS it; it never accepts it from a caller. */
  readonly isLocal: boolean;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  understand(source: MediaSource): Promise<UnderstandDetail>;
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
  /**
   * Resolves the understander for THIS artifact.
   *
   * Keyed on the candidate as well as the modality since PR 4: remote eligibility is per-artifact
   * (this image has a grant, that one does not), and a modality-keyed seam cannot express it. The
   * candidate is already the gate's first argument, so nothing new is threaded through the pass.
   */
  readonly understanderFor: (
    modality: MediaModality,
    candidate: MediaCandidate,
  ) => Understander | undefined;
  /**
   * The REMOTE understander for this artifact, when one is both configured and granted. Absent
   * (or returning undefined) means no remote arm exists — which is production's state whenever
   * `[multimodal] remote_vlm` is unset, and was every install's state before PR 4.
   *
   * The grant lookup lives BEHIND this closure, in `build-media-pass-deps.ts`, so the gate never
   * touches a `Database` and D27(b)'s confinement of the grant store holds without the gate
   * needing an exemption.
   */
  readonly remoteFor?: ((candidate: MediaCandidate) => Understander | undefined) | undefined;
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
  source: MediaSource,
  deps: MediaGateDeps,
): Promise<GateResult> {
  // 0. Disabled by local config or org policy — refuse BEFORE resolving anything, so a disabled
  //    capability never announces itself by doing work.
  if (!deps.enabled || deps.capabilityDisabled) {
    return { ok: false, reason: "no_local_model" };
  }

  // 1. Resolve the provider for this modality. Absent means SKIP, never a default: guessing the
  //    modality means handing bytes to the wrong model.
  const provider = deps.understanderFor(candidate.modality, candidate);
  if (provider === undefined) {
    return { ok: false, reason: "unresolvable_modality" };
  }

  // 2. Prefer the REMOTE arm when this artifact has one — meaning a vendor is configured AND an
  //    active grant names it for this exact artifact. `remoteFor` returns undefined otherwise, and
  //    the local provider resolved above stands.
  //
  //    A grant with no configured remote arm therefore resolves as if no grant existed (§ 19.3):
  //    consent widens what may happen, and must never take away the local capability the user
  //    already had.
  const remote = deps.remoteFor?.(candidate);
  const chosen = remote ?? provider;

  // 3. Locality is DERIVED (I34). A non-local provider that arrived any other way than through
  //    `remoteFor` has no grant behind it and is refused outright — the structural backstop this
  //    gate has carried since PR 1, still reachable and still tested.
  if (!chosen.isLocal && remote === undefined) {
    return { ok: false, reason: "no_remote_grant" };
  }

  // 4. A LOCAL provider that is unavailable refuses; it does not degrade to remote. A REMOTE
  //    provider is not availability-probed — there is no second arm to fall back to, so a probe
  //    would only add a round-trip before the same refusal, and its failure is reported by the
  //    describe itself.
  if (chosen.isLocal && !(await chosen.isAvailable())) {
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
    const detail = await chosen.understand(source);
    return {
      ok: true,
      outcome: {
        text: detail.text,
        // Both DERIVED from the provider, never reported by the understander (I34).
        model: chosen.model,
        isLocal: chosen.isLocal,
        // Conditional spread: absent counts must stay absent, not become 0. See UnderstandDetail.
        ...(detail.framesSampled === undefined ? {} : { framesSampled: detail.framesSampled }),
        ...(detail.framesCaptioned === undefined
          ? {}
          : { framesCaptioned: detail.framesCaptioned }),
      },
    };
  } catch (err) {
    // The reason a user READS. "transcribe failed" printed against a photograph is a lie in the
    // one line the summary gives them, and the failures have different remedies: an unsupported
    // format, a vision model that could not describe an image, or a bad transcode/transcription.
    // `UnsupportedImageFormatError` is checked FIRST, before the modality branch — it is thrown by
    // `image-understander.ts` and must win even though its candidate is also `image`, or the
    // `unsupported_image_format` reason (added in Task 6) is unreachable dead code.
    if (err instanceof UnsupportedImageFormatError) {
      return { ok: false, reason: "unsupported_image_format" };
    }
    return {
      ok: false,
      reason: candidate.modality === "image" ? "describe_failed" : "transcribe_failed",
    };
  } finally {
    clearInterval(heartbeat);
    release();
  }
}
