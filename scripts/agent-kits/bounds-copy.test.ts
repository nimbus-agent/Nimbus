// The agent door's stated bounds are ONE set of sentences (spec section 7.8, OR-AD-6). This test
// fails when a document that must carry them says something else.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AGENT_DOOR_BOUNDS,
  AGENT_DOOR_BOUNDS_FILES,
} from "../../packages/cli/src/lib/agent-door-bounds.ts";

const ROOT = join(import.meta.dir, "..", "..");

/** Line wrapping is not wording: every run of whitespace is one space. */
function flat(text: string): string {
  return text.replaceAll(/\s+/g, " ");
}

describe("the agent door's bounds copy", () => {
  test("is the five sentences the owner ruled on, the self-approval one last", () => {
    const sentences = AGENT_DOOR_BOUNDS.split(/(?<=\.) /);
    expect(sentences).toHaveLength(5);
    expect(sentences[0]).toBe("The agent door guards writes that pass through Nimbus.");
    expect(sentences[3]).toBe("The proposer's name is not verified.");
    expect(sentences[4]).toBe(
      "Until desktop approval ships, an agent that can run commands in your terminal can still approve its own proposals.",
    );
  });

  test.each(AGENT_DOOR_BOUNDS_FILES.map((f) => [f]))("%s carries it verbatim, once", (file) => {
    const text = flat(readFileSync(join(ROOT, file), "utf8"));
    expect(text.split(AGENT_DOOR_BOUNDS).length - 1).toBe(1);
  });

  test("a changed sentence is caught (the check is not satisfied by a near miss)", () => {
    const near = AGENT_DOOR_BOUNDS.replace("is not verified", "is verified");
    expect(flat(`intro ${near} outro`).includes(AGENT_DOOR_BOUNDS)).toBe(false);
    expect(flat(`intro ${AGENT_DOOR_BOUNDS.replaceAll(" ", "\n")} outro`)).toContain(
      AGENT_DOOR_BOUNDS,
    );
  });
});
