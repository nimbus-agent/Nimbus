import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { isLoopbackBaseUrl } from "./base-url-locality.ts";
import { LlamaCppProvider } from "./llamacpp-provider.ts";
import { OllamaProvider } from "./ollama-provider.ts";
import { LlmRouter, type LlmRouterConfig } from "./router.ts";

describe("isLoopbackBaseUrl", () => {
  test("accepts the loopback forms a user would actually write", () => {
    for (const url of [
      "http://127.0.0.1:11434",
      "http://127.0.0.1:8080/",
      "http://127.1.2.3:8080", // the whole of 127.0.0.0/8, not just .0.0.1
      "http://localhost:11434",
      "http://LOCALHOST:11434",
      // `URL` normalises IPv6: the expanded form compresses to `::1`, and the IPv4-mapped
      // form is re-spelled in hex as `::ffff:7f00:1`.
      "http://[::1]:8080",
      "http://[0:0:0:0:0:0:0:1]:8080",
      "http://[::ffff:127.0.0.1]:8080",
      "http://[::ffff:127.255.0.1]:8080",
      "https://127.0.0.1:8443",
    ]) {
      expect(isLoopbackBaseUrl(url)).toBe(true);
    }
  });

  test("rejects every off-machine host", () => {
    for (const url of [
      "http://192.168.1.50:8080", // the LAN box from the finding
      "http://10.0.0.4:11434",
      "http://ollama.internal:11434",
      "https://api.example.com",
      "http://0.0.0.0:11434", // binds everywhere; is not loopback
      "http://[fe80::1]:8080",
      "http://[::ffff:10.0.0.1]:8080",
      "http://127.0.0.999:8080", // not a valid IPv4 at all — `URL` itself rejects it
    ]) {
      expect(isLoopbackBaseUrl(url)).toBe(false);
    }
  });

  test("fails CLOSED on an unparseable URL", () => {
    // We cannot prove the traffic stays here, so it does not count as local.
    for (const url of ["", "not a url", "127.0.0.1:11434", "://127.0.0.1"]) {
      expect(isLoopbackBaseUrl(url)).toBe(false);
    }
  });
});

describe("provider isLocal is derived from the base URL, not hardcoded", () => {
  test("a loopback provider is local", () => {
    expect(new OllamaProvider("http://127.0.0.1:11434").isLocal).toBe(true);
    expect(new LlamaCppProvider("http://127.0.0.1:8080").isLocal).toBe(true);
    // The zero-argument defaults both point at loopback.
    expect(new OllamaProvider().isLocal).toBe(true);
    expect(new LlamaCppProvider().isLocal).toBe(true);
  });

  test("a LAN provider is NOT local, whatever its runtime is called", () => {
    expect(new OllamaProvider("http://192.168.1.50:11434").isLocal).toBe(false);
    expect(new LlamaCppProvider("http://192.168.1.50:8080").isLocal).toBe(false);
  });
});

const AIR_GAPPED: LlmRouterConfig = {
  preferLocal: true,
  remoteModel: "claude-sonnet-4-6",
  localModel: "m.gguf",
  minReasoningParams: 0,
  enforceAirGap: true,
};

describe("enforce_air_gap refuses a non-loopback [llm.local.*] route", () => {
  const realFetch = globalThis.fetch;
  let urls: string[] = [];

  beforeEach(() => {
    urls = [];
    // Every request SUCCEEDS. If the route is skipped it is because of air-gap and nothing
    // else — a failing daemon would make this test pass for the wrong reason.
    globalThis.fetch = mock(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/health")) return new Response("ok");
      if (url.endsWith("/api/tags")) {
        return Response.json({ models: [{ name: "m.gguf" }] });
      }
      return Response.json({ content: "LEAKED", timings: { prompt_n: 1, predicted_n: 1 } });
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("a LAN llama.cpp route is never selected, and NO byte of the prompt reaches it", async () => {
    const router = new LlmRouter(AIR_GAPPED);
    router.registerRoute(new LlamaCppProvider("http://192.168.1.50:8080", "m.gguf"), "m.gguf");

    expect(await router.selectRoute("reasoning")).toBeUndefined();
    await expect(
      router.generate({ task: "reasoning", prompt: "a secret from the private index" }),
    ).rejects.toThrow("No LLM provider available");

    // The assertion that actually matters. `rejects.toThrow` alone would stay green if the
    // route had been probed, or generated, and then thrown for some later reason: air-gap is
    // a REFUSAL, so the host must see zero requests of any kind.
    expect(urls.filter((u) => u.includes("192.168.1.50"))).toEqual([]);
  });

  test("a LAN Ollama route is refused the same way — the vendor id is irrelevant", async () => {
    const router = new LlmRouter(AIR_GAPPED);
    router.registerRoute(new OllamaProvider("http://192.168.1.50:11434", "m.gguf"), "m.gguf");
    expect(await router.selectRoute("reasoning")).toBeUndefined();
    expect(urls.filter((u) => u.includes("192.168.1.50"))).toEqual([]);
  });

  test("a loopback route on the SAME runtime is still selected under air-gap", async () => {
    // The other half: the fix must refuse the LAN host without breaking local llama.cpp.
    const router = new LlmRouter(AIR_GAPPED);
    router.registerRoute(new LlamaCppProvider("http://127.0.0.1:8080", "m.gguf"), "m.gguf");
    const route = await router.selectRoute("reasoning");
    expect(route?.routeId).toBe("llamacpp/m.gguf");
  });

  test("with air-gap OFF the LAN route is usable — reclassified, not disabled", async () => {
    const router = new LlmRouter({ ...AIR_GAPPED, enforceAirGap: false });
    router.registerRoute(new LlamaCppProvider("http://192.168.1.50:8080", "m.gguf"), "m.gguf");
    const route = await router.selectRoute("reasoning");
    expect(route?.routeId).toBe("llamacpp/m.gguf");
    // ...and it reports itself as REMOTE, which is what makes `egress/synthesis-egress.ts`
    // ledger it (I29) and `[agents] synthesis = "local"` refuse it.
    expect(route?.provider.isLocal).toBe(false);
  });

  test("a LAN route's generate() result declares itself remote", async () => {
    const provider = new LlamaCppProvider("http://192.168.1.50:8080", "m.gguf");
    const result = await provider.generate({ task: "reasoning", prompt: "x" });
    expect(result.isLocal).toBe(false);
  });
});
