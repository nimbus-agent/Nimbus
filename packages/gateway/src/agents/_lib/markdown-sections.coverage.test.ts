/**
 * markdown-sections.coverage.test.ts — the arms of markdown-sections.ts the main suite leaves
 * open: `topLevelSections` (a sequential split at every heading level), a serialized gap envelope
 * whose field lines sit ABOVE its `category:` line, an envelope run that ends at a fence, and a
 * meta-preamble stripped from a rewrite that has no heading at all.
 */
import { describe, expect, test } from "bun:test";

import {
  stripMetaPreamble,
  stripSerializedGapEnvelope,
  topLevelSections,
} from "./markdown-sections.ts";

describe("topLevelSections", () => {
  test("splits at EVERY heading level, each section running to the next heading of any level", () => {
    const md = ["intro line", "# Title", "text", "### Sub", "more", "## Next", "end"].join("\n");
    expect(topLevelSections(md)).toEqual([
      { start: 1, end: 3 },
      { start: 3, end: 5 },
      { start: 5, end: 7 },
    ]);
  });

  test("a heading inside a fence is not a boundary, and no heading at all yields no sections", () => {
    const fenced = ["# One", "```", "## not a heading", "```", "tail"].join("\n");
    expect(topLevelSections(fenced)).toEqual([{ start: 0, end: 5 }]);
    expect(topLevelSections("just prose\nno headings")).toEqual([]);
  });
});

describe("stripSerializedGapEnvelope — field order and fences", () => {
  test("detail/remediation lines ABOVE the category line are walked back over, label included", () => {
    const md = [
      "Intro paragraph.",
      "",
      "**Gaps**:",
      "- detail: no PagerDuty connector",
      "- remediation: run nimbus connector auth pagerduty",
      "- category: missing_connector",
      "",
      "## Next",
      "body",
    ].join("\n");
    expect(stripSerializedGapEnvelope(md)).toBe("Intro paragraph.\n\n## Next\nbody");
  });

  // These two pin the OUTCOME at a fence, not the `fenced[]` checks inside the walks: the line
  // next to the envelope is always the fence's own delimiter, which no field or label pattern
  // matches, so the walks stop there even with those checks removed (verified by mutation).
  test("the walk back stops at a fence: a fenced field line above the category line survives", () => {
    const md = [
      "```yaml",
      "detail: an example, quoted",
      "```",
      "- category: empty_index",
      "- detail: nothing indexed",
      "after",
    ].join("\n");
    expect(stripSerializedGapEnvelope(md)).toBe(
      ["```yaml", "detail: an example, quoted", "```", "after"].join("\n"),
    );
  });

  test("the walk forward stops at a fence: a fenced block after the envelope is kept whole", () => {
    const md = [
      "- category: missing_entity_type",
      "```",
      "detail: this is documentation, not an envelope",
      "```",
    ].join("\n");
    expect(stripSerializedGapEnvelope(md)).toBe(
      ["```", "detail: this is documentation, not an envelope", "```"].join("\n"),
    );
  });
});

describe("stripMetaPreamble — no heading in the rewrite", () => {
  test("drops the narrating paragraph and keeps the rest when the document has no heading", () => {
    const md = "Here is the rewritten brief, as requested.\n\nThe actual content.\n\nMore content.";
    expect(stripMetaPreamble(md)).toBe("The actual content.\n\nMore content.");
  });

  test("an italic renderer disclosure is never treated as narration", () => {
    // The marker must actually MATCH inside the disclosure, or this proves nothing about the
    // `_` guard: `\bbased` cannot match straight after the opening `_` (both are word
    // characters, so there is no boundary between them). Mid-sentence, after a space, it does.
    const disclosure = "_Counts below are a floor, based on the provided context._";
    const md = `${disclosure}\n\nThe actual content.`;
    expect(stripMetaPreamble(md)).toBe(md);
    // The same sentence without the italics IS narration, and goes.
    expect(stripMetaPreamble(`${disclosure.slice(1, -1)}\n\nThe actual content.`)).toBe(
      "The actual content.",
    );
  });
});
