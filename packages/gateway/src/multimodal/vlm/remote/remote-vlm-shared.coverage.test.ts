/**
 * Remote-VLM response and transport shapes `remote-vlm.test.ts` leaves unexercised: wrong-shaped
 * caption paths for each vendor (every one must be the typed "no caption text" refusal, never a
 * raw `TypeError` or an empty success), and a fetch that throws — which may surface its error NAME
 * only, never its message, because a fetch failure message embeds the URL and Gemini's URL carries
 * the API key.
 */
import { describe, expect, test } from "bun:test";
import { LlmProviderError } from "../../../llm/provider-error.ts";
import type { RemoteVlmVendor } from "../../media-types.ts";
import type { FetchLike } from "../ollama-vlm.ts";
import { createRemoteVlm } from "./remote-vlm-shared.ts";

const INPUT = {
  bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x01]),
  prompt: "describe",
  mimeType: "image/jpeg",
};

function answering(body: unknown): FetchLike {
  return () => Promise.resolve(Response.json(body));
}

async function failure(vendor: RemoteVlmVendor, fetchImpl: FetchLike): Promise<LlmProviderError> {
  const p = createRemoteVlm({ vendor, apiKey: () => Promise.resolve("k-SECRET-123"), fetchImpl });
  const outcome: unknown = await p.describe(INPUT).then(
    (v) => ({ resolved: v }),
    (e: unknown) => e,
  );
  if (!(outcome instanceof LlmProviderError)) {
    throw new Error(`expected an LlmProviderError, got ${JSON.stringify(outcome)}`);
  }
  return outcome;
}

describe("a caption at the wrong shape is a typed refusal", () => {
  test.each<readonly [RemoteVlmVendor, string, unknown]>([
    ["anthropic", "content that is not an array", { content: { type: "text", text: "a cat" } }],
    [
      "anthropic",
      "content with no text block",
      { content: [{ type: "image" }, { type: "tool_use" }] },
    ],
    [
      "anthropic",
      "a text block whose text is not a string",
      { content: [{ type: "text", text: 7 }] },
    ],
    [
      "anthropic",
      // A string `text` on a block that is not of type "text" (a `thinking` block, say) is not
      // the caption: the scan keys on the block's own type, never on the field being present.
      "a non-text block carrying a string text field",
      { content: [{ type: "thinking", text: "internal reasoning, not a caption" }] },
    ],
    ["anthropic", "a root that is an array", [{ type: "text", text: "a cat" }]],
    ["openai", "choices that is not an array", { choices: { message: { content: "a cat" } } }],
    ["openai", "a choice that is not an object", { choices: ["a cat"] }],
    ["openai", "content that is not a string", { choices: [{ message: { content: ["a cat"] } }] }],
    ["openai", "a null message", { choices: [{ message: null }] }],
    [
      "gemini",
      "parts that is not an array",
      { candidates: [{ content: { parts: { text: "a cat" } } }] },
    ],
    ["gemini", "no candidates", {}],
  ])("%s: %s", async (vendor, _label, body) => {
    const e = await failure(vendor, answering(body));
    expect(e.message).toBe(`${vendor} vlm: response carried no caption text`);
    expect(e.kind).toBe("transport");
  });
});

describe("a fetch that throws", () => {
  test("surfaces the error NAME only — the message (which can carry the key-bearing URL) never", async () => {
    let requestedUrl = "";
    const e = await failure("gemini", (url) => {
      requestedUrl = String(url);
      return Promise.reject(new TypeError(`fetch failed: ${String(url)}`));
    });
    // Premise: the key really is in the URL this vendor builds, so a leaked message WOULD leak it.
    expect(requestedUrl).toContain("key=k-SECRET-123");
    expect(e.message).toBe("gemini vlm: request failed: TypeError");
    expect(e.message).not.toContain("SECRET");
    expect(e.kind).toBe("transport");
    expect(e.status).toBeUndefined();
  });

  test("a non-Error rejection is reported as unknown", async () => {
    const e = await failure("openai", () => Promise.reject("socket hang up"));
    expect(e.message).toBe("openai vlm: request failed: unknown");
    expect(e.kind).toBe("transport");
  });
});
