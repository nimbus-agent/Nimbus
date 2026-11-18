import { describe, expect, it } from "vitest";
import { detailText } from "../../../src/components/incidents/IncidentFindings";
import { remediateCommand } from "../../../src/components/incidents/IncidentProposals";
import { stamp } from "../../../src/components/incidents/safe";

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
