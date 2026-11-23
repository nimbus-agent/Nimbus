import { describe, expect, test } from "bun:test";
import type { NimbusLlmRemoteVendor, NimbusLlmToml } from "../../config/nimbus-toml.ts";
import { DEFAULT_NIMBUS_LLM_TOML } from "../../config/nimbus-toml.ts";
import { AnthropicProvider } from "../../llm/anthropic-provider.ts";
import { GeminiProvider } from "../../llm/gemini-provider.ts";
import { OpenAiProvider } from "../../llm/openai-provider.ts";
import { XaiProvider } from "../../llm/xai-provider.ts";
import { createMemoryVault } from "../../testing/bun-test-support.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import {
  defaultRouteValidationLogger,
  KNOWN_LOCAL_RUNTIMES,
  makeRemoteProvider,
  OLLAMA_DEFAULT_BASE_URL,
  type RemoteVendorId,
  resolveAgentVendor,
  resolveBaseUrl,
  resolveEnabledVendors,
} from "./llm-vendors.ts";

function vendors(
  entries: Record<string, Partial<NimbusLlmRemoteVendor>>,
): ReadonlyMap<string, NimbusLlmRemoteVendor> {
  return new Map(
    Object.entries(entries).map(([id, v]) => [id, { enabled: true, model: "m", ...v }]),
  );
}

