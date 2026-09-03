/**
 * Sampled video frames, extracted to MEMORY (spec § 8, § 5.4).
 *
 * WHY ONE SPAWN PER FRAME, AND WHY NO FILES. The spec anticipated writing frames to scratch files
 * beside the transcode WAV. This does not: each frame is its own
 * `ffmpeg -ss <t> -i <in> -frames:v 1 -f image2 -vcodec mjpeg pipe:1`, whose single JPEG is read
 * off stdout and handed straight to the VLM. `-ss` BEFORE `-i` is an input seek, so the cost is a
 * seek rather than a decode of everything preceding the timestamp — cheap next to the VLM call
 * that follows. The alternative, one invocation streaming N frames through `image2pipe`, needs the
 * caller to split a concatenated MJPEG stream on SOI/EOI markers; sound in principle (JPEG byte
 * stuffing escapes an in-scan `FF`), but it trades a process spawn for a hand-rolled parser on the
 * least-trusted bytes in the subsystem. It strengthens the narrowed disk rule: with this, "nothing
 * is written on the image path" covers video frames too, and the audio transcode's single 0600 WAV
 * is the only file this subsystem writes at all.
 *
 * NOT in `platform/`: resolving an external binary is not OS-specific logic reached through
 * `PlatformServices`. Same reasoning as `stt/ffmpeg-bin.ts` and `computer-use/cu-lanes/chromium-path.ts`.
 */
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { processEnvGet } from "../../platform/env-access.ts";
import { withProcessTimeout } from "../stt/ffmpeg-bin.ts";

/** A probe is metadata only; it has no reason to be slow. */
const DEFAULT_PROBE_TIMEOUT_MS = 30_000;

/** A single seek + decode. Generous enough for a slow disk, tight enough to bound a hang. */
const DEFAULT_FRAME_TIMEOUT_MS = 60_000;

/** A 4K MJPEG frame is a few MB; this bounds a runaway, not a legitimate frame. */
const DEFAULT_MAX_FRAME_BYTES = 16 * 1024 * 1024;

export interface ProbeOptions {
  readonly ffprobeBin: string;
  readonly spawn?: typeof Bun.spawn;
  readonly timeoutMs?: number;
}

export interface FrameOptions {
  readonly ffmpegBin: string;
  readonly spawn?: typeof Bun.spawn;
  readonly timeoutMs?: number;
  readonly maxBytes?: number;
}

type SpawnedProc = {
  exited: Promise<number>;
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  kill: () => void;
};

/** Mirrors `resolveFfmpegBin` exactly — configured path, env override, PATH, then the bare name. */
export function resolveFfprobeBin(
  configuredPath?: string,
  which: (name: string) => string | null = (name) => Bun.which(name),
): string {
  if (configuredPath !== undefined && configuredPath !== "") return configuredPath;
  const envPath = processEnvGet("NIMBUS_FFPROBE_PATH");
  if (envPath !== undefined && envPath !== "") return envPath;
  if (which("ffprobe") !== null) return "ffprobe";
  return "ffprobe";
}

/**
 * Duration in seconds, or `null` when it cannot be determined.
 *
 * NEVER throws. ffprobe ships with every mainstream ffmpeg distribution, but it is a SEPARATE
 * binary and a user can have one without the other. A null here degrades the artifact to
 * transcript-only with a disclosed count (see `av-understander.ts`) instead of failing a video
 * whose audio transcribed perfectly well.
 */
