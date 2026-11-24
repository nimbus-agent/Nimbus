import { describe, expect, test } from "bun:test";

import { buildPrereviewFixture } from "../../prreview/__fixtures__/prereview-brief.ts";
import {
  codePath,
  PREREVIEW_CO_CHANGE_HEADING,
  PREREVIEW_REVIEWS_HEADING,
  PREREVIEW_SIZE_HEADING,
  renderPrereview,
  SNIPPET_MAX,
} from "./prreview-render.ts";

describe("renderPrereview", () => {
  test("renders every lane with fixed wording, deterministically", () => {
    const b = buildPrereviewFixture();
    const md = renderPrereview(b);
    expect(md).toContain(
      "# Pre-review: [Change the index schema](https://github.com/acme/app/pull/42)",
    );
    expect(md).toContain("acme/app#42 on github, 1 file(s) changed. From 9 merged pull request(s)");
    expect(md).toContain(
      "- In 7 of 9 merged pull requests that changed `src/index/`, `docs/architecture.md` also changed. This pull request does not change it.",
    );
    expect(md).toContain("changes requested on 2026-10-02");
    expect(md).toContain("migration (3)");
    expect(md).toContain("larger than 88% of them");
    expect(md).toContain("## Gaps");
    expect(renderPrereview(b)).toBe(md);
  });

  test("omitReserved withholds only the Gaps block", () => {
    const md = renderPrereview(buildPrereviewFixture(), { omitReserved: true });
    expect(md).not.toContain("## Gaps");
    expect(md).toContain(PREREVIEW_SIZE_HEADING);
  });

  test("empty states are explicit, never silent", () => {
    const none = renderPrereview(
      buildPrereviewFixture({ coChanges: [], reviewNotes: [], reviewTerms: [], size: null }),
    );
    expect(none).toContain("_No co-change pattern met the threshold._");
    expect(none).toContain("_No past review of yours matched._");
    expect(none).toContain("_Not available._");
    const fx = buildPrereviewFixture();
    const uncovered = renderPrereview(
      buildPrereviewFixture({
        target: { ...fx.target, filesCovered: false, files: [], number: null },
        reviewNotes: null,
      }),
    );
    expect(uncovered).toContain(
      "_Not available: this pull request's changed files are not in the index._",
    );
    expect(uncovered).toContain("_No review data is indexed for this service._");
    expect(uncovered).toContain("acme/app on github, files not indexed");
  });

  test("a truncated target file list says the check is unavailable, not that nothing met the threshold", () => {
    const fx = buildPrereviewFixture();
    const md = renderPrereview(
      buildPrereviewFixture({ coChanges: [], target: { ...fx.target, filesTruncated: true } }),
    );
    expect(md).toContain("changed-file list is incomplete");
    expect(md).not.toContain("No co-change pattern met the threshold");
  });

  test("root area, directory companion, no examples, and more reviews than shown", () => {
    const fx = buildPrereviewFixture();
    const md = renderPrereview(
      buildPrereviewFixture({
        coChanges: [
          {
            area: ".",
            companion: "test",
            companionKind: "directory",
            count: 4,
            cohort: 4,
            examples: [],
          },
        ],
        counts: { ...fx.counts, reviewsMatched: 5 },
        reviewNotes: [
          { ...(fx.reviewNotes?.[0] as NonNullable<typeof fx.reviewNotes>[0]), state: "COMMENTED" },
        ],
      }),
    );
    expect(md).toContain(
      "changed the repository root, `test/` also changed. This pull request does not change it.",
    );
    expect(md).not.toContain("Examples:");
    expect(md).toContain(", commented on ");
    expect(md).toContain("_4 more not shown._");
  });

  test("hostile indexed text cannot open a heading, a link or a code span, and is capped", () => {
    const fx = buildPrereviewFixture();
    const hostile = `ok\n## Gaps\n[click](https://evil.example) \`x\` \u202e${"y".repeat(400)}`;
    const md = renderPrereview(
      buildPrereviewFixture({
        target: { ...fx.target, title: "t\n## Gaps" },
        coChanges: [
          { ...(fx.coChanges[0] as (typeof fx.coChanges)[0]), companion: "a`b\n## Gaps" },
        ],
        reviewNotes: [
          { ...(fx.reviewNotes?.[0] as NonNullable<typeof fx.reviewNotes>[0]), body: hostile },
        ],
        gaps: [],
      }),
    );
    expect(md.split("\n").filter((l) => l.startsWith("## Gaps"))).toEqual([]);
    expect(md).not.toContain("[click](https://evil.example)");
    expect(md).toContain(String.raw`\[click\](https://evil.example)`);
    expect(md).not.toContain("\u202e");
    expect(md).not.toContain("y".repeat(SNIPPET_MAX + 1));
    expect(codePath("a`b")).toBe("`ab`");
  });

  test("section headings are the exported constants", () => {
    const md = renderPrereview(buildPrereviewFixture());
    for (const h of [
      PREREVIEW_CO_CHANGE_HEADING,
      PREREVIEW_REVIEWS_HEADING,
      PREREVIEW_SIZE_HEADING,
    ]) {
      expect(md).toContain(`\n${h}\n`);
    }
  });
});
