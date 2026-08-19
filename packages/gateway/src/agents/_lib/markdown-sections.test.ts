import { describe, expect, test } from "bun:test";
import {
  normalizeSectionText,
  preambleBody,
  sectionBody,
  stripSections,
} from "./markdown-sections.ts";

describe("preambleBody", () => {
  test("returns everything above the first level-2 heading", () => {
    const md = "# Brief\n\n_window: 90d_\n\n## Tickets\n\nrow one\n\n## Ownership\n\nother";
    expect(preambleBody(md)).toContain("_window: 90d_");
    expect(preambleBody(md)).not.toContain("row one");
    expect(preambleBody(md)).not.toContain("other");
  });

  test("a level-2 heading INSIDE a fence does not end the preamble", () => {
    // The markdown scanned here is the model's output, which may quote a `##` line in an
    // example. Ending the preamble there would hide a disclosure written below it and report
    // a dropped phrase that is present.
    const md = "# Brief\n\n```md\n## Tickets\n```\n\n_window: 90d_\n\n## Tickets\n\nrow one";
    expect(preambleBody(md)).toContain("_window: 90d_");
    expect(preambleBody(md)).not.toContain("row one");
  });

  test("a document with no level-2 heading is all preamble", () => {
    // A rewrite that returns one unstructured paragraph must still be searchable for the
    // clause, rather than reporting an empty preamble and rejecting on a technicality.
    expect(preambleBody("# Brief\n\n_window: 90d_")).toContain("_window: 90d_");
  });

  test("a level-3 heading does not end the preamble — only `##` opens a section", () => {
    const md = "# Brief\n\n### Note\n\n_window: 90d_\n\n## Tickets\n\nrow one";
    expect(preambleBody(md)).toContain("_window: 90d_");
  });
});

describe("normalizeSectionText", () => {
  test("strips emphasis, collapses whitespace and lowercases", () => {
    expect(normalizeSectionText("  **Gaps**   and\n_caveats_ ")).toBe("gaps and caveats");
  });
});

describe("sectionBody", () => {
  test("returns the body under a level-2 heading, up to the next same-or-higher heading", () => {
    const md = "## Tickets\n\nrow one\n\n### Note\n\nnested\n\n## Ownership\n\nother";
    expect(sectionBody(md, "Tickets")).toContain("row one");
    expect(sectionBody(md, "Tickets")).toContain("nested");
    expect(sectionBody(md, "Tickets")).not.toContain("other");
  });

  test("matches a heading by normalized prefix, not equality", () => {
    expect(sectionBody("## Ownership — services: checkout\n\nbody", "Ownership")).toContain("body");
  });

  test("a demoted heading does not open a section", () => {
    expect(sectionBody("### Tickets\n\nbody", "Tickets")).toBeUndefined();
  });

  test("accepts a heading argument already prefixed with '## '", () => {
    const md = "## Tickets\n\nrow one\n\n## Ownership\n\nother";
    expect(sectionBody(md, "## Tickets")).toContain("row one");
    expect(sectionBody(md, "## Tickets")).not.toContain("other");
  });

  test("an unspaced '##nospace' body line does not end the section (deliberately diverges from the pre-extraction scanner, which used a loose /^#+/ end match; CommonMark requires the space, so this is not a heading)", () => {
    const md = "## Tickets\n\nrow one\n##nospace still in body\n\n## Ownership\n\nother";
    const body = sectionBody(md, "Tickets");
    expect(body).toContain("row one");
    expect(body).toContain("##nospace still in body");
    expect(body).not.toContain("other");
  });
});

