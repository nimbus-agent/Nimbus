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
    // No output path argument: nothing on this path touches disk.
    expect(cmd.some((a) => a.endsWith(".jpg") || a.endsWith(".jpeg"))).toBe(false);
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
