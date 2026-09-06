// packages/gateway/src/multimodal/frames/av-understander.ts
/**
 * Transcript + sampled frame captions, as ONE `Understander` (spec § 8, § 12.8).
 *
 * WHY THE TRANSCRIPT IS LOAD-BEARING AND THE CAPTIONS ARE NOT. A video with no transcript is a
 * failed artifact — the gate records `transcribe_failed` and a re-run retries it. A video with a
 * transcript and no captions is a PARTIAL success worth storing, so every caption failure degrades
 * rather than aborts: a missing ffprobe, an unavailable VLM, a corrupt frame, a model error. Each
 * degradation states its reason IN THE BODY, because the body is what reaches an agent's context;
 * a count kept only in metadata would not travel with the text a brief quotes.
 *
 * WHY CAPTIONS COME FIRST. `bodyCapForItemType` clamps `video_understanding` at `BODY_MAX_PROSE`
 * (16,384) and `item-store.ts` sets `body_complete = 0` when it bites. Captions first means a long
 * transcript loses its tail — already disclosed by that flag — rather than the captions silently
 * vanishing from a body that still claims to have them.
 *
 * WHY ONE GPU LEASE COVERS ALL OF THIS. `understandArtifact` takes one `GpuArbiter` lease per
 * artifact with a heartbeat, and the heartbeat — not the lease's narrowness — is what defuses the
 * idle-eviction hazard (spec § 8.1). Re-acquiring per frame would add a queue round-trip per frame
 * and let another caller take the GPU mid-artifact, leaving a half-captioned video that nothing
 * records as partial.
 */
import type { Understander } from "../media-gate.ts";
import type { MediaSource, UnderstandDetail } from "../media-types.ts";
import { FRAME_CAPTION_PROMPT } from "../vlm/caption-prompts.ts";
import type { VlmProvider } from "../vlm/vlm-types.ts";
import { extractFrameJpeg, frameTimestamps, probeDurationSeconds } from "./frame-extract.ts";

export const FRAME_HEADING = "## Frames (sampled)";
export const TRANSCRIPT_HEADING = "## Transcript";

/**
 * Spec § 12.8: a sampled video is not a watched video. This sentence is why a brief quoting a
 * caption cannot present it as a description of the whole video.
 */
export const AV_SAMPLING_DISCLOSURE =
  "Frames were sampled at uniform intervals, not watched: anything occurring only between sampled frames is not described here.";

export interface AvUnderstanderDeps {
  readonly stt: Understander;
  readonly vlm: VlmProvider;
  readonly maxFrames: number;
  readonly ffmpegBin: string;
  readonly ffprobeBin: string;
  /** Injected for tests; production passes the real `frame-extract.ts` functions. */
  readonly probeDuration?: (input: string) => Promise<number | null>;
  readonly extractFrame?: (input: string, atSeconds: number) => Promise<Uint8Array>;
}

function hhmmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((n) => String(n).padStart(2, "0")).join(":");
}

interface FrameCaptionResult {
  readonly sections: readonly string[];
  readonly notes: readonly string[];
  readonly sampled: number;
  readonly captioned: number;
}

/**
 * Samples up to `deps.maxFrames` frames and captions each, degrading (never throwing) at every
 * step: an absent VLM, a duration the probe cannot determine, or a single corrupt frame all
 * shrink the caption count rather than aborting the artifact — see the module doc comment for why
 * only the TRANSCRIPT leg is load-bearing.
 */
async function sampleFrameCaptions(
  path: string,
  deps: AvUnderstanderDeps,
  probe: (input: string) => Promise<number | null>,
  grab: (input: string, at: number) => Promise<Uint8Array>,
): Promise<FrameCaptionResult> {
  if (!(await deps.vlm.isAvailable())) {
    return {
      sections: [],
      notes: [
        "Frame captions are absent: no vision model was available on this machine when the pass ran.",
      ],
      sampled: 0,
      captioned: 0,
    };
  }

  const duration = await probe(path);
  if (duration === null) {
    return {
      sections: [],
      notes: [
        "Frame captions are absent: the video duration could not be determined, so frames could not be sampled.",
      ],
      sampled: 0,
      captioned: 0,
    };
  }

  const stamps = frameTimestamps(duration, deps.maxFrames);
  const captions: string[] = [];
  for (const at of stamps) {
    try {
      const bytes = await grab(path, at);
      const { text } = await deps.vlm.describe({
        bytes,
        prompt: FRAME_CAPTION_PROMPT,
        mimeType: "image/jpeg",
        egressMethod: "multimodal.vlm.frame",
      });
      const caption = text.trim();
      if (caption !== "") {
        captions.push(`[${hhmmss(at)}] ${caption}`);
      }
    } catch {
      // Per-frame failure degrades this frame only. The count below is the disclosure; a silent
      // skip would leave a body claiming completeness it does not have.
    }
  }

  const sections = captions.length > 0 ? [`${FRAME_HEADING}\n\n${captions.join("\n\n")}`] : [];
  return {
    sections,
    notes: [
      `${captions.length} of ${stamps.length} sampled frames captioned. ${AV_SAMPLING_DISCLOSURE}`,
    ],
    sampled: stamps.length,
    captioned: captions.length,
  };
}

