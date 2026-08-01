import { expect, test } from "bun:test";

import type { DecisionsBrief } from "./decisions-types.ts";
import { renderDecisions } from "./render.ts";

function brief(over: Partial<DecisionsBrief> = {}): DecisionsBrief {
  return {
    kind: "decisions",
    agentVersion: 1,
    generatedAt: 1_700_000_000_000,
    latencyMs: 12,
    gaps: [],
    query: { sinceMs: 0, service: null, minConfidence: 0, explain: false },
    entries: [
      {
        id: "d1",
        statement: "Move billing to Postgres",
        rationale: "connection-pool exhaustion",
        alternatives: ["stay on MySQL"],
        confidence: 0.78,
        decidedAt: 1_690_000_000_000,
        hasAdr: false,
        extractionSource: "llm",
        evidence: [
          { kind: "pr", entityId: null, itemId: null, label: "#412", url: null, occurredAt: null },
        ],
        explain: [],
        matchedVia: null,
      },
    ],
    stats: { total: 1, pending: 0, extracted: 1, vetoed: 0, lastPassAt: 1_699_000_000_000 },
    ...over,
  };
}

test("renders the statement, confidence and rationale", () => {
  const md = renderDecisions(brief());
  expect(md).toContain("Move billing to Postgres");
  expect(md).toContain("0.78");
  expect(md).toContain("connection-pool exhaustion");
});

test("flags a decision with no ADR", () => {
  expect(renderDecisions(brief())).toContain("no ADR found");
});

test("says so plainly when there are no decisions", () => {
  const md = renderDecisions(brief({ entries: [] }));
  expect(md).toContain("No decisions");
});

test("renders gap notes", () => {
  const md = renderDecisions(
    brief({ gaps: [{ category: "empty_index", detail: "The local index is empty." }] }),
  );
  expect(md).toContain("The local index is empty.");
});

test("renders the confidence breakdown only when explain is set", () => {
  const withExplain = brief();
  withExplain.query = { ...withExplain.query, explain: true };
  withExplain.entries[0]!.explain = [{ term: "cue", value: 0.25, detail: "heading cue" }];
  expect(renderDecisions(withExplain)).toContain("heading cue");
  expect(renderDecisions(brief())).not.toContain("heading cue");
});
