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
  test("the recorded question is rendered — the field the whole privacy posture is justified by", () => {
    // Fix-wave finding CRITICAL 1: `question` survived capture, transport and parsing but reached
    // no line of human output. Without it a reader of `explain last` cannot tell WHICH ask a
    // report describes — load-bearing when the ring is shared with the ChatOps path, so the
    // newest record may legitimately be someone else's question.
    const out = formatExplain({ ...base, route: "empty_index" });
    expect(out).toContain(`Question:    ${base.question}`);
  });

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

  test("a keyword-only primary search is labelled from its disclosure, even though every row says hybrid_rrf", () => {
    // `searchRankedAsync`'s hybrid branch keeps `scoringFormula: "hybrid_rrf"` on every row even when
    // the query embedding timed out and no vector was used — so the formula alone labelled a
    // keyword-only search "hybrid RRF". The recorded `primaryRetrieval` is what the search actually did.
    const record = {
      ...base,
      route: "local_context" as const,
      searchTerms: "x",
      truncation: { shown: 1, total: 1, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "a",
          service: "slack",
          indexedType: "message",
          title: "looks hybrid",
          score: 0.8,
          matchScore: 0.8,
          recencyComponent: 0.8,
          servicePriorityComponent: 0.5,
          scoringFormula: "hybrid_rrf" as const,
          pass: { kind: "primary-hybrid" as const },
          outcome: "shown" as const,
        },
      ],
    };
    const degraded = formatExplain({
      ...record,
      primaryRetrieval: {
        vectorRanked: false,
        notes: [
          "semantic ranking unavailable (the query embedding timed out) — keyword-only results",
        ],
      },
    });
    expect(degraded).toContain("primary search (keyword-only — semantic ranking did not run)");
    expect(degraded).not.toContain("primary search (hybrid RRF)");
    expect(degraded).toContain(
      "Retrieval note: semantic ranking unavailable (the query embedding timed out) — keyword-only results",
    );

    // A record from a gateway that predates the field keeps the formula-derived label.
    expect(formatExplain(record)).toContain("primary search (hybrid RRF)");
  });

  test("the primary-hybrid pass label reflects whether the search actually ran hybrid, never unconditionally", () => {
    // Fix-wave finding IMPORTANT 4: `LocalIndex.searchRankedAsync` falls back to plain FTS
    // whenever semantic search is off, sqlite-vec is unavailable, or the schema predates it — so
    // labelling the primary pass "primary hybrid search" unconditionally would claim semantic
    // retrieval ran when it may not have. The label must be derived from the group's own
    // `scoringFormula`, distinguishing all three cases.
    const hybridOut = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "x",
      truncation: { shown: 1, total: 1, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "a",
          service: "slack",
          indexedType: "message",
          title: "hybrid hit",
          score: 0.8,
          matchScore: 0.8,
          recencyComponent: 0.8,
          servicePriorityComponent: 0.5,
          scoringFormula: "hybrid_rrf",
          pass: { kind: "primary-hybrid" },
          outcome: "shown",
        },
      ],
    });
    expect(hybridOut).toContain("primary search (hybrid RRF)");
    expect(hybridOut).not.toContain("primary hybrid search");

    const ftsOut = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "x",
      truncation: { shown: 1, total: 1, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "a",
          service: "slack",
          indexedType: "message",
          title: "fts hit",
          score: 0.8,
          matchScore: 0.8,
          recencyComponent: 0.8,
          servicePriorityComponent: 0.5,
          scoringFormula: "fts_rank",
          pass: { kind: "primary-hybrid" },
          outcome: "shown",
        },
      ],
    });
    expect(ftsOut).toContain("primary search (FTS rank)");
    expect(ftsOut).not.toContain("hybrid");

    // No candidate in the group carries a formula at all (score-less throughout) — the neutral
    // fallback, never a guess.
    const neutralOut = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "x",
      truncation: { shown: 1, total: 1, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "a",
          service: "slack",
          indexedType: "message",
          title: "unscored hit",
          pass: { kind: "primary-hybrid" },
          outcome: "shown",
        },
      ],
    });
    expect(neutralOut).toContain("primary index search");
    expect(neutralOut).not.toContain("hybrid");
    expect(neutralOut).not.toContain("FTS");
  });

  test("within a group, candidates sort by score descending — pinned by index position", () => {
    // Both candidates share the SAME pass (primary-hybrid), so this is the within-group half of
    // the sort rule — the across-group half (never comparing scores across passes) is covered by
    // the non-comparability test above. Input order is deliberately low-score-first, so neither
    // "no sort at all" nor "sort ascending" can pass this by accident.
    const out = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "rate",
      truncation: { shown: 2, total: 2, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "lo",
          service: "slack",
          indexedType: "message",
          title: "Low score item",
          score: 0.3,
          matchScore: 0.3,
          recencyComponent: 0.3,
          servicePriorityComponent: 0.5,
          scoringFormula: "hybrid_rrf",
          pass: { kind: "primary-hybrid" },
          outcome: "shown",
        },
        {
          sourceId: "hi",
          service: "slack",
          indexedType: "message",
          title: "High score item",
          score: 0.9,
          matchScore: 0.9,
          recencyComponent: 0.9,
          servicePriorityComponent: 0.5,
          scoringFormula: "hybrid_rrf",
          pass: { kind: "primary-hybrid" },
          outcome: "shown",
        },
      ],
    });
    const hiIndex = out.indexOf("High score item");
    const loIndex = out.indexOf("Low score item");
    expect(hiIndex).toBeGreaterThan(-1);
    expect(loIndex).toBeGreaterThan(-1);
    expect(hiIndex).toBeLessThan(loIndex);
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

  test("a 'dispatch'-stage failure is distinct from 'model', and carries the plan", () => {
    // Fix-wave finding IMPORTANT 3: a connector/executor failure must never be reported as a
    // model failure, and the plan that was being dispatched must survive onto the record.
    const out = formatExplain({
      ...base,
      route: "failed",
      stage: "dispatch",
      error: "ECONNRESET talking to the connector",
      plan: "actions: filesystem_search_files",
    });
    expect(out).toContain("Stage: dispatch");
    expect(out).not.toContain("Stage: model");
    expect(out).toContain("ECONNRESET talking to the connector");
    expect(out).toContain("actions: filesystem_search_files");
  });

  test("a non-dispatch failure never fabricates a plan line", () => {
    const out = formatExplain({
      ...base,
      route: "failed",
      stage: "model",
      error: "boom",
    });
    expect(out).not.toContain("Plan:");
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

  test("a called classifier renders intent/confidence/destination and its entities", () => {
    const out = formatExplain({
      ...base,
      classifier: {
        called: true,
        intent: "file_search",
        confidence: 0.87,
        entities: { pattern: "*.md" },
        destination: "anthropic",
      },
      route: "empty_index",
    });
    expect(out).toContain("intent=file_search");
    expect(out).toContain("confidence=0.87");
    expect(out).toContain("destination=anthropic");
    expect(out).toContain("entities={pattern=*.md}");
    expect(out).not.toMatch(/not called/i);
  });

  test("a called classifier with no entities renders no entities clause at all", () => {
    // The empty-entities half of the ternary: an empty `{}` must render no trailing
    // `entities={...}` clause, never an empty `entities={}`.
    const out = formatExplain({
      ...base,
      classifier: {
        called: true,
        intent: "unknown",
        confidence: 0.1,
        entities: {},
        destination: "ollama",
      },
      route: "empty_index",
    });
    expect(out).toContain("intent=unknown confidence=0.10 destination=ollama");
    expect(out).not.toContain("entities={");
  });

  test("a quoted-phrase pass renders its own distinct label, not the primary-hybrid one", () => {
    const out = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "rate limiting",
      truncation: { shown: 1, total: 1, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "q",
          service: "github",
          indexedType: "issue",
          title: `Issue titled "rate limiting"`,
          pass: { kind: "quoted", query: "rate limiting" },
          outcome: "shown",
        },
      ],
    });
    expect(out).toMatch(/quoted-phrase match "rate limiting"/);
  });

  test("cut: over cap and cut: service fairness render their own distinct reasons", () => {
    const out = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "x",
      truncation: { shown: 1, total: 3, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "cap",
          service: "slack",
          indexedType: "message",
          title: "over the cap",
          pass: { kind: "primary-hybrid" },
          outcome: "cut: over cap",
        },
        {
          sourceId: "fair",
          service: "slack",
          indexedType: "message",
          title: "displaced by fairness",
          pass: { kind: "primary-hybrid" },
          outcome: "cut: service fairness",
        },
      ],
    });
    expect(out).toMatch(/cut — over the final cap/);
    expect(out).toMatch(/cut — displaced by per-service fairness/);
  });

  test("two score-less candidates in the same pass sort as a no-op, never crash or reorder", () => {
    // Both `score`s are `undefined`, so `sortGroup`'s comparator takes its "neither is scored"
    // branch (returns 0) rather than the score-difference branch below it — pinned by asserting
    // the ORIGINAL insertion order survives untouched.
    const out = formatExplain({
      ...base,
      route: "local_context",
      searchTerms: "x",
      truncation: { shown: 2, total: 2, atLeast: false },
      discardedTail: [],
      pool: [
        {
          sourceId: "first",
          service: "github",
          indexedType: "pr",
          title: "first unscored",
          pass: { kind: "repo-slug", slug: "acme/api" },
          outcome: "shown",
        },
        {
          sourceId: "second",
          service: "github",
          indexedType: "pr",
          title: "second unscored",
          pass: { kind: "repo-slug", slug: "acme/api" },
          outcome: "shown",
        },
      ],
    });
    const firstIndex = out.indexOf("first unscored");
    const secondIndex = out.indexOf("second unscored");
    expect(firstIndex).toBeGreaterThan(-1);
    expect(secondIndex).toBeGreaterThan(-1);
    expect(firstIndex).toBeLessThan(secondIndex);
  });

  test("noColor renders a plain title with no ANSI escape codes", () => {
    const colored = formatExplain({ ...base, route: "empty_index" });
    const plain = formatExplain({ ...base, route: "empty_index" }, { noColor: true });
    expect(colored).toContain(String.fromCodePoint(27));
    expect(plain).not.toContain(String.fromCodePoint(27));
    expect(plain).toContain("nimbus explain last");
  });
});