export async function probeDurationSeconds(
  input: string,
  opts: ProbeOptions,
): Promise<number | null> {
  const spawn = opts.spawn ?? Bun.spawn;
  try {
    const proc = spawn(
      [
        opts.ffprobeBin,
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=nw=1:nk=1",
        input,
      ],
      { stdout: "pipe", stderr: "pipe", env: extensionProcessEnv({}) },
    ) as unknown as SpawnedProc;
    // Start the read but do NOT await it before the timeout guard. `new Response(stream).text()`
    // resolves only at EOF, and a wedged ffprobe never closes stdout — awaiting here would block
    // forever and the timeout race below would never even be constructed. `extractFrameJpeg` has
    // the same hazard and the same shape; the two must not diverge.
    const outPromise = new Response(proc.stdout).text();
    let code: number;
    try {
      code = await withProcessTimeout(
        proc,
        opts.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS,
        `ffprobe ${input}`,
      );
    } catch (err) {
      // The timeout fired. `outPromise` is still pending on a stream that will never close, and a
      // pending read keeps `bun test` alive past the last assertion — a hanging suite rather than
      // a failing one. Cancel it explicitly; a no-op on a stream already at EOF.
      void proc.stdout.cancel().catch(() => undefined);
      void outPromise.catch(() => undefined);
      throw err;
    }
    if (code !== 0) {
      void proc.stdout.cancel().catch(() => undefined);
      void outPromise.catch(() => undefined);
      return null;
    }
    const seconds = Number.parseFloat((await outPromise).trim());
    // `N/A` and an empty line both land here. A NaN duration would produce NaN timestamps and an
    // ffmpeg invocation with a garbage `-ss`.
    return Number.isFinite(seconds) && seconds > 0 ? seconds : null;
  } catch {
    return null;
  }
}

/** At most one sampled frame per this many seconds of video. See {@link frameTimestamps}. */
const MIN_FRAME_INTERVAL_SECONDS = 2;

/**
 * Uniformly spaced timestamps strictly INSIDE the clip, at a density bounded from BOTH ends.
 *
 * `(i + 1) / (n + 1)` rather than `i / n`: frame 0 of a video is very often a black or title
 * frame, and the final instant is often a fade. Sampling the open interval spends the budget on
 * frames that carry content.
 *
 * The density clamp is the other half. `maxFrames` alone would sample a 2-second clip eight times
 * at ~220 ms apart — eight VLM calls producing near-identical captions, at full GPU cost, for a
 * clip one frame describes. Frames are therefore capped at one per
 * {@link MIN_FRAME_INTERVAL_SECONDS} as well as at `maxFrames`, and floored at one so a short clip
 * still gets a caption rather than none.
 */
export function frameTimestamps(durationSeconds: number, maxFrames: number): number[] {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || maxFrames < 1) return [];
  const byDensity = Math.floor(durationSeconds / MIN_FRAME_INTERVAL_SECONDS);
  const n = Math.max(1, Math.min(Math.floor(maxFrames), byDensity));
  const out: number[] = [];
  for (let i = 0; i < n; i += 1) {
    out.push((durationSeconds * (i + 1)) / (n + 1));
  }
  return out;
}

export async function extractFrameJpeg(
  input: string,
  atSeconds: number,
  opts: FrameOptions,
): Promise<Uint8Array> {
  const spawn = opts.spawn ?? Bun.spawn;
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const proc = spawn(
    [
      opts.ffmpegBin,
      "-nostdin",
      "-loglevel",
      "error",
      // BEFORE -i: an input seek, not a decode of everything up to `atSeconds`.
      "-ss",
      atSeconds.toFixed(3),
      "-i",
      input,
      "-frames:v",
      "1",
      "-f",
      "image2",
      "-vcodec",
      "mjpeg",
      "pipe:1",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      // I1: scope the child's env rather than inherit the gateway's whole process.env.
      env: extensionProcessEnv({}),
    },
  ) as unknown as SpawnedProc;

  // Read stdout CONCURRENTLY with waiting on exit. ffmpeg blocks once the pipe buffer fills, so
  // awaiting `exited` first would deadlock on any frame larger than that buffer.
  const collect = readBounded(proc.stdout, maxBytes);
  const code = await withProcessTimeout(
    proc,
    opts.timeoutMs ?? DEFAULT_FRAME_TIMEOUT_MS,
    `ffmpeg frame ${atSeconds}s of ${input}`,
  );
  if (code !== 0) {
    const err = await new Response(proc.stderr).text().catch(() => "");
    throw new Error(
      `ffmpeg exited ${code} extracting frame at ${atSeconds}s: ${err.slice(0, 400)}`,
    );
  }
  const bytes = await collect;
  if (bytes.byteLength === 0) {
    // A seek past the last frame exits 0 with no output. Throwing keeps the caller from sending
    // zero bytes to the model and storing whatever it says about them.
    throw new Error(`ffmpeg produced no frame at ${atSeconds}s of ${input}`);
  }
  return bytes;
}

async function readBounded(
  stream: ReadableStream<Uint8Array>,
  maxBytes: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value === undefined) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`frame exceeds the ${maxBytes}-byte cap`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
