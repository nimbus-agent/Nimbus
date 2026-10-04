import { describe, expect, test } from "bun:test";
import {
  namedTags,
  pickEnum,
  pickIntField,
  pickStringArray,
  trimTrailingSlash,
} from "./field-helpers.ts";

describe("trimTrailingSlash", () => {
  test("drops one trailing slash", () => {
    expect(trimTrailingSlash("https://host.example/")).toBe("https://host.example");
  });

  test("drops ONLY one — a doubled slash keeps its first half", () => {
    // The rule every replaced copy encoded; `stripTrailingSlashes` would return the bare host.
    expect(trimTrailingSlash("https://host.example//")).toBe("https://host.example/");
  });

  test("leaves a value without a trailing slash untouched, whitespace included", () => {
    expect(trimTrailingSlash("https://host.example")).toBe("https://host.example");
    expect(trimTrailingSlash("https://host.example/ ")).toBe("https://host.example/ ");
    expect(trimTrailingSlash("")).toBe("");
  });

  test("a lone slash becomes empty", () => {
    expect(trimTrailingSlash("/")).toBe("");
  });
});

describe("namedTags", () => {
  test("reads `name` by default, in input order", () => {
    expect(
      namedTags([
        { id: 1, name: "b" },
        { id: 2, name: "a" },
      ]),
    ).toEqual(["b", "a"]);
  });

  test("reads the field it is given, and only that field", () => {
    expect(namedTags([{ tag: "x" }, { name: "y" }, { tag: "z", name: "w" }], "tag")).toEqual([
      "x",
      "z",
    ]);
  });

  test("skips non-objects and absent, non-string or empty values", () => {
    expect(
      namedTags([null, 7, "bare", ["nested"], {}, { name: 3 }, { name: "" }, { name: "ok" }]),
    ).toEqual(["ok"]);
  });

  test("keeps duplicates and does not trim", () => {
    expect(namedTags([{ name: " a " }, { name: " a " }])).toEqual([" a ", " a "]);
  });

  test("a non-array yields an empty list", () => {
    expect(namedTags(undefined)).toEqual([]);
    expect(namedTags(null)).toEqual([]);
    expect(namedTags("tags")).toEqual([]);
    expect(namedTags({ name: "not-a-list" })).toEqual([]);
  });
});

describe("pickStringArray", () => {
  test("keeps every string element in order, empty strings included", () => {
    expect(pickStringArray(["a", "", "b"])).toEqual(["a", "", "b"]);
  });

  test("drops non-string elements", () => {
    expect(pickStringArray([null, 7, "x", { name: "obj" }, ["y"], true, "ok"])).toEqual([
      "x",
      "ok",
    ]);
  });

  test("returns a new array, never the input", () => {
    const input = ["a", "b"];
    const out = pickStringArray(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  test("a non-array yields an empty list", () => {
    expect(pickStringArray(undefined)).toEqual([]);
    expect(pickStringArray("a,b")).toEqual([]);
    expect(pickStringArray({ 0: "a", length: 1 })).toEqual([]);
  });
});

describe("pickIntField", () => {
  test("returns an integer unchanged", () => {
    expect(pickIntField({ line: 12 }, "line")).toBe(12);
    expect(pickIntField({ line: 0 }, "line")).toBe(0);
  });

  test("truncates a fractional number toward zero", () => {
    expect(pickIntField({ line: 12.7 }, "line")).toBe(12);
    expect(pickIntField({ line: -3.9 }, "line")).toBe(-3);
  });

  test("a numeric string, a non-finite number, or an absent key is null", () => {
    expect(pickIntField({ line: "12" }, "line")).toBeNull();
    expect(pickIntField({ line: Number.NaN }, "line")).toBeNull();
    expect(pickIntField({ line: Number.POSITIVE_INFINITY }, "line")).toBeNull();
    expect(pickIntField({ line: null }, "line")).toBeNull();
    expect(pickIntField({}, "line")).toBeNull();
  });

  test("reads only the key it is given", () => {
    expect(pickIntField({ line: 4, column: 9 }, "column")).toBe(9);
  });
});

describe("pickEnum", () => {
  type Level = "HIGH" | "LOW";
  const LEVELS: ReadonlySet<string> = new Set(["HIGH", "LOW"]);

  test("returns a member of the set unchanged", () => {
    expect(pickEnum<Level>("HIGH", LEVELS)).toBe("HIGH");
    expect(pickEnum<Level>("LOW", LEVELS)).toBe("LOW");
  });

  test("is case-sensitive", () => {
    expect(pickEnum<Level>("high", LEVELS)).toBeNull();
    expect(pickEnum<Level>("High", LEVELS)).toBeNull();
  });

  test("does not trim", () => {
    expect(pickEnum<Level>(" HIGH", LEVELS)).toBeNull();
  });

  test("an unknown string or a non-string is null", () => {
    expect(pickEnum<Level>("MEDIUM", LEVELS)).toBeNull();
    expect(pickEnum<Level>("", LEVELS)).toBeNull();
    expect(pickEnum<Level>(1, LEVELS)).toBeNull();
    expect(pickEnum<Level>(null, LEVELS)).toBeNull();
    expect(pickEnum<Level>(undefined, LEVELS)).toBeNull();
    expect(pickEnum<Level>(["HIGH"], LEVELS)).toBeNull();
  });
});
