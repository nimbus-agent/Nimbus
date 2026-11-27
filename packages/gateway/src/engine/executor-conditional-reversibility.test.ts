// A conditionally reversible row (the Unleash toggle, owner ruling 2026-11-27) is never labelled plain
// "reversible" in a prompt: the prompt has no captured before-state (IC5a), so it names the condition and
// why a call outside it cannot be undone. An unconditional row (the Split kill) keeps the plain label.
import { describe, expect, test } from "bun:test";

import { formatConsentPrompt } from "./executor.ts";
import type { EngineProposal, PlannedAction, RunbookStepRef } from "./types.ts";

const UNLEASH_INPUT = {
  projectId: "web",
  featureName: "f",
  environment: "production",
  enabled: true,
};
const SPLIT_INPUT = { workspaceId: "ws", splitName: "s", environment: "production" };

function prompt(
  type: string,
  mcpToolId: string,
  input: Record<string, unknown>,
  extra: { runbookStep?: RunbookStepRef; engineProposal?: EngineProposal },
): string {
  const action: PlannedAction = {
    type,
    payload: { mcpToolId, input },
    incident: { id: "inc_0123456789abcdef", version: 1 },
    ...extra,
  };
  return formatConsentPrompt(action);
}

const STEP: RunbookStepRef = {
  runbook: "flags",
  step: 1,
  kind: "action",
  reversibility: "reversible",
};
const PROPOSAL: EngineProposal = {
  proposalId: "prp_0123456789abcdef",
  reversibility: "reversible",
};

describe("the reversibility line of a conditionally reversible row", () => {
  test("a runbook step of the Unleash toggle names the condition and the reason, never plain reversible", () => {
    const p = prompt("unleash.feature.toggle", "unleash_unleash_feature_toggle", UNLEASH_INPUT, {
      runbookStep: STEP,
    });
    expect(p).toContain(
      "Reversibility: reversible only if the environment already has an active strategy (declared); otherwise IRREVERSIBLE - Unleash adds a default strategy that serves everyone when it enables an environment with no active strategy, and turning it off does not remove it; nimbus incident undo does not reverse a runbook step",
    );
    expect(p).not.toContain("Reversibility: reversible (declared)");
  });

  test("an engine proposal of the Unleash toggle says undo reverses it only under the condition", () => {
    const p = prompt("unleash.feature.toggle", "unleash_unleash_feature_toggle", UNLEASH_INPUT, {
      engineProposal: PROPOSAL,
    });
    expect(p).toContain(
      "Reversibility: reversible only if the environment already has an active strategy (nimbus incident undo can reverse it then); otherwise IRREVERSIBLE - Unleash adds a default strategy",
    );
    expect(p).not.toContain("Reversibility: reversible - nimbus incident undo can reverse it");
  });

  test("the Split kill, reversible for every call that changed something, keeps the plain labels", () => {
    expect(
      prompt("split.flag.kill", "split_split_kill", SPLIT_INPUT, { runbookStep: STEP }),
    ).toContain(
      "Reversibility: reversible (declared); nimbus incident undo does not reverse a runbook step",
    );
    expect(
      prompt("split.flag.kill", "split_split_kill", SPLIT_INPUT, { engineProposal: PROPOSAL }),
    ).toContain("Reversibility: reversible - nimbus incident undo can reverse it");
  });
});
