import { describe, expect, test } from "bun:test";

import { MCP_TOOL_RESULT_MAX_BYTES } from "../_lib/mcp-tool-result.ts";
import {
  BEFORE_EXCERPT_MAX_CHARS,
  BEFORE_LIST_MAX_ENTRIES,
  beforeReplyJson,
  codePointLength,
  excerptHead,
  excerptTail,
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

  test("only an empty list reads (none); unreadable entries are counted, never dropped", () => {
    expect(listAt({ l: [] }, ["l"])).toBe("(none)");
    expect(listAt({ l: [{ n: "a" }, {}, null, { n: { deep: 1 } }] }, ["l"], "n")).toBe(
      "a (+3 unreadable)",
    );
    expect(listAt({ l: [{ n: "a" }, { n: "b" }, {}] }, ["l"], "n")).toBe("a, b (+1 unreadable)");
    expect(listAt({ l: [{}] }, ["l"], "n")).toBe("(1 entry, unreadable)");
    expect(listAt({ l: [{ n: "a" }, { n: "b" }] }, ["l"])).toBe("(2 entries, unreadable)");
  });

  test("past the cap, unreadable entries are counted in (+N more)", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `n${String(i)}`);
    expect(listAt({ l: [...fifty, {}, {}] }, ["l"])).toBe(`${fifty.join(", ")} (+2 unreadable)`);
    expect(listAt({ l: [...fifty, "x", {}] }, ["l"])).toBe(
      `${fifty.join(", ")} (+2 more, 1 of them unreadable)`,
    );
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

describe("the excerpt cap (B3, plan R4)", () => {
  const ASTRAL = String.fromCodePoint(0x1f600);

  /** Whether `s` has an unpaired surrogate code unit. */
  function hasLoneSurrogate(s: string): boolean {
    for (const ch of s) {
      const cp = ch.codePointAt(0) ?? 0;
      if (cp >= 0xd800 && cp <= 0xdfff) return true;
    }
    return false;
  }

  test("the cap is 1,000 code points", () => {
    expect(BEFORE_EXCERPT_MAX_CHARS).toBe(1000);
  });

  test("a string within the cap is returned as is", () => {
    const s = "a".repeat(1000);
    expect(excerptHead(s)).toBe(s);
    expect(excerptTail(s)).toBe(s);
    expect(excerptHead("")).toBe("");
  });

  test("one over: 1,000 kept and the count marked", () => {
    const s = `${"a".repeat(1000)}b`;
    expect(excerptHead(s)).toBe(`${"a".repeat(1000)} (1 more characters not shown)`);
    expect(excerptTail(`b${"a".repeat(1000)}`)).toBe(
      `(1 earlier characters not shown) ${"a".repeat(1000)}`,
    );
  });

  test("astral characters are cut on a code-point boundary and counted as one each", () => {
    const s = ASTRAL.repeat(1001);
    const head = excerptHead(s);
    const tail = excerptTail(s);
    expect(head).toBe(`${ASTRAL.repeat(1000)} (1 more characters not shown)`);
    expect(tail).toBe(`(1 earlier characters not shown) ${ASTRAL.repeat(1000)}`);
    expect(hasLoneSurrogate(head)).toBe(false);
    expect(hasLoneSurrogate(tail)).toBe(false);
    expect(codePointLength(s)).toBe(1001);
  });

  test("a max of 0 gives only the marker", () => {
    expect(excerptHead("abc", 0)).toBe(" (3 more characters not shown)");
    expect(excerptTail("abc", 0)).toBe("(3 earlier characters not shown) ");
  });

  test("a custom max", () => {
    expect(excerptHead("abcdef", 2)).toBe("ab (4 more characters not shown)");
    expect(excerptTail("abcdef", 2)).toBe("(4 earlier characters not shown) ef");
  });
});
