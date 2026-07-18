import { describe, expect, test } from "bun:test";
import type { IssueRef } from "./gh-api.ts";
import {
  computeStateHash,
  markerFor,
  readStateHash,
  selectExistingIssue,
  shouldComment,
} from "./open-health-issue.ts";

describe("selectExistingIssue", () => {
  const mk = (n: number, key: string, created: string): IssueRef => ({
    number: n,
    body: `x ${markerFor(key)} y`,
    createdAt: created,
  });
  test("marker match → that issue", () => {
    expect(
      selectExistingIssue([mk(1, "secret-health", "2026-01-01")], "secret-health")?.number,
    ).toBe(1);
  });
  test("no match → null", () => {
    expect(selectExistingIssue([mk(1, "other", "2026-01-01")], "secret-health")).toBeNull();
  });
  test("multiple → oldest-open wins", () => {
    const chosen = selectExistingIssue(
      [mk(2, "secret-health", "2026-02-01"), mk(1, "secret-health", "2026-01-01")],
      "secret-health",
    );
    expect(chosen?.number).toBe(1);
  });
});

describe("state hashing / comment gating", () => {
  test("computeStateHash is stable + differs on change", () => {
    expect(computeStateHash("A")).toBe(computeStateHash("A"));
    expect(computeStateHash("A")).not.toBe(computeStateHash("B"));
  });
  test("readStateHash parses the embedded marker", () => {
    const h = computeStateHash("A");
    expect(readStateHash(`body <!-- release-health-state:${h} --> end`)).toBe(h);
    expect(readStateHash("no marker")).toBeNull();
  });
  test("shouldComment only on change", () => {
    const h = computeStateHash("A");
    expect(shouldComment(h, h)).toBe(false);
    expect(shouldComment(computeStateHash("A"), computeStateHash("B"))).toBe(true);
    expect(shouldComment(null, h)).toBe(true); // first time
  });
});
