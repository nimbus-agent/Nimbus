import { describe, expect, test } from "bun:test";
import {
  normalizeSectionText,
  preambleBody,
  sectionBody,
  stripSections,
  stripSerializedGapEnvelope,
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

  // INVERTED on purpose (F29). This asserted `.toContain("- x")` — that a demoted `### Gaps`
  // survives. The rationale for that was sound as written: widening the strip to deeper levels
  // could delete legitimate sub-structure. It does not hold for a RESERVED name. The renderer
  // writes each reserved section exactly once, at level 2, so a second occurrence at ANY level is
  // fabrication by construction. `nimbus why` was observed shipping `# Deterministic Findings`
  // with a `### Gaps` nested under it, raw `category:`/`detail:` fields and all, beside the
  // canonical `## Gaps`.
  test("strips a DEMOTED reserved heading — a reserved name at any level is fabrication", () => {
    expect(stripSections("body\n\n### Gaps\n\n- x", ["## Gaps"])).not.toContain("- x");
  });

  test("strips a PROMOTED reserved heading (F2: `# Gaps` at level 1)", () => {
    const md = "# Impact: x\n\nkeep me\n\n# Gaps\n\n- invented\n\n## Gaps\n\n- canonical";
    const out = stripSections(md, ["## Gaps"]);
    expect(out).not.toContain("invented");
    expect(out).toContain("keep me");
  });

  // The observed `why` shape: a fabricated H1 with the reserved name demoted beneath it. The
  // wrapper heading is not reserved and legitimately survives; its `### Gaps` child does not.
  test("strips a demoted reserved heading nested under a fabricated parent", () => {
    const md = [
      "# Why",
      "",
      "# Deterministic Findings",
      "### Gaps",
      "* `missing_relation_emit`: invented",
      "",
      "## Gaps",
      "",
      "- canonical",
    ].join("\n");
    const out = stripSections(md, ["## Gaps"]);
    expect(out).not.toContain("invented");
    expect(out).toContain("# Deterministic Findings");
  });

  // A demoted section ends at the next same-or-higher heading, not at the next `##`. Without
  // this, stripping a `### Gaps` would swallow every `###` after it up to the next `##`.
  test("a demoted reserved section ends at the next same-or-higher heading", () => {
    const md = "## S\n\n### Gaps\n\n- invented\n\n### Sibling\n\nkept";
    const out = stripSections(md, ["## Gaps"]);
    expect(out).not.toContain("invented");
    expect(out).toContain("kept");
    expect(out).toContain("### Sibling");
  });

  test("a reserved heading inside a fence is still not stripped at any level", () => {
    const md = "body\n\n```md\n### Gaps\n- example\n```\n\nafter";
    const out = stripSections(md, ["## Gaps"]);
    expect(out).toContain("- example");
    expect(out).toContain("after");
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

describe("stripSerializedGapEnvelope", () => {
  // The `negotiate` shape: a plain-text `Gaps:` label with no heading at all, followed by the
  // raw envelope fields. `stripSections` operates on parsed headings, so this is invisible to it
  // at EVERY level — which is why F2's `h.level > 2` fix, and F29's level-agnostic one, both
  // leave it standing. Keyed on the field names instead, which are internal and have no
  // legitimate place in any rendered brief.
  test("removes a non-heading `Gaps:` label and the serialized fields under it", () => {
    const md = [
      "## Evidence not available from the index",
      "",
      " deploys triggered",
      "Gaps:",
      "category: missing_relation_emit",
      "detail: No PagerDuty incident is attributed to a person.",
      "remediation: Run `nimbus connector sync pagerduty`.",
      "",
      "## Sources",
      "",
      "- canonical",
    ].join("\n");
    const out = stripSerializedGapEnvelope(md);
    expect(out).not.toContain("category:");
    expect(out).not.toContain("missing_relation_emit");
    expect(out).not.toContain("Gaps:");
    expect(out).toContain("## Sources");
  });

  // The `janitor` shape: a bare `Gaps` line, no colon, immediately above the fields.
  test("removes a bare `Gaps` label line above the fields", () => {
    const md = "Latency: 0 ms\nGaps\ncategory: missing_connector\ndetail: no paired peers\n\nkeep";
    const out = stripSerializedGapEnvelope(md);
    expect(out).not.toContain("category:");
    expect(out).not.toContain("no paired peers");
    expect(out).toContain("keep");
    // `Latency: 0 ms` is a rendered brief line, not an envelope field. It must survive.
    expect(out).toContain("Latency: 0 ms");
  });

  test("handles list-marker and indented spellings of the same fields", () => {
    const md = "- category: missing_connector\n  detail: x\n  remediation: y\n\nkeep";
    const out = stripSerializedGapEnvelope(md);
    expect(out).not.toContain("missing_connector");
    expect(out).toContain("keep");
  });

  // Fail-closed the other way: a run without a recognised `category:` value is NOT an envelope.
  // A quoted definition or a user's prose could contain "detail:" on its own line, and losing
  // that is a real cost with no matching benefit.
  test("leaves prose alone when no known gap category is present", () => {
    const md = "detail: a quoted line from a Notion page\nremediation: another\n\nkeep";
    expect(stripSerializedGapEnvelope(md)).toBe(md.trimEnd());
  });

  test("leaves an unknown category value alone", () => {
    const md = "category: something_else\ndetail: x\n\nkeep";
    expect(stripSerializedGapEnvelope(md)).toBe(md.trimEnd());
  });

  test("does not touch content inside a fenced block", () => {
    const md = "```yaml\ncategory: missing_connector\ndetail: an example\n```\n\nkeep";
    const out = stripSerializedGapEnvelope(md);
    expect(out).toContain("an example");
    expect(out).toContain("keep");
  });

  test("is identity on a brief that contains no envelope", () => {
    const md = "# Brief\n\n## Gaps\n\n- No PagerDuty incident is attributed to a person.";
    expect(stripSerializedGapEnvelope(md)).toBe(md);
  });

  test("removes every envelope run, not just the first", () => {
    const md = [
      "category: missing_connector",
      "detail: one",
      "",
      "middle",
      "",
      "category: empty_index",
      "detail: two",
    ].join("\n");
    const out = stripSerializedGapEnvelope(md);
    expect(out).not.toContain("detail: one");
    expect(out).not.toContain("detail: two");
    expect(out).toContain("middle");
  });
});

/**
 * The four leaks actually captured from a running 2.10.0 gateway with `[agents] synthesis =
 * "local"`, run through BOTH strips in the order `synthesize.ts` applies them.
 *
 * These are transcripts, not hypotheticals. A survey of eight briefs found six shipping a
 * duplicated Gaps block in three spellings, five of them carrying raw envelope field names into
 * user-facing output. Each case is named for the brief it came from so a future regression points
 * at something reproducible.
 */
describe("captured synthesis leaks (F2 / F28 / F29)", () => {
  // Both strips, in the order `synthesize.ts` applies them. Note this removes the CANONICAL
  // `## Gaps` too, and must: the strip runs on the model's markdown and `joinReserved` re-attaches
  // the renderer-built block immediately afterwards. Asserting the canonical text survives the
  // strip would assert the opposite of the design.
  const strip = (md: string): string => stripSerializedGapEnvelope(stripSections(md, ["## Gaps"]));

  test("why: `### Gaps` demoted under a fabricated `# Deterministic Findings`", () => {
    const out = strip(
      "# Why\n\n# Deterministic Findings\n### Gaps\n* `missing_relation_emit`: LEAK\n\n## Gaps\n\n- canonical",
    );
    expect(out).not.toContain("LEAK");
    expect(out).toContain("# Why");
  });

  test("conflicts: `# Gaps` promoted to level 1, with raw fields", () => {
    const out = strip(
      "# Conflicts\n\n# Gaps\ncategory: missing_connector\n  detail: LEAK\n\n## Gaps\n\n- canonical",
    );
    expect(out).not.toContain("LEAK");
  });

  test("negotiate: a `Gaps:` paragraph label — no heading at all", () => {
    const out = strip(
      "## Evidence not available from the index\n\n deploys triggered\nGaps:\ncategory: missing_relation_emit\ndetail: LEAK\nremediation: LEAK2\n\n## Sources\n\n- canonical",
    );
    expect(out).not.toContain("LEAK");
  });

  test("janitor: a bare `Gaps` line AND a promoted `# Gaps`, in one brief", () => {
    const out = strip(
      "# Janitor\nLatency: 0 ms\nGaps\n# Gaps\ncategory: missing_connector\ndetail: LEAK\n\n## Gaps\n\n- canonical",
    );
    expect(out).not.toContain("LEAK");
    // A rendered brief line that merely LOOKS field-shaped must survive.
    expect(out).toContain("Latency: 0 ms");
  });
});
