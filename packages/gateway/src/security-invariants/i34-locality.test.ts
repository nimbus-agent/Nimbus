import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { readDirFiles } from "../../test/helpers/security-invariants.ts";
import { AnthropicProvider } from "../llm/anthropic-provider.ts";
import { GeminiProvider } from "../llm/gemini-provider.ts";
import { LlamaCppProvider } from "../llm/llamacpp-provider.ts";
import { OllamaProvider } from "../llm/ollama-provider.ts";
import { OpenAiProvider } from "../llm/openai-provider.ts";
import { XaiProvider } from "../llm/xai-provider.ts";

describe("I34 — locality is declared once, and a cloud adapter can never claim to be local", () => {
  // Air-gap refusal AND the I29 `model` appender both read `provider.isLocal`. A wrong
  // `true` is one word and silent in both directions: the prompt leaves under a setting
  // that promised it would not, and no ledger row records that it did.

  test("a local runtime pointed at a LAN box is NOT local", () => {
    // Slice 1's fix. `base_url` is user-configurable and `[llm.local.*]` accepts a remote
    // host, so a hardcoded `true` here defeated `enforce_air_gap` entirely.
    expect(new OllamaProvider("http://192.168.1.50:11434", "m").isLocal).toBe(false);
    expect(new LlamaCppProvider("http://192.168.1.50:8080", "m").isLocal).toBe(false);
  });

  test("a local runtime on loopback IS local", () => {
    expect(new OllamaProvider("http://127.0.0.1:11434", "m").isLocal).toBe(true);
    expect(new LlamaCppProvider("http://localhost:8080", "m").isLocal).toBe(true);
  });

  test("locality is derived from the base URL, never from a vendor id", async () => {
    // One definition site. Three copies of this fact is what produced the hardcoded-env
    // bug in the Windows sandbox work; `LOCAL_PROVIDER_IDS` and its two duplicates were
    // deleted in slice 1 and must not come back.
    const files = await readDirFiles("packages/gateway/src");
    const offenders = files
      .filter((f) => /LOCAL_PROVIDER_IDS|LOCAL_PROVIDERS\s*=/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("every cloud adapter reports isLocal === false, even on a loopback base_url", () => {
    // The INVERSE of the local-runtime rule above, and the case slice 2a could not write because
    // no cloud adapter existed. A LiteLLM-style proxy on 127.0.0.1 FORWARDS to the vendor, so
    // deriving locality from the URL here would reopen the air-gap bypass slice 1 closed --
    // through the opposite door.
    const apiKey = async (): Promise<string | undefined> => "k";
    const baseUrl = "http://127.0.0.1:4000";
    expect(new AnthropicProvider({ apiKey, modelName: "m", baseUrl }).isLocal).toBe(false);
    expect(new OpenAiProvider({ apiKey, modelName: "m", baseUrl }).isLocal).toBe(false);
    expect(new GeminiProvider({ apiKey, modelName: "m", baseUrl }).isLocal).toBe(false);
    expect(new XaiProvider({ apiKey, modelName: "m", baseUrl }).isLocal).toBe(false);
  });

  test("no cloud adapter derives locality from the base URL", async () => {
    // Structural complement to the four value assertions above: a future adapter that imported
    // `isLoopbackBaseUrl` would be DERIVING locality, which is exactly the mistake I34 names.
    // Scoped to the cloud adapters -- the two local runtimes import it correctly and by design.
    const files = await readDirFiles("packages/gateway/src/llm");
    const offenders = files
      .filter((f) => /-provider.ts$/.test(f.rel) && !/^(ollama|llamacpp)-/.test(f.rel))
      .filter((f) => /isLoopbackBaseUrl/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("isLoopbackBaseUrl has exactly one definition site", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const definers = files
      .filter((f) => /export function isLoopbackBaseUrl\b/.test(stripComments(f.contents)))
      .map((f) => `packages/gateway/src/${f.rel}`);
    expect(definers).toEqual(["packages/gateway/src/llm/base-url-locality.ts"]);
  });
});
