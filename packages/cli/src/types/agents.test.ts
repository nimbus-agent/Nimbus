import { describe, expect, it } from "bun:test";

import { isCatchupBrief, isExpertBrief, isImpactBrief } from "./agents.ts";

describe("isExpertBrief", () => {
  it("returns true for a valid ExpertBrief", () => {
    const brief = {
      kind: "expert",
      agentVersion: 1,
      generatedAt: 0,
      latencyMs: 0,
      gaps: [],
      ranked: [],
      query: { topicOrFile: "x" },
    };
    expect(isExpertBrief(brief)).toBe(true);
  });

  it("returns false when kind is wrong", () => {
    expect(
      isExpertBrief({
        kind: "impact",
        agentVersion: 1,
        generatedAt: 0,
        latencyMs: 0,
        gaps: [],
        ranked: [],
      }),
    ).toBe(false);
  });

  it("returns false when agentVersion is wrong", () => {
    expect(
      isExpertBrief({
        kind: "expert",
        agentVersion: 2,
        generatedAt: 0,
        latencyMs: 0,
        gaps: [],
        ranked: [],
      }),
    ).toBe(false);
  });

  it("returns false when gaps is not an array", () => {
    expect(
      isExpertBrief({
        kind: "expert",
        agentVersion: 1,
        generatedAt: 0,
        latencyMs: 0,
        gaps: "no",
        ranked: [],
      }),
    ).toBe(false);
  });

  it("returns false when ranked is not an array", () => {
    expect(
      isExpertBrief({
        kind: "expert",
        agentVersion: 1,
        generatedAt: 0,
        latencyMs: 0,
        gaps: [],
        ranked: { bogus: 1 },
      }),
    ).toBe(false);
  });

  it("returns false for null / non-object inputs", () => {
    expect(isExpertBrief(null)).toBe(false);
    expect(isExpertBrief("string")).toBe(false);
    expect(isExpertBrief(42)).toBe(false);
    expect(isExpertBrief(undefined)).toBe(false);
  });
});

describe("isImpactBrief", () => {
  it("returns true for a valid ImpactBrief", () => {
    const brief = {
      kind: "impact",
      agentVersion: 1,
      generatedAt: 0,
      latencyMs: 0,
      gaps: [],
      affected: [],
      startEntityId: null,
      query: { fileOrPrUrl: "x" },
    };
    expect(isImpactBrief(brief)).toBe(true);
  });

  it("returns false for non-impact briefs", () => {
    expect(
      isImpactBrief({
        kind: "expert",
        agentVersion: 1,
        generatedAt: 0,
        latencyMs: 0,
        gaps: [],
        affected: [],
      }),
    ).toBe(false);
  });

  it("returns false when affected is missing", () => {
    expect(
      isImpactBrief({
        kind: "impact",
        agentVersion: 1,
        generatedAt: 0,
        latencyMs: 0,
        gaps: [],
      }),
    ).toBe(false);
  });

  it("returns false for null / non-object inputs", () => {
    expect(isImpactBrief(null)).toBe(false);
    expect(isImpactBrief("string")).toBe(false);
    expect(isImpactBrief(0)).toBe(false);
  });
});

describe("isCatchupBrief", () => {
  it("returns true for a valid CatchupBrief", () => {
    const brief = {
      kind: "catchup",
      agentVersion: 1,
      generatedAt: 0,
      latencyMs: 0,
      gaps: [],
      sections: [],
      selfPersonId: null,
      involvement: {
        ownedServices: [],
        activeRepos: [],
        incidentServices: [],
        collaboratorPersonIds: [],
      },
      query: { sinceMs: 0 },
    };
    expect(isCatchupBrief(brief)).toBe(true);
  });

  it("returns false for non-catchup briefs", () => {
    expect(
      isCatchupBrief({
        kind: "expert",
        agentVersion: 1,
        generatedAt: 0,
        latencyMs: 0,
        gaps: [],
        sections: [],
      }),
    ).toBe(false);
  });

  it("returns false when sections is missing", () => {
    expect(
      isCatchupBrief({
        kind: "catchup",
        agentVersion: 1,
        generatedAt: 0,
        latencyMs: 0,
        gaps: [],
      }),
    ).toBe(false);
  });

  it("returns false for null / non-object inputs", () => {
    expect(isCatchupBrief(null)).toBe(false);
    expect(isCatchupBrief(true)).toBe(false);
    expect(isCatchupBrief([])).toBe(false);
  });
});
