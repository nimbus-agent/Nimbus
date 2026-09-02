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

  test("transcodes then transcribes, returning the text", async () => {
    const stt = createLongFormStt(deps());
    expect(await stt.understand("/in/demo.mp4")).toBe("hello world");
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
    await stt.understand("/in/demo.mp4");
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
    await stt.understand("/in/demo.mp4");
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
    await expect(stt.understand("/in/demo.mp4")).rejects.toThrow("whisper blew up");
    expect(given).not.toBe("");
    expect(existsSync(given)).toBe(false);
  });

  test("reports unavailability from the injected probe", async () => {
    const stt = createLongFormStt(deps({ isAvailable: async () => false }));
    expect(await stt.isAvailable()).toBe(false);
  });
});
