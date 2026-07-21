import { describe, expect, test } from "bun:test";
import { buildServerGaps } from "./brief-gaps.ts";

const base = {
  declaredCount: 5,
  receivedCount: 5,
  truncatedTitles: [] as string[],
  useIndex: false,
  indexHits: 0,
  semanticAvailable: true,
  searchFailed: false,
  model: "llama3.1:8b",
  remote: false,
  boundGaps: [] as string[],
};

describe("buildServerGaps", () => {
  test("is empty for a complete local run that did not use the index", () => {
    expect(buildServerGaps(base)).toEqual([]);
  });

  test("reports missing sources", () => {
    const g = buildServerGaps({ ...base, receivedCount: 2 });
    expect(g.join(" ")).toContain("3");
  });

  test("names each truncated source", () => {
    const g = buildServerGaps({ ...base, truncatedTitles: ["Long Article"] });
    expect(g.join(" ")).toContain("Long Article");
  });

  test("flags an empty index result when useIndex was requested", () => {
    const g = buildServerGaps({ ...base, useIndex: true, indexHits: 0 });
    expect(g.join(" ").toLowerCase()).toContain("no saved clips");
  });

  test("distinguishes a failed index search from an empty one", () => {
    const g = buildServerGaps({ ...base, useIndex: true, indexHits: 0, searchFailed: true });
    expect(g.join(" ").toLowerCase()).toContain("returned an error");
    expect(g.join(" ").toLowerCase()).not.toContain("no saved clips");
  });

  test("flags keyword-only recall when semantic search was unavailable", () => {
    const g = buildServerGaps({ ...base, useIndex: true, indexHits: 3, semanticAvailable: false });
    expect(g.join(" ").toLowerCase()).toContain("keyword-only");
  });

  test("always discloses a remote model", () => {
    const g = buildServerGaps({ ...base, remote: true, model: "gpt-4o" });
    expect(g.join(" ")).toContain("gpt-4o");
    expect(g.join(" ").toLowerCase()).toContain("left this machine");
  });

  test("never discloses egress for a local model", () => {
    expect(buildServerGaps(base).join(" ").toLowerCase()).not.toContain("left this machine");
  });

  test("passes bound gaps through", () => {
    const g = buildServerGaps({ ...base, boundGaps: ["12 further findings omitted."] });
    expect(g).toContain("12 further findings omitted.");
  });

  test("adds no index gap when the index search succeeded with semantic recall available", () => {
    const g = buildServerGaps({ ...base, useIndex: true, indexHits: 3, semanticAvailable: true });
    expect(g).toEqual([]);
  });
});
