import { describe, expect, test } from "bun:test";
import { formatExplain } from "./explain-format.ts";

const base = {
  askedAt: 1_700_000_000_000,
  durationMs: 342,
  question: "what did we decide about rate limiting?",
  source: "local" as const,
  persona: "standard",
  modelRoute: { provider: "ollama", model: "llama3.2", isLocal: true },
  classifier: { called: false as const, reason: "local preference" },
};

describe("formatExplain honesty rules (spec §5)", () => {
  test("a score-less candidate renders n/a, never 0.00", () => {
    const out = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "rate limiting",
      truncation: { shown: 1, total: 1, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "x",
          service: "github",
          indexedType: "pr",
          title: "Add redis rate limiter",
          pass: { kind: "repo-slug", slug: "acme/api" },
          outcome: "shown",
        },
      ],
    });
    expect(out).toContain("n/a (direct query)");
    expect(out).not.toContain("0.00");
  });

  test("a pool mixing two formulas carries the non-comparability disclosure", () => {
    const out = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "rate",
      truncation: { shown: 2, total: 2, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "a",
          service: "slack",
          indexedType: "message",
          title: "a",
          score: 0.8,
          matchScore: 0.9,
          recencyComponent: 0.8,
          servicePriorityComponent: 0.5,
          scoringFormula: "hybrid_rrf",
          pass: { kind: "primary-hybrid" },
          outcome: "shown",
        },
        {
          sourceId: "b",
          service: "slack",
          indexedType: "message",
          title: "b",
          score: 0.7,
          matchScore: 0.7,
          recencyComponent: 0.7,
          servicePriorityComponent: 0.5,
          scoringFormula: "fts_rank",
          pass: { kind: "fallback-term", term: "rate" },
          outcome: "shown",
        },
      ],
    });
    expect(out).toMatch(/not comparable/i);
  });

  test("the agent route says ranking happened per tool call, not that nothing ranked", () => {
    const out = formatExplain({
      ...base,
      route: "agent_tools",
      toolCalls: [
        {
          toolId: "searchLocalIndex",
          service: "nimbus",
          status: "ok",
          durationMs: 12,
          paramsJson: '{"name":"rate"}',
          ranking: { totalMatches: 41, itemsInWindow: 8, sourceSummary: [] },
        },
      ],
    });
    expect(out).toMatch(/per tool call/i);
    expect(out).not.toMatch(/nothing ranked anything/i);
  });

  test("never claims the model READ what it was given", () => {
    const out = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "x",
      truncation: { shown: 8, total: 41, atLeast: false },
      discardedTail: [],
      pool: [],
    });
    expect(out).toContain("Given to the model");
    expect(out).not.toMatch(/read by the model/i);
  });

  test("truncation.atLeast renders 'at least N', never an exact total (a probe ceiling, not a count)", () => {
    const out = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "x",
      truncation: { shown: 8, total: 40, atLeast: true },
      discardedTail: [],
      pool: [],
    });
    expect(out).toMatch(/at least 40/i);
    expect(out).not.toMatch(/of 40 matching items/i);
  });

  test("a fallback turn renders the local context pool that was actually in the agent's prompt", () => {
    const out = formatExplain({
      ...base,
      route: "agent_tools",
      fallbackFromLocalRouter: { error: "ECONNREFUSED" },
      toolCalls: [],
      localContextAlsoGiven: {
        searchTerms: "rate limiting",
        truncation: { shown: 1, total: 1, atLeast: false },
        discardedTail: [],
        pool: [
          {
            sourceId: "x",
            service: "github",
            indexedType: "pr",
            title: "Add redis rate limiter",
            pass: { kind: "repo-slug", slug: "acme/api" },
            outcome: "shown",
          },
        ],
      },
    });
    expect(out).toMatch(/local model failed/i);
    expect(out).toMatch(/local context assembled before the fallback/i);
    expect(out).toContain("Add redis rate limiter");
  });

  test("a non-fallback agent_tools turn never implies a local context pool was lost", () => {
    const out = formatExplain({
      ...base,
      route: "agent_tools",
      toolCalls: [
        {
          toolId: "searchLocalIndex",
          service: "nimbus",
          status: "ok",
          durationMs: 5,
          paramsJson: null,
        },
      ],
    });
    expect(out).not.toMatch(/local context assembled before the fallback/i);
    expect(out).not.toMatch(/fallback/i);
  });

  test("the empty-index route says the index was empty, not silence", () => {
    const out = formatExplain({ ...base, route: "empty_index" });
    expect(out).toMatch(/index was empty/i);
  });

  test("a failed route discloses its stage and error", () => {
    const out = formatExplain({
      ...base,
      route: "failed",
      stage: "retrieval",
      error: "SQLITE_BUSY",
    });
    expect(out).toContain("retrieval");
    expect(out).toContain("SQLITE_BUSY");
  });

  test("no model route resolved is disclosed rather than fabricated", () => {
    const out = formatExplain({
      askedAt: base.askedAt,
      durationMs: base.durationMs,
      question: base.question,
      source: "local",
      persona: "standard",
      classifier: { called: false, reason: "empty index" },
      route: "empty_index",
    });
    expect(out).toMatch(/no model route was resolved/i);
  });
});
