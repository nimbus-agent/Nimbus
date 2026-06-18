import { describe, expect, test } from "bun:test";
import { formatAttributionChip } from "./attribution.ts";

describe("formatAttributionChip", () => {
  test("0 hops → direct", () => {
    expect(formatAttributionChip({ originLabel: "alice", hops: 0 })).toBe("from alice (direct)");
  });
  test("1 hop → singular", () => {
    expect(formatAttributionChip({ originLabel: "alice", hops: 1 })).toBe(
      "forwarded from alice, 1 hop away",
    );
  });
  test("N hops → plural", () => {
    expect(formatAttributionChip({ originLabel: "alice", hops: 3 })).toBe(
      "forwarded from alice, 3 hops away",
    );
  });
});
