// packages/gateway/src/multimodal/frames/av-understander.test.ts
import { describe, expect, test } from "bun:test";
import type { Understander } from "../media-gate.ts";
import type { VlmProvider } from "../vlm/vlm-types.ts";
import {
  AV_SAMPLING_DISCLOSURE,
  createAvUnderstander,
  FRAME_HEADING,
  TRANSCRIPT_HEADING,
} from "./av-understander.ts";

function stt(text = "hello from the recording"): Understander {
  return {
    isLocal: true,
    model: "whisper-cli",
    isAvailable: () => Promise.resolve(true),
    understand: () => Promise.resolve({ text }),
  };
}

function vlm(opts: { text?: string; fail?: boolean; isLocal?: boolean } = {}): VlmProvider {
  return {
    providerId: "ollama",
    isLocal: opts.isLocal ?? true,
    model: "qwen2.5vl:7b",
    isAvailable: () => Promise.resolve(true),
    describe: () =>
      opts.fail === true
        ? Promise.reject(new Error("vlm down"))
        : Promise.resolve({ text: opts.text ?? "a slide" }),
  };
}

function deps(over: Partial<Parameters<typeof createAvUnderstander>[0]> = {}) {
  return createAvUnderstander({
    stt: stt(),
    vlm: vlm(),
    maxFrames: 2,
    ffmpegBin: "ffmpeg",
    ffprobeBin: "ffprobe",
    probeDuration: () => Promise.resolve(90),
    extractFrame: () => Promise.resolve(new Uint8Array([0xff, 0xd8])),
    ...over,
  });
}

/** Every assertion below is on the body text; the counts are asserted separately. */
async function bodyOf(
  u: ReturnType<typeof createAvUnderstander>,
  p = "/v/clip.mp4",
): Promise<string> {
  return (await u.understand({ kind: "path", path: p })).text;
}