describe("stripSections", () => {
  test("removes a named level-2 section and its body", () => {
    const md = "# Brief\n\nkeep me\n\n## Gaps\n\n- invented\n\n## Next\n\nalso keep";
    const out = stripSections(md, ["## Gaps"]);
    expect(out).toContain("keep me");
    expect(out).toContain("also keep");
    expect(out).not.toContain("invented");
    expect(out).not.toContain("## Gaps");
  });

  test("removes a near-miss heading, because matching is a prefix", () => {
    const out = stripSections("body\n\n## Gaps and caveats\n\n- invented", ["## Gaps"]);
    expect(out).not.toContain("invented");
  });

  test("keeps a deeper heading nested inside a stripped section out of the output", () => {
    const md = "body\n\n## Gaps\n\n- one\n\n### Detail\n\n- two\n\n## Keep\n\nkept";
    const out = stripSections(md, ["## Gaps"]);
    expect(out).not.toContain("two");
    expect(out).toContain("kept");
  });

  test("is a no-op when no heading matches, and when the list is empty", () => {
    expect(stripSections("## Other\n\nbody", ["## Gaps"])).toContain("body");
    expect(stripSections("## Gaps\n\nbody", [])).toContain("body");
  });

  test("strips a heading carrying trailing punctuation or an extra clause", () => {
    expect(stripSections("body\n\n## Gaps:\n\n- x", ["## Gaps"])).not.toContain("- x");
    expect(stripSections("body\n\n## Gaps & Caveats\n\n- x", ["## Gaps"])).not.toContain("- x");
  });

  test("does NOT strip a demoted heading — only level 2 opens a section", () => {
    expect(stripSections("body\n\n### Gaps\n\n- x", ["## Gaps"])).toContain("- x");
  });

  test("accepts a bare-text heading argument (no '## ' prefix)", () => {
    const md = "body\n\n## Gaps\n\n- invented\n\n## Keep\n\nkept";
    const out = stripSections(md, ["Gaps"]);
    expect(out).not.toContain("invented");
    expect(out).toContain("kept");
  });
});

describe("fenced code blocks", () => {
  test("a heading inside a fence does not open a section", () => {
    const md = "## Real\n\n```md\n## Tickets\nnot a heading\n```\n\nstill under Real";
    expect(sectionBody(md, "Real")).toContain("still under Real");
    expect(sectionBody(md, "Tickets")).toBeUndefined();
  });

  test("a heading inside a fence is not stripped", () => {
    const md = "body\n\n```md\n## Gaps\n```\n\ntail";
    const out = stripSections(md, ["## Gaps"]);
    expect(out).toContain("## Gaps");
    expect(out).toContain("tail");
  });

  test("a tilde fence counts too", () => {
    const md = "body\n\n~~~\n## Gaps\n~~~\n\ntail";
    expect(stripSections(md, ["## Gaps"])).toContain("tail");
  });
});

// The heading matcher is a hand-written character scan, replacing the quadratic
// `/^(#+)\s+(.+)$/` (Sonar S8786 — a NON-matching long whitespace run made the
// engine walk every split: measured 8 ms at 5k characters, 511 ms at 40k, a clean
// 4x-input/16x-time curve). The scan is linear, and it was adopted on the promise
// that it accepts exactly the same lines as the regex did.
//
// These are the edge cases where that promise is non-obvious, and where the regex
// only ever succeeded by backtracking. Each one is a distinct arm of the scan, and
// none was covered when the rewrite landed — the file fell to 78.26% branch, under
// the 80% floor, which is what surfaced them.
const LINE_SEPARATOR = String.fromCharCode(0x2028);

describe("heading scan — the edge cases the old regex reached only by backtracking", () => {
  test("hashes then whitespace and NOTHING else is still a heading, with empty text", () => {
    // The regex matched here by handing `(.+)` the last whitespace character, so it
    // needed two: one for `\s+` and one for `.`. Two spaces clear that bar.
    expect(preambleBody(`intro\n##  \nafter`)).toBe("intro");
  });

  test("...but a SINGLE trailing space does not — `s+` and `.+` cannot both be fed", () => {
    expect(preambleBody(`intro\n## \nafter`)).toBe(`intro\n## \nafter`);
  });

  test("a whitespace-only tail ending in a line separator is not a heading", () => {
    // `$` is not multiline and `.` cannot match a line terminator, so the regex
    // failed here. U+2028 survives a `.split("\n")`, so the scan really can see it.
    const md = `intro\n##  ${LINE_SEPARATOR}\nafter`;
    expect(preambleBody(md)).toBe(md);
  });

  test("a text tail containing a line separator is not a heading", () => {
    const md = `intro\n## Gaps${LINE_SEPARATOR}x\nafter`;
    expect(preambleBody(md)).toBe(md);
  });

  test("an empty-text heading still closes the section above it", () => {
    expect(sectionBody(`## a\nbody\n##  \ntail`, "a")).toBe("body");
  });
});
