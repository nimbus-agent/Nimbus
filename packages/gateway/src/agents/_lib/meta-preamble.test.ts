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

  test("leaves a brief with no preamble untouched", () => {
    const md = "# Glossary\n\n- **main** — 21 mention(s)";
    expect(stripMetaPreamble(md)).toBe(md);
  });

  test("never strips a renderer-authored disclosure", () => {
    // `negotiate`'s window clause lives in exactly this position and is the thing I31 exists to
    // protect. Stripping it to remove model chatter would be a far worse trade than leaving the
    // chatter in.
    const md =
      "_window: last 90d — the index records last-modified, not created._\n\n# Negotiation brief";
    expect(stripMetaPreamble(md)).toBe(md);
  });

  test("only the paragraph before the first heading is considered", () => {
    // A document-wide search would delete a legitimate body sentence that happens to use one of
    // these phrases — "the decision was made based on the provided benchmark", say.
    const md =
      "# Decisions\n\nWe chose Postgres based on the provided benchmark numbers.\n\n## Gaps\n\n- none";
    expect(stripMetaPreamble(md)).toContain("based on the provided benchmark");
  });

  test("ordinary prose above a heading survives", () => {
    const md = "A short summary of the week.\n\n# Catchup";
    expect(stripMetaPreamble(md)).toBe(md);
  });
});