describe("createAvUnderstander", () => {
  test("rejects a bytes source instead of casting — whisper/ffmpeg need a seekable file", async () => {
    await expect(
      deps().understand({ kind: "bytes", bytes: new Uint8Array([1]), mime: "video/mp4" }),
    ).rejects.toThrow(/seekable file path/);
  });

  test("captions come FIRST, then the transcript", async () => {
    const body = await bodyOf(deps());
    expect(body.indexOf(FRAME_HEADING)).toBeLessThan(body.indexOf(TRANSCRIPT_HEADING));
    expect(body).toContain("hello from the recording");
    expect(body).toContain("a slide");
  });

  test("the sampling disclosure is always present when any frame was captioned", async () => {
    expect(await bodyOf(deps())).toContain(AV_SAMPLING_DISCLOSURE);
  });

  test("each caption is timestamped so a reader can locate it in the video", async () => {
    const body = await bodyOf(deps());
    expect(body).toContain("[00:00:30]");
    expect(body).toContain("[00:01:00]");
  });

  test("the frame counts are RETURNED, not only rendered into prose", async () => {
    // The defect this pins: counts that exist only in the body never reach `item.metadata`,
    // because the gate builds `UnderstandOutcome` from what the understander returns.
    const detail = await deps().understand({ kind: "path", path: "/v/clip.mp4" });
    expect(detail.framesSampled).toBe(2);
    expect(detail.framesCaptioned).toBe(2);
  });

  test("a video that never reached sampling reports NO counts, not zeros", async () => {
    const detail = await deps({ probeDuration: () => Promise.resolve(null) }).understand({
      kind: "path",
      path: "/v/c.mp4",
    });
    expect(detail.framesSampled).toBeUndefined();
    expect(detail.framesCaptioned).toBeUndefined();
  });

  test("sampled-but-all-failed reports 0 captioned, distinct from never-sampled", async () => {
    const detail = await deps({ vlm: vlm({ fail: true }) }).understand({
      kind: "path",
      path: "/v/clip.mp4",
    });
    expect(detail.framesSampled).toBe(2);
    expect(detail.framesCaptioned).toBe(0);
  });

  test("a silent video says so rather than rendering an empty transcript heading", async () => {
    const body = await bodyOf(deps({ stt: stt("") }));
    expect(body).toContain("(No speech detected.)");
    expect(body).toContain("a slide");
    expect(body).not.toMatch(/## Transcript\n\n\s*$/);
  });

  test("no speech AND no captions REJECTS — an all-disclosure body understands nothing", async () => {
    await expect(
      deps({ stt: stt(""), vlm: vlm({ fail: true }) }).understand({
        kind: "path",
        path: "/v/silent.mp4",
      }),
    ).rejects.toThrow(/no speech and no frame captions/);
  });

  test("model names BOTH contributors, so the derived row records what produced it", () => {
    expect(deps().model).toBe("whisper-cli+qwen2.5vl:7b");
  });

  test("isLocal is true only when BOTH legs are local (I34)", () => {
    expect(deps().isLocal).toBe(true);
    expect(deps({ vlm: vlm({ isLocal: false }) }).isLocal).toBe(false);
  });

  test("availability tracks the TRANSCRIPT leg — the video is still understandable without a VLM", async () => {
    const noVlm = deps({ vlm: { ...vlm(), isAvailable: () => Promise.resolve(false) } });
    expect(await noVlm.isAvailable()).toBe(true);
    const noStt = deps({ stt: { ...stt(), isAvailable: () => Promise.resolve(false) } });
    expect(await noStt.isAvailable()).toBe(false);
  });

  test("no VLM: transcript only, and the body says why there are no captions", async () => {
    const body = await bodyOf(
      deps({ vlm: { ...vlm(), isAvailable: () => Promise.resolve(false) } }),
    );
    expect(body).toContain("hello from the recording");
    expect(body).not.toContain(FRAME_HEADING);
    expect(body).toMatch(/no vision model/i);
  });

  test("no duration (ffprobe missing): transcript only, with the reason stated", async () => {
    const body = await bodyOf(deps({ probeDuration: () => Promise.resolve(null) }), "/v/c.mp4");
    expect(body).toContain("hello from the recording");
    expect(body).toMatch(/duration could not be determined/i);
  });

  test("a per-frame failure NEVER aborts the artifact and is disclosed by count", async () => {
    let n = 0;
    const u = deps({
      extractFrame: () => {
        n += 1;
        return n === 1
          ? Promise.reject(new Error("bad frame"))
          : Promise.resolve(new Uint8Array([0xff]));
      },
    });
    const detail = await u.understand({ kind: "path", path: "/v/clip.mp4" });
    expect(detail.text).toContain("hello from the recording");
    expect(detail.text).toContain("1 of 2");
    expect(detail.framesCaptioned).toBe(1);
  });

  test("every frame failing still yields the transcript, with the count disclosed", async () => {
    const body = await bodyOf(deps({ vlm: vlm({ fail: true }) }));
    expect(body).toContain("hello from the recording");
    expect(body).toContain("0 of 2");
  });

  test("a failing TRANSCRIPT rejects — the gate must record it, not paper over it with captions", async () => {
    const bad = deps({
      stt: { ...stt(), understand: () => Promise.reject(new Error("whisper died")) },
    });
    await expect(bad.understand({ kind: "path", path: "/v/clip.mp4" })).rejects.toThrow(
      /whisper died/,
    );
  });

  test("frame captions carry their own egressMethod", async () => {
    const seen: (string | undefined)[] = [];
    await deps({
      vlm: {
        ...vlm(),
        describe: (input) => {
          seen.push(input.egressMethod);
          return Promise.resolve({ text: "a slide" });
        },
      },
    }).understand({ kind: "path", path: "/v/clip.mp4" });
    expect(seen).toEqual(["multimodal.vlm.frame", "multimodal.vlm.frame"]);
  });
});
