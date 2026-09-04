/**
 * ffmpeg resolution and the transcode to whisper's expected input format (spec § 5.4).
 *
 * `whisper-cli` takes a PATH (`-f`) and wants 16 kHz 16-bit mono PCM WAV, so any compressed or
 * containerised media needs a transcode first. That is why the spec's "never written to disk" rule
 * is narrowed rather than absolute: ONE gateway-owned scratch file, 0600, deleted in a `finally`.
 *
 * NOT in `platform/`: resolving an external binary is not OS-specific logic reached through
 * `PlatformServices`. Both existing precedents keep the resolver beside its consumer —
 * `resolveWhisperBin` in `voice/stt.ts` and `computer-use/cu-lanes/chromium-path.ts`.
 */
import { chmodSync, closeSync, openSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { processEnvGet } from "../../platform/env-access.ts";

export function resolveFfmpegBin(
  configuredPath?: string,
  which: (name: string) => string | null = (name) => Bun.which(name),
): string {
  if (configuredPath !== undefined && configuredPath !== "") return configuredPath;
  const envPath = processEnvGet("NIMBUS_FFMPEG_PATH");
  if (envPath !== undefined && envPath !== "") return envPath;
  if (which("ffmpeg") !== null) return "ffmpeg";
  // Bare name regardless, so the spawn failure names the missing binary rather than a path the
  // user never configured.
  return "ffmpeg";
}

export interface TranscodeOptions {
  readonly ffmpegBin: string;
  readonly scratchDir: string;
  readonly spawn?: typeof Bun.spawn;
  readonly timeoutMs?: number;
}

/** Generous: a long recording on a slow CPU is legitimate. This bounds a HANG, not slowness. */
export const DEFAULT_TRANSCODE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Awaits `proc.exited` under a wall-clock bound, killing the process if it expires.
 *
 * `clearTimeout` runs on every path — an outstanding timer keeps `bun test` alive past the last
 * assertion, which shows up as a suite that hangs rather than one that fails.
 *
 * Exported for `frames/frame-extract.ts`, which spawns ffmpeg once per sampled frame and needs
 * the identical kill-then-reap behaviour. One implementation rather than two: a second copy would
 * be the place the reap gets forgotten.
 */
export async function withProcessTimeout(
  proc: { exited: Promise<number>; kill: () => void },
  timeoutMs: number,
  label: string,
): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      proc.exited,
      new Promise<number>((_resolve, reject) => {
        timer = setTimeout(() => {
          try {
            proc.kill();
          } catch {
            // Already gone.
          }
          // Reap it, so a killed child is not left as a zombie for the life of the gateway — but
          // deliberately NOT awaited here: this call must still reject promptly even against a
          // process (or a test fake) whose `exited` never settles after `kill()`.
          void proc.exited.catch(() => undefined);
          reject(new Error(`timed out after ${timeoutMs}ms for ${label}`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Transcodes to 16 kHz mono PCM WAV in `scratchDir` and returns the path.
 *
 * The caller is responsible for deleting it — always via {@link withScratchFile}, never by hand,
 * so the cleanup rides a `finally` rather than the happy path.
 */
export async function transcodeToWav(input: string, opts: TranscodeOptions): Promise<string> {
  const spawn = opts.spawn ?? Bun.spawn;
  const out = join(opts.scratchDir, `nimbus-stt-${crypto.randomUUID()}.wav`);
  // Owner-only from the moment the inode exists, so decoded audio never sits on disk with
  // default permissions even for the brief window between ffmpeg's first write and the
  // post-write chmod below. `-y` (below) then has ffmpeg overwrite this empty file rather than
  // prompt. No-op on Windows, which is why it is not asserted cross-platform.
  try {
    closeSync(openSync(out, "w", 0o600));
  } catch {
    // A filesystem that rejects the mode still lets ffmpeg create the file itself via `-y`; the
    // post-write chmod below is the remaining backstop.
  }
  const cmd = [
    opts.ffmpegBin,
    "-nostdin",
    "-loglevel",
    "error",
    "-i",
    input,
    "-vn",
    "-ac",
    "1",
    "-ar",
    "16000",
    "-c:a",
    "pcm_s16le",
    "-y",
    out,
  ];
  const proc = spawn(cmd, {
    stdout: "pipe",
    stderr: "pipe",
    // I1: scope the child's env rather than let it inherit the gateway's whole process.env.
    env: extensionProcessEnv({}),
  }) as unknown as {
    exited: Promise<number>;
    // What Bun.spawn({stderr:"pipe"}) actually gives: a byte stream, NOT a Response.
    stderr: ReadableStream<Uint8Array>;
    kill: () => void;
  };

  // A corrupt or adversarial file can make ffmpeg loop or stall forever. Without a bound, one bad
  // artifact hangs the whole pass with no output and no way to tell it apart from slow progress.
  // Kill, then still await `exited` so the process is reaped rather than orphaned.
  const code = await withProcessTimeout(
    proc,
    opts.timeoutMs ?? DEFAULT_TRANSCODE_TIMEOUT_MS,
    input,
  );
  if (code !== 0) {
    const err = await new Response(proc.stderr).text().catch(() => "");
    throw new Error(`ffmpeg exited ${code} for ${input}: ${err.slice(0, 400)}`);
  }
  try {
    // Belt-and-braces: the pre-create above already opened `out` at 0600, so this is normally a
    // no-op. Kept so the file is still restricted even if the pre-create above failed (its own
    // catch) or something along the way recreated the inode with different permissions. No-op on
    // Windows, which is why it is not asserted cross-platform.
    chmodSync(out, 0o600);
  } catch {
    // A filesystem that rejects chmod does not invalidate the transcode.
  }
  return out;
}

/**
 * Runs `fn` with the scratch path and deletes the file on EVERY exit path.
 *
 * The `finally` is the whole point: the narrowed disk rule (spec § 5.4) is only acceptable if the
 * file always goes away, including on a throw and on cancellation.
 */
export async function withScratchFile<T>(path: string, fn: (p: string) => Promise<T>): Promise<T> {
  try {
    return await fn(path);
  } finally {
    try {
      rmSync(path, { force: true });
    } catch {
      // force:true already swallows ENOENT; this guards an exotic EPERM from failing the pass.
    }
  }
}

/**
 * Cloud downloads are named `nimbus-media-<uuid>` with NO extension.
 *
 * Deliberate: a downloaded artifact's extension is whatever the provider served (`.mov`, `.mkv`,
 * `.m4a`, `.webm`, …), so matching on extension is a list guaranteed to drift and to fail on
 * exactly the format nobody anticipated. ffmpeg probes content and never needs the suffix, so the
 * prefix can be the only key.
 */
export const CLOUD_SCRATCH_PREFIX = "nimbus-media-";
const STT_SCRATCH_PREFIX = "nimbus-stt-";

/**
 * Deletes stale scratch WAVs left by a PREVIOUS gateway process.
 *
 * `withScratchFile`'s `finally` covers exceptions and rejections but NOT process death: a SIGINT,
 * a SIGKILL, or a crash mid-pass leaves the file behind. On Windows a SIGTERM is
 * `TerminateProcess`, so there is no graceful path there at all. Without this sweep those files
 * accumulate indefinitely — and they are decoded audio of the user's recordings, which is exactly
 * the artifact the narrowed disk rule (spec § 5.4) exists to keep short-lived.
 *
 * Call once at pass start. Age-bounded rather than delete-all, so it cannot remove a file a
 * CONCURRENT pass is mid-way through using.
 */
export function sweepStaleScratchFiles(
  scratchDir: string,
  nowMs: number,
  maxAgeMs = 60 * 60 * 1000,
): number {
  let removed = 0;
  let entries: string[];
  try {
    entries = readdirSync(scratchDir);
  } catch {
    return 0;
  }
  for (const name of entries) {
    const isSttScratch = name.startsWith(STT_SCRATCH_PREFIX) && name.endsWith(".wav");
    const isCloudScratch = name.startsWith(CLOUD_SCRATCH_PREFIX);
    if (!isSttScratch && !isCloudScratch) {
      continue;
    }
    const full = join(scratchDir, name);
    try {
      if (nowMs - statSync(full).mtimeMs > maxAgeMs) {
        rmSync(full, { force: true });
        removed += 1;
      }
    } catch {
      // Raced with another sweep or another process; nothing to do.
    }
  }
  return removed;
}
