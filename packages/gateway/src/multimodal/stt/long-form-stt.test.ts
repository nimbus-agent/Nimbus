import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLongFormStt } from "./long-form-stt.ts";

function deps(over: Partial<Parameters<typeof createLongFormStt>[0]> = {}) {
  return {
    transcribe: async () => ({ text: "hello world" }),
    isAvailable: async () => true,
    ffmpegBin: "ffmpeg",
    scratchDir: mkdtempSync(join(tmpdir(), "nimbus-lfs-")),
    model: "whisper-base",
    spawn: ((cmd: string[]) => {
      writeFileSync(cmd[cmd.length - 1] as string, "wav");
      return { exited: Promise.resolve(0), stderr: new Response("") };
    }) as unknown as typeof Bun.spawn,
    ...over,
  };
}

describe("createLongFormStt", () => {
  test("is always local", () => {
    expect(createLongFormStt(deps()).isLocal).toBe(true);
  });

  test("rejects a bytes source instead of casting — transcodeToWav needs a path", async () => {
    const stt = createLongFormStt(deps());
    await expect(
      stt.understand({ kind: "bytes", bytes: new Uint8Array([1]), mime: "video/mp4" }),
    ).rejects.toThrow(/path source/);
  });

  test("transcodes then transcribes, returning the text", async () => {
    const stt = createLongFormStt(deps());
    expect(await stt.understand({ kind: "path", path: "/in/demo.mp4" })).toEqual({
      text: "hello world",
    });
  });

  test("passes the TRANSCODED wav to whisper, not the original", async () => {
    let given = "";
    const stt = createLongFormStt(
      deps({
        transcribe: async (p: string) => {
          given = p;
          return { text: "t" };
        },
      }),
    );
    await stt.understand({ kind: "path", path: "/in/demo.mp4" });
    expect(given.endsWith(".wav")).toBe(true);
    expect(given).not.toContain("demo.mp4");
  });

  test("deletes the scratch wav after success", async () => {
    let given = "";
    const stt = createLongFormStt(
      deps({
        transcribe: async (p: string) => {
          given = p;
          return { text: "t" };
        },
      }),
    );
    await stt.understand({ kind: "path", path: "/in/demo.mp4" });
    expect(existsSync(given)).toBe(false);
  });

  test("deletes the scratch wav when transcription THROWS", async () => {
    let given = "";
    const stt = createLongFormStt(
      deps({
        transcribe: async (p: string) => {
          given = p;
          throw new Error("whisper blew up");
        },
      }),
    );
    await expect(stt.understand({ kind: "path", path: "/in/demo.mp4" })).rejects.toThrow(
      "whisper blew up",
    );
    expect(given).not.toBe("");
    expect(existsSync(given)).toBe(false);
  });

  test("reports unavailability from the injected probe", async () => {
    const stt = createLongFormStt(deps({ isAvailable: async () => false }));
    expect(await stt.isAvailable()).toBe(false);
  });

  test("falls back to the REAL Bun.spawn when no spawn override is injected", async () => {
    // Omitting `spawn` is the other arm of `deps.spawn === undefined ? {} : { spawn }` —
    // `transcodeToWav` then uses `opts.spawn ?? Bun.spawn` for real. The input path does not
    // exist and the test environment cannot be assumed to have ffmpeg installed, so the only
    // assertion that holds unconditionally is that the call fails rather than hangs.
    const stt = createLongFormStt({
      transcribe: async () => ({ text: "hello world" }),
      isAvailable: async () => true,
      ffmpegBin: "definitely-not-a-real-ffmpeg-binary",
      scratchDir: mkdtempSync(join(tmpdir(), "nimbus-lfs-")),
      model: "whisper-base",
    });
    await expect(
      stt.understand({ kind: "path", path: "/nonexistent/demo.mp4" }),
    ).rejects.toBeDefined();
  });
});
