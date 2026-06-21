import { describe, expect, it } from "bun:test";

import { createBriefGuard } from "./guard-factory.ts";

describe("createBriefGuard", () => {
  const base = { kind: "x", agentVersion: 1, generatedAt: 0, latencyMs: 0, gaps: [] };
  const isX = createBriefGuard<unknown>("x", (b) => Array.isArray(b["items"]));
  const isXq = createBriefGuard<unknown>("x", (b) => Array.isArray(b["items"]), {
    requireQuery: true,
  });

  it("matches base shape + extra when requireQuery is off (no query needed)", () => {
    expect(isX({ ...base, items: [] })).toBe(true);
    expect(isX({ ...base, items: [], query: { a: 1 } })).toBe(true);
  });

  it("rejects wrong kind / version / non-array gaps / extra-fail", () => {
    expect(isX({ ...base, kind: "y", items: [] })).toBe(false);
    expect(isX({ ...base, agentVersion: 2, items: [] })).toBe(false);
    expect(isX({ ...base, gaps: "no", items: [] })).toBe(false);
    expect(isX({ ...base, items: "no" })).toBe(false);
  });

  it("rejects non-number generatedAt / latencyMs", () => {
    expect(isX({ ...base, generatedAt: "0", items: [] })).toBe(false);
    expect(isX({ ...base, latencyMs: null, items: [] })).toBe(false);
  });

  it("requires a non-null query object only when requireQuery is on", () => {
    expect(isXq({ ...base, items: [] })).toBe(false);
    expect(isXq({ ...base, items: [], query: null })).toBe(false);
    expect(isXq({ ...base, items: [], query: { a: 1 } })).toBe(true);
  });

  it("rejects null / non-object inputs", () => {
    expect(isX(null)).toBe(false);
    expect(isX("s")).toBe(false);
    expect(isX(42)).toBe(false);
  });
});
