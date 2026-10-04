import { describe, expect, test } from "bun:test";

import {
  type CollectedToolCall,
  type ExplainRecordView,
  formatExplain,
  type LocalCandidate,
  parseExplainLastResult,
  parseExplainRecordView,
} from "./explain-format.ts";

/**
 * The strict parser's refusal on one malformed field per KIND of narrowing it does (scalar, closed
 * union, object, array, array entry, nested object, null-vs-absent) — a representative sample, not
 * every field — plus the renderer branches the sibling files never reach. Each refusal is asserted
 * by its EXACT message, so a refusal that blamed the wrong field — a sibling, a parent, the root —
 * fails here.
 */

const BASE = {
  askedAt: 1_700_000_000_000,
  durationMs: 12,
  question: "why is the deploy slow?",
  source: "local",
  persona: "standard",
  classifier: { called: false, reason: "local preference" },
};

const CANDIDATE = {
  sourceId: "c1",
  service: "slack",
  indexedType: "message",
  title: "deploy notes",
  modifiedAt: 1_700_000_000_000,
  score: 0.5,
  matchScore: 0.5,
  recencyComponent: 0.5,
  servicePriorityComponent: 0.5,
  scoringFormula: "hybrid_rrf",
  pass: { kind: "primary-hybrid" },
  outcome: "shown",
};

const LOCAL = {
  ...BASE,
  route: "local_context",
  searchTerms: "deploy slow",
  primaryRetrieval: { vectorRanked: true, notes: [] },
  truncation: { shown: 1, total: 1, atLeast: false },
  pool: [CANDIDATE],
  discardedTail: [{ service: "slack", type: "message", count: 2 }],
};

const TOOL_CALL = {
  toolId: "searchLocalIndex",
  service: "local",
  status: "ok",
  durationMs: 4,
  paramsJson: null,
  ranking: { totalMatches: 3, itemsInWindow: 2, sourceSummary: [] },
};

const AGENT = { ...BASE, route: "agent_tools", toolCalls: [TOOL_CALL] };

const malformed = (where: string): string => `ask.explainLast: malformed response at ${where}`;

/** Every valid fixture above must parse — otherwise the refusal cases below prove nothing. */
test("the valid fixtures parse cleanly (the control for every refusal below)", () => {
  expect(parseExplainLastResult({ record: LOCAL }).record?.route).toBe("local_context");
  expect(parseExplainLastResult({ record: AGENT }).record?.route).toBe("agent_tools");
});

describe("parseExplainLastResult refuses each malformed field by its own path", () => {
  const cases: ReadonlyArray<readonly [string, unknown, string]> = [
    ["a non-number askedAt", { ...LOCAL, askedAt: "soon" }, "askedAt"],
    ["a source outside chatops/local", { ...LOCAL, source: "slack" }, "source"],
    ["a non-object classifier", { ...LOCAL, classifier: null }, "classifier"],
    [
      "a called classifier whose entities are an array",
      {
        ...LOCAL,
        classifier: { called: true, intent: "x", confidence: 1, destination: "d", entities: [] },
      },
      "classifier.entities",
    ],
    ["a non-object modelRoute", { ...LOCAL, modelRoute: "ollama" }, "modelRoute"],
    [
      "a non-object fallbackFromLocalRouter",
      { ...LOCAL, fallbackFromLocalRouter: "it broke" },
      "fallbackFromLocalRouter",
    ],
    ["a truncation that is an array", { ...LOCAL, truncation: [] }, "record.truncation"],
    [
      "a non-boolean truncation.atLeast",
      { ...LOCAL, truncation: { shown: 1, total: 1, atLeast: "yes" } },
      "record.truncation.atLeast",
    ],
    ["a pool that is not an array", { ...LOCAL, pool: {} }, "record.pool"],
    ["a pool entry that is not an object", { ...LOCAL, pool: ["c1"] }, "record.pool[0]"],
    [
      "a candidate pass that is not an object",
      { ...LOCAL, pool: [{ ...CANDIDATE, pass: "primary-hybrid" }] },
      "record.pool[0].pass",
    ],
    [
      "a discardedTail row that is not an object",
      { ...LOCAL, discardedTail: [3] },
      "record.discardedTail[0]",
    ],
    [
      "a non-object primaryRetrieval",
      { ...LOCAL, primaryRetrieval: "on" },
      "record.primaryRetrieval",
    ],
    ["a toolCalls entry that is not an object", { ...AGENT, toolCalls: ["t"] }, "toolCalls[0]"],
    [
      "a tool-call status that is neither ok nor error",
      { ...AGENT, toolCalls: [{ ...TOOL_CALL, status: "pending" }] },
      "toolCalls[0].status",
    ],
    [
      "a null tool-call ranking (absent is fine; null is not)",
      { ...AGENT, toolCalls: [{ ...TOOL_CALL, ranking: null }] },
      "toolCalls[0].ranking",
    ],
    [
      "a non-object localContextAlsoGiven",
      { ...AGENT, localContextAlsoGiven: 7 },
      "localContextAlsoGiven",
    ],
  ];

  test.each(cases)("%s", (_name, record, where) => {
    expect(() => parseExplainLastResult({ record })).toThrow(new Error(malformed(where)));
  });

  test("a record that is not an object at all is refused at 'record'", () => {
    expect(() => parseExplainLastResult({ record: 5 })).toThrow(new Error(malformed("record")));
    expect(() => parseExplainRecordView([LOCAL])).toThrow(new Error(malformed("record")));
  });

  test("a null record with an unknown reason is refused at 'reason'", () => {
    expect(() => parseExplainLastResult({ record: null, reason: "gateway_restarted" })).toThrow(
      new Error(malformed("reason")),
    );
  });

  test("an array root is refused at '<root>'", () => {
    expect(() => parseExplainLastResult([])).toThrow(new Error(malformed("<root>")));
  });

  test("a tool call with no ranking at all parses unchanged — only a NULL ranking is refused", () => {
    // The other half of the null-ranking case above: every fixture there carries a ranking, so
    // without this an absent one could start being refused (or gain `ranking: undefined`) unseen.
    const unranked: CollectedToolCall = {
      toolId: "searchLocalIndex",
      service: "local",
      status: "ok",
      durationMs: 4,
      paramsJson: null,
    };
    const view = parseExplainRecordView({ ...AGENT, toolCalls: [unranked] });
    if (view.route !== "agent_tools") throw new Error(`expected agent_tools, got ${view.route}`);
    expect(view.toolCalls).toStrictEqual([unranked]);
  });
});

