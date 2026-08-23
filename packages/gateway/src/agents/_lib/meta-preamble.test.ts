import { describe, expect, test } from "bun:test";

import { stripMetaPreamble } from "./markdown-sections.ts";

/**
 * F4 — the synthesis prompt leaked into user-facing output. `nimbus glossary --refresh` opened
 * with "Based on the provided tool output, I will provide a deterministic fallback rendering of
 * the glossary terms as a structural template, without copying verbatim." Every distinctive phrase
 * there is prompt vocabulary.
 *
 * A strip beats a prompt directive here for the same reason the reserved-section machinery is a
 * strip: directives are advisory and depend on model politeness, strips are structural.
 */
describe("stripMetaPreamble (F4)", () => {
  test("removes the observed preamble", () => {
    const md =
      "Based on the provided tool output, I will provide a deterministic fallback rendering of the glossary terms as a structural template, without copying verbatim.\n\n# Glossary\n\n- **main** — 21 mention(s)";
    const out = stripMetaPreamble(md);
    expect(out).not.toContain("deterministic fallback");
    expect(out).toContain("# Glossary");
    expect(out).toContain("**main**");
  });

  // These cases assert one property — the input comes back byte-identical — and differ only in
  // WHICH input. Parameterized (S5976) so the next case is a row rather than a fourth copy of the
  // same body, and so a change to the property is made in one place.
  test.each([
    ["a brief with no preamble", "# Glossary\n\n- **main** — 21 mention(s)"],
    // `negotiate`'s window clause lives in exactly this position and is the thing I31 exists to
    // protect. Stripping it to remove model chatter would be a far worse trade than leaving the
    // chatter in.
    [
      "a renderer-authored disclosure",
      "_window: last 90d — the index records last-modified, not created._\n\n# Negotiation brief",
    ],
    ["ordinary prose above a heading", "A short summary of the week.\n\n# Catchup"],
  ])("leaves %s untouched", (_case, md) => {
    expect(stripMetaPreamble(md)).toBe(md);
  });

  test("only the paragraph before the first heading is considered", () => {
    // A document-wide search would delete a legitimate body sentence that happens to use one of
    // these phrases — "the decision was made based on the provided benchmark", say.
    const md =
      "# Decisions\n\nWe chose Postgres based on the provided benchmark numbers.\n\n## Gaps\n\n- none";
    expect(stripMetaPreamble(md)).toContain("based on the provided benchmark");
  });
});
