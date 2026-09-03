import { describe, expect, test } from "bun:test";
import {
  extractFrameJpeg,
  frameTimestamps,
  probeDurationSeconds,
  resolveFfprobeBin,
} from "./frame-extract.ts";

function fakeSpawn(opts: {
  code?: number;
  stdout?: Uint8Array | string;
  stderr?: string;
  neverExits?: boolean;
  record?: string[][];
}) {
  return ((cmd: string[]) => {
    opts.record?.push(cmd);
    const body = opts.stdout ?? new Uint8Array();
    return {
      exited:
        opts.neverExits === true ? new Promise<number>(() => {}) : Promise.resolve(opts.code ?? 0),
      stdout: new Response(body).body,
      stderr: new Response(opts.stderr ?? "").body,
      kill: () => {},
    };
  }) as unknown as typeof Bun.spawn;
}

describe("resolveFfprobeBin", () => {
  test("configured path wins, then PATH lookup, then the bare name", () => {
    expect(resolveFfprobeBin("/opt/ffprobe")).toBe("/opt/ffprobe");
    expect(resolveFfprobeBin(undefined, () => "/usr/bin/ffprobe")).toBe("ffprobe");
    // Bare name regardless, so a spawn failure names the missing binary rather than a path the
    // user never configured — matching resolveFfmpegBin.
    expect(resolveFfprobeBin(undefined, () => null)).toBe("ffprobe");
  });
});

describe("frameTimestamps", () => {
  test("uniformly spaced, strictly inside the duration, never at 0 or the end", () => {
    expect(frameTimestamps(90, 3)).toEqual([22.5, 45, 67.5]);
  });

  test("a short clip still yields one timestamp", () => {
    expect(frameTimestamps(1, 8).length).toBeGreaterThanOrEqual(1);
    expect(frameTimestamps(1, 8).every((t) => t > 0 && t < 1)).toBe(true);
  });

  test("never returns more than maxFrames, and never a non-finite value", () => {
    expect(frameTimestamps(3600, 8)).toHaveLength(8);
    expect(frameTimestamps(0, 8)).toEqual([]);
    expect(frameTimestamps(Number.NaN, 8)).toEqual([]);
    expect(frameTimestamps(-5, 8)).toEqual([]);
  });

  test("sampling density is clamped: a short clip gets fewer frames, not 8 near-identical ones", () => {
    // A 2s clip sampled 8 times is 8 VLM calls ~220ms apart — near-duplicate captions at full
    // GPU cost. At most one frame per MIN_FRAME_INTERVAL_SECONDS.
    expect(frameTimestamps(2, 8)).toHaveLength(1);
    expect(frameTimestamps(10, 8)).toHaveLength(5);
    // The clamp never raises the count above maxFrames, and never drops below one frame.
    expect(frameTimestamps(3600, 8)).toHaveLength(8);
    expect(frameTimestamps(0.5, 8)).toHaveLength(1);
  });
});

describe("probeDurationSeconds", () => {
  test("parses ffprobe's bare duration line", async () => {
    const d = await probeDurationSeconds("/v/clip.mp4", {
      ffprobeBin: "ffprobe",
      spawn: fakeSpawn({ stdout: "123.456\n" }),
    });
    expect(d).toBeCloseTo(123.456, 3);
  });

  test("returns null — never throws — when ffprobe is missing or fails", async () => {
    expect(
      await probeDurationSeconds("/v/clip.mp4", {
        ffprobeBin: "ffprobe",
        spawn: fakeSpawn({ code: 127, stderr: "not found" }),
      }),
    ).toBeNull();
  });

  test("returns null on unparseable output rather than a NaN duration", async () => {
    expect(
      await probeDurationSeconds("/v/clip.mp4", {
        ffprobeBin: "ffprobe",
        spawn: fakeSpawn({ stdout: "N/A\n" }),
      }),
    ).toBeNull();
  });

  test("a wedged ffprobe whose stdout never closes still rejects within the bound", async () => {
    // The hazard this pins: awaiting `new Response(stdout).text()` BEFORE the timeout guard blocks
    // forever, because that promise resolves only at EOF and a hung process never closes the pipe.
    // The timeout race would then never be constructed at all. Red-prove it by moving the await
    // back above `withProcessTimeout` — this test must hang-then-fail, not pass.
    const neverClosing = new ReadableStream<Uint8Array>({ start() {} });
    const spawn = (() => ({
      exited: new Promise<number>(() => {}),
      stdout: neverClosing,
      stderr: new Response("").body,
      kill: () => {},
    })) as unknown as typeof Bun.spawn;
    expect(
      await probeDurationSeconds("/v/clip.mp4", { ffprobeBin: "ffprobe", timeoutMs: 20, spawn }),
    ).toBeNull();
  });
});