describe("formatExplain — renderer branches", () => {
  const view = (pool: LocalCandidate[]): ExplainRecordView => ({
    askedAt: 1_700_000_000_000,
    durationMs: 12,
    question: "q",
    source: "chatops",
    persona: "standard",
    modelRoute: { provider: "openai", model: "gpt-5", isLocal: false },
    classifier: { called: false, reason: "r" },
    route: "local_context",
    searchTerms: "s",
    truncation: { shown: pool.length, total: pool.length, atLeast: false },
    pool,
    discardedTail: [],
  });

  const scored = (title: string, score: number): LocalCandidate => ({
    sourceId: title,
    service: "github",
    indexedType: "pr",
    title,
    score,
    matchScore: score,
    recencyComponent: 0.1,
    servicePriorityComponent: 0.2,
    scoringFormula: "fts_rank",
    pass: { kind: "fallback-term", term: "s" },
    outcome: "shown",
  });

  const unscored = (title: string): LocalCandidate => ({
    sourceId: title,
    service: "github",
    indexedType: "pr",
    title,
    pass: { kind: "fallback-term", term: "s" },
    outcome: "cut: over cap",
  });

  test("a remote model route is labelled remote", () => {
    expect(formatExplain(view([]), { noColor: true })).toContain(
      "Model route: openai / gpt-5 (remote)\n",
    );
  });

  test("within one pass, score-less rows sink below scored ones wherever they started", () => {
    // EVERY input order, so the result cannot depend on which pairs the engine's sort happens to
    // compare: scored rows by score descending, then score-less rows in their original order.
    const rows = [scored("S-high", 0.9), scored("S-low", 0.2), unscored("U1"), unscored("U2")];
    const permutations = (xs: LocalCandidate[]): LocalCandidate[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) =>
            permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
          );
    const all = permutations(rows);
    expect(all).toHaveLength(24);
    for (const input of all) {
      const out = formatExplain(view(input), { noColor: true });
      const unscoredInInputOrder = input.filter((r) => r.score === undefined).map((r) => r.title);
      const expected = ["S-high", "S-low", ...unscoredInInputOrder];
      const positions = expected.map((t) => out.indexOf(`] ${t} (`));
      expect(positions.every((p) => p > 0)).toBe(true);
      expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    }
  });

  test("a scored row missing its components renders each as n/a, never a fabricated number", () => {
    const partial: LocalCandidate = {
      sourceId: "p",
      service: "slack",
      indexedType: "message",
      title: "partial",
      score: 0.75,
      scoringFormula: "hybrid_rrf",
      pass: { kind: "primary-hybrid" },
      outcome: "shown",
    };
    expect(formatExplain(view([partial]), { noColor: true })).toContain(
      "  - [shown] partial (slack message) score=0.75 (match=n/a recency=n/a priority=n/a)\n",
    );
  });
});
