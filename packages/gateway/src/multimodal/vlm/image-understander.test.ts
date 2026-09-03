// packages/gateway/src/multimodal/vlm/image-understander.test.ts
import { describe, expect, test } from "bun:test";
import { IMAGE_CAPTION_PROMPT } from "./caption-prompts.ts";
import { createImageUnderstander } from "./image-understander.ts";
import type { VlmDescribeInput, VlmProvider } from "./vlm-types.ts";

function vlmSpy(text = "A whiteboard.\nVisible text: none"): {
  provider: VlmProvider;
  calls: VlmDescribeInput[];
} {
  const calls: VlmDescribeInput[] = [];
  return {
    calls,
    provider: {
      providerId: "ollama",
      isLocal: true,
      model: "qwen2.5vl:7b",
      isAvailable: () => Promise.resolve(true),
      describe: (input) => {
        calls.push(input);
        return Promise.resolve({ text });
      },
    },
  };
}

describe("createImageUnderstander", () => {
  test("isLocal MIRRORS the provider — it is never hardcoded (I34)", () => {
    const local = vlmSpy().provider;
    expect(createImageUnderstander({ vlm: local }).isLocal).toBe(true);
    const remote: VlmProvider = { ...local, isLocal: false };
    expect(createImageUnderstander({ vlm: remote }).isLocal).toBe(false);
  });

  test("model is the provider's model, so the derived row records what produced it", () => {
    expect(createImageUnderstander({ vlm: vlmSpy().provider }).model).toBe("qwen2.5vl:7b");
  });

  test("understand reads the file into memory and sends the caption prompt", async () => {
    const spy = vlmSpy();
    const bytes = new Uint8Array([9, 8, 7]);
    const u = createImageUnderstander({
      vlm: spy.provider,
      readFile: () => Promise.resolve(bytes),
    });
    const detail = await u.understand("/photos/board.png");
    expect(detail.text).toBe("A whiteboard.\nVisible text: none");
    // An image was never sampled, so it reports no frame counts at all — distinct from a video
    // whose every frame failed, which reports `0 of N`.
    expect(detail.framesSampled).toBeUndefined();
    expect(spy.calls).toHaveLength(1);
    expect(spy.calls[0]?.bytes).toBe(bytes);
    expect(spy.calls[0]?.prompt).toBe(IMAGE_CAPTION_PROMPT);
    expect(spy.calls[0]?.egressMethod).toBe("multimodal.vlm.image");
  });

  test("an unreadable file REJECTS, so the gate records a reason rather than writing an empty row", async () => {
    const u = createImageUnderstander({
      vlm: vlmSpy().provider,
      readFile: () => Promise.reject(new Error("EACCES")),
    });
    await expect(u.understand("/photos/locked.png")).rejects.toThrow(/EACCES/);
  });

  test("an empty caption REJECTS rather than writing a row that claims nothing", async () => {
    const u = createImageUnderstander({
      vlm: vlmSpy("   ").provider,
      readFile: () => Promise.resolve(new Uint8Array([1])),
    });
    await expect(u.understand("/photos/x.png")).rejects.toThrow(/empty caption/i);
  });

  test("a zero-byte file REJECTS before the model is contacted", async () => {
    // `Buffer.from(new Uint8Array()).toString("base64")` is `""`, so this would POST
    // `images: [""]` and spend a round-trip earning a 400 that surfaces as the vaguer
    // `transcribe_failed`. Refusing here keeps the reason precise and the call unmade.
    const spy = vlmSpy();
    const u = createImageUnderstander({
      vlm: spy.provider,
      readFile: () => Promise.resolve(new Uint8Array()),
    });
    await expect(u.understand("/photos/empty.png")).rejects.toThrow(/empty/i);
    expect(spy.calls).toHaveLength(0);
  });

  test("isAvailable delegates to the provider", async () => {
    const spy = vlmSpy();
    const unavailable: VlmProvider = { ...spy.provider, isAvailable: () => Promise.resolve(false) };
    expect(await createImageUnderstander({ vlm: unavailable }).isAvailable()).toBe(false);
  });
});
