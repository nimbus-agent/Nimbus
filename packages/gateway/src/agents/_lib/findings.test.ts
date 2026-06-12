import { describe, expect, it, test } from "bun:test";
import type { ExpertBrief, GapNote } from "./findings.ts";
import {
  isCatchupBrief,
  isConflictBrief,
  isExpertBrief,
  isGhostBrief,
  isHuddleBrief,
  isImpactBrief,
  isJanitorBrief,
  isPreflightBrief,
} from "./findings.ts";

describe("findings type guards", () => {
  test("isExpertBrief accepts a minimal valid brief", () => {
    const brief: ExpertBrief = {
      kind: "expert",
      agentVersion: 1,
      generatedAt: Date.now(),
      latencyMs: 0,
      gaps: [],
      query: { topicOrFile: "x" },
      ranked: [],
    };
    expect(isExpertBrief(brief)).toBe(true);
  });

  test("isExpertBrief rejects wrong kind", () => {
    expect(isExpertBrief({ ...({} as object), kind: "impact" })).toBe(false);
  });

  test("isExpertBrief rejects null and primitives", () => {
    expect(isExpertBrief(null)).toBe(false);
    expect(isExpertBrief(undefined)).toBe(false);
    expect(isExpertBrief("string")).toBe(false);
    expect(isExpertBrief(42)).toBe(false);
  });

  test("isImpactBrief and isCatchupBrief reject expert kind", () => {
    const expert: ExpertBrief = {
      kind: "expert",
      agentVersion: 1,
      generatedAt: 0,
      latencyMs: 0,
      gaps: [],
      query: { topicOrFile: "x" },
      ranked: [],
    };
    expect(isImpactBrief(expert)).toBe(false);
    expect(isCatchupBrief(expert)).toBe(false);
  });

  test("GapNote remediation is optional", () => {
    const a: GapNote = { category: "empty_index", detail: "no items" };
    const b: GapNote = { category: "empty_index", detail: "no items", remediation: "sync first" };
    expect(a.remediation).toBeUndefined();
    expect(b.remediation).toBe("sync first");
  });

  test("isImpactBrief and isCatchupBrief reject objects missing generatedAt/latencyMs", () => {
    const baseShape = {
      agentVersion: 1,
      gaps: [],
      query: { fileOrPrUrl: "x" },
    };
    expect(isImpactBrief({ ...baseShape, kind: "impact", affected: [] })).toBe(false);
    expect(
      isCatchupBrief({ ...baseShape, kind: "catchup", sections: [], query: { sinceMs: 0 } }),
    ).toBe(false);
    const valid = { ...baseShape, generatedAt: 0, latencyMs: 0 };
    expect(isImpactBrief({ ...valid, kind: "impact", affected: [] })).toBe(true);
    expect(isCatchupBrief({ ...valid, kind: "catchup", sections: [], query: { sinceMs: 0 } })).toBe(
      true,
    );
  });
});

describe("6a brief guards", () => {
  it("isGhostBrief accepts a well-formed ghost brief", () => {
    const b = {
      kind: "ghost",
      agentVersion: 1,
      generatedAt: 1,
      latencyMs: 1,
      gaps: [],
      query: { file: "auth.ts" },
      startEntityId: null,
      findings: [],
    };
    expect(isGhostBrief(b)).toBe(true);
    expect(isGhostBrief({ ...b, kind: "impact" })).toBe(false);
  });

  it("isConflictBrief checks the collisions array", () => {
    const b = {
      kind: "conflict",
      agentVersion: 1,
      generatedAt: 1,
      latencyMs: 1,
      gaps: [],
      query: { file: "auth.ts" },
      startEntityId: null,
      collisions: [],
    };
    expect(isConflictBrief(b)).toBe(true);
    expect(isConflictBrief({ ...b, collisions: undefined })).toBe(false);
  });

  it("isHuddleBrief checks the contributions array", () => {
    const b = {
      kind: "huddle",
      agentVersion: 1,
      generatedAt: 1,
      latencyMs: 1,
      gaps: [],
      query: { sinceMs: 0 },
      contributions: [],
    };
    expect(isHuddleBrief(b)).toBe(true);
    expect(isHuddleBrief({ ...b, kind: "ghost" })).toBe(false);
  });
});

describe("6b brief guards", () => {
  const janitor = {
    kind: "janitor",
    agentVersion: 1,
    generatedAt: 1,
    latencyMs: 1,
    gaps: [],
    query: { resourceRef: "i-12345", idleDays: 14 },
    idle: true,
    proposalSuppressed: false,
    cleanupAction: null,
    peersClear: 2,
    peersTouched: [],
  };

  it("isJanitorBrief accepts a well-formed janitor brief", () => {
    expect(isJanitorBrief(janitor)).toBe(true);
  });

  it("isJanitorBrief rejects null, primitives, and each malformed field", () => {
    expect(isJanitorBrief(null)).toBe(false);
    expect(isJanitorBrief(42)).toBe(false);
    expect(isJanitorBrief({ ...janitor, kind: "preflight" })).toBe(false);
    expect(isJanitorBrief({ ...janitor, agentVersion: 2 })).toBe(false);
    expect(isJanitorBrief({ ...janitor, gaps: "x" })).toBe(false);
    expect(isJanitorBrief({ ...janitor, idle: "yes" })).toBe(false);
    expect(isJanitorBrief({ ...janitor, peersTouched: undefined })).toBe(false);
    expect(isJanitorBrief({ ...janitor, generatedAt: "now" })).toBe(false);
    expect(isJanitorBrief({ ...janitor, latencyMs: null })).toBe(false);
    expect(isJanitorBrief({ ...janitor, query: null })).toBe(false);
  });

  const preflight = {
    kind: "preflight",
    agentVersion: 1,
    generatedAt: 1,
    latencyMs: 1,
    gaps: [],
    query: { ref: "HEAD", namespace: "project:zurich" },
    downstreams: [],
    anyFailed: false,
    anyIncomplete: false,
  };

  it("isPreflightBrief accepts a well-formed preflight brief", () => {
    expect(isPreflightBrief(preflight)).toBe(true);
  });

  it("isPreflightBrief rejects null, primitives, and each malformed field", () => {
    expect(isPreflightBrief(null)).toBe(false);
    expect(isPreflightBrief("brief")).toBe(false);
    expect(isPreflightBrief({ ...preflight, kind: "janitor" })).toBe(false);
    expect(isPreflightBrief({ ...preflight, agentVersion: 0 })).toBe(false);
    expect(isPreflightBrief({ ...preflight, gaps: 1 })).toBe(false);
    expect(isPreflightBrief({ ...preflight, downstreams: {} })).toBe(false);
    expect(isPreflightBrief({ ...preflight, anyFailed: "no" })).toBe(false);
    expect(isPreflightBrief({ ...preflight, generatedAt: "t" })).toBe(false);
    expect(isPreflightBrief({ ...preflight, latencyMs: undefined })).toBe(false);
    expect(isPreflightBrief({ ...preflight, query: null })).toBe(false);
  });
});
