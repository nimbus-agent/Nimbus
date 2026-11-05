import { describe, expect, test } from "bun:test";

import { enableWritesPromptLines } from "./enable-prompt.ts";

describe("enableWritesPromptLines", () => {
  test("a well-formed payload lists the service, the wave, every write by state, and the fixed sentence", () => {
    expect(
      enableWritesPromptLines({
        service: "github",
        maxWave: 3,
        writes: [
          {
            toolId: "github_issue_create",
            actionType: "github.issue.create",
            wave: 2,
            offerable: true,
            state: "already_approved",
          },
          {
            toolId: "github_issue_update",
            actionType: "github.issue.update",
            wave: 2,
            offerable: true,
            state: "newly_offerable",
          },
          {
            toolId: "github_pr_merge",
            actionType: "github.pr.merge",
            wave: 3,
            offerable: false,
            state: "not_offerable",
          },
        ],
      }),
    ).toEqual([
      "Service: github",
      "Up to wave: 3",
      "  github_issue_create  github.issue.create  wave 2  (offered to the model)",
      "  github_issue_update  github.issue.update  wave 2  (new: offered after you approve)",
      "  github_pr_merge  github.pr.merge  wave 3  (not offered yet)",
      "",
      "Each call will still ask you before it runs.",
    ]);
  });

  test("a non-string service is malformed", () => {
    expect(enableWritesPromptLines({ service: 1, maxWave: 2, writes: [] })).toBeUndefined();
    expect(enableWritesPromptLines(undefined)).toBeUndefined();
  });

  test("a writes entry missing toolId is malformed", () => {
    expect(
      enableWritesPromptLines({
        service: "github",
        maxWave: 2,
        writes: [
          { actionType: "github.issue.create", wave: 2, offerable: true, state: "newly_offerable" },
        ],
      }),
    ).toBeUndefined();
  });

  test("a writes entry without a boolean offerable is malformed", () => {
    expect(
      enableWritesPromptLines({
        service: "github",
        maxWave: 2,
        writes: [
          {
            toolId: "github_issue_create",
            actionType: "github.issue.create",
            wave: 2,
            state: "not_offerable",
          },
        ],
      }),
    ).toBeUndefined();
  });

  test("a missing, unknown, inherited or contradictory state is malformed", () => {
    const base = { toolId: "github_issue_create", actionType: "github.issue.create", wave: 2 };
    for (const w of [
      { ...base, offerable: true },
      { ...base, offerable: true, state: "approved" },
      { ...base, offerable: true, state: "toString" },
      { ...base, offerable: false, state: "already_approved" },
      { ...base, offerable: false, state: "newly_offerable" },
      { ...base, offerable: true, state: "not_offerable" },
    ]) {
      expect(
        enableWritesPromptLines({ service: "github", maxWave: 2, writes: [w] }),
      ).toBeUndefined();
    }
  });

  test("a control character in a value is shown as a visible escape", () => {
    const esc = String.fromCodePoint(0x1b);
    const lines = enableWritesPromptLines({ service: `git${esc}hub`, maxWave: 3, writes: [] });
    expect(lines?.[0]).toBe(String.raw`Service: git\u{001B}hub`);
  });
});