export function createAvUnderstander(deps: AvUnderstanderDeps): Understander {
  const probe =
    deps.probeDuration ??
    ((input: string) => probeDurationSeconds(input, { ffprobeBin: deps.ffprobeBin }));
  const grab =
    deps.extractFrame ??
    ((input: string, at: number) => extractFrameJpeg(input, at, { ffmpegBin: deps.ffmpegBin }));

  return {
    /**
     * Both legs must be local for the artifact to be local. The gate reads this to decide whether
     * a per-artifact remote grant is required (spec § 3.4 step 3): if EITHER leg would reach a
     * remote model, the artifact is not a local understanding and must not be treated as one.
     */
    get isLocal(): boolean {
      return deps.stt.isLocal && deps.vlm.isLocal;
    },
    model: `${deps.stt.model}+${deps.vlm.model}`,

    /**
     * Tracks the TRANSCRIPT leg only. A machine with whisper and no VLM can still understand a
     * video usefully; refusing the artifact outright would throw away the transcript to avoid
     * missing captions.
     */
    isAvailable: () => deps.stt.isAvailable(),

    async understand(source: MediaSource): Promise<UnderstandDetail> {
      // whisper-cli and ffmpeg both need a seekable file, so this leg requires a path. The media
      // pass never produces a `bytes` source for an `av` candidate (PR 3's cloud arm only fetches
      // bytes for images; audio/video is fetched to a scratch file precisely so ffmpeg can seek
      // it) — but that is a property of the CALLER, not of this type, so it is asserted here
      // rather than cast past. Reusing `transcribe_failed` (rather than inventing a SkipReason)
      // is honest: from the gate's `understandArtifact` catch, any throw from `understand()`
      // already becomes that reason, so this is not a new outcome, only a defended-against one.
      if (source.kind !== "path") {
        throw new Error("av understander requires a seekable file path, not in-memory bytes");
      }
      const path = source.path;

      // A throw here propagates: the gate records `transcribe_failed` and a re-run retries this
      // artifact. Swallowing it and shipping captions alone would store a `video_understanding`
      // row whose transcript is silently absent.
      const transcript = (await deps.stt.understand({ kind: "path", path })).text.trim();

      const frames = await sampleFrameCaptions(path, deps, probe, grab);

      // A video with no audio track, or only silence, transcribes to "". That is a legitimate
      // artifact — a screen capture with eight good frame captions is worth storing — but the
      // section must SAY so rather than render an empty heading that reads as a lost transcript.
      if (transcript === "" && frames.captioned === 0) {
        // Nothing was understood at all: no speech and no caption. Writing a row here would be a
        // `video_understanding` item whose entire body is an apology. Throw instead, so the gate
        // records `transcribe_failed`, the pass discloses it by reason, and a re-run retries it
        // once a vision model or a working probe exists.
        throw new Error(`no speech and no frame captions for ${path}`);
      }

      const sections = [...frames.sections];
      if (frames.notes.length > 0) {
        sections.push(frames.notes.join("\n\n"));
      }
      sections.push(
        `${TRANSCRIPT_HEADING}\n\n${transcript === "" ? "(No speech detected.)" : transcript}`,
      );

      return {
        text: sections.join("\n\n"),
        // Reported only when sampling actually happened, so "never sampled" and "sampled, all
        // failed" stay distinguishable on the row (see `UnderstandDetail`).
        ...(frames.sampled === 0
          ? {}
          : { framesSampled: frames.sampled, framesCaptioned: frames.captioned }),
      };
    },
  };
}