describe("extractFrameJpeg", () => {
  test("seeks BEFORE -i and writes the single frame to stdout, never to a file", async () => {
    const record: string[][] = [];
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const bytes = await extractFrameJpeg("/v/clip.mp4", 12.5, {
      ffmpegBin: "ffmpeg",
      spawn: fakeSpawn({ stdout: jpeg, record }),
    });
    expect(Array.from(bytes)).toEqual(Array.from(jpeg));
    const cmd = record[0] ?? [];
    expect(cmd.indexOf("-ss")).toBeLessThan(cmd.indexOf("-i"));
    expect(cmd).toContain("pipe:1");
    expect(cmd).toContain("-frames:v");
    // No output path argument: nothing on this path touches disk. Positive form: the LAST
    // argument is exactly the stdout sink, and nothing after the input path looks like a
    // filesystem destination — `toContain("pipe:1")` above only proves presence, not
    // exclusivity, so a regression that ALSO wrote a file alongside `pipe:1` would still pass it.
    expect(cmd.at(-1)).toBe("pipe:1");
    const afterInput = cmd.slice(cmd.indexOf("-i") + 2);
    expect(afterInput.every((a) => a === "pipe:1" || a.startsWith("-") || !a.includes("."))).toBe(
      true,
    );
    // Kept as well as the positive check above — belt and braces on the property this task exists
    // to guarantee.
    expect(cmd.some((a) => a.endsWith(".jpg") || a.endsWith(".jpeg"))).toBe(false);
  });

  test("stdout is read CONCURRENTLY with awaiting exit (await-exit-first would deadlock)", async () => {
    // fakeSpawn's stdout is `new Response(body).body` — a fully pre-buffered stream with no
    // backpressure, so it can never observe read ORDER. A real OS pipe with real ffmpeg writing a
    // multi-MB frame is nothing like that: it blocks once the pipe buffer fills, and an
    // await-exit-first implementation would deadlock on it forever. This fake makes read order
    // observable instead: `exited` resolves ONLY once stdout has actually been pulled, so an
    // implementation that awaits exit before reading can never satisfy it and hits the timeout.
    let pulled!: () => void;
    const firstPull = new Promise<void>((resolve) => {
      pulled = resolve;
    });
    let chunks = 0;
    const stdout = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          // Only ever runs when a reader actively pulls. That is the signal — but ONLY with the
          // explicit highWaterMark:0 strategy below. A default-strategy ReadableStream (implicit
          // highWaterMark 1) calls `pull` once, eagerly, at construction to prime its internal
          // queue, with no reader attached at all — verified against this runtime. Without the
          // override this fake's `exited` resolves regardless of read order and the test is
          // worthless in exactly the arrangement it exists to catch (confirmed: see the red-prove
          // notes in the task report).
          chunks += 1;
          if (chunks === 1) {
            controller.enqueue(new Uint8Array([0xff, 0xd8, 0xff, 0xd9]));
            pulled();
          } else {
            controller.close();
          }
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 0 }),
    );
    const spawn = (() => ({
      // Resolves ONLY after the stream has been pulled — i.e. only if the caller read stdout
      // concurrently. An implementation that awaits exit before reading can never satisfy this
      // and will hit the timeout instead.
      exited: firstPull.then(() => 0),
      stdout,
      stderr: new Response("").body,
      kill: () => {},
    })) as unknown as typeof Bun.spawn;

    const bytes = await extractFrameJpeg("/v/clip.mp4", 1, {
      ffmpegBin: "ffmpeg",
      spawn,
      timeoutMs: 2_000,
    });
    expect(Array.from(bytes)).toEqual([0xff, 0xd8, 0xff, 0xd9]);
  });

  test("a non-zero exit throws with the stderr tail", async () => {
    await expect(
      extractFrameJpeg("/v/clip.mp4", 1, {
        ffmpegBin: "ffmpeg",
        spawn: fakeSpawn({ code: 1, stderr: "Invalid data found" }),
      }),
    ).rejects.toThrow(/Invalid data found/);
  });

  test("empty stdout throws rather than sending zero bytes to the model", async () => {
    await expect(
      extractFrameJpeg("/v/clip.mp4", 1, { ffmpegBin: "ffmpeg", spawn: fakeSpawn({}) }),
    ).rejects.toThrow(/no frame/i);
  });

  test("a frame over maxBytes throws instead of buffering without bound", async () => {
    await expect(
      extractFrameJpeg("/v/clip.mp4", 1, {
        ffmpegBin: "ffmpeg",
        maxBytes: 2,
        spawn: fakeSpawn({ stdout: new Uint8Array([1, 2, 3, 4]) }),
      }),
    ).rejects.toThrow(/exceeds/i);
  });

  test("a wedged ffmpeg is killed and rejects within the bound", async () => {
    await expect(
      extractFrameJpeg("/v/clip.mp4", 1, {
        ffmpegBin: "ffmpeg",
        timeoutMs: 20,
        spawn: fakeSpawn({ neverExits: true }),
      }),
    ).rejects.toThrow(/timed out/);
  });
});
