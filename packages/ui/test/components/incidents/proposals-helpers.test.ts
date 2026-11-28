import { describe, expect, it } from "vitest";
import { detailText } from "../../../src/components/incidents/IncidentFindings";
import {
  remediateCommand,
  reversibilityText,
} from "../../../src/components/incidents/IncidentProposals";
import { stamp } from "../../../src/components/incidents/safe";
import type { IncidentProposal } from "../../../src/ipc/types";

describe("remediateCommand", () => {
  it("builds the command only from gateway-shaped ids", () => {
    expect(remediateCommand("inc_0123456789abcdef", "prp_0123456789abcdef")).toBe(
      "nimbus incident remediate inc_0123456789abcdef --pick prp_0123456789abcdef",
    );
    const bad: ReadonlyArray<readonly [string, string]> = [
      ["inc_0123456789abcdef; rm -rf ~", "prp_0123456789abcdef"],
      ["inc_0123456789abcdef", "prp_0123456789abcdef && curl x"],
      ["pagerduty:A", "prp_0123456789abcdef"],
      ["inc_0123456789ABCDEF", "prp_0123456789abcdef"],
      ["inc_0123456789abcdef", ""],
    ];
    for (const [r, p] of bad) {
      expect(remediateCommand(r, p)).toBeNull();
    }
  });
});

describe("reversibilityText", () => {
  const base: IncidentProposal = {
    id: "prp_0123456789abcdef",
    kind: "repeat_last",
    toolId: "split_kill",
    input: {},
    evidence: null,
    confidence: null,
    reversibility: "reversible",
    irreversibleReason: null,
    status: "proposed",
    createdAtMs: 0,
    expiresAtMs: 0,
    actionId: null,
    undoStatus: null,
    undoable: false,
  };
  it("names the condition of a conditionally reversible row, never plain reversible", () => {
    expect(
      reversibilityText({
        ...base,
        toolId: "unleash_feature_toggle",
        reversibleIf: "the environment already has an active strategy",
      }),
    ).toBe(
      "reversible only if the environment already has an active strategy; otherwise IRREVERSIBLE",
    );
  });
  it("keeps the class for an unconditional row and for a condition on a non-reversible class", () => {
    expect(reversibilityText(base)).toBe("reversible");
    expect(reversibilityText({ ...base, reversibility: "unknown", reversibleIf: "x" })).toBe(
      "unknown",
    );
  });
});

describe("detailText", () => {
  it("lists scalar keys in order and hides nested values; a non-object is empty", () => {
    expect(detailText({ b: 1, a: "x", c: null, d: [1], e: true })).toBe(
      "a: x, b: 1, c: null, d: (not shown), e: true",
    );
    expect(detailText(null)).toBe("");
    expect(detailText([1, 2])).toBe("");
  });
});

describe("stamp", () => {
  it("formats a UTC second and refuses a time no Date holds", () => {
    expect(stamp(0)).toBe("1970-01-01T00:00:00Z");
    expect(stamp(Number.NaN)).toBe("unknown time");
    expect(stamp(9e15)).toBe("unknown time");
  });
});
