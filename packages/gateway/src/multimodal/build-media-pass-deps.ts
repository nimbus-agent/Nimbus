/**
 * Constructs the production dependencies for the understanding pass.
 *
 * Separate from `media-pass.ts` so the pass stays a pure orchestrator over injected seams and can
 * be tested without a whisper binary, an arbiter or a config. This is the one place that knows
 * what the real implementations are.
 *
 * `understanderFor` resolves BOTH modalities: PR 2 adds the vision arm alongside PR 1's transcript
 * arm, so an image or video candidate no longer falls through to `unresolvable_modality` here.
 */
import type { Database } from "bun:sqlite";
import { loadNimbusFilesystemRootsFromConfigDir } from "../config/filesystem-toml.ts";
import { wrapLedgeredVlm } from "../egress/vlm-egress.ts";
import { GpuArbiter } from "../llm/gpu-arbiter.ts";
import { WhisperSttProvider } from "../voice/stt.ts";
import { createAvUnderstander } from "./frames/av-understander.ts";
import { resolveFfprobeBin } from "./frames/frame-extract.ts";
import type { LocalUnderstander } from "./media-gate.ts";
import type { MediaPassDeps } from "./media-pass.ts";
import type { MediaModality } from "./media-types.ts";
import {
  DEFAULT_MAX_FRAMES,
  DEFAULT_VLM_BASE_URL,
  DEFAULT_VLM_MODEL,
  loadMultimodalConfig,
} from "./multimodal-config.ts";
import { resolveFfmpegBin } from "./stt/ffmpeg-bin.ts";
import { createLongFormStt } from "./stt/long-form-stt.ts";
import { createImageUnderstander } from "./vlm/image-understander.ts";
import { createOllamaVlm } from "./vlm/ollama-vlm.ts";

export interface BuildMediaPassDepsInput {
  readonly db: Database;
  readonly roots: readonly string[];
  readonly enabled: boolean;
  readonly capabilityDisabled: boolean;
  readonly scratchDir: string;
  readonly maxBytes?: number;
  /** Shared with the LLM runtime when one exists, so media and generation contend on one lock. */
  readonly gpu?: GpuArbiter;
  readonly whisperBin?: string;
  readonly ffmpegBin?: string;
  /** Wall-clock bound on the whisper call itself. See {@link DEFAULT_TRANSCRIBE_TIMEOUT_MS}. */
  readonly transcribeTimeoutMs?: number;
  readonly vlmBaseUrl?: string;
  readonly vlmModel?: string;
  readonly maxFrames?: number;
  readonly ffprobeBin?: string;
  /** Injected only by tests; production uses the global `fetch`. */
  readonly vlmFetch?: typeof fetch;
}

/** 250 MB (spec § 5.3 `max_media_bytes`). */
const DEFAULT_MAX_MEDIA_BYTES = 250 * 1024 * 1024;

/**
 * Generous for the same reason as ffmpeg-bin.ts's `DEFAULT_TRANSCODE_TIMEOUT_MS`: a long
 * recording on a slow CPU is legitimate. This bounds a HANG, not slowness.
 */
export const DEFAULT_TRANSCRIBE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Bounds a whisper transcription call by wall clock, WITHOUT touching `WhisperSttProvider` —
 * that provider is shared with the voice subsystem, which has its own (interactive) tolerance for
 * how long to wait. Without a bound here, a wedged `whisper-cli` hangs the whole understanding
 * pass indefinitely: `transcodeToWav` has its own timeout, but nothing bounded the transcription
 * call that follows it.
 *
 * On expiry this REJECTS rather than resolving. `understandArtifact` (media-gate.ts) already wraps
 * `provider.understand()` in a try/catch that turns any rejection into the `transcribe_failed`
 * skip reason and moves on to the next candidate — so rejecting here is what keeps the pass going
 * rather than aborting it, not a special case this function has to implement itself.
 *
 * Unlike `ffmpeg-bin.ts`'s `withProcessTimeout`, this owns no handle to the underlying process —
 * only the injected `transcribe` promise-returning function — so a real whisper-cli process is not
 * killed on expiry, only waited on no longer. Exported (rather than kept private) so a test can
 * exercise the timeout arm directly with a never-resolving fake and a millisecond-scale bound,
 * instead of waiting out {@link DEFAULT_TRANSCRIBE_TIMEOUT_MS} against a real binary.
 */
