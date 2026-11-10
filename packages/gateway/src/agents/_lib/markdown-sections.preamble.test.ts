/** `stripMetaPreamble` around a heading: nothing before it, a narrating paragraph before it, blank paragraphs. */
import { describe, expect, test } from "bun:test";
import { stripMetaPreamble } from "./markdown-sections.ts";

describe("stripMetaPreamble — documents with a heading", () => {
  test("a document that opens with its heading is returned unchanged", () => {
    const md = "# Title\n\nHere is the rewritten brief.\n\nBody.";
    expect(stripMetaPreamble(md)).toBe(md);
  });

  test("a narrating paragraph before the first heading goes, and the heading onward is untouched", () => {
    const md = "Here is the rewritten brief, as requested.\n\n## Findings\n\n- one\n- two";
    expect(stripMetaPreamble(md)).toBe("## Findings\n\n- one\n- two");
  });

  test("a preamble that is not narration survives, as does a blank paragraph beside narration", () => {
    const real = "Window: last 7 days.\n\n## Findings\n\n- one";
    expect(stripMetaPreamble(real)).toBe(real);
    const mixed = "  \n\nI will provide a summary.\n\nWindow: last 7 days.\n\n## Findings";
    expect(stripMetaPreamble(mixed)).toBe("  \n\nWindow: last 7 days.\n\n## Findings");
  });

  test("a whitespace-only head before a heading is left alone", () => {
    expect(stripMetaPreamble("\n\n## Findings")).toBe("\n\n## Findings");
  });
});