function logger() {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

async function vaultWith(entries: Record<string, string>): Promise<NimbusVault> {
  const vault = createMemoryVault();
  for (const [k, v] of Object.entries(entries)) await vault.set(k, v);
  return vault;
}

function llmToml(remote: ReadonlyMap<string, NimbusLlmRemoteVendor>): NimbusLlmToml {
  return { ...DEFAULT_NIMBUS_LLM_TOML, remoteVendors: remote };
}

describe("resolveBaseUrl", () => {
  test("an omitted base URL resolves to the runtime's own default", () => {
    expect(resolveBaseUrl("ollama", undefined)).toBe(OLLAMA_DEFAULT_BASE_URL);
    expect(resolveBaseUrl("llamacpp", undefined)).toBe("http://127.0.0.1:8080");
  });

  test("an unknown runtime falls back to the Ollama default (the caller drops it first)", () => {
    expect(resolveBaseUrl("vllm", undefined)).toBe(OLLAMA_DEFAULT_BASE_URL);
  });

  test("a blank base URL is the same as an omitted one", () => {
    expect(resolveBaseUrl("llamacpp", "   ")).toBe("http://127.0.0.1:8080");
  });

  test("every trailing slash is stripped, and only trailing ones", () => {
    expect(resolveBaseUrl("ollama", "http://host:1/a//b///")).toBe("http://host:1/a//b");
    expect(resolveBaseUrl("ollama", "  http://host:1/  ")).toBe("http://host:1");
  });

  test("two spellings of one endpoint compare equal once resolved", () => {
    expect(resolveBaseUrl("llamacpp", undefined)).toBe(
      resolveBaseUrl("llamacpp", "http://127.0.0.1:8080/"),
    );
  });
});

describe("KNOWN_LOCAL_RUNTIMES and the default logger", () => {
  test("only ollama and llamacpp can be constructed", () => {
    expect([...KNOWN_LOCAL_RUNTIMES].sort()).toEqual(["llamacpp", "ollama"]);
  });

  test("the default route-validation logger discards a warning without throwing", () => {
    expect(() => defaultRouteValidationLogger.warn("anything")).not.toThrow();
  });
});

describe("makeRemoteProvider", () => {
  const cases: Array<[RemoteVendorId, abstract new (...a: never[]) => unknown, string]> = [
    ["anthropic", AnthropicProvider, "anthropic"],
    ["openai", OpenAiProvider, "openai"],
    ["gemini", GeminiProvider, "gemini"],
    ["xai", XaiProvider, "xai"],
  ];

  test.each(cases)("%s builds its own adapter, never another vendor's", (id, Ctor) => {
    const provider = makeRemoteProvider({
      vendorId: id,
      modelName: "model-x",
      apiKey: async () => "k",
    });
    expect(provider).toBeInstanceOf(Ctor);
    expect(provider.isLocal).toBe(false);
    for (const [, Other] of cases) {
      if (Other !== Ctor) expect(provider).not.toBeInstanceOf(Other);
    }
  });

  test("a configured base URL is passed through, an absent one is not invented", () => {
    const withUrl = makeRemoteProvider({
      vendorId: "openai",
      modelName: "m",
      apiKey: async () => "k",
      baseUrl: "https://proxy.example/v1",
    });
    const without = makeRemoteProvider({
      vendorId: "openai",
      modelName: "m",
      apiKey: async () => "k",
    });
    expect(JSON.stringify(Object.entries(withUrl))).toContain("https://proxy.example/v1");
    expect(JSON.stringify(Object.entries(without))).not.toContain("proxy.example");
  });
});

describe("resolveEnabledVendors", () => {
  test("a disabled vendor is dropped silently (the default-off norm is not an error)", async () => {
    const log = logger();
    const out = resolveEnabledVendors(
      vendors({ openai: { enabled: false } }),
      await vaultWith({}),
      log,
    );
    expect(out).toEqual([]);
    expect(log.messages).toEqual([]);
  });

  test("an unknown vendor id is dropped and named, listing the known ids", async () => {
    const log = logger();
    const out = resolveEnabledVendors(vendors({ mistral: {} }), await vaultWith({}), log);
    expect(out).toEqual([]);
    expect(log.messages).toHaveLength(1);
    expect(log.messages[0]).toContain("[llm.remote.mistral]");
    expect(log.messages[0]).toContain("anthropic, openai, gemini, xai");
  });

  test("an empty or whitespace model is dropped and named", async () => {
    const log = logger();
    const out = resolveEnabledVendors(
      vendors({ openai: { model: "" }, gemini: { model: "   " } }),
      await vaultWith({}),
      log,
    );
    expect(out).toEqual([]);
    expect(log.messages.map((m) => m.includes("empty model"))).toEqual([true, true]);
  });

  test("keeps config order and carries model and base URL, omitting an unset base URL", async () => {
    const out = resolveEnabledVendors(
      vendors({
        xai: { model: "grok", baseUrl: "https://x.example" },
        anthropic: { model: "claude" },
      }),
      await vaultWith({}),
      logger(),
    );
    expect(out.map((v) => [v.vendorId, v.modelName])).toEqual([
      ["xai", "grok"],
      ["anthropic", "claude"],
    ]);
    expect(out[0]?.baseUrl).toBe("https://x.example");
    expect(out[1]).not.toHaveProperty("baseUrl");
  });

  test("the key is read from the Vault on every call, so a key added later is picked up", async () => {
    const vault = await vaultWith({});
    const [v] = resolveEnabledVendors(vendors({ openai: {} }), vault, logger());
    expect(await v?.apiKey()).toBeUndefined();
    await vault.set("openai.api_key", "sk-later");
    expect(await v?.apiKey()).toBe("sk-later");
    await vault.set("openai.api_key", "sk-rotated");
    expect(await v?.apiKey()).toBe("sk-rotated");
  });

  test("each vendor reads its OWN vault key", async () => {
    const vault = await vaultWith({ "anthropic.api_key": "a", "gemini.api_key": "g" });
    const out = resolveEnabledVendors(
      vendors({ anthropic: {}, gemini: {}, xai: {} }),
      vault,
      logger(),
    );
    expect(await Promise.all(out.map((v) => v.apiKey()))).toEqual(["a", "g", undefined]);
  });
});

describe("resolveAgentVendor", () => {
  test("is undefined when no vendor is enabled", async () => {
    expect(await resolveAgentVendor(llmToml(vendors({})), await vaultWith({}))).toBeUndefined();
  });

  test("is undefined when the only enabled vendor has no key", async () => {
    expect(
      await resolveAgentVendor(llmToml(vendors({ openai: {} })), await vaultWith({})),
    ).toBeUndefined();
  });

  test("a whitespace-only key counts as no key", async () => {
    const vault = await vaultWith({ "openai.api_key": "   " });
    expect(await resolveAgentVendor(llmToml(vendors({ openai: {} })), vault)).toBeUndefined();
  });

  test("the FIRST enabled-and-keyed vendor in config order wins, skipping a keyless earlier one", async () => {
    const vault = await vaultWith({ "gemini.api_key": "g-key", "xai.api_key": "x-key" });
    const out = await resolveAgentVendor(
      llmToml(
        vendors({ openai: { model: "gpt" }, gemini: { model: "gem" }, xai: { model: "grok" } }),
      ),
      vault,
    );
    expect(out).toEqual({ providerId: "gemini", modelId: "gem", apiKey: "g-key" });
  });

  test("the key is materialised to a string, not left as a resolver", async () => {
    const vault = await vaultWith({ "anthropic.api_key": "ak" });
    const out = await resolveAgentVendor(llmToml(vendors({ anthropic: { model: "c" } })), vault);
    expect(typeof out?.apiKey).toBe("string");
  });

  test("a rejected vendor is warned about through the supplied logger", async () => {
    const log = logger();
    const out = await resolveAgentVendor(
      llmToml(vendors({ nonesuch: {}, openai: { model: "" } })),
      await vaultWith({}),
      log,
    );
    expect(out).toBeUndefined();
    expect(log.messages).toHaveLength(2);
  });
});
