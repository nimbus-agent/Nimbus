import { describe, expect, test } from "bun:test";

import {
  buildInvestigationBriefFixture,
  buildInvestigationFixture,
} from "../../incident/__fixtures__/investigation-brief.ts";
import { investigationBrief } from "../../investigation/investigation-synthesis.ts";
import { renderIncidentInvestigation } from "./incident-investigation-render.ts";
import { renderInvestigation } from "./investigation-render.ts";
import { RESERVED_HEADINGS_BY_KIND, reservedBlocksFor } from "./reserved-sections.ts";
import { synthesize } from "./synthesize.ts";

describe("renderIncidentInvestigation", () => {
  test("the investigation fixture takes no override and accepts one", () => {
    expect(buildInvestigationFixture().version).toBe(2);
    expect(buildInvestigationFixture({ version: 5 }).version).toBe(5);
  });

  test("says exactly what the plain investigation says, in the same order", () => {
    const brief = buildInvestigationBriefFixture();
    expect(renderIncidentInvestigation(brief)).toBe(renderInvestigation(brief.investigation));
  });

  test("omitReserved withholds actions, leads, gaps and freshness and nothing else", () => {
    const body = renderIncidentInvestigation(buildInvestigationBriefFixture(), {
      omitReserved: true,
    });
    for (const h of ["## What Nimbus did", "## Leads", "## Gaps", "## Data freshness"]) {
      expect(body).not.toContain(h);
    }
    expect(body).toContain("## Summary");
    expect(body).toContain("## Sentry error issues");
  });

  test("the reserved blocks are rebuilt from the brief, in the registry's order", () => {
    const brief = buildInvestigationBriefFixture();
    expect(RESERVED_HEADINGS_BY_KIND.incident_investigation).toEqual([
      "## What Nimbus did",
      "## Leads",
      "## Gaps",
      "## Data freshness",
    ]);
    const blocks = reservedBlocksFor(brief);
    expect(blocks.map((b) => b.heading)).toEqual([
      ...RESERVED_HEADINGS_BY_KIND.incident_investigation,
    ]);
    expect(blocks[0]?.markdown).toContain("Argo CD rollback to 41");
    expect(blocks[1]?.markdown).toContain("timing only, not a proven cause");
  });

  test("investigationBrief mirrors the gaps as detail-only notes", () => {
    const brief = investigationBrief(buildInvestigationBriefFixture().investigation, 5);
    expect(brief.gaps).toEqual([
      { category: "missing_entity_type", detail: "GAP-DETAIL-SENTINEL" },
    ]);
    expect(brief.generatedAt).toBe(5);
  });

  test("synthesize with no runner is the deterministic render", async () => {
    const brief = buildInvestigationBriefFixture();
    const out = await synthesize(brief);
    expect(out.provenance.attempted).toBe(false);
    expect(out.markdown).toContain(renderIncidentInvestigation(brief).trimEnd());
  });
});
