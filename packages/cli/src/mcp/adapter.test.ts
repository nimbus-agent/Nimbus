import { describe, expect, it } from "bun:test";
import { clampLimit, projectRankedItem, projectRankedItems } from "./adapter.ts";

describe("clampLimit", () => {
  it("defaults to 20 when undefined", () => {
    expect(clampLimit(undefined)).toBe(20);
  });
  it("caps at 50", () => {
    expect(clampLimit(1000)).toBe(50);
  });
  it("floors at 1", () => {
    expect(clampLimit(0)).toBe(1);
  });
  it("passes a valid value through, floored", () => {
    expect(clampLimit(7.9)).toBe(7);
  });
  it("defaults on non-finite", () => {
    expect(clampLimit(Number.NaN)).toBe(20);
  });
  it("floors a negative value to 1", () => {
    expect(clampLimit(-5)).toBe(1);
  });
});

describe("projectRankedItem", () => {
  it("keeps core fields and maps indexedType -> type", () => {
    const out = projectRankedItem({
      name: "Fix login bug",
      service: "github",
      itemType: "file",
      indexedType: "pr",
      url: "https://example/pr/1",
      score: 0.91,
      modifiedAt: 1_700_000_000_000,
    });
    expect(out).toEqual({
      name: "Fix login bug",
      service: "github",
      type: "pr",
      url: "https://example/pr/1",
      score: 0.91,
      modifiedAt: 1_700_000_000_000,
    });
  });

  it("drops the raw rawMeta blob but keeps the whitelisted slice as meta (real github PR keys)", () => {
    const out = projectRankedItem({
      name: "PR",
      service: "github",
      indexedType: "pr",
      score: 0.5,
      rawMeta: {
        state: "open",
        number: 42,
        user: "alice", // github stores the PR author under `user`, not `author`
        labels: ["bug", "p1"],
        merged: false,
        draft: false,
        secret_token: "should-not-leak",
        huge_blob: "x".repeat(10_000),
      },
    });
    expect(out["meta"]).toEqual({
      state: "open",
      number: 42,
      user: "alice",
      labels: ["bug", "p1"],
      merged: false,
      draft: false,
    });
    expect(JSON.stringify(out)).not.toContain("should-not-leak");
    expect(JSON.stringify(out)).not.toContain("huge_blob");
  });

  it("truncates an over-long whitelisted string value to META_STRING_MAX (200)", () => {
    const out = projectRankedItem({
      name: "incident",
      service: "pagerduty",
      indexedType: "incident",
      score: 0.5,
      rawMeta: { status: "y".repeat(500), severity: "high" },
    });
    const meta = out["meta"] as Record<string, unknown>;
    expect((meta["status"] as string).length).toBe(200);
    expect(meta["severity"]).toBe("high");
  });

  it("falls back to canonicalUrl when url is absent and keeps semanticSnippet", () => {
    const out = projectRankedItem({
      name: "Doc",
      service: "drive",
      indexedType: "file",
      score: 0.3,
      canonicalUrl: "https://example/canon",
      semanticSnippet: "…matched text…",
    });
    expect(out["url"]).toBe("https://example/canon");
    expect(out["semanticSnippet"]).toBe("…matched text…");
  });

  it("omits meta when no whitelisted keys are present", () => {
    const out = projectRankedItem({
      name: "x",
      service: "s",
      indexedType: "file",
      score: 1,
      rawMeta: { mime_type: "text/plain" },
    });
    expect(out["meta"]).toBeUndefined();
  });

  it("truncates over-long strings inside a whitelisted array value (labels)", () => {
    const out = projectRankedItem({
      name: "PR",
      service: "github",
      indexedType: "pr",
      score: 0.5,
      rawMeta: { labels: ["bug", "z".repeat(500)] },
    });
    const meta = out["meta"] as Record<string, unknown>;
    const labels = meta["labels"] as string[];
    expect(labels[0]).toBe("bug");
    expect(labels[1]?.length).toBe(200);
  });

  it("drops null-valued whitelisted keys but keeps false/zero", () => {
    const out = projectRankedItem({
      name: "PR",
      service: "github",
      indexedType: "pr",
      score: 0.5,
      rawMeta: { state: null, merged: false, number: 0 },
    });
    expect(out["meta"]).toEqual({ merged: false, number: 0 });
  });
});

describe("projectRankedItems", () => {
  it("maps a valid array", () => {
    expect(
      projectRankedItems([{ name: "a", service: "s", indexedType: "pr", score: 1 }]),
    ).toHaveLength(1);
  });
  it("returns [] for undefined", () => {
    expect(projectRankedItems(undefined)).toEqual([]);
  });
  it("returns [] for a non-array object", () => {
    expect(projectRankedItems({})).toEqual([]);
  });
});
