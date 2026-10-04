/**
 * `createOllamaVlm` arms `ollama-vlm.test.ts` does not reach: `/api/show` bodies that are not an
 * object at all, a legacy body that carries NEITHER `capabilities` nor `details.families`, the
 * `mllama` projector family, the all-defaults constructor, and a base URL with a trailing slash.
 *
 * The availability contract under test: anything short of a positive vision signal is
 * UNAVAILABLE (a refusal upstream), never a guess and never a throw.
 */
import { describe, expect, test } from "bun:test";

import { DEFAULT_VLM_BASE_URL, DEFAULT_VLM_MODEL } from "../multimodal-config.ts";
import { createOllamaVlm, type FetchLike } from "./ollama-vlm.ts";

function answering(body: string): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchImpl: (input) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(body, { status: 200, headers: { "content-type": "application/json" } }),
      );
    },
  };
}

describe("createOllamaVlm.isAvailable — bodies with no usable vision signal", () => {
  test.each([
    ["JSON null", "null"],
    ["a JSON array", '["vision"]'],
    ["a bare JSON string", '"vision"'],
  ])(
    "%s is unavailable — a non-object body cannot carry a capability list",
    async (_label, body) => {
      const { fetchImpl, urls } = answering(body);
      await expect(createOllamaVlm({ fetchImpl }).isAvailable()).resolves.toBe(false);
      expect(urls).toHaveLength(1);
    },
  );

  test("a legacy body with neither `capabilities` nor `details.families` is unavailable", async () => {
    // `details` present but family-less (a real legacy shape), and `details` absent entirely.
    for (const body of ['{"details":{"format":"gguf"}}', "{}", '{"details":null}']) {
      const { fetchImpl } = answering(body);
      await expect(createOllamaVlm({ fetchImpl }).isAvailable()).resolves.toBe(false);
    }
  });

  test("the `mllama` projector family also counts as vision, case-insensitively", async () => {
    const { fetchImpl } = answering('{"details":{"families":["llama","MLlama"]}}');
    await expect(createOllamaVlm({ fetchImpl }).isAvailable()).resolves.toBe(true);
    // Control: a non-string family entry never matches, even beside a plausible one.
    const { fetchImpl: odd } = answering('{"details":{"families":[42,null,"llama"]}}');
    await expect(createOllamaVlm({ fetchImpl: odd }).isAvailable()).resolves.toBe(false);
  });
});

describe("createOllamaVlm — construction", () => {
  test("with no options it targets the local default daemon and model, and is LOCAL", () => {
    const vlm = createOllamaVlm();
    expect(vlm.providerId).toBe("ollama");
    expect(vlm.model).toBe(DEFAULT_VLM_MODEL);
    // Derived from DEFAULT_VLM_BASE_URL (a loopback URL), not asserted by fiat (I34).
    expect(DEFAULT_VLM_BASE_URL.startsWith("http://127.0.0.1")).toBe(true);
    expect(vlm.isLocal).toBe(true);
  });

  test("a trailing slash on the base URL is dropped, so endpoints never carry `//api`", async () => {
    const { fetchImpl, urls } = answering('{"capabilities":["vision"]}');
    const vlm = createOllamaVlm({ baseUrl: "http://127.0.0.1:11434/", fetchImpl });
    await expect(vlm.isAvailable()).resolves.toBe(true);
    expect(urls).toEqual(["http://127.0.0.1:11434/api/show"]);
  });
});