export function withTranscribeTimeout(
  transcribe: (wavPath: string) => Promise<{ text: string }>,
  timeoutMs: number,
): (wavPath: string) => Promise<{ text: string }> {
  return (wavPath: string) =>
    new Promise<{ text: string }>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`whisper transcription timed out after ${timeoutMs}ms for ${wavPath}`));
      }, timeoutMs);
      transcribe(wavPath).then(
        (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
        },
      );
    });
}

export type BuiltMediaPassDeps = Omit<
  MediaPassDeps,
  "limit" | "service" | "modality" | "sinceMs" | "afterItemId"
>;

export function buildMediaPassDeps(input: BuildMediaPassDepsInput): BuiltMediaPassDeps {
  const whisper = new WhisperSttProvider(
    input.whisperBin === undefined ? {} : { whisperBin: input.whisperBin },
  );
  const stt = createLongFormStt({
    transcribe: withTranscribeTimeout(
      (wavPath: string) => whisper.transcribe(wavPath),
      input.transcribeTimeoutMs ?? DEFAULT_TRANSCRIBE_TIMEOUT_MS,
    ),
    isAvailable: () => whisper.isAvailable(),
    ffmpegBin: resolveFfmpegBin(input.ffmpegBin),
    scratchDir: input.scratchDir,
    model: "whisper-cli",
  });

  const arbiter = input.gpu ?? new GpuArbiter();

  // THE ONLY production site that may name `createOllamaVlm` or `wrapLedgeredVlm` (static rule
  // D22(g)). The constructor sits INSIDE the wrapper's argument list so an unwrapped provider is
  // not representable here: the audit checks that association, not merely that both names appear.
  const vlm = wrapLedgeredVlm(
    input.db,
    createOllamaVlm({
      baseUrl: input.vlmBaseUrl ?? DEFAULT_VLM_BASE_URL,
      model: input.vlmModel ?? DEFAULT_VLM_MODEL,
      ...(input.vlmFetch === undefined ? {} : { fetchImpl: input.vlmFetch }),
    }),
  );

  const imageUnderstander = createImageUnderstander({ vlm });
  const avUnderstander = createAvUnderstander({
    stt,
    vlm,
    maxFrames: input.maxFrames ?? DEFAULT_MAX_FRAMES,
    ffmpegBin: resolveFfmpegBin(input.ffmpegBin),
    ffprobeBin: resolveFfprobeBin(input.ffprobeBin),
  });

  return {
    db: input.db,
    roots: input.roots,
    maxBytes: input.maxBytes ?? DEFAULT_MAX_MEDIA_BYTES,
    nowMs: () => Date.now(),
    passId: "default",
    scratchDir: input.scratchDir,
    gate: {
      enabled: input.enabled,
      capabilityDisabled: input.capabilityDisabled,
      understanderFor: (modality: MediaModality): LocalUnderstander | undefined =>
        modality === "av" ? avUnderstander : imageUnderstander,
      gpu: {
        acquire: (id: string) => arbiter.acquire(id),
        // Load-bearing: a multi-minute transcription without a heartbeat is evicted by the
        // arbiter's idle timer, and `forceRelease()` wipes the waiter queue with it.
        touch: () => arbiter.touch(),
      },
    },
  };
}

/**
 * The `[[filesystem.roots]]` paths opted into media indexing (`media_index = true`, Task 4b) —
 * the ONLY roots `resolveLocalMediaPath` (media-bytes.ts) may read a candidate from. Deliberately
 * narrower than the full configured root set: a candidate item can only exist for a root that had
 * `media_index = true` at sync time (`filesystem-v2-sync.ts`), so widening the read boundary to
 * every configured root would admit paths the user never opted into for media understanding.
 *
 * Read live per call, matching `ownershipRoots` (`ownership/ownership-target.ts`) and `whyRoots`
 * (`agents-rpc.ts`) — a `[[filesystem.roots]]` edit applies on the next call, no gateway restart.
 * With no `configDir` (the test/embedded shape), the root set is empty.
 */
export function resolveMediaRoots(configDir: string | undefined): string[] {
  if (configDir === undefined) {
    return [];
  }
  return loadNimbusFilesystemRootsFromConfigDir(configDir)
    .filter((r) => r.mediaIndex)
    .map((r) => r.path);
}

/**
 * Kept as a named re-export so `ipc/server/dispatchers.ts` keeps compiling while Task 8 moves it
 * to the full config object. Delete when that task lands.
 */
export function resolveMultimodalEnabled(configDir: string | undefined): boolean {
  return loadMultimodalConfig(configDir).enabled;
}
