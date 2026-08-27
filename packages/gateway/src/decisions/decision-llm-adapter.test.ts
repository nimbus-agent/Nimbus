import { describe, expect, it, test } from "bun:test";

import { LlmRouter } from "../llm/router.ts";
import type { LlmProvider, ProviderId } from "../llm/types.ts";
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

function fakeProvider(id: ProviderId, opts: { available: boolean; text?: string }): LlmProvider {
  // The model this route registers under — `routerWith` below registers each provider
  // under `local-model`/`remote-model` based on `isLocal`, matching this listing.
  const modelName = id === "remote" ? "remote-model" : "local-model";
  return {
    providerId: id,
    isLocal: id !== "remote",
    isAvailable: () => Promise.resolve(opts.available),
    // Must report the model it registers under — route availability (Task 5) requires the
    // daemon reachable AND the route's own modelName among the reported models; an empty
    // listing here makes the route model_absent regardless of isAvailable(). Harmless when
    // `opts.available` is false: `probeProvider` short-circuits on an unreachable daemon
    // before ever consulting the model list.
    listModels: () => Promise.resolve([{ provider: id, modelName }]),
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
  for (const p of providers) r.registerRoute(p, p.isLocal ? "local-model" : "remote-model");
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

// ---------------------------------------------------------------------------
// Growth-shape regression: the fenced-block extractor.
//
// `extractJsonObject`'s fence pattern used to capture the body as a bare lazy
// `[\s\S]*?` directly after a greedy `\s*`. Both match whitespace, so on a
// fence followed by a long whitespace run with no closing fence the engine
// tries every way of splitting that run between them and rescans the remainder
// each time — Σ(n−i), quadratic. Measured on Bun 1.3 against that exact
// pattern: 2 KB 0.9 ms, 4 KB 3.6 ms, 8 KB 15 ms, 16 KB 57 ms, 32 KB 220 ms, a
// clean 4x per doubling. A correctness test cannot see it — the throw is the
// same either way — so the SHAPE of the curve is what is asserted here.
// ---------------------------------------------------------------------------

/** Four sizes = three doublings. Linear predicts ~8x end to end, quadratic ~64x. */
const GROWTH_SIZES = [4_000, 8_000, 16_000, 32_000] as const;
/** Repeats per size, so the linear timings are milliseconds rather than noise. */
const GROWTH_REPEATS = 500;
const GROWTH_MAX_END_TO_END = 16;
/** The quadratic form blows this at the FIRST size, so a regression fails fast. */
const GROWTH_PER_SIZE_CEILING_MS = 1000;

test("an unterminated fence followed by whitespace costs linear, not quadratic, time", () => {
  // No closing fence, so the pattern fails and the raw text is searched for a
  // JSON object instead — which is the throw path, exercised at every size.
  const build = (n: number): string => `\`\`\`${" ".repeat(n)}`;
  expect(() => parseExtraction(build(8))).toThrow("model output was not parseable JSON");

  const timings: number[] = [];
  for (const n of GROWTH_SIZES) {
    const raw = build(n);
    let thrown = 0;
    const count = (): void => {
      try {
        parseExtraction(raw);
      } catch {
        thrown += 1;
      }
    };
    count(); // warm the JIT outside the measured batch
    const startedAt = performance.now();
    for (let i = 0; i < GROWTH_REPEATS; i += 1) count();
    const elapsedMs = performance.now() - startedAt;
    expect(thrown).toBe(GROWTH_REPEATS + 1);
    expect(elapsedMs).toBeLessThan(GROWTH_PER_SIZE_CEILING_MS);
    timings.push(elapsedMs);
  }

  const first = timings[0] ?? 0;
  const last = timings[timings.length - 1] ?? 0;
  // Floor the baseline so a fast machine measuring the smallest size near the
  // clock's resolution cannot manufacture a huge ratio out of noise.
  expect(last / Math.max(first, 0.5)).toBeLessThan(GROWTH_MAX_END_TO_END);
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
