import { describe, expect, test } from "bun:test";
import { load } from "js-yaml";
import { USER_YAML_SCHEMA } from "./user-yaml-schema.ts";

const MERGE = "base: &b\n  a: 1\nderived:\n  <<: *b\n  c: 2\n";

describe("USER_YAML_SCHEMA", () => {
  test("premise: js-yaml's default schema lacks the forms this one restores", () => {
    // If a js-yaml release puts these back in its default schema, the tests below stop proving
    // anything about USER_YAML_SCHEMA — this one fails first and says so.
    expect(load(MERGE)).toEqual({ base: { a: 1 }, derived: { "<<": { a: 1 }, c: 2 } });
    expect(() => load("b: !!binary aGVsbG8=\n")).toThrow();
    expect(() => load("s: !!set {a, b}\n")).toThrow();
  });

  test("merges `<<` keys", () => {
    expect(load(MERGE, { schema: USER_YAML_SCHEMA })).toEqual({
      base: { a: 1 },
      derived: { a: 1, c: 2 },
    });
  });

  test("loads the explicit !!binary, !!omap, !!pairs and !!set tags", () => {
    const doc = load(
      "b: !!binary aGVsbG8=\no: !!omap [{x: 1}]\np: !!pairs [{y: 2}]\ns: !!set {a, b}\n",
      { schema: USER_YAML_SCHEMA },
    ) as Record<string, unknown>;
    expect(new TextDecoder().decode(doc["b"] as Uint8Array)).toBe("hello");
    expect(doc["o"]).toEqual([{ x: 1 }]);
    expect(doc["p"]).toEqual([["y", 2]]);
    expect(doc["s"]).toEqual(new Set(["a", "b"]));
  });

  test("keeps a date-like scalar as the string the user wrote", () => {
    expect(load("d: 2024-01-02\nt: 2024-01-02T03:04:05Z\n", { schema: USER_YAML_SCHEMA })).toEqual({
      d: "2024-01-02",
      t: "2024-01-02T03:04:05Z",
    });
  });
});
