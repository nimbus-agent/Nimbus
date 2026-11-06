// Phase 9.7 C2: the display-only GitLab draft-title detector. Invisible characters are built with
// String.fromCodePoint: none is written literally.
import { describe, expect, test } from "bun:test";

import { gitlabTitleIsDraftExact, gitlabTitleLooksDraft } from "./gitlab-draft.ts";

const ZWSP = String.fromCodePoint(0x200b);
const RLO = String.fromCodePoint(0x202e);

describe("gitlabTitleLooksDraft", () => {
  test.each([
    "Draft: x",
    "draft: x",
    "[Draft] x",
    "(DRAFT) x",
    "  Draft: x",
    "WIP: x",
    "[wip] x",
    "(WIP) x",
    `${ZWSP}Draft: x`,
    `${RLO}[Draft] x`,
    `Dra${ZWSP}ft: x`,
    "Draft:x",
  ])("draft: %j", (title) => {
    expect(gitlabTitleLooksDraft(title)).toBe(true);
  });

  test.each(["Drafts: x", "x Draft:", "Draft x", "Draftsman", "", "   ", "Fix the draft: now"])(
    "not a draft: %j",
    (title) => {
      expect(gitlabTitleLooksDraft(title)).toBe(false);
    },
  );

  test("a title that never settles (nested entities) counts as a draft: the detector errs towards draft", () => {
    expect(gitlabTitleLooksDraft(`&${"amp;".repeat(12)}lt;x`)).toBe(true);
  });

  test("is linear in the title length (no backtracking blow-up)", () => {
    const start = performance.now();
    gitlabTitleLooksDraft(`${" ".repeat(200_000)}x`);
    gitlabTitleLooksDraft(`[${"draft".repeat(40_000)}`);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});

describe("gitlabTitleIsDraftExact (GitLab's own rule on the raw title)", () => {
  test.each(["Draft: x", "DRAFT: x", "[draft] x", "(Draft) x", "Draft:x"])("draft: %j", (t) => {
    expect(gitlabTitleIsDraftExact(t)).toBe(true);
  });
  test.each([
    "WIP: x",
    " Draft: x",
    `Dra${ZWSP}ft: x`,
    "Draft：x",
    "［Draft］x",
    "Draft&#58; x",
    "x",
  ])("not a draft: %j", (t) => {
    expect(gitlabTitleIsDraftExact(t)).toBe(false);
  });
  test("is linear in the title length", () => {
    const start = performance.now();
    gitlabTitleIsDraftExact(`[${"draft".repeat(40_000)}`);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
