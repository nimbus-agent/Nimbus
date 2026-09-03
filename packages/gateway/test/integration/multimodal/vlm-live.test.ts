// packages/gateway/test/integration/multimodal/vlm-live.test.ts
/**
 * Exercised only when a real Ollama with a vision model is reachable. Fakes prove the ENDS
 * (our adapter, and a stand-in daemon); only this proves the WIRE — that `/api/show`'s
 * `capabilities` field and `/api/generate`'s `images` array are shaped the way `ollama-vlm.ts`
 * assumes. Set NIMBUS_TEST_VLM=1 to opt in.
 *
 * No CI runner has Ollama or a VLM (spec § 11.3), so this never runs there — and it never runs on
 * a Windows dev box either unless the developer deliberately starts Ollama. It exists so the wire
 * is exercised at least once by something other than a fake, which is the only thing that catches
 * a contract mismatch between our request shape and Ollama's real one.
 */
import { describe, expect, test } from "bun:test";
import { createOllamaVlm } from "../../../src/multimodal/vlm/ollama-vlm.ts";

const OPTED_IN = process.env["NIMBUS_TEST_VLM"] === "1";

describe.skipIf(!OPTED_IN)("Ollama VLM (live)", () => {
  test("a real daemon reports the vision capability and captions a 1x1 PNG", async () => {
    const vlm = createOllamaVlm({});
    expect(await vlm.isAvailable()).toBe(true);
    // Smallest valid PNG: a single white pixel.
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
      "base64",
    );
    const { text } = await vlm.describe({
      bytes: new Uint8Array(png),
      prompt: "Describe this image in one sentence.",
    });
    expect(text.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
