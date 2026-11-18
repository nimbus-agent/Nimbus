import { describe, expect, test } from "bun:test";

import { formatConsentPrompt } from "./executor.ts";
import type { PlannedAction, RunbookStepRef } from "./types.ts";

/** IC6 (I57 (c)): the prompt names the runbook and the step, and for an action the declared reversibility. */
function promptFor(runbookStep: RunbookStepRef): string {
  const action: PlannedAction = {
    type: "slack.message.post",
    payload: { mcpToolId: "slack_slack_message_post", input: { channel: "C1", text: "x" } },
    incident: { id: "inc_0123456789abcdef", version: 1 },
    runbookStep,
  };
  return formatConsentPrompt(action);
}

describe("the runbook proposer lines", () => {
  test("a read step names the runbook and the step and no reversibility", () => {
    const p = promptFor({ runbook: "pay", step: 2, kind: "read" });
    expect(p).toContain("Proposed by: runbook pay, step 2");
    expect(p).not.toContain("Reversibility:");
  });

  test("an action step adds its declared reversibility, irreversible first and in capitals", () => {
    const line = (reversibility: "reversible" | "irreversible" | "unknown"): string =>
      promptFor({ runbook: "pay", step: 3, kind: "action", reversibility });
    expect(line("irreversible")).toContain(
      "Reversibility: IRREVERSIBLE - this cannot be undone through Nimbus",
    );
    expect(line("reversible")).toContain(
      "Reversibility: reversible (declared); nimbus incident undo does not reverse a runbook step",
    );
    expect(line("unknown")).toContain(
      "Reversibility: unknown - Nimbus does not know whether this can be undone",
    );
    expect(line("unknown")).toContain("Proposed by: runbook pay, step 3");
  });
});
