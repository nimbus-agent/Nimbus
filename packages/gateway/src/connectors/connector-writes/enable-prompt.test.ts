import { describe, expect, test } from "bun:test";

import { enableWritesPromptLines } from "./enable-prompt.ts";

describe("enableWritesPromptLines", () => {
  test("a well-formed payload lists the service, the wave, every write and the fixed sentence", () => {
    expect(
      enableWritesPromptLines({
        service: "github",
        maxWave: 2,
        writes: [
          {
            toolId: "github_issue_create",
            actionType: "github.issue.create",
            wave: 2,
            offerable: true,
          },
          { toolId: "github_pr_merge", actionType: "github.pr.merge", wave: 3, offerable: false },
        ],
      }),
    ).toEqual([
      "Service: github",
      "Up to wave: 2",
      "  github_issue_create  github.issue.create  wave 2  (offered to the model)",
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
        writes: [{ actionType: "github.issue.create", wave: 2, offerable: true }],
      }),
    ).toBeUndefined();
  });

  test("a writes entry without a boolean offerable is malformed", () => {
    expect(
      enableWritesPromptLines({
        service: "github",
        maxWave: 2,
        writes: [{ toolId: "github_issue_create", actionType: "github.issue.create", wave: 2 }],
      }),
    ).toBeUndefined();
  });

  test("a control character in a value is shown as a visible escape", () => {
    const esc = String.fromCodePoint(0x1b);
    const lines = enableWritesPromptLines({ service: `git${esc}hub`, maxWave: 3, writes: [] });
    expect(lines?.[0]).toBe(String.raw`Service: git\u{001B}hub`);
  });
});
