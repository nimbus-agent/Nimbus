import { describe, expect, test } from "bun:test";
import { createRemoteVlm } from "./remote-vlm-shared.ts";

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
const b64 = Buffer.from(BYTES).toString("base64");

function capture(): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchImpl: (u: string | URL | Request, i?: RequestInit) => Promise<Response>;
  reply: (body: unknown, status?: number) => void;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let next: { body: unknown; status: number } = { body: {}, status: 200 };
  return {
    calls,
    reply: (body, status = 200) => {
      next = { body, status };
    },
    fetchImpl: async (u, i) => {
      calls.push({ url: String(u), init: i ?? {} });
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

describe("anthropic", () => {
  test("sends media_type and base64 data, and reads the caption back", async () => {
    const c = capture();
    c.reply({ content: [{ type: "text", text: "a knife diagram" }] });
    const p = createRemoteVlm({
      vendor: "anthropic",
      apiKey: async () => "sk-ant-SECRET",
      fetchImpl: c.fetchImpl,
    });
    const out = await p.describe({ bytes: BYTES, prompt: "describe", mimeType: "image/jpeg" });
    expect(out.text).toBe("a knife diagram");

    const body = JSON.parse(String(c.calls[0]?.init.body));
    const image = body.messages[0].content.find((x: { type: string }) => x.type === "image");
    expect(image.source).toMatchObject({ type: "base64", media_type: "image/jpeg", data: b64 });
    expect(c.calls[0]?.init.headers).toMatchObject({ "x-api-key": "sk-ant-SECRET" });
  });

  /** Anthropic returns HTTP 400 without a media_type — refuse before spending the request. */
  test("REFUSES to send when mimeType is absent", async () => {
    const c = capture();
    const p = createRemoteVlm({
      vendor: "anthropic",
      apiKey: async () => "k",
      fetchImpl: c.fetchImpl,
    });
    await expect(p.describe({ bytes: BYTES, prompt: "d" })).rejects.toThrow(/mimeType/);
    expect(c.calls).toHaveLength(0);
  });
});

describe("openai", () => {
  test("sends a data: URL carrying the mime, and reads the caption back", async () => {
    const c = capture();
    c.reply({ choices: [{ message: { content: "a chart" } }] });
    const p = createRemoteVlm({
      vendor: "openai",
      apiKey: async () => "sk-SECRET",
      fetchImpl: c.fetchImpl,
    });
    expect((await p.describe({ bytes: BYTES, prompt: "d", mimeType: "image/png" })).text).toBe(
      "a chart",
    );
    const body = JSON.parse(String(c.calls[0]?.init.body));
    const img = body.messages[0].content.find((x: { type: string }) => x.type === "image_url");
    expect(img.image_url.url).toBe(`data:image/png;base64,${b64}`);
  });
});

describe("gemini", () => {
  test("sends inline_data with mime_type, and reads the caption back", async () => {
    const c = capture();
    c.reply({ candidates: [{ content: { parts: [{ text: "a photo" }] } }] });
    const p = createRemoteVlm({
      vendor: "gemini",
      apiKey: async () => "g-SECRET",
      fetchImpl: c.fetchImpl,
    });
    expect((await p.describe({ bytes: BYTES, prompt: "d", mimeType: "image/jpeg" })).text).toBe(
      "a photo",
    );
    const body = JSON.parse(String(c.calls[0]?.init.body));
    expect(body.contents[0].parts[1].inline_data).toMatchObject({ mime_type: "image/jpeg" });
  });
});

describe("every vendor", () => {
  test.each(["anthropic", "openai", "gemini"] as const)(
    "%s declares isLocal false — hardcoded, never derived from a URL (I34)",
    (vendor) => {
      expect(createRemoteVlm({ vendor, apiKey: async () => "k" }).isLocal).toBe(false);
    },
  );

  test.each(["anthropic", "openai", "gemini"] as const)(
    "%s refuses with no key BEFORE making a request",
    async (vendor) => {
      const c = capture();
      const p = createRemoteVlm({ vendor, apiKey: async () => null, fetchImpl: c.fetchImpl });
      await expect(
        p.describe({ bytes: BYTES, prompt: "d", mimeType: "image/jpeg" }),
      ).rejects.toThrow();
      expect(c.calls).toHaveLength(0);
    },
  );

  /**
   * A vendor error body can quote the submitted key back, and this text reaches the user through
   * the pass summary. Only the STATUS may be surfaced.
   */
  test.each(["anthropic", "openai", "gemini"] as const)(
    "%s never echoes the vendor's error body",
    async (vendor) => {
      const c = capture();
      c.reply({ error: { message: "invalid key sk-ant-SECRET-LEAKED" } }, 401);
      const p = createRemoteVlm({ vendor, apiKey: async () => "k", fetchImpl: c.fetchImpl });
      await expect(
        p.describe({ bytes: BYTES, prompt: "d", mimeType: "image/jpeg" }),
      ).rejects.toThrow(/^(?!.*SECRET-LEAKED).*$/s);
    },
  );

  /** No round-trip: a probe would be an unledgered outbound request, and there is no fallback. */
  test.each(["anthropic", "openai", "gemini"] as const)(
    "%s isAvailable is key-presence only, making no request",
    async (vendor) => {
      const c = capture();
      const p = createRemoteVlm({ vendor, apiKey: async () => "k", fetchImpl: c.fetchImpl });
      expect(await p.isAvailable()).toBe(true);
      expect(c.calls).toHaveLength(0);
    },
  );
});
