import { describe, expect, test } from "bun:test";

import { AGENT_DOOR_BOUNDS, AGENT_DOOR_BOUNDS_FILES } from "./agent-door-bounds.ts";

describe("the agent door's stated bounds", () => {
  test("are five sentences, one paragraph, with the self-approval sentence last (OR-AD-6)", () => {
    expect(AGENT_DOOR_BOUNDS).not.toMatch(/[\r\n]| {2}/);
    const sentences = AGENT_DOOR_BOUNDS.split(/(?<=\.) /);
    expect(sentences).toEqual([
      "The agent door guards writes that pass through Nimbus.",
      "An agent that holds its own credentials, or can run commands, can act without it.",
      "The ledger records the actions Nimbus dispatches, not network traffic.",
      "The proposer's name is not verified.",
      "Until desktop approval ships, an agent that can run commands in your terminal can still approve its own proposals.",
    ]);
  });

  test("name the documents that must carry them, each once, as repository-relative paths", () => {
    expect(new Set(AGENT_DOOR_BOUNDS_FILES).size).toBe(AGENT_DOOR_BOUNDS_FILES.length);
    for (const file of AGENT_DOOR_BOUNDS_FILES) {
      expect(file).toMatch(/^(docs|packages\/docs)\/[\w./-]+\.mdx?$/);
    }
    expect(AGENT_DOOR_BOUNDS_FILES).toContain("docs/README.md");
    expect(AGENT_DOOR_BOUNDS_FILES).toContain("docs/SECURITY.md");
  });
});
