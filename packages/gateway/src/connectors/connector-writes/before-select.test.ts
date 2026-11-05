import { describe, expect, test } from "bun:test";

import { MCP_TOOL_RESULT_MAX_BYTES } from "../_lib/mcp-tool-result.ts";
import {
  BEFORE_LIST_MAX_ENTRIES,
  beforeReplyJson,
  listAt,
  presentFields,
  requiredStringAt,
  stringAt,
} from "./before-select.ts";

const mcp = (text: string, extra: Record<string, unknown> = {}) => ({
  content: [{ type: "text", text }],
  ...extra,
});

describe("beforeReplyJson", () => {
  test("an MCP CallToolResult is unwrapped and parsed", () => {
    expect(beforeReplyJson(mcp('{"title":"x"}'))).toEqual({ title: "x" });
  });

  test("a plain object without content passes through as is", () => {
    const o = { title: "x" };
    expect(beforeReplyJson(o)).toBe(o);
  });

  test("isError: true throws", () => {
    expect(() => beforeReplyJson(mcp('{"title":"x"}', { isError: true }))).toThrow(/error/);
  });

  test("non-JSON text throws", () => {
    expect(() => beforeReplyJson(mcp("not json"))).toThrow();
  });

  test("a content value with no text part throws", () => {
    expect(() => beforeReplyJson({ content: [] })).toThrow();
    expect(() => beforeReplyJson({ content: "x" })).toThrow();
  });

  test("a string, an array, null and undefined throw", () => {
    for (const v of ["{}", [{ title: "x" }], null, undefined, 7]) {
      expect(() => beforeReplyJson(v), String(v)).toThrow();
    }
  });

  test("text over the MCP result cap throws", () => {
    const big = `"${"a".repeat(MCP_TOOL_RESULT_MAX_BYTES)}"`;
    expect(() => beforeReplyJson(mcp(big))).toThrow(/cap/);
  });
});

describe("stringAt / requiredStringAt / presentFields", () => {
  test("walks own properties; strings as is, finite numbers as strings", () => {
    const v = { a: { b: "x", n: 3, f: 1.5 } };
    expect(stringAt(v, ["a", "b"])).toBe("x");
    expect(stringAt(v, ["a", "n"])).toBe("3");
    expect(stringAt(v, ["a", "f"])).toBe("1.5");
  });

  test("anything else is undefined", () => {
    const v = { a: { o: {}, t: true, nan: Number.NaN, inf: Number.POSITIVE_INFINITY, z: null } };
    for (const k of ["o", "t", "nan", "inf", "z", "missing"]) {
      expect(stringAt(v, ["a", k]), k).toBeUndefined();
    }
    expect(stringAt(v, [])).toBeUndefined();
  });

  test("inherited properties are ignored", () => {
    expect(stringAt(Object.create({ title: "x" }), ["title"])).toBeUndefined();
    expect(stringAt({}, ["toString"])).toBeUndefined();
  });

  test("a walk through a non-object is undefined", () => {
    expect(stringAt({ a: "x" }, ["a", "b"])).toBeUndefined();
    expect(stringAt({ a: [{ b: "x" }] }, ["a", "0", "b"])).toBeUndefined();
    expect(stringAt(null, ["a"])).toBeUndefined();
    expect(stringAt("x", ["length"])).toBeUndefined();
  });

  test("requiredStringAt throws when the value is absent", () => {
    expect(requiredStringAt({ t: "x" }, ["t"])).toBe("x");
    expect(() => requiredStringAt({}, ["fields", "summary"])).toThrow(/fields\.summary/);
  });

  test("presentFields drops the absent entries, keeps the order", () => {
    expect(
      presentFields([
        ["A", "1"],
        ["B", undefined],
        ["C", ""],
      ]),
    ).toEqual([
      { label: "A", value: "1" },
      { label: "C", value: "" },
    ]);
  });
});

describe("listAt (B2: labels and assignees)", () => {
  test("strings, or the string at `item` of each object entry, joined with a comma", () => {
    expect(listAt({ l: ["a", "b"] }, ["l"])).toBe("a, b");
    expect(listAt({ x: { l: [{ n: "a" }, { n: "b" }] } }, ["x", "l"], "n")).toBe("a, b");
  });

  test("an entry without a name is skipped; an empty or nameless list reads (none)", () => {
    expect(listAt({ l: [{ n: "a" }, {}, null, { n: { deep: 1 } }] }, ["l"], "n")).toBe("a");
    expect(listAt({ l: [] }, ["l"])).toBe("(none)");
    expect(listAt({ l: [{}] }, ["l"], "n")).toBe("(none)");
    expect(listAt({ l: [{ n: "a" }] }, ["l"])).toBe("(none)");
  });

  test("absent, null, an object or a string is undefined (the field is omitted)", () => {
    for (const v of [{}, { l: null }, { l: {} }, { l: "a,b" }, null, "x"]) {
      expect(listAt(v, ["l"]), JSON.stringify(v)).toBeUndefined();
    }
    expect(listAt(Object.create({ l: ["a"] }), ["l"])).toBeUndefined();
  });

  test("at most 50 entries, the rest counted", () => {
    expect(BEFORE_LIST_MAX_ENTRIES).toBe(50);
    const fifty = Array.from({ length: 50 }, (_, i) => `n${String(i)}`);
    expect(listAt({ l: fifty }, ["l"])).toBe(fifty.join(", "));
    expect(listAt({ l: [...fifty, "x", "y"] }, ["l"])).toBe(`${fifty.join(", ")} (+2 more)`);
  });
});
