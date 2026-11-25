import { describe, expect, it } from "vitest";
import { withContentKeys } from "../../src/lib/content-keys";

describe("withContentKeys", () => {
  it("keys each item by its content", () => {
    expect(withContentKeys(["a", "b"], (s) => s)).toEqual([
      { key: "a", item: "a" },
      { key: "b", item: "b" },
    ]);
  });

  it("suffixes a repeated content with its occurrence number", () => {
    const keys = withContentKeys(["x", "y", "x", "x"], (s) => s).map((k) => k.key);
    expect(keys).toEqual(["x", "y", "x#2", "x#3"]);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps a key when an unrelated item is inserted before it", () => {
    const before = withContentKeys(["a", "b"], (s) => s);
    const after = withContentKeys(["z", "a", "b"], (s) => s);
    expect(after.find((k) => k.item === "b")?.key).toBe(before.find((k) => k.item === "b")?.key);
  });

  it("returns an empty list for no items", () => {
    expect(withContentKeys([], (s: string) => s)).toEqual([]);
  });
});
