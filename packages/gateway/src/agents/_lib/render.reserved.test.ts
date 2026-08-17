import { describe, expect, test } from "bun:test";
import type { ExpertBrief, GapNote } from "./findings.ts";
import { renderExpert, renderGaps, renderNegotiateEvidenceSection } from "./render.ts";

const GAP: GapNote = {
  category: "empty_index",
  detail: "No items in the local index yet.",
  remediation: "Run `nimbus connector sync <service>`.",
};

const EXPERT_WITH_GAPS: ExpertBrief = {
  kind: "expert",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { topicOrFile: "src/x.ts" },
  ranked: [],
};

describe("renderExpert with omitReserved", () => {
  test("the default render is unchanged and carries the Gaps section", () => {
    const full = renderExpert(EXPERT_WITH_GAPS);
    expect(full).toContain("## Gaps");
    expect(full).toContain("No items in the local index yet.");
  });

  test("omitReserved suppresses the Gaps section and nothing else", () => {
    const body = renderExpert(EXPERT_WITH_GAPS, { omitReserved: true });
    expect(body).not.toContain("## Gaps");
    expect(body).not.toContain("No items in the local index yet.");
    expect(body).toContain("# Expert: src/x.ts");
    expect(body).toContain("_no people matched_");
  });

  test("omitReserved is a no-op on a brief with no gap notes", () => {
    const noGaps: ExpertBrief = { ...EXPERT_WITH_GAPS, gaps: [] };
    expect(renderExpert(noGaps, { omitReserved: true })).toBe(renderExpert(noGaps));
  });
});

describe("exported block builders", () => {
  test("renderGaps is callable directly and produces the canonical block", () => {
    expect(renderGaps([GAP])).toContain("## Gaps");
    expect(renderGaps([GAP])).toContain("No items in the local index yet.");
    expect(renderGaps([])).toBe("");
  });

  test("renderNegotiateEvidenceSection renders the unavailable-evidence list", () => {
    const section = renderNegotiateEvidenceSection(["on-call shifts"]);
    expect(section).toContain("## Evidence not available from the index");
    expect(section).toContain("- on-call shifts");
  });
});
