import { describe, expect, test } from "bun:test";
import { normalizeSectionText, sectionBody, stripSections } from "./markdown-sections.ts";

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
