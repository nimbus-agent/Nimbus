import { describe, expect, test } from "bun:test";
import type { ExpertBrief, GapNote } from "./findings.ts";
import type { NegotiateBrief } from "./negotiate-types.ts";
import {
  joinReserved,
  RESERVED_HEADINGS_BY_KIND,
  reservedBlocksFor,
  reservedHeadingsFor,
} from "./reserved-sections.ts";

const GAP: GapNote = { category: "empty_index", detail: "No items in the local index yet." };

const EXPERT: ExpertBrief = {
  kind: "expert",
  agentVersion: 1,
  generatedAt: 0,
  latencyMs: 0,
  gaps: [GAP],
  query: { topicOrFile: "src/x.ts" },
  ranked: [],
};

describe("RESERVED_HEADINGS_BY_KIND", () => {
  test("every kind reserves the Gaps section", () => {
    for (const headings of Object.values(RESERVED_HEADINGS_BY_KIND)) {
      expect(headings).toContain("## Gaps");
    }
  });

  test("negotiate additionally reserves its two disclosure sections", () => {
    expect(RESERVED_HEADINGS_BY_KIND.negotiate).toEqual([
      "## Sources",
      "## Evidence not available from the index",
      "## Gaps",
    ]);
  });

  test("covers exactly the fourteen brief kinds", () => {
    expect(Object.keys(RESERVED_HEADINGS_BY_KIND).sort()).toEqual([
      "catchup",
      "conflict",
      "decisions",
      "expert",
      "ghost",
      "glossary",
      "huddle",
      "impact",
      "janitor",
      "negotiate",
      "ownership",
      "preflight",
      "premortem",
      "why",
    ]);
  });
});

describe("reservedBlocksFor", () => {
  test("builds the Gaps block from the brief's gap notes", () => {
    const blocks = reservedBlocksFor(EXPERT);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.heading).toBe("## Gaps");
    expect(blocks[0]?.markdown).toContain("No items in the local index yet.");
  });

  test("returns nothing for a brief with no gap notes", () => {
    expect(reservedBlocksFor({ ...EXPERT, gaps: [] })).toEqual([]);
  });
});

describe("reservedHeadingsFor", () => {
  test("reads the registry by the brief's kind", () => {
    expect(reservedHeadingsFor(EXPERT)).toEqual(["## Gaps"]);
  });
});

describe("joinReserved", () => {
  test("appends blocks after the body, separated by a blank line", () => {
    const out = joinReserved("# Brief\n\nbody\n", [
      { heading: "## Gaps", markdown: "## Gaps\n\n- one" },
    ]);
    expect(out).toBe("# Brief\n\nbody\n\n## Gaps\n\n- one");
  });

  test("returns the body untouched when there is nothing reserved", () => {
    expect(joinReserved("# Brief\n", [])).toBe("# Brief\n");
  });

  test("preserves the order blocks are given in", () => {
    const out = joinReserved("body", [
      { heading: "## Sources", markdown: "## Sources\n\na" },
      { heading: "## Gaps", markdown: "## Gaps\n\nb" },
    ]);
    expect(out.indexOf("## Sources")).toBeLessThan(out.indexOf("## Gaps"));
  });
});
