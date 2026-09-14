// Round-trips one raw wire record per `ask.explainLast` route through `parseExplainLastResult` →
// `formatExplain` (fix-wave finding CRITICAL 2). This is the seam `explain-format.ts`'s own
// header comment used to claim was "covered by the `ask.explainLast` tests in
// `diagnostics-rpc.test.ts`" — a false attestation, since that file never imports this one and
// nothing here or there round-tripped the wire shape at all.
//
// The gateway-side type is `AskExplainRecord` in `packages/gateway/src/engine/ask-explain-types.ts`
// — a SEPARATE, independently-declared type this file's `ExplainRecordView` mirrors by hand,
// because `packages/cli` reaches the gateway over IPC only and never imports gateway source. The
// two shapes are not statically pinned together, so `parseExplainLastResult` is STRICT (`bad()`
// throws on anything it does not recognise): a gateway-side rename of `searchTerms`, `atLeast`,
// `discardedTail`, or `pass.kind` would not degrade the report, it would replace it with a
// malformed-response error for every `local_context` turn — the commonest route — while every
// renderer-only test (`explain-format.test.ts`) stayed green, since those construct
// already-narrowed `ExplainRecordView` values directly and never touch the parser at all.
import { describe, expect, test } from "bun:test";
import { formatExplain, parseExplainLastResult } from "./explain-format.ts";

const baseRaw = {
  askedAt: 1_700_000_000_000,
  durationMs: 342,
  question: "what did we decide about rate limiting?",
  source: "local" as const,
  persona: "standard/standard",
  modelRoute: { provider: "ollama", model: "llama3.2", isLocal: true },
  classifier: { called: false, reason: "local preference" },
};

describe("ask.explainLast wire round-trip (fix-wave CRITICAL 2)", () => {
  test("record: null at the top level narrows and never reaches formatExplain", () => {
    const res = parseExplainLastResult({ record: null, reason: "no_ask_since_start" });
    expect(res.record).toBeNull();
    expect(res).toEqual({ record: null, reason: "no_ask_since_start" });
  });

  test("empty_index round-trips", () => {
    const res = parseExplainLastResult({ record: { ...baseRaw, route: "empty_index" } });
    expect(res.record).not.toBeNull();
    if (res.record === null) return;
    const out = formatExplain(res.record);
    expect(out).toContain("Question:");
    expect(out).toMatch(/index was empty/i);
  });

  test("local_context round-trips, including a mixed-formula pool and a score-less repo-slug row", () => {
    const raw = {
      ...baseRaw,
      route: "local_context",
      searchTerms: "rate limiting",
      fallbackTermFired: "throttling",
      truncation: { shown: 2, total: 40, atLeast: true },
      discardedTail: [{ service: "slack", type: "message", count: 12 }],
      pool: [
        {
          sourceId: "a",
          service: "slack",
          indexedType: "message",
          title: "rate limiting RFC",
          modifiedAt: 1_699_000_000_000,
          score: 0.84,
          matchScore: 0.9,
          recencyComponent: 0.8,
          servicePriorityComponent: 0.75,
          scoringFormula: "hybrid_rrf",
          pass: { kind: "primary-hybrid" },
          outcome: "shown",
        },
        {
          sourceId: "b",
          service: "slack",
          indexedType: "message",
          title: "old rate limit ideas",
          score: 0.45,
          matchScore: 0.5,
          recencyComponent: 0.4,
          servicePriorityComponent: 0.4,
          scoringFormula: "fts_rank",
          pass: { kind: "fallback-term", term: "throttling" },
          outcome: "cut: probe slice",
        },
        {
          sourceId: "c",
          service: "github",
          indexedType: "pr",
          title: "Add redis rate limiter",
          pass: { kind: "repo-slug", slug: "acme/api" },
          outcome: "shown",
        },
      ],
    };
    const res = parseExplainLastResult({ record: raw });
    expect(res.record).not.toBeNull();
    if (res.record === null) return;
    const out = formatExplain(res.record);
    expect(out).toContain("Add redis rate limiter");
    expect(out).toContain("n/a (direct query)");
    expect(out).toMatch(/at least 40/i);
    expect(out).toMatch(/not comparable/i);
  });

  test("agent_tools round-trips, including a searchLocalIndex ranking summary and a fallback pool", () => {
    const raw = {
      ...baseRaw,
      route: "agent_tools",
      fallbackFromLocalRouter: { error: "ECONNREFUSED" },
      toolCalls: [
        {
          toolId: "searchLocalIndex",
          service: "nimbus",
          status: "ok",
          durationMs: 12,
          paramsJson: '{"name":"rate"}',
          ranking: {
            totalMatches: 41,
            itemsInWindow: 8,
            sourceSummary: [{ service: "slack", type: "message", count: 8 }],
          },
        },
      ],
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
    };
    const res = parseExplainLastResult({ record: raw });
    expect(res.record).not.toBeNull();
    if (res.record === null) return;
    const out = formatExplain(res.record);
    expect(out).toMatch(/per tool call/i);
    expect(out).toMatch(/local model failed/i);
    expect(out).toContain("Add redis rate limiter");
  });

  test("plan_dispatch round-trips", () => {
    const res = parseExplainLastResult({
      record: { ...baseRaw, route: "plan_dispatch", plan: "actions: filesystem_search_files" },
    });
    expect(res.record).not.toBeNull();
    if (res.record === null) return;
    const out = formatExplain(res.record);
    expect(out).toContain("actions: filesystem_search_files");
  });

  test("a 'failed' route round-trips at every stage, and carries the plan on 'dispatch'", () => {
    for (const stage of ["classification", "retrieval", "model"] as const) {
      const res = parseExplainLastResult({
        record: { ...baseRaw, route: "failed", stage, error: "SQLITE_BUSY" },
      });
      expect(res.record).not.toBeNull();
      if (res.record === null) continue;
      const out = formatExplain(res.record);
      expect(out).toContain(stage);
      expect(out).toContain("SQLITE_BUSY");
    }

    const dispatchRes = parseExplainLastResult({
      record: {
        ...baseRaw,
        route: "failed",
        stage: "dispatch",
        error: "ECONNRESET talking to the connector",
        plan: "actions: filesystem_search_files",
      },
    });
    expect(dispatchRes.record).not.toBeNull();
    if (dispatchRes.record === null) return;
    const out = formatExplain(dispatchRes.record);
    expect(out).toContain("dispatch");
    expect(out).toContain("ECONNRESET talking to the connector");
    expect(out).toContain("actions: filesystem_search_files");
  });

  test("bad() refusal: an unrecognised route throws rather than silently narrowing", () => {
    expect(() =>
      parseExplainLastResult({ record: { ...baseRaw, route: "some_future_route" } }),
    ).toThrow(/malformed response/i);
  });

  test("bad() refusal: a renamed field (searchTerms -> queryTerms) throws on a local_context record", () => {
    // This is the exact regression the header comment's false attestation used to leave
    // unguarded: a gateway-side rename must fail loudly here, not silently degrade the report.
    const raw: Record<string, unknown> = {
      ...baseRaw,
      route: "local_context",
      queryTerms: "rate limiting",
      truncation: { shown: 1, total: 1, atLeast: false },
      discardedTail: [],
      pool: [],
    };
    expect(() => parseExplainLastResult({ record: raw })).toThrow(/malformed response/i);
  });

  test("bad() refusal: a non-object root throws", () => {
    expect(() => parseExplainLastResult("not an object")).toThrow(/malformed response/i);
    expect(() => parseExplainLastResult(null)).toThrow(/malformed response/i);
  });
});
