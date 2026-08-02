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
    stats: {
      total: 1,
      pending: 0,
      extracted: 1,
      vetoed: 0,
      lastPassAt: 1_699_000_000_000,
      truncatedSources: 0,
    },
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

// The brief promises "evidence links". `DecisionEvidence.url` is populated by
// `decision-corroborate.ts` from the corroborating item's permalink, and the
// renderer dropped it on the floor — every brief printed a bare `PR #412` that
// nobody could click through to.
test("renders evidence with a url as a Markdown link", () => {
  const base = brief();
  const entry = base.entries[0];
  if (entry === undefined) throw new Error("fixture has no entry");
  const linked = brief({
    entries: [
      {
        ...entry,
        evidence: [
          {
            kind: "pr",
            entityId: null,
            itemId: null,
            label: "#412",
            url: "https://github.com/acme/billing/pull/412",
            occurredAt: null,
          },
          {
            kind: "source",
            entityId: null,
            itemId: null,
            label: 'notion:page "Billing RFC"',
            url: "https://notion.so/billing-rfc",
            occurredAt: null,
          },
        ],
      },
    ],
  });
  const md = renderDecisions(linked);
  expect(md).toContain("[PR #412](https://github.com/acme/billing/pull/412)");
  // The `source` kind has an empty prefix, so its link text is the bare label.
  expect(md).toContain('[notion:page "Billing RFC"](https://notion.so/billing-rfc)');
});

// The nullable half. A graph entity with no indexed permalink must render as
// plain text, never as an empty-target `[PR #412]()` dead link.
test("renders evidence without a url as plain text, not an empty link", () => {
  const md = renderDecisions(brief());
  expect(md).toContain("PR #412");
  expect(md).not.toContain("[PR #412](");
  expect(md).not.toContain("]()");
});

test("renders the confidence breakdown only when explain is set", () => {
  const withExplain = brief();
  withExplain.query = { ...withExplain.query, explain: true };
  withExplain.entries[0]!.explain = [{ term: "cue", value: 0.25, detail: "heading cue" }];
  expect(renderDecisions(withExplain)).toContain("heading cue");
  expect(renderDecisions(brief())).not.toContain("heading cue");
});
