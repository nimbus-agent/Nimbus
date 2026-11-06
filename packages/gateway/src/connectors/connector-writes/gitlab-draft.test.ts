// Phase 9.7 C2: the display-only GitLab draft-title detector. Invisible characters are built with
// String.fromCodePoint: none is written literally.
import { describe, expect, test } from "bun:test";

import { gitlabTitleLooksDraft } from "./gitlab-draft.ts";

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

  test("is linear in the title length (no backtracking blow-up)", () => {
    const start = performance.now();
    gitlabTitleLooksDraft(`${" ".repeat(200_000)}x`);
    gitlabTitleLooksDraft(`[${"draft".repeat(40_000)}`);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
