import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveFfmpegBin,
  sweepStaleScratchFiles,
  transcodeToWav,
  withScratchFile,
} from "./ffmpeg-bin.ts";

describe("resolveFfmpegBin", () => {
  test("prefers an explicit configured path", () => {
    expect(resolveFfmpegBin("/opt/ffmpeg", () => null)).toBe("/opt/ffmpeg");
  });

  test("falls back to PATH lookup", () => {
    expect(resolveFfmpegBin(undefined, (n) => (n === "ffmpeg" ? "/usr/bin/ffmpeg" : null))).toBe(
      "ffmpeg",
    );
  });

  test("returns the bare name when nothing resolves, so the spawn error names it", () => {
    expect(resolveFfmpegBin(undefined, () => null)).toBe("ffmpeg");
  });
});

describe("transcodeToWav", () => {
  test("builds a 16 kHz mono PCM command and returns the scratch path", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    let seen: string[] = [];
    const out = await transcodeToWav("/in/demo.mp4", {
      ffmpegBin: "ffmpeg",
      scratchDir: scratch,
      // `stderr` is a ReadableStream, which is what Bun.spawn({stderr:"pipe"}) actually returns.
      // An earlier draft of this plan had the fake return a `Response` here while production code
      // wrapped it in `new Response(...)` — the fake and the real thing disagreed, so the test
      // proved nothing about the wire. `.body` is the stream.
      spawn: ((cmd: string[]) => {
        seen = cmd;
        writeFileSync(cmd[cmd.length - 1] as string, "wav");
        return { exited: Promise.resolve(0), stderr: new Response("").body, kill: () => undefined };
      }) as unknown as typeof Bun.spawn,
    });

    expect(seen).toContain("-ar");
    expect(seen).toContain("16000");
    expect(seen).toContain("-ac");
    expect(seen).toContain("1");
    expect(seen[0]).toBe("ffmpeg");
    expect(out.endsWith(".wav")).toBe(true);
    expect(out.startsWith(scratch)).toBe(true);
  });

  test("throws when ffmpeg exits non-zero", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    await expect(
      transcodeToWav("/in/demo.mp4", {
        ffmpegBin: "ffmpeg",
        scratchDir: scratch,
        spawn: (() => ({
          exited: Promise.resolve(1),
          stderr: new Response("boom").body,
          kill: () => undefined,
        })) as unknown as typeof Bun.spawn,
      }),
    ).rejects.toThrow(/ffmpeg/);
  });
});

describe("withScratchFile", () => {
  test("deletes the file after a successful callback", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    const f = join(scratch, "a.wav");
    writeFileSync(f, "x");
    await withScratchFile(f, async () => "done");
    expect(existsSync(f)).toBe(false);
  });

  test("deletes the file when the callback THROWS — the finally is the contract", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    const f = join(scratch, "b.wav");
    writeFileSync(f, "x");
    await expect(
      withScratchFile(f, async () => {
        throw new Error("kaboom");
      }),
    ).rejects.toThrow("kaboom");
    expect(existsSync(f)).toBe(false);
  });

  test("does not throw when the file is already gone", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    const f = join(scratch, "missing.wav");
    await expect(withScratchFile(f, async () => 1)).resolves.toBe(1);
  });
});

describe("transcodeToWav timeout", () => {
  test("kills the process and throws when it never exits", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    let killed = 0;
    await expect(
      transcodeToWav("/in/hangs.mp4", {
        ffmpegBin: "ffmpeg",
        scratchDir: scratch,
        timeoutMs: 20,
        spawn: (() => ({
          // Never settles — the hang this bound exists for.
          exited: new Promise<number>(() => undefined),
          stderr: new Response("").body,
          kill: () => {
            killed += 1;
          },
        })) as unknown as typeof Bun.spawn,
      }),
    ).rejects.toThrow(/timed out/);
    expect(killed).toBe(1);
  });
});

describe("sweepStaleScratchFiles", () => {
  test("removes an old scratch wav a dead process left behind", () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-sweep-"));
    const old = join(scratch, "nimbus-stt-old.wav");
    writeFileSync(old, "x");
    utimesSync(old, new Date(0), new Date(0));
    expect(sweepStaleScratchFiles(scratch, Date.now())).toBe(1);
    expect(existsSync(old)).toBe(false);
  });

  test("leaves a RECENT scratch wav alone — a concurrent pass may be using it", () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-sweep-"));
    const fresh = join(scratch, "nimbus-stt-fresh.wav");
    writeFileSync(fresh, "x");
    expect(sweepStaleScratchFiles(scratch, Date.now())).toBe(0);
    expect(existsSync(fresh)).toBe(true);
  });

  test("never touches a file it did not create", () => {
    const scratch = mkdtempSync(join(tmpdir(), "nimbus-sweep-"));
    const foreign = join(scratch, "someone-elses.wav");
    writeFileSync(foreign, "x");
    utimesSync(foreign, new Date(0), new Date(0));
    expect(sweepStaleScratchFiles(scratch, Date.now())).toBe(0);
    expect(existsSync(foreign)).toBe(true);
  });

  test("returns 0 for a directory that does not exist", () => {
    expect(sweepStaleScratchFiles(join(tmpdir(), "nimbus-not-here-xyz"), Date.now())).toBe(0);
  });
});
