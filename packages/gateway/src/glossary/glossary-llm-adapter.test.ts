import { describe, expect, it } from "bun:test";

import { LlmRouter } from "../llm/router.ts";
import type { LlmProvider, LlmProviderKind } from "../llm/types.ts";
import { createGlossaryLlm } from "./glossary-llm-adapter.ts";

function fakeProvider(
  id: LlmProviderKind,
  opts: { available: boolean; text?: string },
): LlmProvider {
  return {
    providerId: id,
    isLocal: id !== "remote",
    isAvailable: () => Promise.resolve(opts.available),
    listModels: () => Promise.resolve([]),
    generate: () =>
      Promise.resolve({
        text: opts.text ?? "{}",
        tokensIn: 0,
        tokensOut: 0,
        modelUsed: `fake-${id}`,
        isLocal: id !== "remote",
        provider: id,
      }),
  };
}

function routerWith(...providers: LlmProvider[]): LlmRouter {
  const r = new LlmRouter({
    preferLocal: true,
    remoteModel: "remote-model",
    localModel: "local-model",
    minReasoningParams: 0,
    enforceAirGap: false,
  });
  for (const p of providers) r.registerProvider(p);
  return r;
}

describe("createGlossaryLlm", () => {
  it("returns the raw text from an available local provider", async () => {
    const llm = createGlossaryLlm(
      routerWith(fakeProvider("ollama", { available: true, text: '{"isDomainTerm":true}' })),
    );
    expect(await llm.generateJson("prompt")).toBe('{"isDomainTerm":true}');
  });

  it("falls back to llamacpp when ollama is down", async () => {
    const llm = createGlossaryLlm(
      routerWith(
        fakeProvider("ollama", { available: false }),
        fakeProvider("llamacpp", { available: true, text: "from-llamacpp" }),
      ),
    );
    expect(await llm.generateJson("prompt")).toBe("from-llamacpp");
  });

  // THE load-bearing test: this is the whole "local-only, no egress" guarantee.
  it("returns null rather than using an available REMOTE provider", async () => {
    let remoteCalled = false;
    const remote = fakeProvider("remote", { available: true, text: "LEAKED" });
    const spied: LlmProvider = {
      ...remote,
      generate: (o) => {
        remoteCalled = true;
        return remote.generate(o);
      },
    };
    const llm = createGlossaryLlm(routerWith(fakeProvider("ollama", { available: false }), spied));
    expect(await llm.generateJson("prompt")).toBeNull();
    expect(remoteCalled).toBe(false);
  });

  it("returns null when no provider is available at all", async () => {
    const llm = createGlossaryLlm(routerWith(fakeProvider("ollama", { available: false })));
    expect(await llm.generateJson("prompt")).toBeNull();
  });

  it("returns null without calling a provider when the signal is already aborted", async () => {
    let called = false;
    const local = fakeProvider("ollama", { available: true, text: "x" });
    const llm = createGlossaryLlm(
      routerWith({
        ...local,
        generate: (o) => {
          called = true;
          return local.generate(o);
        },
      }),
    );
    const ac = new AbortController();
    ac.abort();
    expect(await llm.generateJson("prompt", ac.signal)).toBeNull();
    expect(called).toBe(false);
  });
});
