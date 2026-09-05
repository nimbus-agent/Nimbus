/**
 * File-length transcription over the existing `WhisperSttProvider` (spec § 9.1).
 *
 * That provider takes a PATH and assumes whisper's input format, so this wrapper owns the
 * transcode and the scratch-file lifecycle and hands whisper a WAV it is guaranteed to accept.
 *
 * Everything is injected rather than constructed here: `mock.module` is process-global and leaks
 * across the combined CI test run, so DI is the house rule for anything spawning a subprocess.
 */
import type { MediaSource, UnderstandDetail } from "../media-types.ts";
import { transcodeToWav, withScratchFile } from "./ffmpeg-bin.ts";

export interface LongFormSttDeps {
  /** Usually `WhisperSttProvider.transcribe`, bound. Receives the TRANSCODED wav path. */
  readonly transcribe: (wavPath: string) => Promise<{ text: string }>;
  readonly isAvailable: () => Promise<boolean>;
  readonly ffmpegBin: string;
  readonly scratchDir: string;
  readonly model: string;
  readonly spawn?: typeof Bun.spawn;
}

export interface LongFormStt {
  /**
   * Literal `true`: STT is local-only in all four PRs (spec § 12.7), so no remote STT provider
   * exists whose locality could differ. A remote tier must DERIVE this, never widen the literal.
   */
  readonly isLocal: true;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  understand(source: MediaSource): Promise<UnderstandDetail>;
}

export function createLongFormStt(deps: LongFormSttDeps): LongFormStt {
  return {
    isLocal: true,
    model: deps.model,
    isAvailable: deps.isAvailable,
    async understand(source: MediaSource): Promise<UnderstandDetail> {
      // This leg is reached only through `av-understander.ts`, which itself requires a path
      // source before calling here (whisper-cli/ffmpeg both need a seekable file) — so `bytes`
      // cannot arrive in production. Asserted rather than assumed: a future direct caller of this
      // module that skips that guard fails loudly instead of `transcodeToWav` receiving an object
      // where it expects a path string.
      if (source.kind !== "path") {
        throw new Error("long-form STT requires a path source, not in-memory bytes");
      }
      const wav = await transcodeToWav(source.path, {
        ffmpegBin: deps.ffmpegBin,
        scratchDir: deps.scratchDir,
        ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
      });
      return withScratchFile(wav, async (p) => {
        const res = await deps.transcribe(p);
        return { text: res.text };
      });
    },
  };
}
