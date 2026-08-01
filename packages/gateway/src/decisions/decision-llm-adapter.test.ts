import { describe, expect, it, test } from "bun:test";

import { LlmRouter } from "../llm/router.ts";
import type { LlmProvider, LlmProviderKind } from "../llm/types.ts";
import {
  buildExtractionPrompt,
  createDecisionLlm,
  type DecisionLlm,
  extractDecision,
  parseExtraction,
} from "./decision-llm-adapter.ts";

function fakeLlm(reply: string): DecisionLlm {
  return { complete: async () => reply };
}

function fakeProvider(
  id: LlmProviderKind,
  opts: { available: boolean; text?: string },
): LlmProvider {
  return {
    providerId: id,
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

test("the prompt contains the sentence and demands strict JSON", () => {
  const p = buildExtractionPrompt("We decided to adopt Postgres.", "surrounding text");
  expect(p).toContain("We decided to adopt Postgres.");
  expect(p).toContain("JSON");
});

test("parses a decision with rationale and alternatives", () => {
  const out = parseExtraction(
    '{"is_decision":true,"statement":"Adopt Postgres","rationale":"pool exhaustion","alternatives":["MySQL","shard"]}',
  );
  expect(out).toEqual({
    kind: "decision",
    statement: "Adopt Postgres",
    rationale: "pool exhaustion",
    alternatives: ["MySQL", "shard"],
  });
});

test("parses a veto", () => {
  expect(parseExtraction('{"is_decision":false}')).toEqual({ kind: "veto" });
});

test("tolerates a model that wraps JSON in prose or a fenced block", () => {
  const out = parseExtraction(
    'Sure!\n```json\n{"is_decision":true,"statement":"Adopt Postgres"}\n```\nHope that helps.',
  );
  expect(out.kind).toBe("decision");
});

// A local model returning junk must be a VETO-free failure: the row stays
// pending and retries with backoff. Silently treating garbage as a veto would
// permanently discard a real decision.
test("throws on unparseable output rather than vetoing", () => {
  expect(() => parseExtraction("I could not determine that.")).toThrow();
});

test("throws when is_decision is true but no statement is given", () => {
  expect(() => parseExtraction('{"is_decision":true}')).toThrow();
});

test('throws when is_decision is the string "true" rather than a boolean', () => {
  expect(() => parseExtraction('{"is_decision":"true","statement":"X"}')).toThrow();
});

test("throws when is_decision is absent", () => {
  expect(() => parseExtraction('{"statement":"X"}')).toThrow();
});

test("throws when is_decision is a number", () => {
  expect(() => parseExtraction('{"is_decision":1,"statement":"X"}')).toThrow();
});

test("a non-array alternatives field degrades to an empty list", () => {
  const out = parseExtraction('{"is_decision":true,"statement":"X","alternatives":"nope"}');
  expect(out).toEqual({ kind: "decision", statement: "X", rationale: null, alternatives: [] });
});

test("extractDecision round-trips through an injected llm", async () => {
  const out = await extractDecision(
    fakeLlm('{"is_decision":true,"statement":"Adopt Postgres"}'),
    "We decided to adopt Postgres.",
    "ctx",
  );
  expect(out?.kind).toBe("decision");
});

test("extractDecision returns null when complete returns null (no model available)", async () => {
  const noModelLlm: DecisionLlm = { complete: async () => null };
  const out = await extractDecision(noModelLlm, "We decided to adopt Postgres.", "ctx");
  expect(out).toBeNull();
});

test("extractDecision still throws on malformed non-null output", async () => {
  await expect(
    extractDecision(fakeLlm("not json at all"), "We decided to adopt Postgres.", "ctx"),
  ).rejects.toThrow();
});

describe("createDecisionLlm", () => {
  it("returns the raw text from an available local provider", async () => {
    const llm = createDecisionLlm(
      routerWith(fakeProvider("ollama", { available: true, text: '{"is_decision":false}' })),
    );
    expect(await llm.complete("prompt")).toBe('{"is_decision":false}');
  });

  it("falls back to llamacpp when ollama is down", async () => {
    const llm = createDecisionLlm(
      routerWith(
        fakeProvider("ollama", { available: false }),
        fakeProvider("llamacpp", { available: true, text: "from-llamacpp" }),
      ),
    );
    expect(await llm.complete("prompt")).toBe("from-llamacpp");
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
    const llm = createDecisionLlm(routerWith(fakeProvider("ollama", { available: false }), spied));
    expect(await llm.complete("prompt")).toBeNull();
    expect(remoteCalled).toBe(false);
  });

  it("returns null when no provider is available at all", async () => {
    const llm = createDecisionLlm(routerWith(fakeProvider("ollama", { available: false })));
    expect(await llm.complete("prompt")).toBeNull();
  });
});
